// Loaded ONLY when AUTH_ENABLED is true (via React.lazy in main.tsx), so the
// default path never imports PowerSync/Supabase and the existing app is untouched.
import App from "../App";
import { AuthProvider } from "./AuthProvider";
import { AuthGate } from "./AuthGate";
import { PowerSyncContext } from "@powersync/react";
import { powerSync } from "../sync/system";

export default function AuthedApp() {
  return (
    <PowerSyncContext.Provider value={powerSync}>
      <AuthProvider>
        <AuthGate>
          <App />
        </AuthGate>
      </AuthProvider>
    </PowerSyncContext.Provider>
  );
}
