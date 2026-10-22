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
                        results?: { ok: boolean; number?: string; status?: string; error?: string; warning?: string; adopted?: boolean }[] } | null;
    if (error) {
      try { res = await (error as { context?: Response }).context?.json(); } catch { /* keep error */ }
      if (!res) return { ok: false, message: `NOT sent to Zoho: ${error.message}` };
    }
    if (res?.skipped) return { ok: true, message: res.skipped };
    const r = res?.results?.[0];
    if (r?.ok && r.adopted) {   // 0059: accounts had already invoiced the sales order in Zoho
      return { ok: true, message: `Already invoiced by accounts in Zoho: ${r.number ?? ""} (${r.status ?? ""}) — linked, not created again` };
    }
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

/** 0059: read one order's Zoho sales order back now (Michelle's edits, sent
 *  state) and its customer's account terms. Throttled server-side to 30 s per
 *  order; the change arrives through sync. Never throws. */
export async function syncSalesOrder(orderId: number, force = false): Promise<{ ok: boolean; changes: string[]; message?: string }> {
  try {
    const { data, error } = await supabase.functions.invoke("zoho-push", { body: { action: "so_sync", order_id: orderId, force } });
    if (error) return { ok: false, changes: [], message: error.message };
    const d = data as { ok?: boolean; changes?: string[]; warnings?: string[]; error?: string; skipped?: string };
    return { ok: d?.ok !== false, changes: [...(d?.changes ?? []), ...(d?.warnings ?? [])], message: d?.error ?? d?.skipped };
  } catch (e) {
    return { ok: false, changes: [], message: e instanceof Error ? e.message : String(e) };
  }
}

/** 0059: admin releases an order for fulfilment before accounts have sent the
 *  Zoho sales order. The note is required and goes on the order. */
export async function overrideFulfilGate(orderId: number, note: string): Promise<void> {
  const { error } = await supabase.rpc("override_fulfil_gate", { p_order_id: orderId, p_note: note });
  if (error) throw new Error(error.message);
}

/** 0059: why "Fulfil" is not allowed yet — the same rules as the database's
 *  fulfil_block_reason(), from the synced columns, so the button can say why
 *  before anyone presses it. The database still has the final word. */
export function fulfilBlockReason(o: {
  zoho_salesorder_id?: string | null; zoho_salesorder_number?: string | null; zoho_so_status?: string | null;
  zoho_so_readback_issue?: string | null; fulfil_override_at?: string | null;
  // 0061: accounts' invoice (read back from Zoho) and whether the customer is on account
  zoho_invoice_id?: string | null; zoho_invoice_number?: string | null; zoho_status?: string | null;
  zoho_invoice_balance_minor?: number | null; cust_on_account?: boolean;
}): string | null {
  if (!o.zoho_salesorder_id || o.fulfil_override_at) return null;
  const st = o.zoho_so_status ?? "draft";
  if (st === "deleted" || st === "void") return `The Zoho sales order ${o.zoho_salesorder_number ?? ""} was ${st} in Zoho — ask accounts before taking stock out.`;
  if (!o.zoho_invoice_id || ["void", "deleted"].includes(o.zoho_status ?? "")) return "Waiting for accounts to invoice this sales order in Zoho.";
  if (o.zoho_so_readback_issue) return `The Zoho invoice has a line CTP cannot match: ${o.zoho_so_readback_issue}`;
  if (!o.cust_on_account && o.zoho_status !== "paid") {
    const due = (o.zoho_invoice_balance_minor ?? 0) > 0 ? `, R${((o.zoho_invoice_balance_minor ?? 0) / 100).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} due` : "";
    return `Waiting for payment: ${o.zoho_invoice_number ?? "the invoice"} is ${(o.zoho_status ?? "unpaid").replace(/_/g, " ")}${due} (cash customer — accounts record the payment in Zoho).`;
  }
  return null;
}

/** 0061: admin sets a customer to account (fulfil after invoice) or cash (after payment). */
export async function setCustomerOnAccount(customerId: number, onAccount: boolean): Promise<void> {
  const { error } = await supabase.rpc("set_customer_on_account", { p_customer_id: customerId, p_on_account: onAccount });
  if (error) throw new Error(error.message);
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
