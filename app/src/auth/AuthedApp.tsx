// Loaded lazily from main.tsx. Two jobs:
//   1. stand up PowerSync + Supabase auth around whatever UI renders;
//   2. pick that UI by surface — the desktop App inside Tauri, the mobile
//      shell in a browser. The mobile shell only speaks ported commands
//      (src/data/backend.web.ts), so it can never hit a "not available in the
//      browser build" error; the desktop App keeps its full Rust surface.
// THE WEB/PWA ROOT. PowerSync belongs here and only here.
//
// The desktop has its own root — DesktopAuthedApp — which deliberately does NOT
// import this file or anything under sync/system, because sync/system
// constructs a PowerSyncDatabase at module scope. The desktop reads and writes
// fleetview.db through Rust; a second PowerSync-owned database syncing in the
// background is the "two databases" problem Phase 3 exists to remove.
import MobileShell from "../mobile/MobileShell";
import { AuthProvider } from "./AuthProvider";
import { AuthGate } from "./AuthGate";
import { PowerSyncContext } from "@powersync/react";
import { powerSync, connectPowerSync, disconnectPowerSync } from "../sync/system";

const powerSyncAdapter = {
  connect: connectPowerSync,
  disconnect: disconnectPowerSync,
};

export default function AuthedApp() {
  return (
    <PowerSyncContext.Provider value={powerSync}>
      <AuthProvider sync={powerSyncAdapter}>
        <AuthGate>
          <MobileShell />
        </AuthGate>
      </AuthProvider>
    </PowerSyncContext.Provider>
  );
}
