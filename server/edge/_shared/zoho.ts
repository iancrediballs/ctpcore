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
export async function zohoInit(db: SupabaseClient) {
  const { data: tok } = await db.rpc("zoho_secret_get", { p_name: "zoho_refresh_token" });
  const { data: c } = await db.from("zoho_config").select("dc").eq("id", 1).maybeSingle();
  REFRESH = (tok as string | null) || env("ZOHO_REFRESH_TOKEN");
  token = null; contactCache = null; taxCache = null;
  DC = c?.dc || env("ZOHO_DC") || "com";
  const host = DC === "ca" ? "https://www.zohoapis.ca" : `https://www.zohoapis.${DC}`;
  BASE = API === "books" ? `${host}/books/v3` : `${host}/inventory/v1`;
}

export class Blocked extends Error {}   // a rule refused the document: not retried blindly

// ── Zoho HTTP ────────────────────────────────────────────────────────────────
let token: string | null = null;
async function zohoToken(): Promise<string> {
  if (token) return token;
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
  return (token = b.access_token as string);
}

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
export async function findByReference(kind: "invoices" | "bills" | "salesorders", ref: string) {
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
    return { salesorder_id: String(existing.salesorder_id), salesorder_number: String(existing.salesorder_number),
             status: String(existing.status ?? ""), created: false };
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
  const st = String(so.status ?? "");
  const warning = st && st !== "draft" ? `Zoho created sales order ${so.salesorder_number} as "${st}", not draft.` : undefined;
  await log({ doc_type: "salesorder", ctp_id: orderId, ctp_ref: o.number, action: "create", ok: !warning,
              zoho_id: String(so.salesorder_id), message: `${o.number} → Zoho sales order ${so.salesorder_number} (${st})${warning ? " — " + warning : ""}` });
  return { salesorder_id: String(so.salesorder_id), salesorder_number: String(so.salesorder_number), status: st, created: true, warning };
}

export async function deleteSalesOrder(id: string) { await zoho("DELETE", `/salesorders/${id}`); }

/** Invoice lines linked to the sales order they come from: each CTP line takes
 *  the first unused sales-order line with the same Zoho item, so Zoho records
 *  the invoice as converted from the order (no standalone duplicate). */
// deno-lint-ignore no-explicit-any
export async function linkToSalesOrder(soId: string, lines: any[]): Promise<{ lines: any[]; customer_id: string; status: string; linked: number } | null> {
  let so;
  try { so = (await zoho("GET", `/salesorders/${soId}`)).salesorder; }
  catch (e) {
    if (/\(404|does not exist|not found/i.test(e instanceof Error ? e.message : String(e))) return null;
    throw e;
  }
  // deno-lint-ignore no-explicit-any
  const pool = ((so.line_items ?? []) as any[]).map((x) => ({ id: String(x.line_item_id), item: String(x.item_id), used: false }));
  let linked = 0;
  const out = lines.map((l) => {
    const hit = pool.find((p) => !p.used && p.item === String(l.item_id));
    if (!hit) return l;
    hit.used = true; linked++;
    return { ...l, salesorder_item_id: hit.id };
  });
  return { lines: out, customer_id: String(so.customer_id), status: String(so.status ?? ""), linked };
}
