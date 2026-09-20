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
  //
  // ⚠ IDS DO NOT ROUND-TRIP. Every Postgres table here keeps its original
  // BIGINT identity ids; a locally-INSERTed row carries a client-generated
  // UUID in op.id. Upserting `{...opData, id: op.id}` would hand Postgres a
  // UUID for a bigint column — a type error on the very first write. So:
  //
  //   * stock_movement (the only PUT so far): upload WITHOUT the id — Postgres
  //     assigns the identity — keyed on client_uuid with ignoreDuplicates, so
  //     a retry after a half-acknowledged upload inserts nothing twice.
  //     (`authenticated` holds INSERT only on this table; ON CONFLICT DO
  //     NOTHING needs no UPDATE grant, and no .select() is chained so no
  //     RETURNING read happens either.)
  //   * PATCH/DELETE target rows that came FROM Postgres, so their op.id is
  //     the numeric string that round-trips fine in an .eq().
  //   * a PUT on any other table is refused loudly: each new local-insert
  //     table needs its own conflict key thought through, not inherited
  //     accidents. tx.complete() would otherwise discard the write silently.
  async uploadData(database: AbstractPowerSyncDatabase) {
    const tx = await database.getNextCrudTransaction();
    if (!tx) return;
    try {
      for (const op of tx.crud) {
        const table = supabase.from(op.table);
        let res;
        if (op.op === UpdateType.PUT) {
          if (op.table === "stock_movement") {
            res = await table.upsert({ ...op.opData }, {
              onConflict: "client_uuid",
              ignoreDuplicates: true,
            });
          } else {
            throw new Error(
              `PowerSync upload: no INSERT mapping for table "${op.table}" — ` +
                `add one to SupabaseConnector.uploadData (ids are bigint server-side; ` +
                `never upload the local UUID id).`
            );
          }
        } else if (op.op === UpdateType.PATCH) {
          res = await table.update(op.opData ?? {}).eq("id", op.id);
        } else if (op.op === UpdateType.DELETE) {
          res = await table.delete().eq("id", op.id);
        }
        if (res?.error) {
          // 0049: the shelf guard refused this movement ON PURPOSE (SQLSTATE
          // CT001). Retrying can never succeed and would block every later
          // write on this device behind it, so the whole local transaction is
          // dropped (both legs of a transfer go together) and the person is
          // told why. The local row disappears at the next checkpoint because
          // the server never had it.
          if (res.error.code === "CT001") {
            console.warn("PowerSync upload refused by the shelf guard; dropping:", res.error.message);
            window.dispatchEvent(new CustomEvent("ctp-sync-refused", { detail: { message: res.error.message } }));
            await tx.complete();
            return;
          }
          throw res.error;
        }
      }
      await tx.complete();
    } catch (e) {
      console.error("PowerSync uploadData failed:", e);
      throw e; // let PowerSync retry
    }
  }
}
