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

// ── boot state: did starting the sync itself fail? ────────────────────────
// The SDK's SyncStatus only exists once the database is open. If init() throws
// — seen in the field as "Failed to fetch dynamically imported module
// wa-sqlite-async-*.js", the 2.3 MB SQLite chunk not arriving on a bad line —
// there is no status to read, the shell rendered with "offline · 0 parts" for
// the life of the page, and nothing ever retried. The gate reads this for
// that phase, and its Retry button runs connectPowerSync() again.
export type SyncBootState = { phase: "idle" | "starting" | "started" | "failed"; error: string | null; attempt: number };
let boot: SyncBootState = { phase: "idle", error: null, attempt: 0 };
const bootListeners = new Set<(b: SyncBootState) => void>();
export function subscribeSyncBoot(fn: (b: SyncBootState) => void): () => void {
  bootListeners.add(fn);
  fn(boot);
  return () => { bootListeners.delete(fn); };
}
function setBoot(patch: Partial<SyncBootState>) {
  boot = { ...boot, ...patch };
  for (const l of bootListeners) l(boot);
}

let connecting = false;
export async function connectPowerSync() {
  if (connecting || powerSync.connected) return;
  connecting = true;
  setBoot({ phase: "starting", error: null, attempt: boot.attempt + 1 });
  try {
    await powerSync.init();
    // The database is open: from here the SDK's own status tells the story
    // (connecting, connected, progress), so hand over to it now rather than
    // after connect() returns.
    setBoot({ phase: "started" });
    await powerSync.connect(new SupabaseConnector());
  } catch (e) {
    setBoot({ phase: "failed", error: e instanceof Error ? e.message : String(e) });
    throw e;
  } finally {
    connecting = false;
  }
}

/** Drop the stream and open a new one. What the gate's Retry does once the
 *  database is open: the SDK retries on its own every 5 s after a socket
 *  timeout, but a person who has watched a number not move for a minute
 *  deserves a button that does something visible. */
export async function reconnectPowerSync() {
  if (boot.phase === "failed" || !powerSync.ready) return connectPowerSync();
  await disconnectPowerSync();
  await powerSync.connect(new SupabaseConnector());
}

export async function disconnectPowerSync() {
  try {
    await powerSync.disconnect();
  } catch {
    /* ignore */
  }
}
