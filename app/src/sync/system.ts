// The PowerSync-managed local SQLite (separate from the Rust rusqlite DB used by
// the existing views). During B1 this syncs in the background; the data-layer
// cutover (reads/writes via PowerSync) is the next increment.
import { PowerSyncDatabase, createBaseLogger, LogLevel } from "@powersync/web";
import { AppSchema } from "./AppSchema";
import { SupabaseConnector } from "./SupabaseConnector";

const logger = createBaseLogger();
logger.useDefaults();
// Support switch. `localStorage.ctp_sync_debug = "1"` before a reload turns the
// SDK's own log to DEBUG (every checkpoint, keepalive and reconnect) and keeps
// a timestamped timeline of status changes at window.__ctpSync — the thing to
// read when someone says "it just sat there".
const SYNC_DEBUG = (() => { try { return localStorage.getItem("ctp_sync_debug") === "1"; } catch { return false; } })();
logger.setLevel(SYNC_DEBUG ? LogLevel.DEBUG : LogLevel.WARN);

export const powerSync = new PowerSyncDatabase({
  schema: AppSchema,
  database: { dbFilename: "ctp_core.db" },
  logger,
});

type SyncTrace = { t: number; connected: boolean; connecting: boolean; hasSynced?: boolean;
  downloaded?: number; total?: number; error?: string; lastSyncedAt?: string };
declare global { interface Window { __ctpSync?: { db: PowerSyncDatabase; t0: number; trace: SyncTrace[] } } }
if (typeof window !== "undefined") {
  const t0 = Date.now();
  const trace: SyncTrace[] = [];
  window.__ctpSync = { db: powerSync, t0, trace };
  powerSync.registerListener({
    statusChanged: (st) => {
      const p = st.downloadProgress;
      const err = st.dataFlowStatus.downloadError ?? st.dataFlowStatus.uploadError;
      const e: SyncTrace = { t: Date.now() - t0, connected: st.connected, connecting: st.connecting,
        hasSynced: st.hasSynced, downloaded: p?.downloadedOperations, total: p?.totalOperations,
        error: err ? String(err) : undefined, lastSyncedAt: st.lastSyncedAt?.toISOString() };
      trace.push(e);
      if (SYNC_DEBUG) console.info("[CTP sync]", JSON.stringify(e));
    },
  });
}

// Whose data is on this device. Sign-out clears the database, but a session
// can also end without a sign-out (expiry, a cleared cookie) and a different
// person then sign in: the database would still hold the previous login's
// buckets until the new sync replaced them - seconds online, never offline.
// So the owner of the local data is recorded, and a different user clears it
// before connecting.
const OWNER_KEY = "ctp_sync_owner";
const owner = {
  get: (): string | null => { try { return localStorage.getItem(OWNER_KEY); } catch { return null; } },
  set: (id: string | null) => { try { id ? localStorage.setItem(OWNER_KEY, id) : localStorage.removeItem(OWNER_KEY); } catch { /* storage unavailable */ } },
};

let connecting = false;
export async function connectPowerSync(userId?: string) {
  if (connecting || powerSync.connected) return;
  connecting = true;
  try {
    await powerSync.init();
    const previous = owner.get();
    if (userId && previous && previous !== userId) {
      console.warn("[CTP sync] different user on this device - clearing the previous login's data");
      await powerSync.disconnectAndClear();
    }
    if (userId) owner.set(userId);
    await powerSync.connect(new SupabaseConnector());
  } finally {
    connecting = false;
  }
}

export async function disconnectPowerSync() {
  try {
    await powerSync.disconnect();
  } catch {
    /* ignore */
  }
}

/** Stop sync and wipe every synced row from this device. What sign-out does. */
export async function clearPowerSync() {
  owner.set(null);
  if (!powerSync.ready) { await disconnectPowerSync(); return; }
  await powerSync.disconnectAndClear();
}
