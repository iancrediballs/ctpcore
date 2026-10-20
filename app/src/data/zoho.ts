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

/** Read Zoho's status back onto pushed documents (Draft → Sent → Paid / Void).
 *  Throttled server-side to once every 2 minutes unless `force`. Never throws. */
export async function refreshZohoStatus(force = false): Promise<{ ok: boolean; changed: number; message?: string }> {
  try {
    const { data, error } = await supabase.functions.invoke("zoho-push", { body: { action: "status", force } });
    if (error) return { ok: false, changed: 0, message: error.message };
    const d = data as { ok?: boolean; changed?: number; error?: string; skipped?: string };
    return { ok: d?.ok !== false, changed: d?.changed ?? 0, message: d?.error ?? d?.skipped };
  } catch (e) {
    return { ok: false, changed: 0, message: e instanceof Error ? e.message : String(e) };
  }
}

/** How a Zoho status reads to staff. Zoho's own word is kept in the data;
 *  this is only the label. `doc` matters: an "open" bill is an approved one. */
export function zohoStatusLabel(status: string | null | undefined, doc: "invoice" | "bill" | "salesorder" = "invoice"):
    { text: string; tone: "wait" | "ok" | "done" | "bad" } {
  switch (status) {
    case null: case undefined: case "": return { text: "Not in Zoho yet", tone: "wait" };
    case "pushing": return { text: "Sending to Zoho…", tone: "wait" };
    case "draft": return { text: "Zoho: Draft — awaiting accountant", tone: "wait" };
    case "sent": case "viewed": case "unpaid": return { text: "Zoho: Sent (approved)", tone: "ok" };
    case "open": return { text: doc === "invoice" ? "Zoho: Sent (approved)" : doc === "bill" ? "Zoho: Open (approved)" : "Zoho: Open (confirmed)", tone: "ok" };
    case "invoiced": return { text: "Zoho: Invoiced", tone: "done" };
    case "partially_invoiced": return { text: "Zoho: Part-invoiced", tone: "ok" };
    case "closed": return { text: "Zoho: Closed", tone: "done" };
    case "overdue": return { text: "Zoho: Overdue", tone: "bad" };
    case "partially_paid": return { text: "Zoho: Part-paid", tone: "ok" };
    case "paid": return { text: "Zoho: Paid", tone: "done" };
    case "void": return { text: "Zoho: Void", tone: "bad" };
    case "deleted": return { text: "Deleted in Zoho", tone: "bad" };
    case "blocked": case "error": return { text: "NOT in Zoho — error", tone: "bad" };
    default: return { text: `Zoho: ${status}`, tone: "ok" };
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
