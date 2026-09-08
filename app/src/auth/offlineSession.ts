// CTP Core — offline sign-in for the desktop counter.
//
// THE PROBLEM THIS SOLVES
// The counter must keep trading with no connectivity — that is a headline
// feature, not a nicety. So the app has to answer "is this person allowed to
// use this machine right now?" without a server, which means checking a typed
// password against something already on the machine.
//
// It stores a PBKDF2-SHA256 VERIFIER, never a password and never anything
// reversible into one. Web Crypto does the work, so there is no new dependency
// and no hand-rolled crypto. All of it lives here rather than being split
// between Rust and TypeScript: one implementation to get right beats two that
// have to agree.
//
// WHAT IT PROTECTS AGAINST, AND WHAT IT DOES NOT — see migration 0022 for the
// full version. Short form: it stops someone using the APP without a valid
// password. It does nothing about someone reading fleetview.db directly, which
// is unencrypted and holds cost, margin and every customer. Encryption at rest
// is a separate, tracked item tied to the first hire.
import { invoke } from "@tauri-apps/api/core";

/** How long a machine may go without reaching the server before sign-in stops.
 *  Generous on purpose: a counter that loses its connection on a Friday must
 *  not stop trading over a weekend. The failure being designed against is a
 *  business closing early, not a breach. */
export const OFFLINE_WINDOW_DAYS = 14;
/** Warning starts at half the window, so a weekend cannot swallow the notice.
 *  A warning at day 13 arrives when it is already nearly too late. */
export const OFFLINE_WARN_AFTER_DAYS = 7;

const PBKDF2_ITERS = 210_000; // OWASP guidance for PBKDF2-SHA256, 2023 onward

export type LocalSessionSummary = {
  user_id: string; email: string; display_name: string | null;
  role: string | null; last_verified_at: string;
};
type LocalSessionSecret = LocalSessionSummary & {
  verifier: string; verifier_salt: string; verifier_iters: number;
  refresh_token: string | null;
};

// ─── verifier ────────────────────────────────────────────────────────────────

const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password: string, salt: Uint8Array, iters: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as unknown as BufferSource, iterations: iters, hash: "SHA-256" },
    key, 256
  );
  return b64(bits);
}

/** Constant-time-ish compare. Not a defence against a local attacker — they
 *  have the file — but it costs nothing and avoids a needless timing signal. */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ─── the offline window ──────────────────────────────────────────────────────

export type OfflineState =
  | { band: "fresh";   daysOffline: number }
  | { band: "warning"; daysOffline: number; daysLeft: number }
  | { band: "expired"; daysOffline: number };

export function offlineState(lastVerifiedAt: string, now = new Date()): OfflineState {
  // SQLite datetime('now') is UTC without a zone marker; say so explicitly
  // rather than letting the runtime guess and be wrong by its offset.
  const last = new Date(lastVerifiedAt.replace(" ", "T") + "Z");
  const days = Math.floor((now.getTime() - last.getTime()) / 86_400_000);
  if (days >= OFFLINE_WINDOW_DAYS) return { band: "expired", daysOffline: days };
  if (days >= OFFLINE_WARN_AFTER_DAYS)
    return { band: "warning", daysOffline: days, daysLeft: OFFLINE_WINDOW_DAYS - days };
  return { band: "fresh", daysOffline: days };
}

/** What the operator is told. Says what is wrong, what to do, and by when —
 *  "session expiring soon" is not actionable; this is. */
export function offlineMessage(s: OfflineState): string | null {
  if (s.band === "fresh") return null;
  if (s.band === "warning")
    return `This machine hasn't reached the server for ${s.daysOffline} day${s.daysOffline === 1 ? "" : "s"}. ` +
           `It will stop allowing sign-in in ${s.daysLeft} day${s.daysLeft === 1 ? "" : "s"} — ` +
           `connect it to the internet when convenient.`;
  return `This machine hasn't reached the server for ${s.daysOffline} days, so it can no longer ` +
         `sign anyone in. Connect it to the internet and sign in once to continue.`;
}

// ─── the store (Rust side holds opaque strings only) ─────────────────────────

export const listLocalSessions = () => invoke<LocalSessionSummary[]>("list_local_sessions");
export const forgetLocalSession = (userId: string) =>
  invoke<void>("forget_local_session", { userId });
export const touchLocalSession = (userId: string, role: string | null) =>
  invoke<void>("touch_local_session", { userId, role });

/** Cache an account after a SUCCESSFUL ONLINE sign-in, and only then.
 *  Recomputing the verifier here is what makes a centrally-changed password
 *  take effect on this machine; stamping last_verified_at resets the window. */
export async function cacheSession(args: {
  userId: string; email: string; displayName: string | null;
  role: string | null; password: string; refreshToken: string | null;
}): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const verifier = await derive(args.password, salt, PBKDF2_ITERS);
  await invoke<void>("save_local_session", {
    userId: args.userId, email: args.email, displayName: args.displayName,
    role: args.role, verifier, verifierSalt: b64(salt.buffer),
    verifierIters: PBKDF2_ITERS, refreshToken: args.refreshToken,
  });
}

export type OfflineSignIn =
  | { ok: true; session: LocalSessionSummary; state: OfflineState }
  | { ok: false; reason: "unknown-machine" | "wrong-password" | "expired"; message: string };

/** Sign in with no network, against what this machine already holds. */
export async function offlineSignIn(email: string, password: string): Promise<OfflineSignIn> {
  const row = await invoke<LocalSessionSecret | null>("get_local_session", { email });

  // A machine that has never been online has nothing to check against. Say that,
  // rather than reporting it as a wrong password — a generic auth error here is
  // a support call created; this sentence is a support call avoided.
  if (!row) {
    return {
      ok: false, reason: "unknown-machine",
      message: "This machine hasn't signed in to CTP Core before, so it can't check your " +
               "password while offline. Connect it to the internet and sign in once — after " +
               "that it will work offline.",
    };
  }

  const state = offlineState(row.last_verified_at);
  if (state.band === "expired") {
    return { ok: false, reason: "expired", message: offlineMessage(state)! };
  }

  const attempt = await derive(password, unb64(row.verifier_salt), row.verifier_iters);
  if (!sameSecret(attempt, row.verifier)) {
    return {
      ok: false, reason: "wrong-password",
      message: "That password doesn't match the one last used on this machine. If you changed " +
               "it recently, you'll need an internet connection to sign in with the new one.",
    };
  }

  const { verifier: _v, verifier_salt: _s, verifier_iters: _i, refresh_token: _r, ...summary } = row;
  return { ok: true, session: summary, state };
}
