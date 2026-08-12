import React, { Suspense } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { AUTH_ENABLED, SUPABASE_URL } from "./sync/config";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// The faint logo watermark behind everything (styles.css, body::before).
// Resolved here rather than in CSS because only runtime knows the surface:
// inside Tauri the file ships in the bundle, on the web it comes from the
// asset bucket. Same rule as assetUrl(), done without importing the data seam
// into the entry point. SVG is not an accepted upload type on the bucket
// (sensible — SVG can carry script), so the hosted copy is a PNG.
document.documentElement.style.setProperty(
  "--ctp-watermark",
  isTauri
    ? "url('/assets/brand/ctp_logo_light.svg')"
    : `url('${SUPABASE_URL}/storage/v1/object/public/ctp-assets/assets/brand/ctp_logo_light_v1.png')`
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
