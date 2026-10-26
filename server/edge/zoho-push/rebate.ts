// CTP Core — customer rebates by accrual + credit note (0092, docs/14_REBATE_ACCRUAL_CREDIT_NOTE.md).
//
//   rebate_probe                      ADMIN: which Zoho calls this token can make (credit notes, journals, accounts)
//   rebate_setup   { customer_code, mode, rebate_from?, scheme?, settle? }   ADMIN: the customer's rebate mode
//   rebate_account { customer_code, apply? }   ADMIN: create / link the second Zoho contact "<name> – Rebate"
//   rebate_accrue  { customer_code?, force? }  read the accrual customers' invoices + credit notes since their
//                                     cutover, post the rebate per line (differences only), read statements back
//   rebate_statement { customer_code, period: "YYYY-MM", apply?, open? }   the month's statement; apply = the
//                                     DRAFT credit note on the rebate contact (open: admin, TEST customers only —
//                                     for real customers Michelle opens it in Zoho)
//   rebate_offset  { statement, apply? }   the offset journal (Dr Rebate Clearing / Cr AR on the main account),
//                                     DRAFT; without the journal scope it returns the entry for Michelle to type
//   rebate_void    { statement }       TEST customers only: void the statement's credit note (cleanup)
//
// Rules: nothing is emailed (no /email calls, contacts get no email address); every Zoho document CTP makes
// is a draft for Michelle; the credit note's lines are ACCOUNT lines, never items (an item line would put
// stock back); the price book on a contact is never touched here.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { zoho, Blocked, rands, taxIdFor, type Logger } from "../_shared/zoho.ts";

const isTestCustomer = (code: string) => /TEST/i.test(code);
const monthEnd = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) throw new Blocked(`period must be YYYY-MM, got "${ym}"`);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

// deno-lint-ignore no-explicit-any
async function customerByCode(db: SupabaseClient, code: string): Promise<any> {
  const { data: c } = await db.from("customer").select("id, code, name, zoho_contact_id").eq("code", code).is("deleted_at", null).maybeSingle();
  if (!c) throw new Blocked(`No customer ${code}`);
  return c;
}

export async function rebateProbe() {
  const out: Record<string, string> = {};
  const tries: [string, string][] = [["creditnotes", "/creditnotes"], ["journals", "/journals"], ["chartofaccounts", "/chartofaccounts"],
                                     ["contacts", "/contacts"], ["invoices", "/invoices"]];
  for (const [k, p] of tries) {
    try { await zoho("GET", p, { per_page: "1" }); out[k] = "ok"; }
    catch (e) { out[k] = e instanceof Error ? e.message : String(e); }
  }
  return out;
}

// deno-lint-ignore no-explicit-any
export async function rebateSetup(db: SupabaseClient, log: Logger, body: any) {
  const c = await customerByCode(db, String(body.customer_code ?? ""));
  let schemeId: number | null = null;
  if (body.scheme) {
    const { data: sc } = await db.from("rebate_scheme").select("id").eq("name", String(body.scheme)).maybeSingle();
    if (!sc) throw new Blocked(`No rebate scheme "${body.scheme}"`);
    schemeId = sc.id;
  }
  if (body.mode === "accrual" && !isTestCustomer(c.code) && body.confirm !== "Ian approved") {
    throw new Blocked(`${c.name} is a real customer: accrual mode needs Ian's go (send confirm: "Ian approved").`);
  }
  const { data, error } = await db.rpc("rebate_set_customer", { p_customer_id: c.id, p: {
    mode: body.mode ?? "price_book", rebate_from: body.rebate_from ?? null, scheme_id: schemeId, settle: body.settle ?? "offset", notes: body.notes ?? null } });
  if (error) throw new Blocked(error.message);
  await log({ doc_type: "contact", ctp_id: c.id, ctp_ref: `customer:${c.code}`, action: "rebate_setup", ok: true,
              message: `${c.name}: rebate mode ${data.mode} from ${data.rebate_from ?? "—"}${schemeId ? `, scheme ${body.scheme}` : ""}, settle ${data.settle}` });
  return data;
}

// ── the second Zoho account ──────────────────────────────────────────────────
// deno-lint-ignore no-explicit-any
export async function rebateAccount(db: SupabaseClient, log: Logger, body: any) {
  const c = await customerByCode(db, String(body.customer_code ?? ""));
  if (!c.zoho_contact_id) throw new Blocked(`${c.name} is not linked to a Zoho contact`);
  const main = (await zoho("GET", `/contacts/${c.zoho_contact_id}`)).contact;
  const name = `${main.contact_name} – Rebate`;
  // an existing contact with exactly that name is linked, never doubled
  // deno-lint-ignore no-explicit-any
  const found = (((await zoho("GET", "/contacts", { contact_name_contains: `${main.contact_name}`, per_page: "200" })).contacts ?? []) as any[])
    .find((x) => String(x.contact_name).trim() === name);
  const { data: cr } = await db.from("customer_rebate").select("*").eq("customer_id", c.id).maybeSingle();
  if (cr?.zoho_rebate_contact_id && (!found || String(found.contact_id) === cr.zoho_rebate_contact_id)) {
    return { linked: true, existing: true, contact_id: cr.zoho_rebate_contact_id, contact_name: cr.zoho_rebate_contact_name };
  }
  // deno-lint-ignore no-explicit-any
  const strip = (a: any) => a ? Object.fromEntries(Object.entries(a).filter(([k, v]) => !/_id$|^address_id$/.test(k) && v !== "" && v != null)) : undefined;
  const payload: Record<string, unknown> = {
    contact_name: name, company_name: main.company_name || main.contact_name, contact_type: "customer",
    customer_sub_type: main.customer_sub_type || "business",
    billing_address: strip(main.billing_address),
    payment_terms: main.payment_terms, payment_terms_label: main.payment_terms_label,
    notes: `Rebate account of ${main.contact_name} (Zoho contact ${c.zoho_contact_id}). Created by CTP Core: monthly rebate credit notes ` +
           `are raised here (docs/14). Invoices go to the main account. No email address on purpose.`,
  };
  for (const k of ["vat_reg_no", "tax_reg_no", "vat_treatment", "tax_treatment", "currency_id"]) if (main[k]) payload[k] = main[k];
  if (body.apply !== true) return { preview: true, would_create: !found, would_link: found ? String(found.contact_id) : null, payload };
  // deno-lint-ignore no-explicit-any
  let k: any = found;
  if (!k) k = (await zoho("POST", "/contacts", {}, payload)).contact;
  const id = String(k.contact_id);
  await db.from("customer_rebate").upsert({ customer_id: c.id, mode: cr?.mode ?? "price_book", rebate_from: cr?.rebate_from ?? null,
    settle: cr?.settle ?? "offset", zoho_rebate_contact_id: id, zoho_rebate_contact_name: name, updated_at: new Date().toISOString() });
  await log({ doc_type: "contact", ctp_id: c.id, ctp_ref: `customer:${c.code}`, action: found ? "found_existing" : "create", ok: true, zoho_id: id,
              message: `${c.name}: rebate account "${name}" ${found ? "linked" : "created"}` });
  return { linked: true, created: !found, contact_id: id, contact_name: name };
}

// ── accrual: read each accrual customer's documents since the cutover ───────
// deno-lint-ignore no-explicit-any
const lineTotals = (doc: any) => {
  // item_total is per line after line discount; an entity-level discount and tax-inclusive pricing are
  // spread back so the rebate is always on the line's share of the document excl. VAT
  // deno-lint-ignore no-explicit-any
  const lines = (doc.line_items ?? []) as any[];
  const sub = lines.reduce((t, l) => t + Number(l.item_total ?? 0), 0);
  const disc = Number(doc.discount_total ?? doc.discount_amount ?? 0);
  const entity = doc.discount_type === "entity_level" && disc > 0 && sub > 0 ? (sub - disc) / sub : 1;
  return lines.map((l) => {
    let t = Number(l.item_total ?? 0) * entity;
    if (doc.is_inclusive_tax) t = t / (1 + Number(l.tax_percentage ?? 0) / 100);
    return { line_id: String(l.line_item_id), item_id: l.item_id ? String(l.item_id) : null, sku: l.sku ?? null,
             qty: Number(l.quantity ?? 0), item_total: Math.round(t * 100) / 100,
             ...(l.invoice_id ? { invoice_id: String(l.invoice_id) } : {}), ...(l.invoice_item_id ? { invoice_item_id: String(l.invoice_item_id) } : {}) };
  });
};

// deno-lint-ignore no-explicit-any
async function listSince(path: string, key: string, contactId: string, from: string): Promise<any[]> {
  // deno-lint-ignore no-explicit-any
  const out: any[] = [];
  for (let page = 1; page <= 20; page++) {
    const b = await zoho("GET", path, { customer_id: contactId, date_start: from, per_page: "200", page: String(page) });
    out.push(...(b[key] ?? []));
    if (!b.page_context?.has_more_page) break;
  }
  return out;
}

// deno-lint-ignore no-explicit-any
export async function rebateAccrue(db: SupabaseClient, log: Logger, cfg: any, body: any) {
  if (!cfg?.rebate_accrual_enabled) return { skipped: "Rebate accrual is switched off (zoho_config.rebate_accrual_enabled)." };
  let q = db.from("customer_rebate").select("customer_id, rebate_from, customer:customer_id(id, code, name, zoho_contact_id)").eq("mode", "accrual");
  if (body.customer_code) {
    const c = await customerByCode(db, String(body.customer_code));
    q = q.eq("customer_id", c.id);
  }
  const { data: crs, error } = await q;
  if (error) throw new Error(error.message);
  // deno-lint-ignore no-explicit-any
  const results: any[] = [];
  for (const cr of crs ?? []) {
    // deno-lint-ignore no-explicit-any
    const c = cr.customer as any;
    if (!c?.zoho_contact_id || !cr.rebate_from) continue;
    const { data: seen } = await db.from("rebate_doc_seen").select("doc_type, zoho_doc_id, last_modified, status").eq("customer_id", c.id);
    const seenMap = new Map((seen ?? []).map((s) => [`${s.doc_type}:${s.zoho_doc_id}`, s]));
    // deno-lint-ignore no-explicit-any
    const docs: { type: "invoice" | "credit_note"; row: any }[] = [
      ...(await listSince("/invoices", "invoices", c.zoho_contact_id, cr.rebate_from)).map((row) => ({ type: "invoice" as const, row })),
      ...(await listSince("/creditnotes", "creditnotes", c.zoho_contact_id, cr.rebate_from)).map((row) => ({ type: "credit_note" as const, row })),
    ];
    const listed = new Set<string>();
    // deno-lint-ignore no-explicit-any
    const out: any = { customer: c.code, documents: docs.length, read: 0, posted: 0, rebate_minor: 0, flags: [] as string[] };
    for (const d of docs) {
      const id = String(d.type === "invoice" ? d.row.invoice_id : d.row.creditnote_id);
      listed.add(`${d.type}:${id}`);
      const prev = seenMap.get(`${d.type}:${id}`);
      if (!body.force && prev && prev.last_modified === String(d.row.last_modified_time ?? "") && prev.status === String(d.row.status)) continue;
      const full = d.type === "invoice" ? (await zoho("GET", `/invoices/${id}`)).invoice : (await zoho("GET", `/creditnotes/${id}`)).creditnote;
      const { data: r, error: e } = await db.rpc("rebate_accrue_doc", { p_customer_id: c.id, p: {
        type: d.type, id, number: d.type === "invoice" ? full.invoice_number : full.creditnote_number, date: full.date,
        status: full.status, last_modified: String(d.row.last_modified_time ?? full.last_modified_time ?? ""), lines: lineTotals(full) } });
      if (e) { out.flags.push(`${id}: ${e.message}`); continue; }
      out.read++; out.posted += r.posted; out.flags.push(...(r.flags ?? []));
      if (r.posted) {
        await log({ doc_type: d.type === "invoice" ? "invoice" : "creditnote", ctp_id: c.id, ctp_ref: r.number, action: "rebate_accrue", ok: true,
                    zoho_id: id, message: `${c.code} ${r.number} (${r.status}): rebate now R${(r.rebate_minor / 100).toFixed(2)} (${r.posted} entr${r.posted === 1 ? "y" : "ies"})` });
      }
    }
    // documents read before that Zoho no longer lists (deleted) → reverse to 0
    for (const s of seen ?? []) {
      if (listed.has(`${s.doc_type}:${s.zoho_doc_id}`) || s.status === "deleted") continue;
      let gone = false;
      try { await zoho("GET", `/${s.doc_type === "invoice" ? "invoices" : "creditnotes"}/${s.zoho_doc_id}`); }
      catch (e) { gone = /\(404|does not exist|not found/i.test(e instanceof Error ? e.message : String(e)); }
      if (!gone) continue;
      const { data: r } = await db.rpc("rebate_accrue_doc", { p_customer_id: c.id, p: { type: s.doc_type, id: s.zoho_doc_id, status: "deleted", lines: [] } });
      out.posted += r?.posted ?? 0;
    }
    const { data: pos } = await db.rpc("rebate_position_of", { p_customer_id: c.id });
    out.position = pos;
    results.push(out);
  }
  const statements = await statementReadback(db, log);
  return { customers: results, statements };
}

// ── statements → the credit note ─────────────────────────────────────────────
// deno-lint-ignore no-explicit-any
async function statementReadback(db: SupabaseClient, log: Logger): Promise<any[]> {
  const { data: sts } = await db.from("rebate_statement").select("id, number, status, zoho_creditnote_id, zoho_creditnote_status")
    .not("zoho_creditnote_id", "is", null).in("status", ["draft", "credited"]);
  // deno-lint-ignore no-explicit-any
  const out: any[] = [];
  for (const s of sts ?? []) {
    try {
      const cn = (await zoho("GET", `/creditnotes/${s.zoho_creditnote_id}`)).creditnote;
      const { data } = await db.rpc("rebate_statement_zoho", { p_statement_id: s.id, p: {
        creditnote_status: cn.status, creditnote_number: cn.creditnote_number, total: cn.total, balance: cn.balance } });
      if (data && data.from !== data.to) {
        await log({ doc_type: "creditnote", ctp_ref: s.number, action: "status", ok: true, zoho_id: s.zoho_creditnote_id,
                    message: `${s.number}: credit note ${cn.creditnote_number} ${cn.status} → statement ${data.to}` });
      }
      out.push({ statement: s.number, creditnote: cn.creditnote_number, status: cn.status, balance: cn.balance, ...data });
    } catch (e) {
      out.push({ statement: s.number, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

// deno-lint-ignore no-explicit-any
async function fallbackAccount(db: SupabaseClient, schemeId: number): Promise<{ id: string | null; why: string }> {
  const { data: sc } = await db.from("rebate_scheme").select("zoho_rebate_account_id, zoho_rebate_account_name").eq("id", schemeId).maybeSingle();
  if (sc?.zoho_rebate_account_id) return { id: sc.zoho_rebate_account_id, why: sc.zoho_rebate_account_name ?? "scheme rebate account" };
  const { data: mp } = await db.from("make_profile").select("code, zoho_sales_account_id").eq("rebate_scheme_id", schemeId).not("zoho_sales_account_id", "is", null).limit(1).maybeSingle();
  return { id: mp?.zoho_sales_account_id ?? null, why: mp ? `the ${mp.code} sales account (no "Sales Rebates" account set on the scheme yet)` : "none" };
}

// deno-lint-ignore no-explicit-any
export async function rebateStatement(db: SupabaseClient, log: Logger, cfg: any, who: any, body: any) {
  const c = await customerByCode(db, String(body.customer_code ?? ""));
  const periodEnd = monthEnd(String(body.period ?? ""));
  // a statement that already has its credit note is not rebuilt: apply / open then only link, open or read it back
  const { data: done } = await db.from("rebate_statement").select("*").eq("customer_id", c.id).eq("period_end", periodEnd).not("zoho_creditnote_id", "is", null).maybeSingle();
  // deno-lint-ignore no-explicit-any
  let built: any = done && body.apply === true ? done : null;
  if (!built) {
    if (cfg?.rebate_accrual_enabled) await rebateAccrue(db, log, cfg, { customer_code: c.code });
    const { data, error } = await db.rpc("rebate_statement_build", { p_customer_id: c.id, p_period_end: periodEnd, p_apply: body.apply === true });
    if (error) throw new Blocked(error.message);
    built = data;
  }
  if (body.apply !== true || built.skipped) return built;

  const { data: cr } = await db.from("customer_rebate").select("zoho_rebate_contact_id, zoho_rebate_contact_name").eq("customer_id", c.id).maybeSingle();
  if (!cr?.zoho_rebate_contact_id) throw new Blocked(`${c.name} has no rebate account in Zoho yet (rebate_account first). Statement ${built.number} is saved as a draft in CTP.`);
  const taxId = await taxIdFor(1500, cfg?.tax_id ?? null);
  const notes: string[] = [];
  // deno-lint-ignore no-explicit-any
  const lines: any[] = [];
  // deno-lint-ignore no-explicit-any
  for (const l of built.lines as any[]) {
    const acc = l.account_id ? { id: l.account_id, why: "" } : await fallbackAccount(db, l.scheme_id);
    if (!acc.id) throw new Blocked(`No Zoho account to book the "${l.scheme}" rebate to: set rebate_scheme.zoho_rebate_account_id ("Sales Rebates").`);
    if (acc.why && !notes.includes(acc.why)) notes.push(acc.why);
    lines.push({ account_id: acc.id, name: l.doc_type === "invoice" ? `Rebate on ${l.number}` : `Rebate reversed: credit note ${l.number}`,
                 description: `${l.scheme} rebate · ${l.doc_type === "invoice" ? "invoice" : "credit note"} ${l.number} of ${l.date} · statement ${built.number}`,
                 quantity: 1, rate: rands(l.amount_minor), ...(taxId ? { tax_id: taxId } : {}) });
  }
  // idempotent: a credit note already carrying this statement number is linked, never doubled
  let cn = built.zoho_creditnote_id ? (await zoho("GET", `/creditnotes/${built.zoho_creditnote_id}`)).creditnote : null;
  if (!cn) {
    // deno-lint-ignore no-explicit-any
    const hits = (((await zoho("GET", "/creditnotes", { customer_id: cr.zoho_rebate_contact_id, search_text: built.number })).creditnotes ?? []) as any[])
      .filter((x) => x.reference_number === built.number && x.status !== "void");
    if (hits.length) cn = (await zoho("GET", `/creditnotes/${hits[0].creditnote_id}`)).creditnote;
  }
  let created = false;
  if (!cn) {
    const today = new Date().toISOString().slice(0, 10);
    cn = (await zoho("POST", "/creditnotes", {}, {
      customer_id: cr.zoho_rebate_contact_id, date: periodEnd > today ? today : periodEnd, reference_number: built.number,
      is_inclusive_tax: false, is_draft: true, line_items: lines,   // DRAFT for Michelle (the API opens it otherwise)
      notes: `Rebate statement ${built.number} for ${c.name}, ${built.period_start} to ${built.period_end}: ${lines.length} document(s). Calculated by CTP Core from sent invoices at full price.`,
    })).creditnote;
    created = true;
    if (cn.status !== "draft") notes.push(`Zoho created it as ${cn.status}, not draft`);
  }
  if (body.open === true) {
    if (!isTestCustomer(c.code)) throw new Blocked("Opening a credit note is Michelle's step in Zoho for real customers.");
    if (who.actor && !who.admin) throw new Blocked("Admin only.");
    if (cn.status === "draft") { await zoho("POST", `/creditnotes/${cn.creditnote_id}/status/open`); }
    cn = (await zoho("GET", `/creditnotes/${cn.creditnote_id}`)).creditnote;
  }
  await db.rpc("rebate_statement_zoho", { p_statement_id: built.id, p: { creditnote_id: String(cn.creditnote_id), creditnote_number: cn.creditnote_number,
    creditnote_status: cn.status, total: cn.total, balance: cn.balance } });
  await log({ doc_type: "creditnote", ctp_id: c.id, ctp_ref: built.number, action: created ? "create" : "found_existing", ok: true, zoho_id: String(cn.creditnote_id),
              message: `${built.number}: credit note ${cn.creditnote_number} (${cn.status}) on "${cr.zoho_rebate_contact_name}", R${cn.total} incl VAT, ${lines.length} line(s)${notes.length ? ` — booked to ${notes.join("; ")}` : ""}` });
  return { statement: built.number, total_excl_minor: built.total_minor, creditnote_id: String(cn.creditnote_id), creditnote_number: cn.creditnote_number,
           creditnote_status: cn.status, creditnote_total: cn.total, created, lines: cn.line_items?.length, notes };
}

// ── offset: the rebate credit lands on the main account ─────────────────────
// deno-lint-ignore no-explicit-any
export async function rebateOffset(db: SupabaseClient, log: Logger, cfg: any, body: any) {
  const { data: st } = await db.from("rebate_statement").select("*, customer:customer_id(id, code, name, zoho_contact_id)").eq("number", String(body.statement ?? "")).maybeSingle();
  if (!st) throw new Blocked(`No statement ${body.statement}`);
  if (!st.zoho_creditnote_id) throw new Blocked(`${st.number} has no credit note yet`);
  const cn = (await zoho("GET", `/creditnotes/${st.zoho_creditnote_id}`)).creditnote;
  const amount = Number(cn.total);
  // deno-lint-ignore no-explicit-any
  const c = st.customer as any;
  const entry = {
    journal_date: new Date().toISOString().slice(0, 10), reference_number: st.number,
    notes: `Rebate ${st.number}: credit note ${cn.creditnote_number} on the rebate account, offset to ${c.name}'s main account. ` +
           `Pair: refund ${cn.creditnote_number} to Rebate Clearing (Michelle), then apply this credit to open invoices.`,
    line_items: [
      { account_id: cfg?.rebate_clearing_account_id ?? "<Rebate Clearing>", debit_or_credit: "debit", amount, description: `Rebate ${st.number} (${cn.creditnote_number})` },
      { account_id: "<Accounts Receivable>", customer_id: c.zoho_contact_id, debit_or_credit: "credit", amount, description: `Rebate ${st.number} credited to ${c.name}` },
    ],
  };
  const steps = [
    `1. Zoho → Credit Notes → ${cn.creditnote_number} ("${cn.customer_name}") → Refund: R${amount.toFixed(2)}, From account "Rebate Clearing", reference ${st.number}.`,
    `2. Zoho → Accountant → Manual Journals → New: date today, reference ${st.number}; Debit "Rebate Clearing" R${amount.toFixed(2)}; Credit "Accounts Receivable", contact "${c.name}", R${amount.toFixed(2)}. Publish.`,
    `3. Open ${c.name}'s open invoices → Apply Credits → the journal credit ${st.number}.`,
  ];
  if (body.apply !== true || !cfg?.rebate_clearing_account_id) {
    return { preview: true, statement: st.number, creditnote: cn.creditnote_number, amount_incl_vat: amount, entry, michelle_steps: steps,
             note: cfg?.rebate_clearing_account_id ? null : "The Rebate Clearing account id is not set (zoho_config.rebate_clearing_account_id) — the journal is drafted by hand from these steps." };
  }
  throw new Blocked("Drafting the journal through the API needs the ZohoBooks.accountants scope (see rebate_probe); use michelle_steps.");
}

// ── TEST cleanup ─────────────────────────────────────────────────────────────
// deno-lint-ignore no-explicit-any
export async function rebateVoid(db: SupabaseClient, log: Logger, body: any) {
  const { data: st } = await db.from("rebate_statement").select("*, customer:customer_id(code, name)").eq("number", String(body.statement ?? "")).maybeSingle();
  // deno-lint-ignore no-explicit-any
  if (!st || !isTestCustomer((st.customer as any).code)) throw new Blocked("Only a TEST customer's statement can be voided here; real ones are Michelle's in Zoho.");
  if (!st.zoho_creditnote_id) throw new Blocked(`${st.number} has no credit note`);
  await zoho("POST", `/creditnotes/${st.zoho_creditnote_id}/status/void`);
  const cn = (await zoho("GET", `/creditnotes/${st.zoho_creditnote_id}`)).creditnote;
  const { data } = await db.rpc("rebate_statement_zoho", { p_statement_id: st.id, p: { creditnote_status: cn.status, balance: cn.balance } });
  await log({ doc_type: "creditnote", ctp_ref: st.number, action: "void", ok: cn.status === "void", zoho_id: st.zoho_creditnote_id,
              message: `${st.number}: TEST credit note ${cn.creditnote_number} voided` });
  return { statement: st.number, creditnote: cn.creditnote_number, status: cn.status, ...data };
}
