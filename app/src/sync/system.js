// The PowerSync-managed local SQLite (separate from the Rust rusqlite DB used by
// the existing views). During B1 this syncs in the background; the data-layer
// cutover (reads/writes via PowerSync) is the next increment.
import { PowerSyncDatabase, createBaseLogger, LogLevel } from "@powersync/web";
import { AppSchema } from "./AppSchema";
import { SupabaseConnector } from "./SupabaseConnector";
const logger = createBaseLogger();
logger.useDefaults();
logger.setLevel(LogLevel.WARN);
export const powerSync = new PowerSyncDatabase({
    schema: AppSchema,
    database: { dbFilename: "ctp_core.db" },
});
let connecting = false;
export async function connectPowerSync() {
    if (connecting || powerSync.connected)
        return;
    connecting = true;
    try {
        await powerSync.init();
        await powerSync.connect(new SupabaseConnector());
    }
    finally {
        connecting = false;
    }
}
export async function disconnectPowerSync() {
    try {
        await powerSync.disconnect();
    }
    catch {
        /* ignore */
    }
}
