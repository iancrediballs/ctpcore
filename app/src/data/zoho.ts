// CTP Core → Zoho write-back, from the app's side (0047, server/edge/zoho-push).
// Shared by the web backend (invoices) and the desktop receiving screen (bills).
// Neither function throws: every outcome — sent, skipped because sending is
// off, or the error — comes back as a sentence the screen must show.
import { supabase } from "../sync/supabase";

export type ZohoOutcome = { ok: boolean; message: string };

/** Ask the zoho-push Edge Function to send one document. */
export async function pushToZoho(docType: "invoice" | "bill", ctpId: number): Promise<ZohoOutcome> {
  try {
    const { data, error } = await supabase.functions.invoke("zoho-push",
      { body: { action: "push", doc_type: docType, ctp_id: ctpId } });
    let res = data as { ok?: boolean; skipped?: string; error?: string;
                        results?: { ok: boolean; number?: string; status?: string; error?: string; warning?: string }[] } | null;
    if (error) {
      try { res = await (error as { context?: Response }).context?.json(); } catch { /* keep error */ }
      if (!res) return { ok: false, message: `NOT sent to Zoho: ${error.message}` };
    }
    if (res?.skipped) return { ok: true, message: res.skipped };
    const r = res?.results?.[0];
    if (r?.ok) {
      return { ok: !r.warning, message: `Sent to Zoho as ${r.status ?? "draft"} ${r.number ?? ""}`.trim() + (r.warning ?? "") };
    }
    return { ok: false, message: `NOT sent to Zoho: ${r?.error ?? res?.error ?? "unknown error"}` };
  } catch (e) {
    return { ok: false, message: `NOT sent to Zoho: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** SQLite 'YYYY-MM-DD HH:MM:SS' (UTC, from datetime('now')) → ISO with Z. */
const utc = (s: unknown) =>
  typeof s === "string" && /^\d{4}-\d\d-\d\d \d\d:\d\d/.test(s) ? s.replace(" ", "T") + "Z" : s;

/** A receipt just posted on the desktop: upload it (submit_goods_receipt,
 *  idempotent on client_uuid), then ask for the Zoho bill. */
export async function sendReceiptToCloud(payload: Record<string, unknown>): Promise<ZohoOutcome> {
  const body = { ...payload, received_at: utc(payload.received_at), posted_at: utc(payload.posted_at) };
  const { data, error } = await supabase.rpc("submit_goods_receipt", { p: body });
  if (error) return { ok: false, message: `NOT sent to the cloud or Zoho: ${error.message}` };
  const id = Number((data as { receipt_id?: number })?.receipt_id);
  if (!id) return { ok: false, message: "NOT sent to Zoho: the cloud did not return a receipt id" };
  return pushToZoho("bill", id);
}
