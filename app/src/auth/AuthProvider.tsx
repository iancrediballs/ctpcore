import React, { createContext, useContext, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase, readStoredSession } from "../sync/supabase";
import { initialAuthIntent } from "./authIntent";

/** Background sync, supplied by the surface rather than imported here.
 *
 *  This used to `import { connectPowerSync } from "../sync/system"`, and that
 *  one line decided the architecture: sync/system.ts constructs a
 *  PowerSyncDatabase at module scope, so any importer drags PowerSync in. On
 *  the desktop that is precisely wrong — the desktop reads and writes
 *  fleetview.db through Rust, and a second PowerSync-owned database syncing in
 *  the background is the "two databases" problem Phase 3 exists to avoid.
 *
 *  Injecting it means the web passes PowerSync and the desktop passes nothing,
 *  and neither surface can accidentally acquire the other's data layer. */
export type SyncAdapter = {
  /** Start sync for this user. The id lets the surface notice a different
   *  person signing in on a device that still holds someone else's data. */
  connect: (userId: string) => Promise<void>;
  disconnect: () => Promise<void>;
  /** Stop sync AND wipe the local database. Sign-out uses this: what synced
   *  for one login must not be on the device for the next. */
  clear: () => Promise<void>;
};

export type Role = "customer" | "sales" | "warehouse" | "manager" | "admin" | null;

type AuthCtx = {
  session: Session | null;
  role: Role;
  loading: boolean;
  signOut: () => Promise<void>;
  /** True when this session arrived from an invite or reset link and the
   *  person has not chosen a password yet. The app stays behind a
   *  "set your password" screen until they do — otherwise they are signed in
   *  on a one-time token and locked out the moment it expires. */
  mustSetPassword: boolean;
  passwordSet: () => void;
};

const Ctx = createContext<AuthCtx>({
  session: null, role: null, loading: true, signOut: async () => {},
  mustSetPassword: false, passwordSet: () => {},
});
export const useAuth = () => useContext(Ctx);

/** How long to wait for getSession() before opening with the stored session. */
const STORED_SESSION_AFTER_MS = 2500;
/** How often an expired token is retried while the network seems dead. */
const EXPIRED_RETRY_MS = 15_000;

/** Refresh an EXPIRED token now (one still valid is auto-refresh's job).
 *  auth-js caches a failed refresh for 60 s (keyed on the refresh token), so a
 *  reconnect would otherwise wait that out. */
async function refreshNow() {
  const stored = readStoredSession();
  if (!stored || (stored.expires_at ?? 0) * 1000 > Date.now()) return;
  try {
    (supabase.auth as unknown as { lastRefreshFailure: unknown }).lastRefreshFailure = null;
    await supabase.auth.refreshSession();
  } catch { /* the auto-refresh ticker tries again */ }
}

export function AuthProvider(
  { children, sync }: { children: React.ReactNode; sync?: SyncAdapter }
) {
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<Role>(null);
  const [loading, setLoading] = useState(true);
  // Seeded from the URL this page was opened with, captured before supabase-js
  // wiped it. PASSWORD_RECOVERY below is the second route to the same state:
  // belt and braces, because the two flows differ between implicit and PKCE.
  const [mustSetPassword, setMustSetPassword] = useState(initialAuthIntent !== null);

  useEffect(() => {
    // SO-3: opened offline with an expired access token, getSession() tries to
    // refresh it, retries for ~30 s, then resolves with session null — the app
    // sat on "Loading…" and then fell to the login screen. auth-js itself KEEPS
    // the stored session when a refresh fails for want of a network, and all
    // the app shows offline comes from the local PowerSync database, which
    // needs no token. So when offline, or when the network does not answer in
    // a moment, open with the stored session; auth-js refreshes it later.
    let settled = false;
    const useStored = () => {
      if (settled) return;
      const stored = readStoredSession();
      if (!stored) return;
      settled = true;
      setSession(stored);
      setLoading(false);
    };
    if (typeof navigator !== "undefined" && navigator.onLine === false) useStored();
    const slow = window.setTimeout(useStored, STORED_SESSION_AFTER_MS);
    supabase.auth.getSession().then(({ data }) => {
      window.clearTimeout(slow);
      settled = true;
      // null with the session still in storage = the refresh failed on the
      // network (a rejected refresh token is removed from storage): keep it.
      setSession(data.session ?? readStoredSession());
      setLoading(false);
    });
    // Back online: refresh now rather than waiting out auth-js's failure cooldown.
    const onOnline = () => { void refreshNow(); };
    window.addEventListener("online", onOnline);
    // A dead network often never fires "offline"/"online" (signal, not Wi-Fi),
    // so an expired token is also retried on a timer. No-op while it is valid.
    const retry = window.setInterval(onOnline, EXPIRED_RETRY_MS);
    const { data: sub } = supabase.auth.onAuthStateChange((e, s) => {
      // INITIAL_SESSION arrives as null when the refresh failed offline. Only a
      // real sign-out (or a session auth-js removed) drops us to the login.
      setSession(s ?? (e === "SIGNED_OUT" ? null : readStoredSession()));
      if (e === "PASSWORD_RECOVERY") setMustSetPassword(true);
      // A deliberate sign-out clears it, so the next person to use this browser
      // gets the normal login screen rather than somebody else's reset flow.
      if (e === "SIGNED_OUT") setMustSetPassword(false);
    });
    return () => {
      window.clearTimeout(slow);
      window.clearInterval(retry);
      window.removeEventListener("online", onOnline);
      sub.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!session) {
      setRole(null);
      sync?.disconnect();
      return;
    }
    // role: prefer a JWT claim if present (B2 token hook), else app_user table.
    supabase
      .from("app_user")
      .select("role")
      .eq("id", session.user.id)
      .maybeSingle()
      .then(({ data }) => setRole(((data?.role as Role) ?? "customer")));
    // start background sync, if this surface has one (non-fatal — reads still
    // work without it). The desktop passes no adapter: it syncs through its own
    // Rust client, not PowerSync.
    sync?.connect(session.user.id).catch((e) => console.error("background sync connect failed:", e));
  }, [session]);

  // Sign-out wipes the device. Measured 14 Sep: after a staff sign-out the local
  // database still held every price, cost, stock movement, customer and order,
  // readable by whoever picked the phone up next - and a customer signing in
  // on it saw that data until their own first sync replaced it. The cost of
  // clearing is that the next sign-in on this device does a first sync again
  // (a few seconds online); that is the right trade.
  const signOut = async () => {
    try { await sync?.clear(); } catch (e) { console.error("could not clear local data on sign-out:", e); }
    await supabase.auth.signOut();
  };

  return (
    <Ctx.Provider value={{
      session, role, loading, signOut,
      mustSetPassword,
      passwordSet: () => setMustSetPassword(false),
    }}>{children}</Ctx.Provider>
  );
}
