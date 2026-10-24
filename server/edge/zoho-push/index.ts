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
//   { "action": "estimate", "order_id": 43 }    Phase 2 (0062/0063): the quote's DRAFT Zoho estimate,
//                          created ONCE, then only read back (Zoho leads); skipped unless estimates_enabled
//   { "action": "estimate_recreate", "order_id": 43, "note"? }   ADMIN (0064): the quote's estimate was
//                          deleted/voided in Zoho → confirm that in Zoho, retire the link, new draft from
//                          the current CTP lines. Links a live estimate with the same reference instead
//                          of making a second one.
//   Phase 3 on Zoho Inventory (0065) — act only when zoho_config.stock_master = 'zoho', or as an
//   explicit rehearsal test (admin / server token, "rehearsal_test": true):
//   { "action": "stock_sync", "force"?: true }   Inventory items → the stock cache (also every 15 min
//                          with the status read-back)
//   { "action": "ship", "order_id": 43 }        Fulfil: package + shipment from the confirmed SO (delivered),
//                          then record_goods_out() — no CTP sale movement
//   { "action": "ship", "order_id": 43, "mirror": true }   CTP mode: after CTP's own fulfil, the same package +
//                          shipment so Inventory's physical stock follows (record_goods_out is then a no-op)
//   { "action": "adjust", "part_id": 1001, "counted": 5, "reason"?: "…" }   count → Inventory adjustment
//   { "action": "receive_list" }                open Zoho POs with lines
//   { "action": "receive", "purchaseorder_id": "…", "lines": [{ "line_item_id", "quantity" }] }
//   { "action": "hook", "module": "item|salesorder|invoice|estimate|package|shipment|bill|purchasereceive|adjustment", "id": "…" }
//                          Zoho workflow-rule webhook (anon key): trusts nothing but the id; re-reads Zoho
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
         rebateDiscount, linkToSalesOrder, salesOrderFor, deleteSalesOrder, estimateFor, estimatePayload, findLiveEstimate,
         zohoInv, type Logger } from "../_shared/zoho.ts";


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
    // 0062: the quote's Zoho estimate (Phase 2)
    { table: "sales_order", idCol: "zoho_estimate_id", numCol: "zoho_estimate_number", ref: "number",
      path: "estimates", key: "estimate", numKey: "estimate_number", doc: "estimate",
      stCol: "zoho_estimate_status", atCol: "zoho_estimate_status_at", errCol: "zoho_estimate_error" },
    { table: "goods_receipt", idCol: "zoho_bill_id", numCol: "zoho_bill_number", ref: "number",
      path: "bills", key: "bill", numKey: "bill_number", doc: "bill",
      stCol: "zoho_status", atCol: "zoho_status_at", errCol: "zoho_error" },
  ] as const;
  const changes: { doc: string; ref: string; from: string | null; to: string }[] = [];
  let checked = 0;
  for (const k of kinds) {
    const extra = k.table === "sales_order" ? ", number, status, client_response, zoho_salesorder_id, zoho_invoice_id, deleted_at" : "";
    const { data: rows, error } = await db.from(k.table)
      .select(`id, ${k.ref}, ${k.idCol}, ${k.numCol}, ${k.stCol}${extra}`)
      .not(k.idCol, "is", null).limit(200);
    if (error) throw new Error(`${k.table}: ${error.message}`);
    // deno-lint-ignore no-explicit-any
    for (const r of (rows ?? []) as any[]) {
      const was: string | null = r[k.stCol];
      // 0061: an invoiced SO is still read until accounts' invoice is linked onto the order
      if (FINAL.includes(was ?? "") && !(k.doc === "salesorder" && !r.zoho_invoice_id && !r.deleted_at && was === "invoiced")) continue;
      if (k.doc === "estimate" && ["accepted", "declined", "expired"].includes(was ?? "")) continue;
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
        // 0062: the customer declined (or the desk cancelled) a quote whose estimate is still open in Zoho
        if (k.doc === "estimate" && ["draft", "sent"].includes(status)
            && (r.client_response === "declined" || r.status === "cancelled" || r.deleted_at)) {
          await zoho("POST", `/estimates/${r[k.idCol]}/status/declined`);
          status = "declined";
          b.estimate.status = "declined";
        }
        // 0063: Zoho leads the quote — lines, prices, discounts, total, expiry, status
        if (k.doc === "estimate") {
          const { data: ap, error: apErr } = await db.rpc("apply_zoho_estimate", { p_order_id: r.id, p_est: estimatePayload(b.estimate) });
          if (apErr) await log({ doc_type: "estimate", ctp_id: r.id, ctp_ref: r.number, action: "readback_error", ok: false, message: apErr.message });
          else if ((ap?.changes?.length ?? 0) + (ap?.warnings?.length ?? 0) > 0) {
            if (status !== was) changes.push({ doc: k.doc, ref: r[k.ref], from: was, to: status });
            await log({ doc_type: "estimate", ctp_id: r.id, ctp_ref: r.number, action: "readback", ok: !(ap.warnings?.length), zoho_id: r[k.idCol],
                        message: `${r.number}: ${[...(ap.changes ?? []), ...(ap.warnings ?? [])].join("; ")}`.slice(0, 2000) });
          }
          continue;
        }
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
  else if (data?.note) {
    await log({ doc_type: "invoice", ctp_id: orderId, ctp_ref: ref, action: data.linked ? "found_existing" : "status", ok: true,
                zoho_id: String(invs[0].invoice_id), message: `${ref}: ${data.note}` });
    // 23 Oct: the invoice was just linked or changed (raised / paid) — the customer's outstanding
    // balance in Zoho changed with it, so re-read it now instead of on the 6-hour schedule.
    const { data: o } = await db.from("sales_order").select("customer_id").eq("id", orderId).maybeSingle();
    if (o?.customer_id) await refreshTerms(db, log, 0, o.customer_id);
  }
}

// Account terms from the Zoho contact, for customers with live orders. One GET
// per customer, at most every `maxAge` (6 h on the schedule).
async function refreshTerms(db: SupabaseClient, log: Logger, maxAge: number, only?: number) {
  // one named customer: always (their invoice may just have closed the order); otherwise customers with open orders
  let ids: number[];
  if (only) ids = [only];
  else {
    const { data: live } = await db.from("sales_order").select("customer_id").is("deleted_at", null).in("status", ["quote", "confirmed", "fulfilled"]);
    ids = [...new Set((live ?? []).map((r) => r.customer_id))];
  }
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
  if (!o.zoho_salesorder_id) {
    // 0063: a quote with a Zoho estimate — Zoho's version comes back now (Zoho leads)
    const { data: q } = await db.from("sales_order").select("zoho_estimate_id, zoho_estimate_synced_at").eq("id", orderId).maybeSingle();
    if (!q?.zoho_estimate_id) return { skipped: "no Zoho sales order or estimate" };
    if (!force && q.zoho_estimate_synced_at && Date.now() - new Date(q.zoho_estimate_synced_at).getTime() < 30_000) return { skipped: "read less than 30 s ago" };
    // deno-lint-ignore no-explicit-any
    let e: any;
    try { e = (await zoho("GET", `/estimates/${q.zoho_estimate_id}`)).estimate; }
    catch (err) {
      if (!/\(404|does not exist|not found/i.test(err instanceof Error ? err.message : String(err))) throw err;
      e = { estimate_id: q.zoho_estimate_id, status: "deleted" };
    }
    const { data: ap, error: apErr } = await db.rpc("apply_zoho_estimate", { p_order_id: orderId,
      p_est: e.status === "deleted" ? { estimate_id: q.zoho_estimate_id, status: "deleted" } : estimatePayload(e) });
    if (apErr) throw new Error(apErr.message);
    return { status: e.status, estimate: true, changes: ap?.changes ?? [], warnings: ap?.warnings ?? [] };
  }
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

// ── Phase 3: Zoho Inventory holds the stock (0065) ───────────────────────────
const jhbToday = () => jhbDate(new Date().toISOString());
// Zoho Inventory keeps TWO stocks (live test 23 Oct): stock_on_hand is ACCOUNTING stock — it moves
// only when invoices/bills are approved (Michelle keeps them draft) — while actual_available_stock is
// PHYSICAL stock, moved by shipments and purchase receives. The shelf is what CTP shows, so the
// cache's "on hand" is the physical figure; the accounting one is kept in zoho_item.actual_available.
// deno-lint-ignore no-explicit-any
const invItemRow = (i: any) => ({ item_id: String(i.item_id),
  stock_on_hand: i.actual_available_stock ?? i.stock_on_hand,          // physical (shelf)
  available_stock: i.available_stock,
  available_for_sale: i.available_for_sale ?? i.available_for_sale_stock ?? null,
  actual_available_stock: i.stock_on_hand ?? null });                  // accounting (stored in actual_available)

/** The stock cache: every Inventory item (1 call per 200), at most every 15 min unless forced. */
async function stockSync(db: SupabaseClient, log: Logger, force: boolean) {
  const { data: cfg } = await db.from("zoho_config").select("stock_synced_at").eq("id", 1).maybeSingle();
  const last = cfg?.stock_synced_at ? new Date(cfg.stock_synced_at).getTime() : 0;
  if (!force && Date.now() - last < 15 * 60_000) return { skipped: "stock read less than 15 minutes ago" };
  // deno-lint-ignore no-explicit-any
  const rows: any[] = [];
  for (let page = 1; page <= 10; page++) {
    const b = await zohoInv("GET", "/items", { page: String(page), per_page: "200" });
    rows.push(...(b.items ?? []).filter((i: { track_inventory?: boolean }) => i.track_inventory !== false).map(invItemRow));
    if (!b.page_context?.has_more_page) break;
  }
  const { data, error } = await db.rpc("apply_zoho_stock", { p_items: rows });
  if (error) { await log({ doc_type: "item", action: "readback_error", ok: false, message: error.message }); throw new Error(error.message); }
  return { items_read: rows.length, ...data };
}
/** One item's stock now (after a ship / adjust / receive touched it). */
async function stockOne(db: SupabaseClient, itemIds: string[]) {
  // deno-lint-ignore no-explicit-any
  const rows: any[] = [];
  for (const id of [...new Set(itemIds)].slice(0, 20)) {
    try { rows.push(invItemRow((await zohoInv("GET", `/items/${id}`)).item)); } catch { /* the next sync catches it */ }
  }
  if (rows.length) await db.rpc("apply_zoho_stock", { p_items: rows });
  return rows;
}

// deno-lint-ignore no-explicit-any
async function inventoryMayAct(db: SupabaseClient, who: any, body: any): Promise<string | null> {
  const { data: c } = await db.from("zoho_config").select("stock_master").eq("id", 1).maybeSingle();
  if (c?.stock_master === "zoho") return null;
  if (body.rehearsal_test === true && (!who.actor || who.admin)) return null;
  return "Zoho Inventory does not hold the stock yet (rehearsal switch: CTP). An admin can switch it in Settings → Zoho.";
}

/** Fulfil through Zoho Inventory: package + shipment (delivered) from the confirmed SO. Idempotent:
 *  an order with a shipment is just recorded; an unshipped package on the SO is reused. */
// deno-lint-ignore no-explicit-any
async function shipOrder(db: SupabaseClient, log: Logger, who: any, orderId: number, body: any) {
  const { data: o } = await db.from("sales_order").select("id, number, status, zoho_salesorder_id, zoho_package_id, zoho_package_number, zoho_shipment_id, zoho_shipment_number")
    .eq("id", orderId).is("deleted_at", null).maybeSingle();
  if (!o) throw new Blocked("No such order");
  if (!o.zoho_salesorder_id) throw new Blocked(`${o.number} has no Zoho sales order — nothing to ship in Zoho.`);
  if (o.status === "confirmed") {
    const { data: why } = await db.rpc("fulfil_block_reason", { p_order_id: orderId });
    if (why) throw new Blocked(String(why));
  } else if (!["fulfilled", "invoiced"].includes(o.status)) throw new Blocked(`${o.number} is ${o.status}, not accepted.`);
  const so = (await zohoInv("GET", `/salesorders/${o.zoho_salesorder_id}`)).salesorder;
  // deno-lint-ignore no-explicit-any
  const pkgs = (so.packages ?? []) as any[];
  // deno-lint-ignore no-explicit-any
  let pkg: any = pkgs.find((p) => String(p.package_id) === String(o.zoho_package_id)) ?? pkgs.find((p) => !["shipped", "delivered"].includes(String(p.status)));
  // deno-lint-ignore no-explicit-any
  const shippedPkg: any = pkgs.find((p) => ["shipped", "delivered"].includes(String(p.status)));
  let shipment: { id: string; number: string; status: string } | null = null;
  if (shippedPkg && (!pkg || ["shipped", "delivered"].includes(String(pkg.status)))) {
    pkg = shippedPkg;
    const full = (await zohoInv("GET", `/packages/${pkg.package_id}`)).package;
    const so2 = full?.shipment_order ?? {};
    shipment = { id: String(so2.shipment_id ?? o.zoho_shipment_id ?? ""), number: String(so2.shipment_number ?? o.zoho_shipment_number ?? ""),
                 status: String(full?.status ?? pkg.status) };
  }
  if (!pkg) {
    // deno-lint-ignore no-explicit-any
    const lines = ((so.line_items ?? []) as any[]).map((l) => ({ so_line_item_id: l.line_item_id,
      quantity: Number(l.quantity) - Number(l.quantity_packed ?? 0) })).filter((l) => l.quantity > 0);
    if (!lines.length) throw new Blocked(`Everything on ${so.salesorder_number} is already packed in Zoho.`);
    pkg = (await zohoInv("POST", "/packages", { salesorder_id: String(o.zoho_salesorder_id) },
      { date: jhbToday(), line_items: lines, notes: `CTP Core goods out · ${o.number}` })).package;
    await log({ doc_type: "package", ctp_id: orderId, ctp_ref: o.number, action: "create", ok: true, zoho_id: String(pkg.package_id),
                message: `${o.number} → Zoho package ${pkg.package_number} (${lines.length} line(s))` });
  }
  let createdShipment = false;
  if (!shipment) {
    createdShipment = true;
    const ship = { date: jhbToday(), delivery_method: String(body.delivery_method ?? "Collection"),
      tracking_number: String(body.tracking_number ?? o.number), reference_number: o.number, notes: `CTP Core goods out · ${o.number}` };
    // deno-lint-ignore no-explicit-any
    let sh: any;
    const q = { package_ids: String(pkg.package_id), salesorder_id: String(o.zoho_salesorder_id) };
    try { sh = (await zohoInv("POST", "/shipmentorders", q, ship)).shipmentorder; }
    catch (e) {
      if (!/shipment.?number/i.test(e instanceof Error ? e.message : String(e))) throw e;
      sh = (await zohoInv("POST", "/shipmentorders", q, { ...ship, shipment_number: `SH-${o.number}` })).shipmentorder;
    }
    let st = String(sh.status ?? "shipped");
    try { await zohoInv("POST", `/shipmentorders/${sh.shipment_id}/status/delivered`); st = "delivered"; } catch { /* stays shipped; shown */ }
    shipment = { id: String(sh.shipment_id), number: String(sh.shipment_number), status: st };
    await log({ doc_type: "shipment", ctp_id: orderId, ctp_ref: o.number, action: "create", ok: true, zoho_id: shipment.id,
                message: `${o.number} → Zoho shipment ${shipment.number} (${st}) for package ${pkg.package_number}` });
  }
  const { data: rec, error } = await db.rpc("record_goods_out", { p_order_id: orderId, p_actor: who.actor ?? null, p_ship: {
    package_id: String(pkg.package_id), package_number: pkg.package_number, shipment_id: shipment.id, shipment_number: shipment.number,
    shipment_status: shipment.status } });
  if (error) throw new Error(`Shipped in Zoho (${shipment.number}), but recording goods out in CTP failed: ${error.message}`);
  // deno-lint-ignore no-explicit-any
  const stock = await stockOne(db, ((so.line_items ?? []) as any[]).map((l) => String(l.item_id)));
  return { package_number: pkg.package_number, shipment_number: shipment.number, shipment_status: shipment.status, created_shipment: createdShipment, ...rec, stock };
}

/** A count from the phone → an Inventory quantity adjustment (counted − Zoho on hand). */
// deno-lint-ignore no-explicit-any
async function adjustFromCount(db: SupabaseClient, log: Logger, who: any, body: any) {
  const partId = Number(body.part_id), counted = Number(body.counted);
  if (!Number.isInteger(partId) || !Number.isFinite(counted) || counted < 0) throw new Blocked("part_id and a counted quantity (0 or more) are required");
  const { data: z } = await db.from("zoho_item").select("zoho_item_id, sku").eq("part_id", partId).eq("status", "active").maybeSingle();
  if (!z) throw new Blocked("This part is not linked to an active Zoho item.");
  const item = (await zohoInv("GET", `/items/${z.zoho_item_id}`)).item;
  const before = Number(item.stock_on_hand ?? 0), delta = counted - before;
  const { data: me } = who.actor ? await db.from("app_user").select("display_name").eq("id", who.actor).maybeSingle() : { data: null };
  const reason = String(body.reason ?? "Stock count").slice(0, 100);
  const { data: row } = await db.from("zoho_stock_adjustment").insert({ part_id: partId, zoho_item_id: z.zoho_item_id, sku: z.sku,
    counted, zoho_before: before, delta, reason, actor: who.actor ?? null, status: delta === 0 ? "no_change" : "pending" }).select("id").single();
  if (delta === 0) { await stockOne(db, [z.zoho_item_id]); return { sku: z.sku, counted, zoho_before: before, delta: 0, note: "matches Zoho — nothing adjusted" }; }
  const ref = `CTP-COUNT-${row?.id}`;
  try {
    const adj = (await zohoInv("POST", "/inventoryadjustments", {}, { date: jhbToday(), reason, adjustment_type: "quantity",
      reference_number: ref, description: `Counted ${counted} on the CTP phone${me?.display_name ? " by " + me.display_name : ""}; Zoho had ${before}.`,
      line_items: [{ item_id: z.zoho_item_id, quantity_adjusted: delta }] })).inventory_adjustment;
    await db.from("zoho_stock_adjustment").update({ status: "posted", zoho_adjustment_id: String(adj.inventory_adjustment_id), zoho_reference: ref }).eq("id", row?.id);
    await log({ doc_type: "adjustment", ctp_id: partId, ctp_ref: z.sku, action: "create", ok: true, zoho_id: String(adj.inventory_adjustment_id),
                message: `${z.sku}: counted ${counted}, Zoho had ${before} → adjusted ${delta > 0 ? "+" : ""}${delta} (${ref})` });
    await stockOne(db, [z.zoho_item_id]);
    return { sku: z.sku, counted, zoho_before: before, delta, adjustment_id: String(adj.inventory_adjustment_id), reference: ref };
  } catch (e) {
    await db.from("zoho_stock_adjustment").update({ status: "error", error: e instanceof Error ? e.message : String(e) }).eq("id", row?.id);
    throw e;
  }
}

/** Open Zoho POs with their lines, for the phone's Receive screen. */
async function receiveList() {
  // deno-lint-ignore no-explicit-any
  const list = ((await zohoInv("GET", "/purchaseorders", { per_page: "200" })).purchaseorders ?? []) as any[];
  const open = list.filter((p) => ["open", "issued", "partially_received"].includes(String(p.status))).slice(0, 25);
  // deno-lint-ignore no-explicit-any
  const out: any[] = [];
  for (const p of open) {
    const full = (await zohoInv("GET", `/purchaseorders/${p.purchaseorder_id}`)).purchaseorder;
    out.push({ purchaseorder_id: String(full.purchaseorder_id), number: full.purchaseorder_number, vendor: full.vendor_name, date: full.date,
      status: full.status, reference: full.reference_number ?? null,
      // deno-lint-ignore no-explicit-any
      lines: (full.line_items ?? []).map((l: any) => ({ line_item_id: String(l.line_item_id), item_id: String(l.item_id), sku: l.sku, name: l.name,
        ordered: Number(l.quantity), received: Number(l.quantity_received ?? 0) })) });
  }
  return out;
}

/** Goods arrived against a Zoho PO → an Inventory purchase receive (stock in now). */
// deno-lint-ignore no-explicit-any
async function receiveGoods(db: SupabaseClient, log: Logger, who: any, body: any) {
  const poId = String(body.purchaseorder_id ?? "");
  if (!/^\d+$/.test(poId)) throw new Blocked("purchaseorder_id is required");
  // deno-lint-ignore no-explicit-any
  const lines = ((Array.isArray(body.lines) ? body.lines : []) as any[])
    .map((l) => ({ line_item_id: String(l.line_item_id), quantity: Number(l.quantity) })).filter((l) => l.quantity > 0);
  if (!lines.length) throw new Blocked("Nothing to receive — enter a quantity on at least one line.");
  const po = (await zohoInv("GET", `/purchaseorders/${poId}`)).purchaseorder;
  const { data: row } = await db.from("zoho_purchase_receive").insert({ zoho_purchaseorder_id: poId, purchaseorder_number: po.purchaseorder_number,
    lines, notes: body.notes ?? null, actor: who.actor ?? null }).select("id").single();
  try {
    const prBody = { date: jhbToday(), line_items: lines, notes: String(body.notes ?? `Received on the CTP phone (CTP-RCV-${row?.id})`) };
    // deno-lint-ignore no-explicit-any
    let pr: any;
    try { pr = (await zohoInv("POST", "/purchasereceives", { purchaseorder_id: poId }, prBody)).purchasereceive; }
    catch (e) {
      // auto-numbering for receives is off in this org: give it a number
      if (!/receive number/i.test(e instanceof Error ? e.message : String(e))) throw e;
      pr = (await zohoInv("POST", "/purchasereceives", { purchaseorder_id: poId, ignore_auto_number_generation: "true" },
        { ...prBody, receive_number: `PR-${po.purchaseorder_number}-${row?.id}` })).purchasereceive;
    }
    await db.from("zoho_purchase_receive").update({ status: "posted", zoho_receive_id: String(pr.purchasereceive_id ?? pr.receive_id), receive_number: pr.receive_number }).eq("id", row?.id);
    await log({ doc_type: "purchasereceive", ctp_ref: po.purchaseorder_number, action: "create", ok: true, zoho_id: String(pr.purchasereceive_id ?? pr.receive_id),
                message: `${po.purchaseorder_number} → Zoho purchase receive ${pr.receive_number} (${lines.reduce((t, l) => t + l.quantity, 0)} unit(s))` });
    // deno-lint-ignore no-explicit-any
    const items = ((po.line_items ?? []) as any[]).filter((l) => lines.some((x) => x.line_item_id === String(l.line_item_id))).map((l) => String(l.item_id));
    await stockOne(db, items);
    return { receive_number: pr.receive_number, receive_id: String(pr.purchasereceive_id ?? pr.receive_id), purchaseorder: po.purchaseorder_number };
  } catch (e) {
    await db.from("zoho_purchase_receive").update({ status: "error", error: e instanceof Error ? e.message : String(e) }).eq("id", row?.id);
    throw e;
  }
}

/** Zoho workflow-rule webhook. Trusts nothing in the payload except the record id, and only
 *  re-reads that record from Zoho with CTP's own token; throttled per record. */
const hookSeen = new Map<string, number>();
// deno-lint-ignore no-explicit-any
async function hook(db: SupabaseClient, log: Logger, body: any) {
  const m = String(body.module ?? "").toLowerCase(), id = String(body.id ?? "");
  if (!/^\d{6,25}$/.test(id)) return { skipped: "no record id" };
  const key = `${m}:${id}`;
  if (Date.now() - (hookSeen.get(key) ?? 0) < 10_000) return { skipped: "seen in the last 10 s" };
  hookSeen.set(key, Date.now());
  const orderBy = async (col: string, val: string) =>
    (await db.from("sales_order").select("id").eq(col, val).is("deleted_at", null).maybeSingle()).data?.id as number | undefined;
  switch (m) {
    case "item": return { item: await stockOne(db, [id]) };
    case "salesorder": { const o = await orderBy("zoho_salesorder_id", id); return o ? await syncOne(db, log, o, true) : { skipped: "not a CTP order" }; }
    case "estimate": { const o = await orderBy("zoho_estimate_id", id); return o ? await syncOne(db, log, o, true) : { skipped: "not a CTP quote" }; }
    case "invoice": {
      const inv = (await zoho("GET", `/invoices/${id}`)).invoice;
      // deno-lint-ignore no-explicit-any
      const soId = String(inv?.salesorder_id ?? (inv?.salesorders ?? [])[0]?.salesorder_id ?? "");
      const o = (soId && await orderBy("zoho_salesorder_id", soId)) || await orderBy("zoho_invoice_id", id);
      return o ? await syncOne(db, log, o, true) : { skipped: "not a CTP order" };
    }
    case "package": case "shipment": {
      const d = m === "package" ? (await zohoInv("GET", `/packages/${id}`)).package : (await zohoInv("GET", `/shipmentorders/${id}`)).shipmentorder;
      // deno-lint-ignore no-explicit-any
      await stockOne(db, ((d?.line_items ?? []) as any[]).map((l) => String(l.item_id)));
      const o = d?.salesorder_id ? await orderBy("zoho_salesorder_id", String(d.salesorder_id)) : undefined;
      return o ? await syncOne(db, log, o, true) : { stock: "refreshed" };
    }
    case "bill": case "purchasereceive": case "adjustment": return await stockSync(db, log, true);
    default: return { skipped: `module ${m} not handled` };
  }
}

// ── entry ────────────────────────────────────────────────────────────────────
async function authorise(req: Request, db: SupabaseClient) {
  const syncToken = env("ZOHO_SYNC_TOKEN");
  if (syncToken && req.headers.get("x-sync-token") === syncToken) return { ok: true, actor: null as string | null, manager: false, admin: false };
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data } = jwt ? await db.auth.getUser(jwt) : { data: null };
  if (!data?.user) return { ok: false, actor: null, manager: false, admin: false };
  const { data: me } = await db.from("app_user").select("role").eq("id", data.user.id).maybeSingle();
  const staff = ["sales", "warehouse", "manager", "admin"].includes(me?.role ?? "");
  return { ok: staff, actor: data.user.id, manager: me?.role === "manager" || me?.role === "admin", admin: me?.role === "admin" };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  const body = await req.json().catch(() => ({}));
  // 0065: Zoho's workflow-rule webhooks carry only the public anon key. "hook" trusts nothing
  // but the record id and re-reads it from Zoho, so it is the one action open to that caller.
  const who = body.action === "hook" ? { ok: true, actor: null as string | null, manager: false, admin: false } : await authorise(req, db);
  if (!who.ok) return json({ error: "Staff only" }, who.actor ? 403 : 401);

  const log: Logger = async (r) => { await db.from("zoho_push_log").insert({ ...r, actor: who.actor }); };
  const { data: cfg } = await db.from("zoho_config").select("*").eq("id", 1).maybeSingle();

  // Switched off is an answer, not an error — checked before the secrets so an
  // invoice issued before go-live does not report a failure that isn't one.
  // (Status read-back is allowed while sending is off: documents already in
  // Zoho still change status there.)
  if (!["test", "status", "so_sync", "hook", "stock_sync", "receive_list"].includes(body.action) && (!cfg?.push_enabled || !cfg?.push_from)) {
    return json({ ok: true, skipped: "Sending to Zoho is off (Settings → Zoho). Nothing was sent." });
  }
  await zohoInit(db);
  const missing = zohoMissing();
  if (missing.length) return json({ ok: false, error: `Zoho is not connected yet. Missing secrets: ${missing.join(", ")}` }, 412);

  try {
    if (body.action === "status") {
      const st = await refreshStatus(db, log, body.force === true);
      // 0065: the Zoho stock cache rides on the same 10-min schedule (itself throttled to 15 min)
      let stock: unknown = null;
      try { stock = await stockSync(db, log, false); } catch (e) { stock = { error: e instanceof Error ? e.message : String(e) }; }
      return json({ ok: true, ...st, stock });
    }
    if (body.action === "hook") {
      try { return json({ ok: true, module: body.module, ...(await hook(db, log, body)) }); }
      catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await log({ doc_type: "hook", action: "error", ok: false, message: `${body.module}:${body.id} ${msg}`.slice(0, 2000) });
        return json({ ok: false, error: msg }, 200);   // 200: Zoho must not retry-storm a record we cannot read
      }
    }
    if (body.action === "stock_sync") return json({ ok: true, ...(await stockSync(db, log, body.force === true)) });
    if (["ship", "adjust", "receive", "receive_list"].includes(body.action)) {
      if (body.action !== "receive_list") {
        // 24 Oct: in CTP mode, Fulfil already moved the CTP ledger; a "mirror" ship then creates the Zoho
        // package + shipment so Inventory's PHYSICAL stock follows (the invoice only moves accounting stock).
        // Only for an order CTP has already fulfilled, so it can never deduct twice in CTP.
        let mirrorOk = false;
        if (body.action === "ship" && body.mirror === true) {
          const { data: mo } = await db.from("sales_order").select("status").eq("id", Number(body.order_id)).maybeSingle();
          mirrorOk = ["fulfilled", "invoiced"].includes(String(mo?.status));
          if (!mirrorOk) return json({ ok: false, error: "Mirror shipping is only for an order CTP has already fulfilled." }, 409);
        }
        const no = mirrorOk ? null : await inventoryMayAct(db, who, body);
        if (no) return json({ ok: false, error: no }, 409);
      }
      try {
        if (body.action === "ship") {
          const id = Number(body.order_id);
          if (!Number.isInteger(id) || id <= 0) return json({ error: "order_id is required" }, 400);
          const shipped = await shipOrder(db, log, who, id, body);
          // 0068: CTP-mode mirror — CTP's own fulfil was the goods-out step; record the Zoho shipment beside it
          if (body.mirror === true && shipped.created_shipment) {
            await db.rpc("append_order_event", { p_order_id: id, p_kind: "shipped", p_label: `Zoho package ${shipped.package_number} / shipment ${shipped.shipment_number}`,
              p_actor: who.actor, p_detail: { package: shipped.package_number, shipment: shipped.shipment_number } });
          }
          return json({ ok: true, ...shipped });
        }
        if (body.action === "adjust") return json({ ok: true, ...(await adjustFromCount(db, log, who, body)) });
        if (body.action === "receive") return json({ ok: true, ...(await receiveGoods(db, log, who, body)) });
        return json({ ok: true, purchaseorders: await receiveList() });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const kind = body.action === "ship" ? "shipment" : body.action === "adjust" ? "adjustment" : "purchasereceive";
        await log({ doc_type: kind, ctp_id: Number(body.order_id ?? body.part_id) || null, action: e instanceof Blocked ? "blocked" : "error", ok: false, message: msg });
        return json({ ok: false, error: msg }, e instanceof Blocked ? 409 : 502);
      }
    }
    if (body.action === "so_sync") {
      const id = Number(body.order_id);
      if (!Number.isInteger(id) || id <= 0) return json({ error: "order_id is required" }, 400);
      return json({ ok: true, ...(await syncOne(db, log, id, body.force === true)) });
    }
    if (body.action === "estimate") {
      const id = Number(body.order_id);
      if (!Number.isInteger(id) || id <= 0) return json({ error: "order_id is required" }, 400);
      if (!cfg?.estimates_enabled) return json({ ok: true, skipped: "Quotes are not Zoho estimates yet (0062 switch is off)." });
      if (new Date(cfg.push_from) > new Date()) return json({ ok: true, skipped: "Before the Zoho go-live date." });
      try {
        const est = await estimateFor(db, cfg, id, log);
        const { data: ap, error: apErr } = await db.rpc("apply_zoho_estimate", { p_order_id: id, p_est: estimatePayload(est.estimate) });
        if (apErr) throw new Error(`Estimate ${est.estimate_number} is in Zoho, but linking it failed: ${apErr.message}`);
        // 0068: the timeline names who sent the quote to Zoho
        if (est.action === "created" || est.action === "found") {
          await db.rpc("append_order_event", { p_order_id: id, p_kind: "quoted", p_label: `Quote sent to Zoho as ${est.estimate_number} (draft for accounts)`,
            p_actor: who.actor, p_detail: { estimate: est.estimate_number } });
        }
        const { estimate: _e, ...ref } = est;
        return json({ ok: true, ...ref, changes: ap?.changes ?? [], warnings: ap?.warnings ?? [] });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await log({ doc_type: "estimate", ctp_id: id, action: e instanceof Blocked ? "blocked" : "error", ok: false, message: msg });
        await db.from("sales_order").update({ zoho_estimate_error: msg }).eq("id", id);
        return json({ ok: false, error: msg }, e instanceof Blocked ? 409 : 502);
      }
    }
    if (body.action === "estimate_recreate") {
      // admin only; the server's own sync token is trusted like the live test (actor null)
      if (who.actor && !who.admin) return json({ error: "Only an admin can create a new estimate." }, 403);
      const id = Number(body.order_id);
      if (!Number.isInteger(id) || id <= 0) return json({ error: "order_id is required" }, 400);
      if (!cfg?.estimates_enabled) return json({ error: "Quotes are not Zoho estimates (switch is off)." }, 409);
      const { data: o } = await db.from("sales_order").select("id, number, status, zoho_estimate_id, zoho_estimate_number, zoho_estimate_status")
        .eq("id", id).is("deleted_at", null).maybeSingle();
      if (!o) return json({ error: "No such order" }, 404);
      if (o.status !== "quote" || !o.zoho_estimate_id) return json({ error: `${o.number} has no estimate to replace.` }, 409);
      // 1. Zoho must agree the old one is gone (deleted) or void — never trust a stale cache
      let zst = "deleted";
      try { zst = String((await zoho("GET", `/estimates/${o.zoho_estimate_id}`)).estimate?.status ?? "deleted"); }
      catch (e) { if (!/\(404|does not exist|not found/i.test(e instanceof Error ? e.message : String(e))) throw e; }
      if (!["deleted", "void"].includes(zst)) {
        await db.rpc("apply_zoho_estimate", { p_order_id: id, p_est: { estimate_id: o.zoho_estimate_id, status: zst } });
        return json({ error: `Zoho estimate ${o.zoho_estimate_number} still exists in Zoho (${zst}) — no new estimate.` }, 409);
      }
      if (o.zoho_estimate_status !== zst) await db.rpc("apply_zoho_estimate", { p_order_id: id, p_est: { estimate_id: o.zoho_estimate_id, status: zst } });
      // 2. a live estimate already carrying this RQ no. is linked, not doubled
      const live = await findLiveEstimate(o.number, o.zoho_estimate_id);
      const { error: rsErr } = await db.rpc("reset_zoho_estimate", { p_order_id: id, p_actor: who.actor, p_reason: String(body.note ?? "") });
      if (rsErr) return json({ error: rsErr.message }, 409);
      // 3. the new draft from the current CTP lines (estimateFor links `live` if there is one)
      try {
        const est = await estimateFor(db, cfg, id, log);
        const { data: ap, error: apErr } = await db.rpc("apply_zoho_estimate", { p_order_id: id, p_est: estimatePayload(est.estimate) });
        if (apErr) throw new Error(`Estimate ${est.estimate_number} is in Zoho, but linking it failed: ${apErr.message}`);
        await log({ doc_type: "estimate", ctp_id: id, ctp_ref: o.number, action: live ? "found_existing" : "create", ok: true, zoho_id: est.estimate_id,
                    message: `${o.number}: estimate ${o.zoho_estimate_number} was ${zst} in Zoho → ${live ? "linked existing" : "new draft"} ${est.estimate_number} (admin recovery)` });
        const { estimate: _e, ...ref } = est;
        return json({ ok: true, replaced: o.zoho_estimate_number, was: zst, linked_existing: !!live, ...ref, changes: ap?.changes ?? [] });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await log({ doc_type: "estimate", ctp_id: id, ctp_ref: o.number, action: e instanceof Blocked ? "blocked" : "error", ok: false, message: msg });
        await db.from("sales_order").update({ zoho_estimate_error: msg }).eq("id", id);
        return json({ ok: false, error: msg }, e instanceof Blocked ? 409 : 502);
      }
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
