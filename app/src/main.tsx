// FIRST, before anything can construct the Supabase client: note whether this
// page was opened by an invite or a password-reset link. supabase-js strips the
// token out of the URL as it starts up, and with it the only evidence of why
// the person is here. See auth/authIntent.ts.
import "./auth/authIntent";

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
// v3: an 800 px WebP (~41 KB) of the v2 master (~120 KB). It is drawn at 5%
// opacity, so the extra resolution of the 1600 px master was never visible.
document.documentElement.style.setProperty(
  "--ctp-watermark",
  isTauri
    ? "url('/assets/brand/ctp_logo_light.svg')"
    : "url('/brand/ctp_logo_light_v3.webp')"
);

// Which root renders:
//   * Tauri desktop, AUTH_ENABLED=false — the plain App, exactly as before.
//     No sync/auth code runs; flipping AUTH_ENABLED opts the desktop in.
//   * a browser (the hosted PWA) — ALWAYS the authed path. There is no
//     Rust layer in a browser, so an unauthenticated <App/> would just be a
//     screenful of dead queries; the only working web surface is
//     login → PowerSync → MobileShell, regardless of the desktop flag.
const useAuthedRoot = AUTH_ENABLED || !isTauri;

// Two authed roots, and which one loads matters architecturally.
//
//   AuthedApp        web/PWA. Mounts PowerSync, which owns its own database.
//   DesktopAuthedApp desktop. Mounts NO PowerSync — the desktop reads and
//                    writes fleetview.db through Rust, and a second
//                    PowerSync-owned database syncing in the background is the
//                    "two databases" problem Phase 3 exists to remove.
//
// Both are lazy, so the chunk that is not taken is never fetched: on the plain
// desktop path neither loads, and on the authed desktop path the PowerSync
// chunk is never pulled in at all.
const AuthedApp = React.lazy(() => import("./auth/AuthedApp"));
const DesktopAuthedApp = React.lazy(() => import("./auth/DesktopAuthedApp"));
const AuthedRoot = isTauri ? DesktopAuthedApp : AuthedApp;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {useAuthedRoot ? (
      <Suspense fallback={<div className="login-wrap"><div className="login-sub">Loading…</div></div>}>
        <AuthedRoot />
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
    // 24 Oct: a tab left open keeps running the old build after a deploy. When a new service
    // worker takes over, tell the shell (it shows "New version ready — Reload"), and look for
    // an update whenever the app comes back to the foreground.
    // (a first install also fires controllerchange — only a REPLACED worker means a new version)
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController) window.dispatchEvent(new Event("ctp-new-version")); });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void navigator.serviceWorker.getRegistration().then((r) => r?.update());
    });
    navigator.serviceWorker.register("/sw.js").catch((e) => {
      console.warn("[CTP] service worker registration failed:", e);
    });
  });
}
