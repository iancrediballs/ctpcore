import React, { useState } from "react";
import { supabase } from "../sync/supabase";
import { useAuth } from "./AuthProvider";

// Tech-noir login screen. On success the AuthProvider picks up the session,
// loads the role, and starts background sync.
function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setErr(error.message);
    setBusy(false);
  };

  // 2026-10-07: there was no way to ask for a reset from inside the app, so
  // every forgotten password meant someone opening the Supabase dashboard.
  const forgot = async () => {
    if (!email) { setErr("Type your email address first, then tap Forgot password."); return; }
    setBusy(true);
    setErr(null);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin,
    });
    if (error) setErr(error.message); else setSent(true);
    setBusy(false);
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">CTP <b>Core</b></div>
        <div className="login-sub">Sign in to continue</div>
        <input className="login-in" type="email" placeholder="Email" autoFocus
          autoComplete="username"
          value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="login-in" type="password" placeholder="Password"
          autoComplete="current-password"
          value={password} onChange={(e) => setPassword(e.target.value)} />
        {err && <div className="login-err">✕ {err}</div>}
        {sent && <div className="login-sub">Check your email — the link opens here and asks you to set a new password.</div>}
        <button className="login-btn" disabled={busy || !email || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <button type="button" className="login-link" disabled={busy} onClick={forgot}>
          Forgot password?
        </button>
      </form>
    </div>
  );
}

/** Where an invited user — or anyone who followed a reset link — lands.
 *
 *  They already have a session at this point: the link signed them in. What
 *  they do NOT have is a password, so without this screen they would be let
 *  into the app and then locked out for good once the one-time token expired.
 *  That was the bug: the invite "worked", dropped them straight into CTP Core,
 *  and gave them no way back. */
function SetPasswordScreen() {
  const { session, passwordSet, signOut } = useAuth();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const tooShort = password.length > 0 && password.length < 8;
  const mismatch = confirm.length > 0 && password !== confirm;
  const ok = password.length >= 8 && password === confirm;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ok) return;
    setBusy(true);
    setErr(null);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) { setErr(error.message); setBusy(false); return; }
    // Only now is the account actually usable. Drop the flag and the app opens.
    passwordSet();
    setBusy(false);
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">CTP <b>Core</b></div>
        <div className="login-sub">
          Welcome{session?.user.email ? `, ${session.user.email}` : ""} — choose a password
        </div>
        <input className="login-in" type="password" placeholder="New password" autoFocus
          autoComplete="new-password"
          value={password} onChange={(e) => setPassword(e.target.value)} />
        <input className="login-in" type="password" placeholder="Confirm password"
          autoComplete="new-password"
          value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        {tooShort && <div className="login-err">✕ At least 8 characters.</div>}
        {mismatch && <div className="login-err">✕ The two don't match.</div>}
        {err && <div className="login-err">✕ {err}</div>}
        <button className="login-btn" disabled={busy || !ok}>
          {busy ? "Saving…" : "Set password and continue"}
        </button>
        <button type="button" className="login-link" disabled={busy}
          onClick={() => void signOut()}>
          Not you? Sign out
        </button>
      </form>
    </div>
  );
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { session, loading, mustSetPassword } = useAuth();
  if (loading) return <div className="login-wrap"><div className="login-sub">Loading…</div></div>;
  if (!session) return <LoginScreen />;
  // Order matters: a session is not enough when it came from a one-time link.
  if (mustSetPassword) return <SetPasswordScreen />;
  return <>{children}</>;
}
