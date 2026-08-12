// Loaded lazily from main.tsx. Two jobs:
//   1. stand up PowerSync + Supabase auth around whatever UI renders;
//   2. pick that UI by surface — the desktop App inside Tauri, the mobile
//      shell in a browser. The mobile shell only speaks ported commands
//      (src/data/backend.web.ts), so it can never hit a "not available in the
//      browser build" error; the desktop App keeps its full Rust surface.
import App from "../App";
import MobileShell from "../mobile/MobileShell";
import { AuthProvider } from "./AuthProvider";
import { AuthGate } from "./AuthGate";
import { PowerSyncContext } from "@powersync/react";
import { powerSync } from "../sync/system";
import { isTauri } from "../data/api";

export default function AuthedApp() {
  return (
    <PowerSyncContext.Provider value={powerSync}>
      <AuthProvider>
        <AuthGate>
          {isTauri ? <App /> : <MobileShell />}
        </AuthGate>
      </AuthProvider>
    </PowerSyncContext.Provider>
  );
}
