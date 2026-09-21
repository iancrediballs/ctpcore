// CTP Core — a customer accepts a quote.
//
// Ian, 2026-09-20: Zoho Books owns the document chain. Accepting a quote
// creates the SALES ORDER in Zoho (that is the proforma the customer gets),
// and reserves the stock in CTP Core (the ledger stays the source of truth
// because inventory tracking is off in Books). Both, or neither.
//
// THE ORDER OF THINGS, and why:
//   1. Who is calling, and is it their quote.           (403 otherwise)
//   2. quote_accept_check — every blocker, by name.      (409, nothing done)
//   3. Zoho: reuse a sales order that already carries this order number
//      (a retry after a dropped response), else create one.
//   4. accept_quote(): ONE database transaction — status, Zoho refs, holds.
//   5. If 4 fails: delete the Zoho sales order again. If THAT fails too:
//      log_integration_issue so the desk sees an orphan to tidy, and still
//      tell the customer it did not go through. They are never left with a
//      hold and no document, or a document and no hold.
//   Nothing after that. Sending the proforma, recording the payment and
//   converting to the invoice happen in Zoho's own screens.
//
// Zoho-first, then the database, because the database side is the one that
// can be made atomic and reversed cleanly; a created-then-deleted sales
// order leaves a gap in Zoho's SO numbering, which is a cosmetic cost, while
// a hold without a document would be a real one.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { ZohoError, zohoConfigured, findSalesOrderByReference, createSalesOrder, deleteSalesOrder, type ZohoLine } from "./zoho.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const admin = () => createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

type Blocker = { kind: string; message: string; sku?: string; name?: string };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Not signed in" }, 401);
  const db = admin();
  const { data: caller, error: callerErr } = await db.auth.getUser(token);
  if (callerErr || !caller?.user) return json({ error: "Not signed in" }, 401);
  const uid = caller.user.id;

  let body: { order_id?: unknown };
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const orderId = Number(body.order_id);
  if (!Number.isInteger(orderId) || orderId <= 0) return json({ error: "order_id is required" }, 400);

  // ── 1. the order, and that it is theirs ──────────────────────────────────
  const { data: o, error: oErr } = await db
    .from("sales_order")
    .select("id, number, status, customer_id, zoho_salesorder_id, zoho_salesorder_number, customer:customer_id(id, name, auth_user_id, zoho_contact_id)")
    .eq("id", orderId).is("deleted_at", null).maybeSingle();
  if (oErr) return json({ error: oErr.message }, 500);
  if (!o) return json({ error: "No such order" }, 404);
  const cust = (Array.isArray(o.customer) ? o.customer[0] : o.customer) as { id: number; name: string; auth_user_id: string | null; zoho_contact_id: string | null } | null;
  if (!cust || cust.auth_user_id !== uid) return json({ error: "That order belongs to a different customer" }, 403);

  // already done (a retry after the response was lost)
  if (o.status === "confirmed" && o.zoho_salesorder_id) {
    return json({ ok: true, already: true, order_id: o.id, number: o.number, zoho_salesorder_number: o.zoho_salesorder_number });
  }

  // ── 2. every blocker, by name — before any API call ──────────────────────
  // Run as the caller (their JWT) so the function's own ownership check applies too.
  const asCaller = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
  const { data: chk, error: chkErr } = await asCaller.rpc("quote_accept_check", { order_id: orderId });
  if (chkErr) return json({ error: chkErr.message }, 400);
  const blockers: Blocker[] = (chk?.blockers ?? []) as Blocker[];
  if (!chk?.ok) {
    return json({ error: "This quote cannot be accepted yet.", blockers, message: blockers.map((b) => b.message).join(" ") }, 409);
  }
  if (!zohoConfigured()) {
    return json({ error: "Ordering is not connected to the accounts system on this server yet — please tell us and we will accept it by hand." }, 503);
  }

  // the lines, as Zoho wants them: item, quantity, unit rate ex VAT, and the
  // rebate (if the rebate columns exist on this database) as a line discount
  let lines: Record<string, unknown>[] | null = null;
  const withRebate = await db.from("sales_line").select("qty, unit_price_minor, part:part_id(sku, name, zoho_item_id), rebate_pct").eq("order_id", orderId).is("deleted_at", null);
  if (!withRebate.error) lines = withRebate.data as Record<string, unknown>[];
  else {
    // no rebate column yet on this database (0044 not applied): read without it
    const plain = await db.from("sales_line").select("qty, unit_price_minor, part:part_id(sku, name, zoho_item_id)").eq("order_id", orderId).is("deleted_at", null);
    if (plain.error) return json({ error: plain.error.message }, 500);
    lines = plain.data as Record<string, unknown>[];
  }
  const items: ZohoLine[] = (lines ?? []).map((l: Record<string, unknown>) => {
    const p = (Array.isArray(l.part) ? l.part[0] : l.part) as { sku: string; name: string; zoho_item_id: string };
    const pct = Number(l.rebate_pct ?? 0);
    return {
      item_id: p.zoho_item_id, quantity: Number(l.qty), rate: Number(l.unit_price_minor) / 100,
      description: `${p.sku} · CTP ${o.number}`,
      ...(pct > 0 ? { discount: `${pct}%` } : {}),
    };
  });
  if (items.length === 0) return json({ error: "This quote has no lines." }, 409);

  // ── 3. Zoho: reuse or create ─────────────────────────────────────────────
  let so: { salesorder_id: string; salesorder_number: string } | null = null; let created = false;
  try {
    const existing = await findSalesOrderByReference(o.number);
    if (existing) { so = existing; }
    else {
      so = await createSalesOrder({
        customer_id: cust.zoho_contact_id!, reference_number: o.number,
        date: new Date().toISOString().slice(0, 10), line_items: items,
        notes: `Accepted in CTP Core on ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC · CTP order ${o.number}`,
      });
      created = true;
    }
  } catch (e) {
    console.error("zoho create failed:", e);
    const msg = e instanceof ZohoError ? e.message : String(e);
    return json({ error: `We could not raise the sales order in our accounts system, so nothing was accepted or reserved. Please try again in a minute; if it keeps failing, call us. (${msg})` }, 502);
  }
  if (!so) return json({ error: "We could not raise the sales order in our accounts system; nothing was accepted or reserved." }, 502);

  // ── 4. the one transaction ───────────────────────────────────────────────
  const { data: acc, error: accErr } = await db.rpc("accept_quote", {
    order_id: orderId, p_auth_user: uid, p_zoho_salesorder_id: so.salesorder_id, p_zoho_salesorder_number: so.salesorder_number,
  });
  if (accErr) {
    console.error("accept_quote failed after Zoho SO", so.salesorder_number, ":", accErr.message);
    // ── 5. compensate ──
    if (created) {
      try { await deleteSalesOrder(so.salesorder_id); }
      catch (delErr) {
        console.error("compensation failed; logging orphan:", delErr);
        await db.rpc("log_integration_issue", {
          p_system: "zoho", p_kind: "orphan_salesorder", p_order_id: orderId, p_external_id: so.salesorder_id,
          p_detail: `Sales order ${so.salesorder_number} was created in Zoho but CTP could not record the acceptance (${accErr.message}); deleting it failed too (${String(delErr)}). Delete it in Zoho by hand.`,
        });
      }
    }
    return json({ error: `Nothing was accepted or reserved: ${accErr.message.replace(/^[A-Z0-9]+: /, "")}` }, 409);
  }

  // Everything after this — sending the proforma, recording the payment,
  // converting to the invoice — Ian does in Zoho's own screens (2026-09-21).
  return json({ ok: true, already: acc?.already ?? false, order_id: orderId, number: o.number,
                zoho_salesorder_id: so.salesorder_id, zoho_salesorder_number: so.salesorder_number,
                reserved_lines: acc?.reserved_lines ?? 0 });
});
