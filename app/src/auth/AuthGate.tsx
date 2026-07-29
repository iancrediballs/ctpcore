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

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setErr(error.message);
    setBusy(false);
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
      </form>
    </div>
  );
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth();
  if (loading) return <div className="login-wrap"><div className="login-sub">Loading…</div></div>;
  if (!session) return <LoginScreen />;
  return <>{children}</>;
}
