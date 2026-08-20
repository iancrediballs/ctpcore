import React, { Suspense } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { AUTH_ENABLED } from "./sync/config";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// The faint logo watermark behind everything (styles.css, body::before).
// Resolved here rather than in CSS because only runtime knows the surface:
// inside Tauri the SVG ships in the bundle; on the web the PNG now ships in
// the bundle too (public/brand/) — v2, rebuilt from the refined master, and
// no longer fetched from the bucket so it draws before any network exists.
document.documentElement.style.setProperty(
  "--ctp-watermark",
  isTauri
    ? "url('/assets/brand/ctp_logo_light.svg')"
    : "url('/brand/ctp_logo_light_v2.png')"
);

// Which root renders:
//   * Tauri desktop, AUTH_ENABLED=false — the plain App, exactly as before.
//     No sync/auth code runs; flipping AUTH_ENABLED opts the desktop in.
//   * a browser (the hosted PWA) — ALWAYS the authed path. There is no
//     Rust layer in a browser, so an unauthenticated <App/> would just be a
//     screenful of dead queries; the only working web surface is
//     login → PowerSync → MobileShell, regardless of the desktop flag.
const useAuthedRoot = AUTH_ENABLED || !isTauri;

// The login gate + PowerSync live in a lazily-loaded chunk so that when the
// plain desktop path is taken, none of that code even loads.
const AuthedApp = React.lazy(() => import("./auth/AuthedApp"));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {useAuthedRoot ? (
      <Suspense fallback={<div className="login-wrap"><div className="login-sub">Loading…</div></div>}>
        <AuthedApp />
      </Suspense>
    ) : (
      <App />
    )}
  </React.StrictMode>
);

// The PWA bits: only in a real browser, only in a production build (the dev
// server would fight the cache on every hot reload).
if (!isTauri && import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((e) => {
      console.warn("[CTP] service worker registration failed:", e);
    });
  });
}
