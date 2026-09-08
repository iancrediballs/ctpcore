// THE DESKTOP ROOT WHEN AUTHENTICATION IS ON.
//
// Deliberately NOT AuthedApp. That file mounts PowerSync, and this one must
// not, for the reason Phase 3 exists: the desktop reads and writes
// fleetview.db through Rust, and a second PowerSync-owned database syncing in
// the background is exactly the two-databases problem being removed. Note what
// is absent from the imports below — nothing here reaches sync/system, so
// PowerSyncDatabase is never constructed on this path.
//
// It passes no SyncAdapter to AuthProvider, so nothing tries to start a
// background sync. When the Rust sync client lands (Stage B), its connect and
// disconnect are what get passed here — same seam, different implementation.
import App from "../App";
import { AuthProvider } from "./AuthProvider";
import { DesktopAuthGate } from "./DesktopAuthGate";

export default function DesktopAuthedApp() {
  return (
    <AuthProvider>
      <DesktopAuthGate>
        <App />
      </DesktopAuthGate>
    </AuthProvider>
  );
}
