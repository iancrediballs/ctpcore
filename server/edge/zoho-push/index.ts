// CTP Core — write-back to Zoho: invoices to customers, bills from suppliers.
//
//   customer side  sales_order invoiced by invoice_order()  -> Zoho INVOICE
//   supplier side  goods_receipt posted (desktop, uploaded)  -> Zoho BILL
//
// Rules (see server/0047_zoho_writeback.sql for the full reasoning):
//   * Only documents at or after zoho_config.push_from, and only when
//     push_enabled. History is never pushed — Michelle imports it herself.
//   * Idempotent: Zoho id stored on the CTP record; before creating, Zoho is
//     searched for our reference (CTP-INV-<no> / CTP-GRN-<no>) so a create whose
//     id was lost is found, not repeated. A short claim (zoho_status='pushing')
//     stops two callers pushing the same document at once.
//   * Draft by default (invoice_as_draft / bill_as_draft).
//   * Contacts: stored zoho_contact_id, else email, else VAT no., else exact
//     name; created if none match. Lines by SKU via the cached zoho_item.item_id.
//     Any unknown SKU blocks the WHOLE document — nothing is half-pushed.
//   * Every attempt is logged (zoho_push_log) and the last error is written on
//     the document. Nothing fails silently.
//
// Calls (POST JSON):
//   { "action": "push" }                         every queued document
//   { "action": "push", "doc_type": "invoice", "ctp_id": 42 }   one document
//   { "action": "test" }   manager/admin: create a clearly marked TEST draft
//                          invoice + bill against TEST contacts, read them back,
//                          then delete all four; returns what was created.
//
// Secrets: same as zoho-sync (ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET,
// ZOHO_REFRESH_TOKEN, ZOHO_ORG_ID, ZOHO_DC, optional ZOHO_SYNC_TOKEN).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

const env = (k: string) => Deno.env.get(k) ?? "";
const DC = env("ZOHO_DC") || "com";
const ORG = env("ZOHO_ORG_ID");
const BASE = `https://www.zohoapis.${DC}/inventory/v1`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sync-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

class Blocked extends Error {}   // a rule refused the document: not retried blindly

// ── Zoho HTTP ────────────────────────────────────────────────────────────────
let token: string | null = null;
async function zohoToken(): Promise<string> {
  if (token) return token;
  const p = new URLSearchParams({
    refresh_token: env("ZOHO_REFRESH_TOKEN"), client_id: env("ZOHO_CLIENT_ID"),
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
async function zoho(method: string, path: string, query: Record<string, string> = {}, body?: unknown): Promise<any> {
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

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const vatOf = (c: Record<string, unknown>) =>
  norm(c.tax_reg_no ?? c.vat_reg_no ?? c.tax_id ?? c.gst_no ?? "").replace(/[^0-9a-z]/g, "");
const rands = (minor: number) => Math.round(minor) / 100;
const jhbDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-CA", { timeZone: "Africa/Johannesburg" }); // yyyy-mm-dd

// Find our own document again by its reference. The list filter is not
// documented for every field, so the result is ALWAYS re-checked exactly here:
// a filter Zoho ignores can widen the result, never produce a false match.
async function findByReference(kind: "invoices" | "bills", ref: string) {
  for (const q of [{ reference_number: ref }, { search_text: ref }]) {
    const b = await zoho("GET", `/${kind}`, { ...q, per_page: "200" });
    const rows = (b[kind] ?? []) as Record<string, unknown>[];
    const hit = rows.find((r) => String(r.reference_number ?? "") === ref);
    if (hit) return hit;
  }
  return null;
}

// ── contacts ─────────────────────────────────────────────────────────────────
type Party = { id: number; name: string; email: string | null; vat_no: string | null;
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

async function resolveContact(db: SupabaseClient, table: "customer" | "supplier", p: Party,
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
async function itemIds(db: SupabaseClient, partIds: number[]) {
  const { data, error } = await db.from("zoho_item").select("zoho_item_id, part_id, status").in("part_id", partIds);
  if (error) throw new Error(`zoho_item: ${error.message}`);
  const m = new Map<number, string>();
  for (const r of data ?? []) if (r.status !== "inactive") m.set(r.part_id, r.zoho_item_id);
  return m;
}

let taxCache: Record<string, unknown>[] | null = null;
async function taxIdFor(bps: number, configured: string | null): Promise<string | undefined> {
  if (bps <= 0) return undefined;
  if (configured) return configured;
  if (!taxCache) taxCache = ((await zoho("GET", "/settings/taxes")).taxes ?? []) as Record<string, unknown>[];
  const t = taxCache.find((x) => Math.round(Number(x.tax_percentage) * 100) === bps);
  if (!t) throw new Blocked(`No Zoho tax at ${(bps / 100).toFixed(2)}% — create it in Zoho or set the tax id in Settings → Zoho.`);
  return String(t.tax_id);
}

// ── logging ──────────────────────────────────────────────────────────────────
type LogRow = { doc_type: string; ctp_id?: number | null; ctp_ref?: string | null; action: string;
                ok: boolean; zoho_id?: string | null; message?: string | null };
type Logger = (r: LogRow) => Promise<void>;

// ── one invoice ──────────────────────────────────────────────────────────────
// deno-lint-ignore no-explicit-any
async function pushInvoice(db: SupabaseClient, cfg: any, id: number, log: Logger) {
  const { data: o, error } = await db.from("sales_order")
    .select("id, number, status, invoice_no, invoiced_at, tax_rate_bps, currency, notes, zoho_invoice_id, zoho_status, zoho_pushed_at, " +
            "customer:customer_id(id, code, name, email, vat_no, zoho_contact_id), " +
            "lines:sales_line(qty, unit_price_minor, deleted_at, part:part_id(id, sku, name))")
    .eq("id", id).single();
  if (error || !o) throw new Blocked(`Order ${id} not found`);
  const ref = `CTP-INV-${o.invoice_no}`;
  if (o.zoho_invoice_id) return { ref, zoho_id: o.zoho_invoice_id, already: true };
  if (o.status !== "invoiced" || !o.invoice_no) throw new Blocked(`${o.number} is not invoiced`);
  if (!cfg.push_from || new Date(o.invoiced_at) < new Date(cfg.push_from)) {
    throw new Blocked(`${o.number} was invoiced before the Zoho go-live date — history is never pushed`);
  }

  // claim: one pusher at a time (a stale claim older than 10 minutes is retaken)
  const stale = new Date(Date.now() - 10 * 60_000).toISOString();
  const { data: claimed } = await db.from("sales_order").update({ zoho_status: "pushing", zoho_pushed_at: new Date().toISOString() })
    .eq("id", id).is("zoho_invoice_id", null)
    .or(`zoho_status.is.null,zoho_status.neq.pushing,zoho_pushed_at.lt.\"${stale}\"`)
    .select("id");
  if (!claimed?.length) return { ref, busy: true };

  try {
    const existing = await findByReference("invoices", ref);
    let inv = existing;
    if (!existing) {
      const lines = (o.lines ?? []).filter((l: { deleted_at: string | null }) => !l.deleted_at);
      if (!lines.length) throw new Blocked(`${o.number} has no lines`);
      const ids = await itemIds(db, lines.map((l: { part: { id: number } }) => l.part.id));
      const missing = lines.filter((l: { part: { id: number } }) => !ids.get(l.part.id)).map((l: { part: { sku: string } }) => l.part.sku);
      if (missing.length) throw new Blocked(`Not linked to a Zoho item: ${missing.join(", ")} — run Settings → Zoho → Check Zoho`);
      const taxId = await taxIdFor(o.tax_rate_bps ?? 0, cfg.tax_id);
      const customerId = await resolveContact(db, "customer", o.customer, "customer", log);
      const body = {
        customer_id: customerId,
        ...(cfg.use_ctp_invoice_number ? { invoice_number: o.invoice_no } : {}),
        reference_number: ref,
        date: jhbDate(o.invoiced_at),
        is_inclusive_tax: false,
        line_items: lines.map((l: { qty: number; unit_price_minor: number; part: { id: number; sku: string; name: string } }) => ({
          item_id: ids.get(l.part.id), quantity: l.qty, rate: rands(l.unit_price_minor),
          description: l.part.sku, ...(taxId ? { tax_id: taxId } : {}),
        })),
        notes: `CTP Core order ${o.number}`,
      };
      const b = await zoho("POST", "/invoices", cfg.use_ctp_invoice_number ? { ignore_auto_number_generation: "true" } : {}, body);
      inv = b.invoice;
      if (!cfg.invoice_as_draft) await zoho("POST", `/invoices/${inv!.invoice_id}/status/sent`);
    }
    const status = existing ? String(existing.status ?? "") : (cfg.invoice_as_draft ? "draft" : "sent");
    const { error: e2 } = await db.from("sales_order").update({
      zoho_invoice_id: String(inv!.invoice_id), zoho_invoice_number: String(inv!.invoice_number ?? ""),
      zoho_status: status, zoho_pushed_at: new Date().toISOString(), zoho_error: null,
    }).eq("id", id);
    if (e2) throw new Error(`Zoho invoice ${inv!.invoice_id} CREATED but saving its id failed: ${e2.message}. The next push will find it by ${ref}.`);
    await log({ doc_type: "invoice", ctp_id: id, ctp_ref: o.invoice_no, action: existing ? "found_existing" : "create",
                ok: true, zoho_id: String(inv!.invoice_id), message: `${o.number} → Zoho invoice ${inv!.invoice_number} (${status})` });
    return { ref, zoho_id: String(inv!.invoice_id), number: inv!.invoice_number, status, already: !!existing };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.from("sales_order").update({ zoho_status: e instanceof Blocked ? "blocked" : "error", zoho_error: msg }).eq("id", id);
    throw e;
  }
}

// ── one bill ─────────────────────────────────────────────────────────────────
// deno-lint-ignore no-explicit-any
async function pushBill(db: SupabaseClient, cfg: any, id: number, log: Logger) {
  const { data: g, error } = await db.from("goods_receipt")
    .select("id, number, status, kind, received_at, posted_at, supplier_invoice_ref, invoice_currency, notes, zoho_bill_id, zoho_status, " +
            "supplier:supplier_id(id, code, name, email, vat_no, zoho_contact_id), " +
            "lines:goods_receipt_line(qty_received, unit_cost_minor, deleted_at, part:part_id(id, sku, name))")
    .eq("id", id).single();
  if (error || !g) throw new Blocked(`Receipt ${id} not found`);
  const ref = `CTP-GRN-${g.number}`;
  if (g.zoho_bill_id) return { ref, zoho_id: g.zoho_bill_id, already: true };
  if (g.status !== "posted" || g.kind !== "purchase" || !g.supplier) throw new Blocked(`${g.number} is not a posted supplier receipt`);
  if (!cfg.push_from || new Date(g.posted_at) < new Date(cfg.push_from)) {
    throw new Blocked(`${g.number} was received before the Zoho go-live date — history is never pushed`);
  }
  if ((g.invoice_currency ?? "ZAR") !== "ZAR") {
    throw new Blocked(`${g.number} is a ${g.invoice_currency} invoice — foreign-currency bills are entered in Zoho by hand for now`);
  }

  const stale = new Date(Date.now() - 10 * 60_000).toISOString();
  const { data: claimed } = await db.from("goods_receipt").update({ zoho_status: "pushing", zoho_pushed_at: new Date().toISOString() })
    .eq("id", id).is("zoho_bill_id", null)
    .or(`zoho_status.is.null,zoho_status.neq.pushing,zoho_pushed_at.lt.\"${stale}\"`)
    .select("id");
  if (!claimed?.length) return { ref, busy: true };

  try {
    const existing = await findByReference("bills", ref);
    let bill = existing;
    let warn = "";
    if (!existing) {
      const lines = (g.lines ?? []).filter((l: { deleted_at: string | null }) => !l.deleted_at);
      if (!lines.length) throw new Blocked(`${g.number} has no lines`);
      const ids = await itemIds(db, lines.map((l: { part: { id: number } }) => l.part.id));
      const missing = lines.filter((l: { part: { id: number } }) => !ids.get(l.part.id)).map((l: { part: { sku: string } }) => l.part.sku);
      if (missing.length) throw new Blocked(`Not linked to a Zoho item: ${missing.join(", ")}`);
      const vendorId = await resolveContact(db, "supplier", g.supplier, "vendor", log);
      const date = jhbDate(g.received_at);
      const b = await zoho("POST", "/bills", {}, {
        vendor_id: vendorId,
        bill_number: g.supplier_invoice_ref || g.number,
        reference_number: ref,
        date, due_date: date,
        line_items: lines.map((l: { qty_received: number; unit_cost_minor: number; part: { id: number; sku: string } }) => ({
          item_id: ids.get(l.part.id), quantity: l.qty_received, rate: rands(l.unit_cost_minor), description: l.part.sku,
        })),
        notes: `CTP Core goods receipt ${g.number}`,
      });
      bill = b.bill;
      const st = String(bill!.status ?? "");
      if (!cfg.bill_as_draft && st === "draft") await zoho("POST", `/bills/${bill!.bill_id}/status/open`);
      if (cfg.bill_as_draft && st && st !== "draft") {
        warn = ` — WARNING: Zoho created this bill as "${st}", not draft. Review it in Zoho.`;
      }
    }
    const status = String(bill!.status ?? (cfg.bill_as_draft ? "draft" : "open"));
    const { error: e2 } = await db.from("goods_receipt").update({
      zoho_bill_id: String(bill!.bill_id), zoho_bill_number: String(bill!.bill_number ?? ""),
      zoho_status: status, zoho_pushed_at: new Date().toISOString(), zoho_error: warn ? warn.slice(3) : null,
    }).eq("id", id);
    if (e2) throw new Error(`Zoho bill ${bill!.bill_id} CREATED but saving its id failed: ${e2.message}. The next push will find it by ${ref}.`);
    await log({ doc_type: "bill", ctp_id: id, ctp_ref: g.number, action: existing ? "found_existing" : "create",
                ok: !warn, zoho_id: String(bill!.bill_id), message: `${g.number} → Zoho bill ${bill!.bill_number} (${status})${warn}` });
    return { ref, zoho_id: String(bill!.bill_id), number: bill!.bill_number, status, already: !!existing, warning: warn || undefined };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.from("goods_receipt").update({ zoho_status: e instanceof Blocked ? "blocked" : "error", zoho_error: msg }).eq("id", id);
    throw e;
  }
}

// ── the clearly-marked live test ─────────────────────────────────────────────
// deno-lint-ignore no-explicit-any
async function liveTest(db: SupabaseClient, cfg: any, log: Logger) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
  const out: Record<string, unknown> = { stamp, created: [] as unknown[], deleted: [] as unknown[] };
  const { data: link } = await db.from("zoho_item").select("zoho_item_id, sku").eq("status", "active").not("part_id", "is", null).limit(1).single();
  if (!link) throw new Blocked("No linked Zoho item to test with — run Check Zoho first");
  const created: { kind: string; id: string; label: string }[] = [];
  const note = (k: string, id: string, label: string) => { created.push({ kind: k, id, label }); (out.created as unknown[]).push({ kind: k, id, label }); };
  try {
    const cust = (await zoho("POST", "/contacts", {}, { contact_name: `ZZ CTP CORE TEST ${stamp} - DELETE ME`, contact_type: "customer",
      notes: "Created by CTP Core write-back test. Deleted automatically." })).contact;
    note("contact", String(cust.contact_id), cust.contact_name);
    const vend = (await zoho("POST", "/contacts", {}, { contact_name: `ZZ CTP CORE TEST VENDOR ${stamp} - DELETE ME`, contact_type: "vendor",
      notes: "Created by CTP Core write-back test. Deleted automatically." })).contact;
    note("contact", String(vend.contact_id), vend.contact_name);
    const taxId = await taxIdFor(1500, cfg.tax_id).catch(() => undefined);
    const inv = (await zoho("POST", "/invoices", {}, { customer_id: cust.contact_id, reference_number: `CTP-TEST-${stamp}`,
      line_items: [{ item_id: link.zoho_item_id, quantity: 1, rate: 1, description: `TEST ${link.sku}`, ...(taxId ? { tax_id: taxId } : {}) }],
      notes: "CTP CORE TEST - DELETE ME" })).invoice;
    note("invoice", String(inv.invoice_id), `${inv.invoice_number} status=${inv.status}`);
    const today = jhbDate(new Date().toISOString());
    const bill = (await zoho("POST", "/bills", {}, { vendor_id: vend.contact_id, bill_number: `CTP-TEST-${stamp}`,
      reference_number: `CTP-TEST-${stamp}`, date: today, due_date: today,
      line_items: [{ item_id: link.zoho_item_id, quantity: 1, rate: 1, description: `TEST ${link.sku}` }],
      notes: "CTP CORE TEST - DELETE ME" })).bill;
    note("bill", String(bill.bill_id), `${bill.bill_number} status=${bill.status}`);
    out.invoice_default_status = inv.status;
    out.bill_default_status = bill.status;
    out.found_by_reference = !!(await findByReference("invoices", `CTP-TEST-${stamp}`));
  } finally {
    // delete in reverse: documents before the contacts they belong to
    for (const c of created.reverse()) {
      const path = c.kind === "contact" ? `/contacts/${c.id}` : c.kind === "invoice" ? `/invoices/${c.id}` : `/bills/${c.id}`;
      try { await zoho("DELETE", path); (out.deleted as unknown[]).push(c); }
      catch (e) {
        // a delete Zoho refuses: void the document instead, and say so loudly
        let fallback = "";
        if (c.kind !== "contact") {
          try { await zoho("POST", `${path}/status/void`); fallback = " — VOIDED instead"; } catch { /* reported below */ }
        }
        (out.deleted as unknown[]).push({ ...c, error: (e instanceof Error ? e.message : String(e)) + fallback });
      }
    }
    await log({ doc_type: "test", action: "test", ok: !(out.deleted as { error?: string }[]).some((d) => d.error),
                message: JSON.stringify(out).slice(0, 4000) });
  }
  return out;
}

// ── entry ────────────────────────────────────────────────────────────────────
async function authorise(req: Request, db: SupabaseClient) {
  const syncToken = env("ZOHO_SYNC_TOKEN");
  if (syncToken && req.headers.get("x-sync-token") === syncToken) return { ok: true, actor: null as string | null, manager: false };
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data } = jwt ? await db.auth.getUser(jwt) : { data: null };
  if (!data?.user) return { ok: false, actor: null, manager: false };
  const { data: me } = await db.from("app_user").select("role").eq("id", data.user.id).maybeSingle();
  const staff = ["sales", "warehouse", "manager", "admin"].includes(me?.role ?? "");
  return { ok: staff, actor: data.user.id, manager: me?.role === "manager" || me?.role === "admin" };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  const who = await authorise(req, db);
  if (!who.ok) return json({ error: "Staff only" }, who.actor ? 403 : 401);

  const log: Logger = async (r) => { await db.from("zoho_push_log").insert({ ...r, actor: who.actor }); };
  const body = await req.json().catch(() => ({}));
  const { data: cfg } = await db.from("zoho_config").select("*").eq("id", 1).maybeSingle();

  // Switched off is an answer, not an error — checked before the secrets so an
  // invoice issued before go-live does not report a failure that isn't one.
  if (body.action !== "test" && (!cfg?.push_enabled || !cfg?.push_from)) {
    return json({ ok: true, skipped: "Sending to Zoho is off (Settings → Zoho). Nothing was sent." });
  }
  const missing = ["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN", "ZOHO_ORG_ID"].filter((k) => !env(k));
  if (missing.length) return json({ ok: false, error: `Zoho is not connected yet. Missing secrets: ${missing.join(", ")}` }, 412);

  try {
    if (body.action === "test") {
      if (!who.manager && who.actor) return json({ error: "Only a manager or admin can run the Zoho test" }, 403);
      return json({ ok: true, test: await liveTest(db, cfg ?? {}, log) });
    }

    let jobs: { doc_type: string; ctp_id: number }[];
    if (body.doc_type && body.ctp_id) jobs = [{ doc_type: body.doc_type, ctp_id: Number(body.ctp_id) }];
    else {
      const { data, error } = await db.from("zoho_push_queue").select("doc_type, ctp_id").order("doc_at").limit(50);
      if (error) throw new Error(`queue: ${error.message}`);
      jobs = data ?? [];
    }

    const results: unknown[] = [];
    for (const j of jobs) {
      try {
        const r = j.doc_type === "invoice" ? await pushInvoice(db, cfg, j.ctp_id, log)
                : j.doc_type === "bill"    ? await pushBill(db, cfg, j.ctp_id, log)
                : (() => { throw new Blocked(`unknown doc_type ${j.doc_type}`); })();
        results.push({ ...j, ok: true, ...r });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await log({ doc_type: j.doc_type, ctp_id: j.ctp_id, action: e instanceof Blocked ? "blocked" : "error", ok: false, message: msg });
        results.push({ ...j, ok: false, error: msg });
      }
    }
    const failed = results.filter((r) => !(r as { ok: boolean }).ok).length;
    return json({ ok: failed === 0, pushed: results.length - failed, failed, results }, failed ? 207 : 200);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await log({ doc_type: body.action === "test" ? "test" : "invoice", action: "error", ok: false, message: msg });
    return json({ ok: false, error: msg }, 502);
  }
});
