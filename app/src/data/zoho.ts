// CTP Core → Zoho write-back, from the app's side (0047, server/edge/zoho-push).
// Shared by the web backend (invoices) and the desktop receiving screen (bills).
// Neither function throws: every outcome — sent, skipped because sending is
// off, or the error — comes back as a sentence the screen must show.
import { supabase } from "../sync/supabase";
import { netMsg } from "./errors";

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
      if (!res) return { ok: false, message: `NOT sent to Zoho: ${netMsg(error)}` };
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
    return { ok: false, message: `NOT sent to Zoho: ${netMsg(e)}` };
  }
}

/** Read Zoho's status back onto pushed documents (Draft → Sent → Paid / Void).
 *  Throttled server-side to once every 2 minutes unless `force`. Never throws. */
export async function refreshZohoStatus(force = false): Promise<{ ok: boolean; changed: number; message?: string }> {
  try {
    const { data, error } = await supabase.functions.invoke("zoho-push", { body: { action: "status", force } });
    if (error) return { ok: false, changed: 0, message: netMsg(error) };
    const d = data as { ok?: boolean; changed?: number; error?: string; skipped?: string };
    return { ok: d?.ok !== false, changed: d?.changed ?? 0, message: d?.error ?? d?.skipped };
  } catch (e) {
    return { ok: false, changed: 0, message: netMsg(e) };
  }
}

/** 0059: read one order's Zoho sales order back now (Michelle's edits, sent
 *  state) and its customer's account terms. Throttled server-side to 30 s per
 *  order; the change arrives through sync. Never throws. */
export async function syncSalesOrder(orderId: number, force = false): Promise<{ ok: boolean; changes: string[]; message?: string }> {
  try {
    const { data, error } = await supabase.functions.invoke("zoho-push", { body: { action: "so_sync", order_id: orderId, force } });
    if (error) return { ok: false, changes: [], message: netMsg(error) };
    const d = data as { ok?: boolean; changes?: string[]; warnings?: string[]; error?: string; skipped?: string };
    return { ok: d?.ok !== false, changes: [...(d?.changes ?? []), ...(d?.warnings ?? [])], message: d?.error ?? d?.skipped };
  } catch (e) {
    return { ok: false, changes: [], message: netMsg(e) };
  }
}

/** QA 26 Oct (FLOW-1): after cancel_order(), the order's Zoho documents follow — the open sales
 *  order is voided (no email; Zoho's stock commitment goes), an invoiced one is left and named,
 *  a draft/sent estimate is declined. Never throws: `message` is what staff must be told. */
export async function cancelInZoho(orderId: number): Promise<{ ok: boolean; voided?: string; message?: string }> {
  try {
    const { data, error } = await supabase.functions.invoke("zoho-push", { body: { action: "cancel", order_id: orderId } });
    let d = data as { ok?: boolean; error?: string; salesorder?: { number?: string; voided?: boolean; message?: string; error?: string }; estimate?: { error?: string } } | null;
    if (error) {
      // a non-2xx answer still carries the server's own words
      try { d = await (error as { context?: Response }).context?.json(); } catch { /* keep the generic message */ }
      return { ok: false, message: d?.error ?? error.message };
    }
    const so = d?.salesorder;
    if (so?.voided) return { ok: true, voided: so.number };
    const msg = so?.error ?? so?.message ?? d?.estimate?.error ?? d?.error;
    return { ok: !so?.error && !d?.estimate?.error && d?.ok !== false, message: msg };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** 0062 (Phase 2): the quote's draft Zoho estimate, created or brought up to
 *  date after staff price it. The server skips it while quotes are not yet Zoho
 *  estimates (zoho_config.estimates_enabled off). Never throws. */
export async function syncEstimate(orderId: number): Promise<{ ok: boolean; skipped?: string; message?: string; number?: string }> {
  try {
    const { data, error } = await supabase.functions.invoke("zoho-push", { body: { action: "estimate", order_id: orderId } });
    if (error) return { ok: false, message: netMsg(error) };
    const d = data as { ok?: boolean; skipped?: string; error?: string; warning?: string; estimate_number?: string };
    return { ok: d?.ok !== false, skipped: d?.skipped, message: d?.error ?? d?.warning, number: d?.estimate_number };
  } catch (e) {
    return { ok: false, message: netMsg(e) };
  }
}

/** 0064: ADMIN — the quote's estimate was deleted/voided in Zoho; Zoho is
 *  re-checked, the old link retired and a fresh draft made from the current
 *  CTP lines (or a live one with the same reference linked). Never throws. */
export async function recreateEstimate(orderId: number): Promise<{ ok: boolean; message?: string; number?: string; linked?: boolean }> {
  try {
    const { data, error } = await supabase.functions.invoke("zoho-push", { body: { action: "estimate_recreate", order_id: orderId } });
    let d = data as { ok?: boolean; error?: string; estimate_number?: string; linked_existing?: boolean } | null;
    if (error) {
      try { d = await (error as { context?: Response }).context?.json(); } catch { /* keep */ }
      if (!d) return { ok: false, message: netMsg(error) };
    }
    return { ok: d?.ok === true, message: d?.error, number: d?.estimate_number, linked: d?.linked_existing };
  } catch (e) {
    return { ok: false, message: netMsg(e) };
  }
}

// ── 0065: Zoho Inventory holds the stock (rehearsal switch) ────────────────
type InvResult<T> = { ok: true; data: T } | { ok: false; message: string };
async function inv<T>(body: Record<string, unknown>): Promise<InvResult<T>> {
  try {
    const { data, error } = await supabase.functions.invoke("zoho-push", { body });
    let d = data as (T & { ok?: boolean; error?: string }) | null;
    if (error) {
      try { d = await (error as { context?: Response }).context?.json(); } catch { /* keep */ }
      if (!d) return { ok: false, message: netMsg(error) };
    }
    if (!d || d.ok === false) return { ok: false, message: d?.error ?? "Zoho did not answer." };
    return { ok: true, data: d };
  } catch (e) { return { ok: false, message: netMsg(e) }; }
}
export type ShipResult = { package_number: string; shipment_number: string; shipment_status: string; already?: boolean };
/** Fulfil when Zoho holds the stock: package + shipment (delivered) from the order's Zoho SO. */
export const shipInZoho = (orderId: number, mirror = false) => inv<ShipResult>({ action: "ship", order_id: orderId, ...(mirror ? { mirror: true } : {}) });
export type AdjustResult = { sku: string; counted: number; zoho_before: number; delta: number; reference?: string; note?: string };
/** A shelf count → Zoho Inventory adjustment (counted − Zoho's physical on hand). */
export const countToZoho = (partId: number, counted: number, reason = "Stock count") =>
  inv<AdjustResult>({ action: "adjust", part_id: partId, counted, reason });
export type OpenPO = { purchaseorder_id: string; number: string; vendor: string; date: string; status: string; reference: string | null;
  lines: { line_item_id: string; item_id: string; sku: string; name: string; ordered: number; received: number }[] };
export const openPurchaseOrders = () => inv<{ purchaseorders: OpenPO[] }>({ action: "receive_list" });
export const receiveInZoho = (purchaseorderId: string, lines: { line_item_id: string; quantity: number }[], notes?: string) =>
  inv<{ receive_number: string; purchaseorder: string }>({ action: "receive", purchaseorder_id: purchaseorderId, lines, notes });
export const refreshZohoStock = () => inv<{ items_read?: number; parts_changed?: number; skipped?: string }>({ action: "stock_sync", force: true });

/** 0059: admin releases an order for fulfilment before accounts have sent the
 *  Zoho sales order. The note is required and goes on the order. */
export async function overrideFulfilGate(orderId: number, note: string): Promise<void> {
  const { error } = await supabase.rpc("override_fulfil_gate", { p_order_id: orderId, p_note: note });
  if (error) throw new Error(netMsg(error));
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
  // 0078: the invoice must have been sent (account customers too)
  const inv = o.zoho_status ?? "draft";
  if (["draft", "pending_approval", "approved"].includes(inv)) {
    const how = inv === "draft" ? "a draft" : inv === "approved" ? "approved but not sent" : "waiting for approval";
    return `Invoice ${o.zoho_invoice_number ?? ""} is ${how} in Zoho, ask Michelle to mark it sent.`;
  }
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
  if (error) throw new Error(netMsg(error));
}

/** How a Zoho status reads to staff. Zoho's own word is kept in the data;
 *  this is only the label. `doc` matters: an "open" bill is an approved one. */
export function zohoStatusLabel(status: string | null | undefined, doc: "invoice" | "bill" | "salesorder" = "invoice"):
    { text: string; tone: "wait" | "ok" | "done" | "bad" } {
  // 23 Oct (Ian's e2e test): a sales order "open" in Zoho is CONFIRMED — never show it as a draft.
  if (doc === "salesorder") {
    switch (status) {
      case null: case undefined: case "": return { text: "Zoho: status not read yet", tone: "wait" };
      case "draft": return { text: "Zoho: Draft — not confirmed", tone: "wait" };
      case "pending_approval": return { text: "Zoho: Awaiting approval", tone: "wait" };
      case "approved": case "open": case "confirmed": return { text: "Zoho: Confirmed", tone: "ok" };
      case "onhold": case "on_hold": return { text: "Zoho: On hold", tone: "wait" };
      case "partially_invoiced": return { text: "Zoho: Part-invoiced", tone: "ok" };
      case "invoiced": return { text: "Zoho: Invoiced", tone: "done" };
      case "partially_shipped": return { text: "Zoho: Part-shipped", tone: "ok" };
      case "shipped": case "fulfilled": return { text: "Zoho: Shipped", tone: "done" };
      case "closed": return { text: "Zoho: Closed", tone: "done" };
      case "void": case "cancelled": return { text: "Zoho: Void", tone: "bad" };
      case "deleted": return { text: "Deleted in Zoho", tone: "bad" };
      case "blocked": case "error": return { text: "NOT in Zoho — error", tone: "bad" };
      default: return { text: `Zoho: ${status.replace(/_/g, " ")}`, tone: "ok" };
    }
  }
  switch (status) {
    case null: case undefined: case "": return { text: "Not in Zoho yet", tone: "wait" };
    case "pushing": return { text: "Sending to Zoho…", tone: "wait" };
    case "draft": return { text: "Zoho: Draft — awaiting accountant", tone: "wait" };
    case "sent": case "viewed": case "unpaid": return { text: "Zoho: Sent (approved)", tone: "ok" };
    case "open": return { text: doc === "bill" ? "Zoho: Open (approved)" : "Zoho: Sent (approved)", tone: "ok" };
    case "overdue": return { text: "Zoho: Overdue", tone: "bad" };
    case "partially_paid": return { text: "Zoho: Part-paid", tone: "ok" };
    case "paid": return { text: "Zoho: Paid", tone: "done" };
    case "closed": return { text: "Zoho: Closed", tone: "done" };
    case "void": return { text: "Zoho: Void", tone: "bad" };
    case "deleted": return { text: "Deleted in Zoho", tone: "bad" };
    case "blocked": case "error": return { text: "NOT in Zoho — error", tone: "bad" };
    default: return { text: `Zoho: ${status.replace(/_/g, " ")}`, tone: "ok" };
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
  if (error) return { ok: false, message: `NOT sent to the cloud or Zoho: ${netMsg(error)}` };
  const id = Number((data as { receipt_id?: number })?.receipt_id);
  if (!id) return { ok: false, message: "NOT sent to Zoho: the cloud did not return a receipt id" };
  return pushToZoho("bill", id);
}

// ── 0070: the customer's PO on acceptance ───────────────────────────────────
export type PoInput = { po_number: string; po_file?: string | null; po_file_name?: string | null };
export type AcceptPrecheck = { po_file_required: boolean; customer_id: number;
  credit: { customer: string; staff: string; limit_minor: number; outstanding_minor: number; order_minor: number } | null };

/** What accepting this quote needs (PO file or not) and the credit-limit warning. Read-only. */
export async function acceptPrecheck(orderId: number, onBehalf = false): Promise<AcceptPrecheck | null> {
  try {
    const { data, error } = await supabase.functions.invoke("accept-quote",
      { body: { order_id: orderId, check: true, ...(onBehalf ? { on_behalf_note: "precheck" } : {}) } });
    if (error || !data?.ok) return null;
    return data as AcceptPrecheck;
  } catch { return null; }
}

/** Upload the PO (PDF / photo) to po-docs/<customer>/<order>/…; returns the stored path. */
export async function uploadPo(customerId: number, orderId: number, file: File): Promise<string> {
  const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80) || "po";
  const path = `${customerId}/${orderId}/${Date.now()}-${safe}`;
  const { error } = await supabase.storage.from("po-docs").upload(path, file, { contentType: file.type || undefined, upsert: false });
  if (error) throw new Error(`The PO file did not upload: ${netMsg(error)}`);
  return path;
}

/** Staff: a 5-minute link to a stored PO file. */
export async function poFileUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from("po-docs").createSignedUrl(path, 300);
  if (error || !data?.signedUrl) throw new Error(`Could not open the PO: ${error?.message ?? "no link"}`);
  return data.signedUrl;
}

// ── 0072: price books (Zoho stays the source) ───────────────────────────────
/** Per order line: list + the customer's book rate; staff also get cost and the margin floor. */
export type LinePrice = { line_id: number; part_id: number; list_minor?: number; book_minor?: number; cost_minor?: number; floor_minor?: number;
  /** 0092: an accrual-rebate customer — the rebate this line EARNS (credited monthly), and (staff) its % in bps */
  rebate_minor?: number; rebate_bps?: number };
export type OrderPrices = { order_id: number; pricebook: string | null; rebate_mode?: "accrual" | null; lines: LinePrice[] };
export async function orderPrices(orderId: number): Promise<OrderPrices | null> {
  const { data, error } = await supabase.rpc("order_prices", { p_order_id: orderId });
  if (error) { console.error(error); return null; }
  return data as OrderPrices;
}
// ── 0092: rebates by accrual + credit note ──────────────────────────────────
/** Earned = every accrual; accruing = not on a statement yet; credited = on an open credit note;
 *  settled = used / paid out; outstanding = earned − settled. Minor units, excl. VAT. */
export type RebatePosition = { mode: "price_book" | "accrual"; rebate_from?: string | null; earned_minor?: number; accruing_minor?: number;
  this_month_minor?: number; on_statement_minor?: number; credited_minor?: number; settled_minor?: number; outstanding_minor?: number;
  last_creditnote?: string | null;
  statements?: { number: string; period_end: string; total_minor: number; status: string; creditnote: string | null; creditnote_status: string | null }[];
  settings?: { zoho_rebate_contact_name: string | null; settle: string } | null };
/** Staff: one customer's rebate position and statements. */
export async function rebateCustomer(customerId: number): Promise<RebatePosition | null> {
  const { data, error } = await supabase.rpc("rebate_customer", { p_customer_id: customerId });
  if (error) { console.error(error); return null; }
  return data as RebatePosition;
}
/** A logged-in customer: their own rebate figures (mode price_book = nothing to show). */
export async function myRebate(): Promise<RebatePosition | null> {
  const { data, error } = await supabase.rpc("my_rebate");
  if (error) { console.error(error); return null; }
  return data as RebatePosition;
}
/** A logged-in customer on a price book: list + their rebate price, keyed by part id. */
export async function myPrices(partIds: number[]): Promise<Record<string, { list_minor: number | null; book_minor: number }>> {
  if (!partIds.length) return {};
  const { data, error } = await supabase.rpc("my_prices", { p_part_ids: partIds });
  if (error) { console.error(error); return {}; }
  return (data ?? {}) as Record<string, { list_minor: number | null; book_minor: number }>;
}

// ── 0076: price books on the device ─────────────────────────────────────────
/** One part's rate in one Zoho price book, with the part's list price for the strikethrough. */
export type BookPrice = { pricebook_id: string; name: string | null; part_id: number; book_minor: number; list_minor: number | null };
/** A customer on a price book (staff only — a customer's device holds no customer rows). */
export type BookCustomer = { id: number; name: string; book: string };
/** Online read of the same rows the sync streams carry, for before the streams are deployed or
 *  while a first sync is still running. Staff: every book (RLS: staff only). A customer: only
 *  their own book, resolved from the login by my_price_book(). */
export async function remoteBookPrices(isClient: boolean): Promise<{ rows: BookPrice[]; customers: BookCustomer[] }> {
  if (isClient) {
    const { data, error } = await supabase.rpc("my_price_book");
    if (error) { console.error(error); return { rows: [], customers: [] }; }
    return { rows: (data ?? []) as BookPrice[], customers: [] };
  }
  const [items, books, custs] = await Promise.all([
    supabase.from("price_book_item").select("pricebook_id, part_id, rate_minor, list_minor").not("part_id", "is", null),
    supabase.from("price_book").select("pricebook_id, name"),
    supabase.from("customer").select("id, name, zoho_pricebook_id").not("zoho_pricebook_id", "is", null).is("deleted_at", null),
  ]);
  for (const r of [items, books, custs]) if (r.error) console.error(r.error);
  const names = new Map((books.data ?? []).map((b) => [String(b.pricebook_id), String(b.name)]));
  return {
    rows: (items.data ?? []).map((i) => ({ pricebook_id: String(i.pricebook_id), name: names.get(String(i.pricebook_id)) ?? null,
      part_id: Number(i.part_id), book_minor: Number(i.rate_minor), list_minor: i.list_minor == null ? null : Number(i.list_minor) })),
    customers: (custs.data ?? []).map((c) => ({ id: Number(c.id), name: String(c.name), book: String(c.zoho_pricebook_id) })),
  };
}
/** "Hermans Panel Beaters" → "Hermans rebate": the label staff see on a part when no customer is picked. */
export const bookLabel = (book: string, customers: BookCustomer[], name: string | null) => {
  const on = customers.filter((c) => c.book === book);
  return on.length === 1 ? `${on[0].name.split(/\s+/)[0]} rebate` : (name ?? "Price book");
};
