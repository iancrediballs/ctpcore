// The desktop sign-in gate. Unlike the web gate it must work with no network,
// because the counter has to keep trading when the connection does not.
//
// How a sign-in is attempted, in order:
//   1. Supabase, if it answers. Success caches the account for offline use and
//      resets the offline clock.
//   2. If Supabase cannot be reached, the cached verifier on this machine.
//
// Online is tried FIRST on purpose. It is the only path that picks up a
// password changed centrally, or a role changed centrally, or an account that
// has been disabled. Falling back to the cache only when the server is
// genuinely unreachable keeps the machine as current as its connection allows.
import React, { useCallback, useEffect, useState } from "react";
import { supabase } from "../sync/supabase";
import { useAuth } from "./AuthProvider";
import {
  offlineSignIn, cacheSession, listLocalSessions, touchLocalSession,
  offlineState, offlineMessage,
  type LocalSessionSummary, type OfflineState,
} from "./offlineSession";

type Mode = { kind: "online" } | { kind: "offline"; session: LocalSessionSummary; state: OfflineState };

function LoginScreen({ onOffline }: { onOffline: (m: Extract<Mode, { kind: "offline" }>) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [known, setKnown] = useState<LocalSessionSummary[]>([]);

  // Who has used this machine before — the shift-handover picker. A shared
  // counter sees several people a day and each has their own login, so the
  // common case is "not me, the other one" rather than typing an address.
  useEffect(() => { listLocalSessions().then(setKnown).catch(() => setKnown([])); }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        // Distinguish "server said no" from "server never answered". Only the
        // second is a case for the offline path; the first is a real rejection
        // and falling back to a cached password would undo a central change.
        const unreachable =
          error.status === undefined || error.status === 0 ||
          /fetch|network|timeout/i.test(error.message);
        if (!unreachable) { setErr(error.message); return; }

        const res = await offlineSignIn(email, password);
        if (!res.ok) { setErr(res.message); return; }
        onOffline({ kind: "offline", session: res.session, state: res.state });
        return;
      }
      // Online success: refresh the cached verifier and role, and reset the clock.
      const u = data.user, s = data.session;
      if (u && s) {
        const { data: au } = await supabase
          .from("app_user").select("role, display_name").eq("id", u.id).maybeSingle();
        await cacheSession({
          userId: u.id, email: u.email ?? email,
          displayName: (au?.display_name as string) ?? null,
          role: (au?.role as string) ?? null,
          password, refreshToken: s.refresh_token ?? null,
        }).catch((e) => console.error("could not cache session for offline use:", e));
      }
    } catch (e) {
      // Total failure to reach Supabase throws rather than returning an error.
      const res = await offlineSignIn(email, password);
      if (!res.ok) { setErr(res.message); }
      else onOffline({ kind: "offline", session: res.session, state: res.state });
      if (!res.ok) console.error(e);
    } finally { setBusy(false); }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">CTP <b>Core</b></div>
        <div className="login-sub">Sign in to continue</div>
        <input className="login-in" type="email" placeholder="Email" autoFocus
          value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="login-in" type="password" placeholder="Password"
          value={password} onChange={(e) => setPassword(e.target.value)} />
        {err && <div className="login-err">✕ {err}</div>}
        <button className="login-btn" disabled={busy || !email || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        {known.length > 0 && (
          <div className="login-known">
            <div className="login-known-h">Used on this machine</div>
            {known.map((k) => (
              <button key={k.user_id} type="button" className="login-known-b"
                onClick={() => { setEmail(k.email); setPassword(""); setErr(null); }}>
                {k.display_name || k.email}
                <span className="login-known-s">{k.display_name ? k.email : ""}</span>
              </button>
            ))}
          </div>
        )}
      </form>
    </div>
  );
}

/** Who is signed in, how current the machine is, and how to hand over.
 *
 *  Always visible, not only when unhappy — so a warning is a change in
 *  something already being watched rather than an alarm from nowhere, and so an
 *  operator can report "it says 9 days" instead of "it's broken".
 *
 *  The handover button matters as much as the warning: per-person logins are
 *  only workable on a shared counter if switching takes one click. If handing
 *  over is awkward, people share one login, and then actor_id records nothing. */
function AccountStrip(
  { mode, who, onSwitch }: { mode: Mode; who: string; onSwitch: () => void }
) {
  const state = mode.kind === "offline" ? mode.state : null;
  const msg = state ? offlineMessage(state) : null;
  const cls = mode.kind === "online" ? "ok" : state!.band === "warning" ? "warn" : "off";
  return (
    <div className={"connbadge " + cls}>
      <div className="connbadge-top">
        <span className="connbadge-who">{who}</span>
        <button className="connbadge-sw" onClick={onSwitch} title="Sign out and hand over">
          Switch user
        </button>
      </div>
      {mode.kind === "online"
        ? <span>Connected</span>
        : <span>Working offline · last checked in {state!.daysOffline} day
            {state!.daysOffline === 1 ? "" : "s"} ago</span>}
      {msg && <div className="connbadge-msg">{msg}</div>}
    </div>
  );
}

export function DesktopAuthGate({ children }: { children: React.ReactNode }) {
  const { session, loading, signOut } = useAuth();
  const [offline, setOffline] = useState<Extract<Mode, { kind: "offline" }> | null>(null);

  /** Hand the machine to the next person. Works offline: an offline session
   *  exists only in React state, and supabase.auth.signOut() will fail with no
   *  network — which must not block the handover, so it is best-effort. The
   *  cached verifier is deliberately NOT removed: the point of caching is that
   *  the previous user can sign back in later without connectivity. Forgetting
   *  an account is a separate, explicit act (forget_local_session). */
  const switchUser = useCallback(async () => {
    setOffline(null);
    try { await signOut(); } catch { /* offline: local state is what matters */ }
  }, [signOut]);

  // Any successful server contact resets the offline clock — a silent token
  // refresh counts, not only a typed sign-in. A machine that reaches the server
  // even once a week never sees a warning at all.
  useEffect(() => {
    if (!session) return;
    setOffline(null);
    (async () => {
      try {
        const { data } = await supabase
          .from("app_user").select("role").eq("id", session.user.id).maybeSingle();
        await touchLocalSession(session.user.id, (data?.role as string) ?? null);
      } catch {
        /* non-fatal: the clock simply is not reset this time */
      }
    })();
  }, [session]);

  // Re-evaluate the band while the app stays open, so a machine left running
  // for days crosses into "warning" without needing a restart.
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 60 * 60 * 1000);
    return () => clearInterval(t);
  }, []);

  if (loading) return <div className="login-wrap"><div className="login-sub">Loading…</div></div>;

  if (!session && !offline) return <LoginScreen onOffline={setOffline} />;

  // An offline session that ages past the window while the app is OPEN is not
  // terminated mid-shift — refusing a new sign-in is tolerable, killing an
  // active till session is not. The band is re-read at launch and at sign-in.
  const mode: Mode = session
    ? { kind: "online" }
    : { kind: "offline", session: offline!.session, state: offlineState(offline!.session.last_verified_at) };

  const who = session
    ? (session.user.email ?? "Signed in")
    : (offline!.session.display_name || offline!.session.email);

  return (
    <>
      <AccountStrip mode={mode} who={who} onSwitch={switchUser} />
      {children}
    </>
  );
}
