import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from "react";
import { supabase } from "../sync/supabase";
import { useAuth } from "./AuthProvider";
// Tech-noir login screen. On success the AuthProvider picks up the session,
// loads the role, and starts background sync.
function LoginScreen() {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState(null);
    const submit = async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error)
            setErr(error.message);
        setBusy(false);
    };
    return (_jsx("div", { className: "login-wrap", children: _jsxs("form", { className: "login-card", onSubmit: submit, children: [_jsxs("div", { className: "login-brand", children: ["CTP ", _jsx("b", { children: "Core" })] }), _jsx("div", { className: "login-sub", children: "Sign in to continue" }), _jsx("input", { className: "login-in", type: "email", placeholder: "Email", autoFocus: true, value: email, onChange: (e) => setEmail(e.target.value) }), _jsx("input", { className: "login-in", type: "password", placeholder: "Password", value: password, onChange: (e) => setPassword(e.target.value) }), err && _jsxs("div", { className: "login-err", children: ["\u2715 ", err] }), _jsx("button", { className: "login-btn", disabled: busy || !email || !password, children: busy ? "Signing in…" : "Sign in" })] }) }));
}
export function AuthGate({ children }) {
    const { session, loading } = useAuth();
    if (loading)
        return _jsx("div", { className: "login-wrap", children: _jsx("div", { className: "login-sub", children: "Loading\u2026" }) });
    if (!session)
        return _jsx(LoginScreen, {});
    return _jsx(_Fragment, { children: children });
}
