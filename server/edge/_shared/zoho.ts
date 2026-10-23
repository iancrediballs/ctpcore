// CTP Core — the Zoho Books calls shared by zoho-push (invoices, bills, status,
// test) and accept-quote (sales orders). One token path: the refresh token in
// Supabase Vault (written by zoho-auth), the DC in zoho_config.dc.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export const env = (k: string) => Deno.env.get(k) ?? "";
export let DC = env("ZOHO_DC") || "com";
const ORG = env("ZOHO_ORG_ID");
const API = (env("ZOHO_API") || "inventory").toLowerCase();
let BASE = "";

// Refresh token from Vault (zoho-auth writes it), DC from zoho_config.dc;
// the env secrets remain only as a fallback. ZOHO_API picks Books or Inventory.
let REFRESH = "";
let DB: SupabaseClient | null = null;
export async function zohoInit(db: SupabaseClient) {
  DB = db;
  const { data: tok } = await db.rpc("zoho_secret_get", { p_name: "zoho_refresh_token" });
  const { data: c } = await db.from("zoho_config").select("dc").eq("id", 1).maybeSingle();
  REFRESH = (tok as string | null) || "";   // Vault only: the env / integration_secret tokens are retired
  contactCache = null; taxCache = null;   // the access token survives: it is cached until it expires
  DC = c?.dc || env("ZOHO_DC") || "com";
  const host = DC === "ca" ? "https://www.zohoapis.ca" : `https://www.zohoapis.${DC}`;
  BASE = API === "books" ? `${host}/books/v3` : `${host}/inventory/v1`;
}

export class Blocked extends Error {}   // a rule refused the document: not retried blindly

// ── Zoho HTTP ────────────────────────────────────────────────────────────────
// Access token cache (0055): this instance first, then Vault (shared by every
// function and cold start), and only then a refresh — Zoho allows ~10 new
// tokens per 10 minutes. Refreshed when under 5 minutes remain.
let token: { value: string; until: number } | null = null;
const MARGIN = 5 * 60_000;
export async function zohoToken(): Promise<string> {
  if (token && token.until - MARGIN > Date.now()) return token.value;
  if (DB) {
    const { data: cached } = await DB.rpc("zoho_secret_get", { p_name: "zoho_access_token" });
    const s = String(cached ?? ""), i = s.indexOf("|");
    const until = i > 0 ? Number(s.slice(0, i)) : 0;
    if (until - MARGIN > Date.now()) { token = { value: s.slice(i + 1), until }; return token.value; }
  }
  const p = new URLSearchParams({
    refresh_token: REFRESH, client_id: env("ZOHO_CLIENT_ID"),
    client_secret: env("ZOHO_CLIENT_SECRET"), grant_type: "refresh_token",
  });
  const accounts = DC === "ca" ? "https://accounts.zohocloud.ca" : `https://accounts.zoho.${DC}`;
  const r = await fetch(`${accounts}/oauth/v2/token`, { method: "POST", body: p });
  const b = await r.json().catch(() => ({}));
  if (!r.ok || !b.access_token) {
    throw new Error(`Zoho token refresh failed (${r.status}${b.error ? ", " + b.error : ""}). Check the Zoho secrets and ZOHO_DC.`);
  }
  const until = Date.now() + Number(b.expires_in ?? 3600) * 1000;
  token = { value: b.access_token as string, until };
  if (DB) await DB.rpc("zoho_secret_put", { p_name: "zoho_access_token", p_value: `${until}|${b.access_token}` });
  return token.value;
}

/** For callers that build their own requests (zoho-sync, zoho-auth). */
export function zohoBase() { return BASE; }

// deno-lint-ignore no-explicit-any
export async function zoho(method: string, path: string, query: Record<string, string> = {}, body?: unknown): Promise<any> {
  const u = new URL(BASE + path);
  u.searchParams.set("organization_id", ORG);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  const r = await fetch(u, {
    method,
    headers: { Authorization: `Zoho-oauthtoken ${await zohoToken()}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok || (b.code !== undefined && b.code !== 0)) {
    throw new Error(`Zoho ${method} ${path} failed (${r.status}, code ${b.code ?? "?"}): ${b.message ?? "no message"}`);
  }
  return b;
}

export const norm = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
export const vatOf = (c: Record<string, unknown>) =>
  norm(c.tax_reg_no ?? c.vat_reg_no ?? c.tax_id ?? c.gst_no ?? "").replace(/[^0-9a-z]/g, "");
export const rands = (minor: number) => Math.round(minor) / 100;
export const jhbDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-CA", { timeZone: "Africa/Johannesburg" }); // yyyy-mm-dd

// Find our own document again by its reference. The list filter is not
// documented for every field, so the result is ALWAYS re-checked exactly here:
// a filter Zoho ignores can widen the result, never produce a false match.
export async function findByReference(kind: "invoices" | "bills" | "salesorders" | "estimates", ref: string) {
  for (const q of [{ reference_number: ref }, { search_text: ref }]) {
    const b = await zoho("GET", `/${kind}`, { ...q, per_page: "200" });
    const rows = (b[kind] ?? []) as Record<string, unknown>[];
    const hit = rows.find((r) => String(r.reference_number ?? "") === ref);
    if (hit) return hit;
  }
  return null;
}

// ── contacts ─────────────────────────────────────────────────────────────────
export type Party = { id: number; name: string; email: string | null; vat_no: string | null;
               zoho_contact_id: string | null; code: string };
let contactCache: Record<string, unknown>[] | null = null;
async function allContacts() {
  if (contactCache) return contactCache;
  const out: Record<string, unknown>[] = [];
  for (let page = 1; page <= 25; page++) {
    const b = await zoho("GET", "/contacts", { page: String(page), per_page: "200" });
    out.push(...(b.contacts ?? []));
    if (!b.page_context?.has_more_page) break;
  }
  return (contactCache = out);
}

export async function resolveContact(db: SupabaseClient, table: "customer" | "supplier", p: Party,
                              type: "customer" | "vendor", log: Logger): Promise<string> {
  if (p.zoho_contact_id) return p.zoho_contact_id;
  const list = (await allContacts()).filter((c) => !c.contact_type || c.contact_type === type);
  const email = norm(p.email), vat = norm(p.vat_no).replace(/[^0-9a-z]/g, ""), name = norm(p.name);
  const hit =
    (email && list.find((c) => norm(c.email) === email)) ||
    (vat && list.find((c) => vatOf(c) === vat)) ||
    list.find((c) => norm(c.contact_name) === name || norm(c.company_name) === name);
  let id: string;
  let how: string;
  if (hit) {
    id = String(hit.contact_id);
    how = email && norm(hit.email) === email ? "email" : vat && vatOf(hit) === vat ? "VAT no." : "name";
  } else {
    const b = await zoho("POST", "/contacts", {}, {
      contact_name: p.name, company_name: p.name, contact_type: type,
      ...(p.email ? { contact_persons: [{ first_name: p.name, email: p.email, is_primary_contact: true }] } : {}),
      notes: `Created by CTP Core (${table} ${p.code})${p.vat_no ? ` · VAT no. ${p.vat_no}` : ""}`,
    });
    id = String(b.contact.contact_id);
    how = "created";
    contactCache?.push(b.contact);
  }
  const { error } = await db.from(table).update({ zoho_contact_id: id }).eq("id", p.id);
  if (error) throw new Error(`Saving Zoho contact id on ${table} ${p.code}: ${error.message}`);
  await log({ doc_type: "contact", ctp_id: p.id, ctp_ref: `${table}:${p.code}`, action: how === "created" ? "create" : "link",
              ok: true, zoho_id: id, message: `${p.name} → Zoho ${type} (${how})` });
  return id;
}

// ── items and tax ────────────────────────────────────────────────────────────
export async function itemIds(db: SupabaseClient, partIds: number[]) {
  const { data, error } = await db.from("zoho_item").select("zoho_item_id, part_id, status").in("part_id", partIds);
  if (error) throw new Error(`zoho_item: ${error.message}`);
  const m = new Map<number, string>();
  for (const r of data ?? []) if (r.status !== "inactive") m.set(r.part_id, r.zoho_item_id);
  return m;
}

let taxCache: Record<string, unknown>[] | null = null;
export async function taxIdFor(bps: number, configured: string | null): Promise<string | undefined> {
  if (bps <= 0) return undefined;
  if (configured) return configured;
  if (!taxCache) taxCache = ((await zoho("GET", "/settings/taxes")).taxes ?? []) as Record<string, unknown>[];
  // Several Zoho taxes share 15% ("Change in use …", accommodation, export).
  // Only the default / "Standard Rate" one is right for a normal sale or bill.
  const atRate = taxCache.filter((x) => Math.round(Number(x.tax_percentage) * 100) === bps);
  const t = atRate.find((x) => x.is_default_tax === true) ?? atRate.find((x) => /^standard/i.test(String(x.tax_name)))
         ?? (atRate.length === 1 ? atRate[0] : undefined);
  if (!t) throw new Blocked(`No Zoho tax at ${(bps / 100).toFixed(2)}% — create it in Zoho or set the tax id in Settings → Zoho.`);
  return String(t.tax_id);
}

// ── logging ──────────────────────────────────────────────────────────────────
export type LogRow = { doc_type: string; ctp_id?: number | null; ctp_ref?: string | null; action: string;
                ok: boolean; zoho_id?: string | null; message?: string | null };
export type Logger = (r: LogRow) => Promise<void>;

/** Zoho is usable: client secrets, org, and a refresh token. Call after zohoInit. */
export function zohoMissing(): string[] {
  const m = ["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_ORG_ID"].filter((k) => !env(k));
  if (!REFRESH) m.push("refresh token (run zoho-auth)");
  return m;
}

// ── sales orders (accept-quote) ──────────────────────────────────────────────
export type SalesOrderRef = { salesorder_id: string; salesorder_number: string; status: string; created: boolean; warning?: string };

/** Line discount for a rebated line, as Zoho wants it ("7.5%"). */
export const rebateDiscount = (pct: unknown) => {
  const n = Number(pct ?? 0);
  return n > 0 ? { discount: `${Math.round(n * 100) / 100}%` } : {};
};

/** The Zoho sales order for one CTP order. Idempotent: a sales order already
 *  carrying the CTP order number as its reference is reused, never doubled.
 *  Created as a DRAFT (Zoho's default for the API); a non-draft result is
 *  reported, not hidden. Lines by SKU through zoho_item; any unlinked SKU
 *  blocks the whole order. VAT is the Standard Rate tax. */
// deno-lint-ignore no-explicit-any
export async function salesOrderFor(db: SupabaseClient, cfg: any, orderId: number, log: Logger): Promise<SalesOrderRef> {
  const { data: o, error } = await db.from("sales_order")
    .select("id, number, tax_rate_bps, zoho_salesorder_id, zoho_salesorder_number, " +
            "customer:customer_id(id, code, name, email, vat_no, zoho_contact_id), " +
            "lines:sales_line(qty, unit_price_minor, rebate_pct, deleted_at, part:part_id(id, sku, name))")
    .eq("id", orderId).single();
  if (error || !o) throw new Blocked(`Order ${orderId} not found`);
  if (o.zoho_salesorder_id) {
    return { salesorder_id: o.zoho_salesorder_id, salesorder_number: o.zoho_salesorder_number ?? "", status: "existing", created: false };
  }
  const existing = await findByReference("salesorders", o.number);
  if (existing && !["void", "cancelled"].includes(String(existing.status))) {
    await log({ doc_type: "salesorder", ctp_id: orderId, ctp_ref: o.number, action: "found_existing", ok: true,
                zoho_id: String(existing.salesorder_id), message: `${o.number} → existing Zoho sales order ${existing.salesorder_number}` });
    let st = String(existing.status ?? "");
    if (st === "draft") {   // a retry found our own draft: confirm it now (21 Oct rule)
      try { await zoho("POST", `/salesorders/${existing.salesorder_id}/status/open`); st = "open"; } catch { /* stays draft; shown */ }
    }
    return { salesorder_id: String(existing.salesorder_id), salesorder_number: String(existing.salesorder_number),
             status: st, created: false };
  }
  // deno-lint-ignore no-explicit-any
  const lines = ((o.lines ?? []) as any[]).filter((l) => !l.deleted_at);
  if (!lines.length) throw new Blocked(`${o.number} has no lines`);
  const ids = await itemIds(db, lines.map((l) => l.part.id));
  const missing = lines.filter((l) => !ids.get(l.part.id)).map((l) => l.part.sku);
  if (missing.length) throw new Blocked(`Not linked to a Zoho item: ${missing.join(", ")}`);
  const taxId = await taxIdFor(o.tax_rate_bps ?? 0, cfg?.tax_id ?? null);
  // deno-lint-ignore no-explicit-any
  const customerId = await resolveContact(db, "customer", o.customer as any, "customer", log);
  const b = await zoho("POST", "/salesorders", {}, {
    customer_id: customerId, reference_number: o.number, date: jhbDate(new Date().toISOString()),
    is_inclusive_tax: false,
    line_items: lines.map((l) => ({
      item_id: ids.get(l.part.id), quantity: l.qty, rate: rands(l.unit_price_minor),
      description: l.part.sku, ...(taxId ? { tax_id: taxId } : {}), ...rebateDiscount(l.rebate_pct),
    })),
    notes: `Accepted in CTP Core · order ${o.number}`,
  });
  const so = b.salesorder;
  // Ian, 21 Oct: sales orders are CONFIRMED (open) so they commit stock in Zoho.
  // Invoices and bills stay draft for Michelle. Zoho creates the SO as draft;
  // marking it open is a second call — if it fails the SO stays draft and the
  // order says so (it is still a valid order; Michelle can confirm it in Zoho).
  let st = String(so.status ?? "");
  let warning: string | undefined;
  if (st === "draft") {
    try {
      await zoho("POST", `/salesorders/${so.salesorder_id}/status/open`);
      st = String((await zoho("GET", `/salesorders/${so.salesorder_id}`)).salesorder?.status ?? "open");
    } catch (e) {
      warning = `Sales order ${so.salesorder_number} could not be confirmed in Zoho and is still a draft: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  if (!warning && st !== "open") warning = `Zoho shows sales order ${so.salesorder_number} as "${st}", not confirmed.`;
  await log({ doc_type: "salesorder", ctp_id: orderId, ctp_ref: o.number, action: "create", ok: !warning,
              zoho_id: String(so.salesorder_id), message: `${o.number} → Zoho sales order ${so.salesorder_number} (${st})${warning ? " — " + warning : ""}` });
  return { salesorder_id: String(so.salesorder_id), salesorder_number: String(so.salesorder_number), status: st, created: true, warning };
}

export async function deleteSalesOrder(id: string) {
  try { await zoho("DELETE", `/salesorders/${id}`); }
  catch (e) {   // a confirmed SO Zoho will not delete is voided instead
    await zoho("POST", `/salesorders/${id}/status/void`).catch(() => { throw e; });
  }
}

/** Invoice lines linked to the sales order they come from: each CTP line takes
 *  the first unused sales-order line with the same Zoho item, so Zoho records
 *  the invoice as converted from the order (no standalone duplicate). */
// deno-lint-ignore no-explicit-any
export async function linkToSalesOrder(soId: string, lines: any[]): Promise<{ lines: any[]; customer_id: string; status: string; linked: number;
  invoices: { invoice_id: string; invoice_number: string; status: string }[] } | null> {
  let so;
  try { so = (await zoho("GET", `/salesorders/${soId}`)).salesorder; }
  catch (e) {
    if (/\(404|does not exist|not found/i.test(e instanceof Error ? e.message : String(e))) return null;
    throw e;
  }
  // 0059: the sales order's own rate, discount and tax win (Michelle may have
  // corrected them in Zoho); the quantity stays what CTP actually sent out.
  // deno-lint-ignore no-explicit-any
  const pool = ((so.line_items ?? []) as any[]).map((x) => ({ id: String(x.line_item_id), item: String(x.item_id), used: false,
    rate: x.rate, discount: x.discount, tax_id: x.tax_id }));
  let linked = 0;
  const out = lines.map((l) => {
    const hit = pool.find((p) => !p.used && p.item === String(l.item_id));
    if (!hit) return l;
    hit.used = true; linked++;
    const { discount: _d, ...rest } = l;
    const disc = hit.discount !== undefined && hit.discount !== null && String(hit.discount) !== "0" && String(hit.discount) !== "" ? { discount: hit.discount } : {};
    return { ...rest, salesorder_item_id: hit.id, ...(hit.rate !== undefined ? { rate: hit.rate } : {}),
             ...(hit.tax_id ? { tax_id: hit.tax_id } : {}), ...disc };
  });
  // 0059: invoices accounts already raised from this sales order in Zoho
  // deno-lint-ignore no-explicit-any
  const invoices = ((so.invoices ?? []) as any[]).filter((i) => !["void"].includes(String(i.status)))
    .map((i) => ({ invoice_id: String(i.invoice_id), invoice_number: String(i.invoice_number ?? ""), status: String(i.status ?? "") }));
  return { lines: out, customer_id: String(so.customer_id), status: String(so.status ?? ""), linked, invoices };
}

// ── estimates (Phase 2, 0062) ────────────────────────────────────────────────
// Quote = Zoho estimate. "Send quote" creates the DRAFT once; Zoho then leads its
// content (0063) and accounts SEND it from Zoho — the app never marks it sent.
// Accept (only once sent) = a CONFIRMED sales order raised from the ESTIMATE's
// lines, then the estimate marked accepted. Only when estimates_enabled is on.
export type EstimateRef = { estimate_id: string; estimate_number: string; status: string;
  action: "created" | "updated" | "unchanged" | "found"; warning?: string; last_modified_time?: string };

/** One quote's lines as Zoho line items. Unlinked SKUs and unpriced lines block. */
// deno-lint-ignore no-explicit-any
async function quoteDoc(db: SupabaseClient, cfg: any, orderId: number, log: Logger) {
  const { data, error } = await db.from("sales_order")
    .select("id, number, status, tax_rate_bps, zoho_estimate_id, zoho_estimate_number, zoho_estimate_status, " +
            "customer:customer_id(id, code, name, email, vat_no, zoho_contact_id), " +
            "lines:sales_line(qty, unit_price_minor, rebate_pct, deleted_at, part:part_id(id, sku, name))")
    .eq("id", orderId).single();
  if (error || !data) throw new Blocked(`Order ${orderId} not found`);
  // deno-lint-ignore no-explicit-any
  const o = data as any;
  // deno-lint-ignore no-explicit-any
  const lines = ((o.lines ?? []) as any[]).filter((l) => !l.deleted_at);
  if (!lines.length) throw new Blocked(`${o.number} has no lines`);
  const unpriced = lines.filter((l) => !(Number(l.unit_price_minor) > 0)).map((l) => l.part.sku);
  if (unpriced.length) throw new Blocked(`${o.number} is not fully priced: ${unpriced.join(", ")}`);
  const ids = await itemIds(db, lines.map((l) => l.part.id));
  const missing = lines.filter((l) => !ids.get(l.part.id)).map((l) => l.part.sku);
  if (missing.length) throw new Blocked(`Not linked to a Zoho item: ${missing.join(", ")}`);
  const taxId = await taxIdFor(o.tax_rate_bps ?? 0, cfg?.tax_id ?? null);
  // deno-lint-ignore no-explicit-any
  const customerId = await resolveContact(db, "customer", o.customer as any, "customer", log);
  const line_items = lines.map((l) => ({
    item_id: ids.get(l.part.id), quantity: l.qty, rate: rands(l.unit_price_minor),
    description: l.part.sku, ...(taxId ? { tax_id: taxId } : {}), ...rebateDiscount(l.rebate_pct),
  }));
  return { o, customerId, line_items };
}

const gone = (e: unknown) => /\(404|does not exist|not found/i.test(e instanceof Error ? e.message : String(e));

/** What the read-back hands apply_zoho_estimate (0063): Zoho's estimate as CTP stores it. */
// deno-lint-ignore no-explicit-any
export const estimatePayload = (e: any) => ({
  estimate_id: String(e.estimate_id), estimate_number: e.estimate_number, status: e.status,
  last_modified_time: e.last_modified_time ?? null, total: e.total, expiry_date: e.expiry_date || null,
  is_emailed: e.is_emailed ?? null,
  // deno-lint-ignore no-explicit-any
  line_items: (e.line_items ?? []).map((l: any) => ({ item_id: l.item_id, quantity: l.quantity, rate: l.rate,
    discount: l.discount, discount_amount: l.discount_amount, sku: l.sku, name: l.name })),
});

/** "Send quote": the quote's draft estimate, created ONCE as a proposal (Ian,
 *  23 Oct: Zoho leads the content). An estimate already linked or found by
 *  reference is never edited — it is only read back. A deleted one is not
 *  re-created. Returns the full Zoho estimate for the read-back. */
// deno-lint-ignore no-explicit-any
export async function estimateFor(db: SupabaseClient, cfg: any, orderId: number, log: Logger): Promise<EstimateRef & { estimate: any }> {
  const { data: cur } = await db.from("sales_order").select("number, status, zoho_estimate_id, zoho_estimate_number, zoho_estimate_status")
    .eq("id", orderId).single();
  if (!cur) throw new Blocked(`Order ${orderId} not found`);
  if (cur.zoho_estimate_status === "deleted") {
    throw new Blocked(`The Zoho estimate ${cur.zoho_estimate_number ?? ""} for ${cur.number} was deleted in Zoho — not re-created automatically.`);
  }
  if (cur.zoho_estimate_id) {
    try {
      const e = (await zoho("GET", `/estimates/${cur.zoho_estimate_id}`)).estimate;
      return { estimate_id: String(e.estimate_id), estimate_number: String(e.estimate_number), status: String(e.status ?? ""),
               action: "unchanged", last_modified_time: e.last_modified_time, estimate: e };
    } catch (e) {
      if (gone(e)) throw new Blocked(`Zoho estimate ${cur.zoho_estimate_number ?? ""} was deleted in Zoho.`);
      throw e;
    }
  }
  if (cur.status !== "quote") throw new Blocked(`${cur.number} is ${cur.status}, not a quote`);
  const hit = await findByReference("estimates", cur.number);
  if (hit && !["void", "declined", "expired"].includes(String(hit.status))) {
    const e = (await zoho("GET", `/estimates/${hit.estimate_id}`)).estimate;
    await log({ doc_type: "estimate", ctp_id: orderId, ctp_ref: cur.number, action: "found_existing", ok: true, zoho_id: String(e.estimate_id),
                message: `${cur.number} → existing Zoho estimate ${e.estimate_number} (${e.status})` });
    return { estimate_id: String(e.estimate_id), estimate_number: String(e.estimate_number), status: String(e.status ?? ""),
             action: "found", last_modified_time: e.last_modified_time, estimate: e };
  }
  const { o, customerId, line_items } = await quoteDoc(db, cfg, orderId, log);
  const e = (await zoho("POST", "/estimates", {}, { customer_id: customerId, reference_number: o.number, is_inclusive_tax: false,
    line_items, date: jhbDate(new Date().toISOString()), notes: `Quote from CTP Core · order ${o.number}` })).estimate;
  await log({ doc_type: "estimate", ctp_id: orderId, ctp_ref: o.number, action: "create", ok: true, zoho_id: String(e.estimate_id),
              message: `${o.number} → Zoho estimate ${e.estimate_number} (${e.status}) — draft for accounts to check and send` });
  return { estimate_id: String(e.estimate_id), estimate_number: String(e.estimate_number), status: String(e.status ?? "draft"),
           action: "created", last_modified_time: e.last_modified_time, estimate: e };
}

/** Customer (or admin on their behalf) accepted. The estimate must already be
 *  SENT by accounts (or accepted in Zoho); the app never marks it sent. Zoho
 *  converts only ACCEPTED estimates (live test 23 Oct: "Only accepted quotes can
 *  be converted to sales orders"), so the customer's acceptance is recorded on
 *  the estimate first, then the confirmed sales order is raised from the
 *  ESTIMATE's own lines with estimate_id — prices exactly as accounts sent them.
 *  If CTP's transaction then fails the SO is deleted and the estimate stays
 *  accepted; a retry is allowed on an accepted estimate. Idempotent on the RQ no. */
// deno-lint-ignore no-explicit-any
export async function salesOrderFromEstimate(db: SupabaseClient, orderId: number, estimateId: string, log: Logger):
    Promise<SalesOrderRef & { estimate_status: string; estimate_number: string }> {
  const { data: o } = await db.from("sales_order").select("id, number, zoho_salesorder_id, zoho_salesorder_number").eq("id", orderId).single();
  if (!o) throw new Blocked(`Order ${orderId} not found`);
  let est;
  try { est = (await zoho("GET", `/estimates/${estimateId}`)).estimate; }
  catch (e) { if (gone(e)) throw new Blocked("The Zoho estimate for this quote was deleted in Zoho — ask accounts."); throw e; }
  const estimate_number = String(est.estimate_number ?? "");
  let estimate_status = String(est.status ?? "");
  if (estimate_status === "draft") throw new Blocked(`Waiting for accounts to send estimate ${estimate_number} from Zoho.`);
  if (!["sent", "accepted"].includes(estimate_status)) {
    throw new Blocked(`Zoho estimate ${estimate_number} is ${estimate_status} — it cannot be accepted.`);
  }
  if (estimate_status === "sent") {
    await zoho("POST", `/estimates/${estimateId}/status/accepted`);
    estimate_status = "accepted";
    await log({ doc_type: "estimate", ctp_id: orderId, ctp_ref: o.number, action: "update", ok: true, zoho_id: estimateId,
                message: `${o.number}: customer accepted Zoho estimate ${estimate_number} (sent → accepted)` });
  }
  const existing = o.zoho_salesorder_id ? null : await findByReference("salesorders", o.number);
  if (o.zoho_salesorder_id || (existing && !["void", "cancelled"].includes(String(existing.status)))) {
    const id = String(o.zoho_salesorder_id ?? existing!.salesorder_id);
    let st = existing ? String(existing.status ?? "") : "existing";
    if (st === "draft") { try { await zoho("POST", `/salesorders/${id}/status/open`); st = "open"; } catch { /* stays draft; shown */ } }
    return { salesorder_id: id, salesorder_number: String(o.zoho_salesorder_number ?? existing!.salesorder_number ?? ""), status: st,
             created: false, estimate_status, estimate_number };
  }
  // deno-lint-ignore no-explicit-any
  const line_items = ((est.line_items ?? []) as any[]).map((l) => ({
    item_id: l.item_id, quantity: l.quantity, rate: l.rate, description: l.description ?? l.sku,
    ...(l.tax_id ? { tax_id: l.tax_id } : {}),
    ...(l.discount !== undefined && l.discount !== null && String(l.discount) !== "0" && String(l.discount) !== "" ? { discount: l.discount } : {}),
  }));
  const body = { customer_id: est.customer_id, reference_number: o.number, date: jhbDate(new Date().toISOString()),
    is_inclusive_tax: !!est.is_inclusive_tax, line_items, ...(est.discount ? { discount: est.discount, is_discount_before_tax: est.is_discount_before_tax } : {}),
    notes: `Accepted in CTP Core · order ${o.number} · from estimate ${estimate_number}` };
  // deno-lint-ignore no-explicit-any
  let so: any;
  let linked = true;
  try { so = (await zoho("POST", "/salesorders", {}, { ...body, estimate_id: estimateId })).salesorder; }
  catch (e) {
    if (!/estimate|quote/i.test(e instanceof Error ? e.message : String(e))) throw e;
    linked = false;
    so = (await zoho("POST", "/salesorders", {}, body)).salesorder;
  }
  let st = String(so.status ?? "");
  let warning: string | undefined;
  if (st === "draft") {
    try {
      await zoho("POST", `/salesorders/${so.salesorder_id}/status/open`);
      st = String((await zoho("GET", `/salesorders/${so.salesorder_id}`)).salesorder?.status ?? "open");
    } catch (e) {
      warning = `Sales order ${so.salesorder_number} could not be confirmed in Zoho and is still a draft: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  if (!warning && st !== "open") warning = `Zoho shows sales order ${so.salesorder_number} as "${st}", not confirmed.`;
  await log({ doc_type: "salesorder", ctp_id: orderId, ctp_ref: o.number, action: "create", ok: !warning, zoho_id: String(so.salesorder_id),
              message: `${o.number} → Zoho sales order ${so.salesorder_number} (${st}) from estimate ${estimate_number}` +
                       `${linked ? "" : " (not linked: Zoho refused estimate_id)"}${warning ? " — " + warning : ""}` });
  return { salesorder_id: String(so.salesorder_id), salesorder_number: String(so.salesorder_number), status: st, created: true, warning,
           estimate_status, estimate_number };
}

/** Safety net after the CTP commit: an estimate still at "sent" → accepted.
 *  (salesOrderFromEstimate normally accepted it already; never marks anything sent.) */
export async function markEstimateAccepted(estimateId: string): Promise<string> {
  const now = String((await zoho("GET", `/estimates/${estimateId}`)).estimate?.status ?? "");
  if (now !== "sent") return now;
  await zoho("POST", `/estimates/${estimateId}/status/accepted`);
  return "accepted";
}
