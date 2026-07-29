// Bridges PowerSync <-> Supabase: supplies the auth token for the sync stream,
// and pushes local writes back up via the Supabase Data API.
import {
  type AbstractPowerSyncDatabase,
  type PowerSyncBackendConnector,
  UpdateType,
} from "@powersync/web";
import { supabase } from "./supabase";
import { POWERSYNC_URL } from "./config";

export class SupabaseConnector implements PowerSyncBackendConnector {
  // PowerSync calls this to get a token for the sync connection.
  async fetchCredentials() {
    const { data } = await supabase.auth.getSession();
    const session = data.session;
    if (!session) return null;
    return { endpoint: POWERSYNC_URL, token: session.access_token };
  }

  // PowerSync calls this to flush the local write queue to the backend.
  // NOTE (B1): writes require the target tables to be granted to the Data-API
  // `authenticated` role (auto-expose was left OFF for safety) + RLS write
  // policies. Until the write cutover, the app reads via Rust and makes no
  // PowerSync writes, so this stays idle.
  async uploadData(database: AbstractPowerSyncDatabase) {
    const tx = await database.getNextCrudTransaction();
    if (!tx) return;
    try {
      for (const op of tx.crud) {
        const table = supabase.from(op.table);
        let res;
        if (op.op === UpdateType.PUT) {
          res = await table.upsert({ ...op.opData, id: op.id });
        } else if (op.op === UpdateType.PATCH) {
          res = await table.update(op.opData ?? {}).eq("id", op.id);
        } else if (op.op === UpdateType.DELETE) {
          res = await table.delete().eq("id", op.id);
        }
        if (res?.error) throw res.error;
      }
      await tx.complete();
    } catch (e) {
      console.error("PowerSync uploadData failed:", e);
      throw e; // let PowerSync retry
    }
  }
}
