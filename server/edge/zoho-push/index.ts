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
//   * ALWAYS DRAFT — Michelle's standing rule. Only an explicit false in
//     zoho_config (admin-only, set_zoho_draft_policy) skips it; a missing or
//     unreadable config means draft.
//   * Contacts: stored zoho_contact_id, else email, else VAT no., else exact
//     name; created if none match. Lines by SKU via the cached zoho_item.item_id.
//     Any unknown SKU blocks the WHOLE document — nothing is half-pushed.
//   * Every attempt is logged (zoho_push_log) and the last error is written on
//     the document. Nothing fails silently.
//
// Calls (POST JSON):
//   { "action": "push" }                         every queued document
//   { "action": "push", "doc_type": "invoice", "ctp_id": 42 }   one document
//   { "action": "status", "force"?: true }      read Zoho status back (draft/sent/paid/void);
//                          sales orders also bring Michelle's edits back (0059)
//   { "action": "so_sync", "order_id": 43 }     one order's sales order + its customer's terms, now
//   { "action": "test" }   manager/admin: create a clearly marked TEST draft
//                          invoice + bill against TEST contacts, read them back,
//                          then delete all four; returns what was created.
//
// Secrets: same as zoho-sync (ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET,
// ZOHO_ORG_ID, ZOHO_API, optional ZOHO_SYNC_TOKEN); refresh token in Vault, DC in
// zoho_config.dc — both written by zoho-auth.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

import { env, zohoInit, zohoMissing, Blocked, zoho, rands, jhbDate, findByReference, resolveContact, itemIds, taxIdFor,
         rebateDiscount, linkToSalesOrder, salesOrderFor, deleteSalesOrder, type Logger } from "../_shared/zoho.ts";


const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sync-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });


// ── one invoice ──────────────────────────────────────────────────────────────
// deno-lint-ignore no-explicit-any
async function pushInvoice(db: SupabaseClient, cfg: any, id: number, log: Logger) {
  const { data: o, error } = await db.from("sales_order")
    .select("id, number, status, invoice_no, invoiced_at, tax_rate_bps, currency, notes, zoho_invoice_id, zoho_status, zoho_pushed_at, zoho_salesorder_id, " +
            "customer:customer_id(id, code, name, email, vat_no, zoho_contact_id), " +
            "lines:sales_line(qty, unit_price_minor, rebate_pct, deleted_at, part:part_id(id, sku, name))")
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
    let soNote = "";
    if (!existing) {
      const lines = (o.lines ?? []).filter((l: { deleted_at: string | null }) => !l.deleted_at);
      if (!lines.length) throw new Blocked(`${o.number} has no lines`);
      const ids = await itemIds(db, lines.map((l: { part: { id: number } }) => l.part.id));
      const missing = lines.filter((l: { part: { id: number } }) => !ids.get(l.part.id)).map((l: { part: { sku: string } }) => l.part.sku);
      if (missing.length) throw new Blocked(`Not linked to a Zoho item: ${missing.join(", ")} — run Settings → Zoho → Check Zoho`);
      const taxId = await taxIdFor(o.tax_rate_bps ?? 0, cfg.tax_id);
      let lineItems = lines.map((l: { qty: number; unit_price_minor: number; rebate_pct: number | null; part: { id: number; sku: string; name: string } }) => ({
        item_id: ids.get(l.part.id), quantity: l.qty, rate: rands(l.unit_price_minor),
        description: l.part.sku, ...(taxId ? { tax_id: taxId } : {}), ...rebateDiscount(l.rebate_pct),
      }));
      // Accepted with a Zoho sales order: the invoice is converted FROM it
      // (lines carry salesorder_item_id), for the sales order's own contact.
      let customerId: string;
      const so = o.zoho_salesorder_id ? await linkToSalesOrder(o.zoho_salesorder_id, lineItems) : null;
      // 0061: an order with a Zoho sales order is invoiced BY ACCOUNTS in Zoho
      // (Michelle converts the SO). CTP adopts that invoice and never creates one.
      if (o.zoho_salesorder_id && !(so && so.invoices.length)) {
        throw new Blocked(`${o.number}: accounts raise the invoice for ${o.zoho_salesorder_id ? "its sales order" : "it"} in Zoho — none yet, so nothing was created. CTP links it once it exists.`);
      }
      if (so && so.invoices.length) {
        const mine = so.invoices[0];
        const { error: e3 } = await db.from("sales_order").update({
          zoho_invoice_id: mine.invoice_id, zoho_invoice_number: mine.invoice_number, zoho_status: mine.status,
          zoho_pushed_at: new Date().toISOString(), zoho_status_at: new Date().toISOString(), zoho_error: null,
        }).eq("id", id);
        if (e3) throw new Error(`Zoho invoice ${mine.invoice_number} exists for ${o.number} but saving its id failed: ${e3.message}`);
        await log({ doc_type: "invoice", ctp_id: id, ctp_ref: o.invoice_no, action: "found_existing", ok: true, zoho_id: mine.invoice_id,
                    message: `${o.number} → Zoho invoice ${mine.invoice_number} (${mine.status}), already raised by accounts from the sales order — not created again` +
                             (so.invoices.length > 1 ? ` (the SO has ${so.invoices.length} invoices: ${so.invoices.map((i) => i.invoice_number).join(", ")})` : "") });
        return { ref, zoho_id: mine.invoice_id, number: mine.invoice_number, status: mine.status, already: true, adopted: true };
      }
      if (so) {
        lineItems = so.lines; customerId = so.customer_id;
        soNote = ` from sales order (${so.linked}/${lineItems.length} lines linked)`;
      } else {
        if (o.zoho_salesorder_id) {
          await log({ doc_type: "salesorder", ctp_id: id, ctp_ref: o.number, action: "missing", ok: false, zoho_id: o.zoho_salesorder_id,
                      message: `${o.number}: its Zoho sales order is gone (deleted in Zoho) — invoicing without it` });
          soNote = " — sales order deleted in Zoho, invoiced without it";
        }
        customerId = await resolveContact(db, "customer", o.customer, "customer", log);
      }
      const body = {
        customer_id: customerId,
        ...(cfg.use_ctp_invoice_number ? { invoice_number: o.invoice_no } : {}),
        reference_number: ref,
        date: jhbDate(o.invoiced_at),
        is_inclusive_tax: false,
        line_items: lineItems,
        notes: `CTP Core order ${o.number}`,
      };
      const q = cfg.use_ctp_invoice_number ? { ignore_auto_number_generation: "true" } : {};
      let b;
      try { b = await zoho("POST", "/invoices", q, body); }
      catch (e) {
        // Zoho may refuse to invoice a DRAFT sales order. Then — and only then —
        // the order is confirmed (open) in Zoho: it is being invoiced now.
        if (!so || so.status !== "draft" || !/sales ?order|draft|status/i.test(e instanceof Error ? e.message : "")) throw e;
        await zoho("POST", `/salesorders/${o.zoho_salesorder_id}/status/open`);
        await log({ doc_type: "salesorder", ctp_id: id, ctp_ref: o.number, action: "update", ok: true, zoho_id: o.zoho_salesorder_id,
                    message: `${o.number}: Zoho would not invoice a draft sales order, so it was marked open to invoice it` });
        b = await zoho("POST", "/invoices", q, body);
      }
      inv = b.invoice;
      if (cfg.invoice_as_draft === false) await zoho("POST", `/invoices/${inv!.invoice_id}/status/sent`);
    }
    const status = existing ? String(existing.status ?? "") : (cfg.invoice_as_draft === false ? "sent" : "draft");
    const { error: e2 } = await db.from("sales_order").update({
      zoho_invoice_id: String(inv!.invoice_id), zoho_invoice_number: String(inv!.invoice_number ?? ""),
      zoho_status: status, zoho_pushed_at: new Date().toISOString(), zoho_status_at: new Date().toISOString(), zoho_error: null,
    }).eq("id", id);
    if (e2) throw new Error(`Zoho invoice ${inv!.invoice_id} CREATED but saving its id failed: ${e2.message}. The next push will find it by ${ref}.`);
    await log({ doc_type: "invoice", ctp_id: id, ctp_ref: o.invoice_no, action: existing ? "found_existing" : "create",
                ok: true, zoho_id: String(inv!.invoice_id), message: `${o.number} → Zoho invoice ${inv!.invoice_number} (${status})${soNote}` });
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
      if (cfg.bill_as_draft === false && st === "draft") await zoho("POST", `/bills/${bill!.bill_id}/status/open`);
      if (cfg.bill_as_draft !== false && st && st !== "draft") {
        warn = ` — WARNING: Zoho created this bill as "${st}", not draft. Review it in Zoho.`;
      }
    }
    const status = String(bill!.status ?? (cfg.bill_as_draft === false ? "open" : "draft"));
    const { error: e2 } = await db.from("goods_receipt").update({
      zoho_bill_id: String(bill!.bill_id), zoho_bill_number: String(bill!.bill_number ?? ""),
      zoho_status: status, zoho_pushed_at: new Date().toISOString(), zoho_status_at: new Date().toISOString(), zoho_error: warn ? warn.slice(3) : null,
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

// ── status read-back: Draft → Sent → Paid / Void, as Michelle moves it ──────
// Reads each pushed document that is not yet final straight from Zoho by id
// (no reliance on list filters) and writes Zoho's own status word onto the CTP
// record. A document Michelle deleted in Zoho is marked 'deleted' — its Zoho
// id is KEPT, so it is never silently re-created; re-sending is a deliberate act.
const FINAL = ["paid", "void", "deleted", "invoiced", "closed"];
async function refreshStatus(db: SupabaseClient, log: Logger, force: boolean) {
  const { data: cfg } = await db.from("zoho_config").select("status_synced_at").eq("id", 1).maybeSingle();
  const last = cfg?.status_synced_at ? new Date(cfg.status_synced_at).getTime() : 0;
  if (!force && Date.now() - last < 2 * 60_000) return { skipped: "refreshed less than 2 minutes ago", changed: 0 };
  await db.from("zoho_config").update({ status_synced_at: new Date().toISOString() }).eq("id", 1);

  const kinds = [
    { table: "sales_order", idCol: "zoho_invoice_id", numCol: "zoho_invoice_number", ref: "invoice_no",
      path: "invoices", key: "invoice", numKey: "invoice_number", doc: "invoice",
      stCol: "zoho_status", atCol: "zoho_status_at", errCol: "zoho_error" },
    { table: "sales_order", idCol: "zoho_salesorder_id", numCol: "zoho_salesorder_number", ref: "number",
      path: "salesorders", key: "salesorder", numKey: "salesorder_number", doc: "salesorder",
      stCol: "zoho_so_status", atCol: "zoho_so_status_at", errCol: "zoho_so_error" },
    { table: "goods_receipt", idCol: "zoho_bill_id", numCol: "zoho_bill_number", ref: "number",
      path: "bills", key: "bill", numKey: "bill_number", doc: "bill",
      stCol: "zoho_status", atCol: "zoho_status_at", errCol: "zoho_error" },
  ] as const;
  const changes: { doc: string; ref: string; from: string | null; to: string }[] = [];
  let checked = 0;
  for (const k of kinds) {
    const extra = k.table === "sales_order" ? ", number, zoho_salesorder_id, zoho_invoice_id, deleted_at" : "";
    const { data: rows, error } = await db.from(k.table)
      .select(`id, ${k.ref}, ${k.idCol}, ${k.numCol}, ${k.stCol}${extra}`)
      .not(k.idCol, "is", null).limit(200);
    if (error) throw new Error(`${k.table}: ${error.message}`);
    // deno-lint-ignore no-explicit-any
    for (const r of (rows ?? []) as any[]) {
      const was: string | null = r[k.stCol];
      // 0061: an invoiced SO is still read until accounts' invoice is linked onto the order
      if (FINAL.includes(was ?? "") && !(k.doc === "salesorder" && !r.zoho_invoice_id && !r.deleted_at && was === "invoiced")) continue;
      checked++;
      let status: string, number: string | null = r[k.numCol];
      try {
        const b = await zoho("GET", `/${k.path}/${r[k.idCol]}`);
        status = String(b[k.key]?.status ?? "unknown");
        number = b[k.key]?.[k.numKey] ?? number;
        // 0059: the same read carries Michelle's edits — apply them (Zoho wins)
        if (k.doc === "salesorder" && !r.deleted_at) await applySalesOrder(db, r.id, r.number, b.salesorder, log);
        // 0061: accounts' invoice for an SO-backed order — status, balance, payments
        if (k.doc === "invoice" && r.zoho_salesorder_id && !r.deleted_at) await linkInvoices(db, r.id, r.number, [b.invoice], log);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Zoho answers a missing record with HTTP 404 or a "does not exist" code.
        if (/\(404|does not exist|not found/i.test(msg)) status = "deleted";
        else { await log({ doc_type: k.doc, ctp_id: r.id, ctp_ref: r[k.ref], action: "status_error", ok: false, message: msg }); continue; }
      }
      const patch: Record<string, unknown> = { [k.atCol]: new Date().toISOString() };
      if (status !== was) {
        patch[k.stCol] = status;
        patch[k.errCol] = status === "deleted"
          ? "This document was DELETED in Zoho. It will not be re-sent automatically — ask the accountant."
          : null;
        changes.push({ doc: k.doc, ref: r[k.ref], from: was, to: status });
        await log({ doc_type: k.doc, ctp_id: r.id, ctp_ref: r[k.ref], action: "status", ok: status !== "deleted",
                    zoho_id: r[k.idCol], message: `Zoho status ${was ?? "?"} → ${status}` });
      }
      if (number && number !== r[k.numCol]) patch[k.numCol] = number;
      await db.from(k.table).update(patch).eq("id", r.id);
    }
  }
  const terms = await refreshTerms(db, log, force ? 10 * 60_000 : 6 * 3600_000);
  return { checked, changed: changes.length, changes, terms };
}

// ── 0059/0061: read-back of one sales order (Michelle's edits, her invoice) ──
// Before accounts invoice it, CTP's lines follow the SALES ORDER. Once the SO
// has invoice(s) in Zoho (Michelle converts it — 0061), the lines follow the
// INVOICE(S), summed per item, so goods out = what was invoiced; the invoice,
// its status, balance and payments are linked onto the order.
// deno-lint-ignore no-explicit-any
const payLine = (p: any) => `${p.payment_number ?? p.payment_id ?? ""} ${p.date ?? ""} R${p.amount ?? ""} ${p.payment_mode ?? ""}`.replace(/\s+/g, " ").trim();
// deno-lint-ignore no-explicit-any
async function applySalesOrder(db: SupabaseClient, orderId: number, ref: string, so: any, log: Logger) {
  if (!so) return null;
  // deno-lint-ignore no-explicit-any
  const live = ((so.invoices ?? []) as any[]).filter((i) => !["void", "deleted"].includes(String(i.status)));
  // deno-lint-ignore no-explicit-any
  let items: any[] = so.line_items ?? [];
  let mod = String(so.last_modified_time ?? "");
  // deno-lint-ignore no-explicit-any
  const invs: any[] = [];
  for (const i of live) {
    try { invs.push((await zoho("GET", `/invoices/${i.invoice_id}`)).invoice); }
    catch (e) { await log({ doc_type: "invoice", ctp_id: orderId, ctp_ref: ref, action: "status_error", ok: false, message: e instanceof Error ? e.message : String(e) }); return null; }
  }
  if (invs.length) {
    // deno-lint-ignore no-explicit-any
    const byItem = new Map<string, any>();
    for (const inv of invs) {
      if (String(inv.last_modified_time ?? "") > mod) mod = String(inv.last_modified_time);
      for (const l of inv.line_items ?? []) {
        const k = String(l.item_id);
        const prev = byItem.get(k);
        byItem.set(k, prev ? { ...prev, quantity: Number(prev.quantity) + Number(l.quantity) } : { ...l });
      }
    }
    items = [...byItem.values()];
  }
  const { data, error } = await db.rpc("apply_zoho_salesorder", { p_order_id: orderId, p_so: {
    salesorder_number: so.salesorder_number, status: so.status, is_emailed: so.is_emailed,
    last_modified_time: mod, payment_terms: so.payment_terms, payment_terms_label: so.payment_terms_label,
    // deno-lint-ignore no-explicit-any
    line_items: items.map((l: any) => ({ line_item_id: l.line_item_id, item_id: l.item_id, quantity: l.quantity,
      rate: l.rate, discount: l.discount, discount_amount: l.discount_amount, sku: l.sku, name: l.name })),
  } });
  if (!error && invs.length) await linkInvoices(db, orderId, ref, invs, log);
  if (error) {
    await log({ doc_type: "salesorder", ctp_id: orderId, ctp_ref: ref, action: "readback_error", ok: false, message: error.message });
    return null;
  }
  if ((data?.changes?.length ?? 0) + (data?.warnings?.length ?? 0) > 0) {
    await log({ doc_type: "salesorder", ctp_id: orderId, ctp_ref: ref, action: "readback", ok: !(data.warnings?.length), zoho_id: String(so.salesorder_id),
                message: `${ref}: ${[...(data.changes ?? []), ...(data.warnings ?? [])].join("; ")}`.slice(0, 2000) });
  }
  return data;
}

// The SO's invoice(s) → the order: first invoice's id/number, totals summed,
// status = paid only when every invoice is paid.
// deno-lint-ignore no-explicit-any
async function linkInvoices(db: SupabaseClient, orderId: number, ref: string, invs: any[], log: Logger) {
  const sum = (k: string) => invs.reduce((t, i) => t + Number(i[k] ?? 0), 0);
  const st = invs.every((i) => i.status === "paid") ? "paid" : String((invs.find((i) => i.status !== "paid") ?? invs[0]).status ?? "");
  const { data, error } = await db.rpc("apply_zoho_invoice_link", { p_order_id: orderId, p_inv: {
    invoice_id: String(invs[0].invoice_id), invoice_number: invs.map((i) => i.invoice_number).join(" + "), status: st,
    total: sum("total"), balance: sum("balance"), payment_made: sum("payment_made"), count: invs.length,
    // deno-lint-ignore no-explicit-any
    payments: invs.flatMap((i) => (i.payments ?? []).map((p: any) => payLine(p))),
  } });
  if (error) await log({ doc_type: "invoice", ctp_id: orderId, ctp_ref: ref, action: "readback_error", ok: false, message: error.message });
  else if (data?.note) await log({ doc_type: "invoice", ctp_id: orderId, ctp_ref: ref, action: data.linked ? "found_existing" : "status", ok: true,
                                   zoho_id: String(invs[0].invoice_id), message: `${ref}: ${data.note}` });
}

// Account terms from the Zoho contact, for customers with live orders. One GET
// per customer, at most every `maxAge` (6 h on the schedule).
async function refreshTerms(db: SupabaseClient, log: Logger, maxAge: number, only?: number) {
  let q = db.from("sales_order").select("customer_id").is("deleted_at", null).in("status", ["quote", "confirmed", "fulfilled"]);
  if (only) q = q.eq("customer_id", only);
  const { data: live } = await q;
  const ids = [...new Set((live ?? []).map((r) => r.customer_id))];
  if (!ids.length) return 0;
  const { data: custs } = await db.from("customer").select("id, code, zoho_contact_id, zoho_terms_synced_at").in("id", ids).not("zoho_contact_id", "is", null);
  let n = 0;
  for (const c of custs ?? []) {
    if (c.zoho_terms_synced_at && Date.now() - new Date(c.zoho_terms_synced_at).getTime() < maxAge) continue;
    try {
      const b = await zoho("GET", `/contacts/${c.zoho_contact_id}`);
      const k = b.contact ?? {};
      await db.rpc("apply_zoho_contact_terms", { p_customer_id: c.id, p_c: {
        payment_terms: k.payment_terms, payment_terms_label: k.payment_terms_label, credit_limit: k.credit_limit,
        outstanding_receivable_amount: k.outstanding_receivable_amount, unused_credits_receivable_amount: k.unused_credits_receivable_amount } });
      n++;
    } catch (e) {
      await log({ doc_type: "contact", ctp_id: c.id, ctp_ref: c.code, action: "status_error", ok: false, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return n;
}

// One order, on demand (the desk opens it). Throttled to once per 30 s per order.
async function syncOne(db: SupabaseClient, log: Logger, orderId: number, force: boolean) {
  const { data: o } = await db.from("sales_order").select("id, number, customer_id, zoho_salesorder_id, zoho_so_synced_at, zoho_so_status")
    .eq("id", orderId).is("deleted_at", null).maybeSingle();
  if (!o) return { skipped: "no such order" };
  if (!o.zoho_salesorder_id) return { skipped: "no Zoho sales order" };
  if (!force && o.zoho_so_synced_at && Date.now() - new Date(o.zoho_so_synced_at).getTime() < 30_000) return { skipped: "read less than 30 s ago" };
  let so;
  try { so = (await zoho("GET", `/salesorders/${o.zoho_salesorder_id}`)).salesorder; }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/\(404|does not exist|not found/i.test(msg)) {
      await db.from("sales_order").update({ zoho_so_status: "deleted", zoho_so_status_at: new Date().toISOString(),
        zoho_so_error: "This document was DELETED in Zoho. It will not be re-sent automatically — ask the accountant." }).eq("id", orderId);
      return { status: "deleted" };
    }
    throw e;
  }
  const r = await applySalesOrder(db, orderId, o.number, so, log);
  const terms = await refreshTerms(db, log, 60 * 60_000, o.customer_id);
  return { status: so?.status, emailed: so?.is_emailed, changes: r?.changes ?? [], warnings: r?.warnings ?? [], terms };
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
    // sales order (draft) and the invoice converted from it
    const soLine = { item_id: link.zoho_item_id, quantity: 1, rate: 1, description: `TEST ${link.sku}`, ...(taxId ? { tax_id: taxId } : {}) };
    const so = (await zoho("POST", "/salesorders", {}, { customer_id: cust.contact_id, reference_number: `CTP-TEST-SO-${stamp}`,
      date: today, is_inclusive_tax: false, line_items: [soLine], notes: "CTP CORE TEST - DELETE ME" })).salesorder;
    note("salesorder", String(so.salesorder_id), `${so.salesorder_number} status=${so.status}`);
    out.salesorder_default_status = so.status;
    // 21 Oct: sales orders are confirmed (open) — prove Zoho accepts it
    await zoho("POST", `/salesorders/${so.salesorder_id}/status/open`);
    out.salesorder_confirmed_status = (await zoho("GET", `/salesorders/${so.salesorder_id}`)).salesorder?.status;
    out.salesorder_found_by_reference = !!(await findByReference("salesorders", `CTP-TEST-SO-${stamp}`));
    const linked = await linkToSalesOrder(String(so.salesorder_id), [soLine]);
    const soInvBody = { customer_id: linked!.customer_id, reference_number: `CTP-TEST-SOINV-${stamp}`, date: today,
      is_inclusive_tax: false, line_items: linked!.lines, notes: "CTP CORE TEST - DELETE ME" };
    let soInv;
    try { soInv = (await zoho("POST", "/invoices", {}, soInvBody)).invoice; out.draft_salesorder_invoiceable = true; }
    catch (e) {
      out.draft_salesorder_invoiceable = false;
      out.draft_salesorder_refusal = e instanceof Error ? e.message : String(e);
      await zoho("POST", `/salesorders/${so.salesorder_id}/status/open`);
      soInv = (await zoho("POST", "/invoices", {}, soInvBody)).invoice;
    }
    note("invoice", String(soInv.invoice_id), `${soInv.invoice_number} from SO status=${soInv.status}`);
    out.invoice_from_so_status = soInv.status;
    out.salesorder_status_after_invoice = (await zoho("GET", `/salesorders/${so.salesorder_id}`)).salesorder?.status;
    out.invoice_default_status = inv.status;
    out.bill_default_status = bill.status;
    out.found_by_reference = !!(await findByReference("invoices", `CTP-TEST-${stamp}`));
  } finally {
    // delete in reverse: documents before the contacts they belong to
    for (const c of created.reverse()) {
      const path = c.kind === "contact" ? `/contacts/${c.id}` : c.kind === "invoice" ? `/invoices/${c.id}`
                 : c.kind === "salesorder" ? `/salesorders/${c.id}` : `/bills/${c.id}`;
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
  // (Status read-back is allowed while sending is off: documents already in
  // Zoho still change status there.)
  if (body.action !== "test" && body.action !== "status" && body.action !== "so_sync" && (!cfg?.push_enabled || !cfg?.push_from)) {
    return json({ ok: true, skipped: "Sending to Zoho is off (Settings → Zoho). Nothing was sent." });
  }
  await zohoInit(db);
  const missing = zohoMissing();
  if (missing.length) return json({ ok: false, error: `Zoho is not connected yet. Missing secrets: ${missing.join(", ")}` }, 412);

  try {
    if (body.action === "status") {
      return json({ ok: true, ...(await refreshStatus(db, log, body.force === true)) });
    }
    if (body.action === "so_sync") {
      const id = Number(body.order_id);
      if (!Number.isInteger(id) || id <= 0) return json({ error: "order_id is required" }, 400);
      return json({ ok: true, ...(await syncOne(db, log, id, body.force === true)) });
    }
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
