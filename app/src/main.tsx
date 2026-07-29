import React, { Suspense } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { AUTH_ENABLED } from "./sync/config";

// The login gate + PowerSync live in a lazily-loaded chunk so that when
// AUTH_ENABLED is false the app behaves exactly as before (no sync/auth code runs).
const AuthedApp = React.lazy(() => import("./auth/AuthedApp"));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {AUTH_ENABLED ? (
      <Suspense fallback={<div className="login-wrap"><div className="login-sub">Loading…</div></div>}>
        <AuthedApp />
      </Suspense>
    ) : (
      <App />
    )}
  </React.StrictMode>
);
