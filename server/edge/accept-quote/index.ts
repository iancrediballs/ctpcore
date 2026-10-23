// CTP Core — a customer accepts a quote.
//
// 2026-10-23 (0062, Phase 2): when quotes are Zoho estimates (zoho_config.
// estimates_enabled) and this quote has one, accepting marks the ESTIMATE
// accepted and raises the confirmed sales order from the estimate's lines
// (salesOrderFromEstimate). Without an estimate: the 20 Oct path, unchanged.
// 0063 (Ian, 23 Oct): accept only once accounts have SENT the estimate (the app
// never marks it sent); with estimates on, a quote without one cannot be
// accepted. Zoho converts only ACCEPTED estimates, so the estimate is accepted,
// then the linked SO raised; if CTP's transaction fails the SO is deleted and
// the estimate stays accepted (logged; a retry links normally).
//
// 2026-10-22 (0058): { order_id, on_behalf_note } lets an ADMIN accept for the
// customer (confirmed by phone/email). Same Zoho SO + stock hold; the admin and
// the note are recorded on the order by accept_quote_on_behalf().
//
// 2026-10-20 (Ian: "sales order as before"): rewired onto the 19 Oct Zoho link —
// the refresh token in Vault, the DC in zoho_config, lines by SKU through
// zoho_item, Standard Rate VAT, contact matched or created, the sales order
// left in DRAFT. Respects the go-live switch: while Zoho sending is off, or
// before push_from, the quote is accepted and reserved with NO sales order
// (history never goes to Zoho). When the order is invoiced, zoho-push converts
// this sales order into the (draft) invoice. The September token path
// (integration_secret, ./zoho.ts, zoho-connect) is retired.
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
import { zohoInit, zohoMissing, salesOrderFor, salesOrderFromEstimate, markEstimateAccepted, deleteSalesOrder, Blocked, type Logger } from "../_shared/zoho.ts";

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

  let body: { order_id?: unknown; on_behalf_note?: unknown };
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const orderId = Number(body.order_id);
  if (!Number.isInteger(orderId) || orderId <= 0) return json({ error: "order_id is required" }, 400);
  // 0058: an admin accepts on the customer's behalf (confirmed by phone/email).
  // Same steps below; only the ownership check and the final RPC differ.
  const onBehalf = body.on_behalf_note !== undefined;
  const note = String(body.on_behalf_note ?? "").trim();
  if (onBehalf) {
    const { data: me } = await db.from("app_user").select("role").eq("id", uid).maybeSingle();
    if (me?.role !== "admin") return json({ error: "Only an admin can accept a quote on the customer's behalf." }, 403);
    if (note.length < 3) return json({ error: "Say how the customer confirmed it, e.g. \"Confirmed by Denver via phone\"." }, 400);
  }

  // ── 1. the order, and that it is theirs ──────────────────────────────────
  const { data: o, error: oErr } = await db
    .from("sales_order")
    .select("id, number, status, customer_id, zoho_salesorder_id, zoho_salesorder_number, zoho_estimate_id, zoho_estimate_status, customer:customer_id(id, name, auth_user_id, zoho_contact_id)")
    .eq("id", orderId).is("deleted_at", null).maybeSingle();
  if (oErr) return json({ error: oErr.message }, 500);
  if (!o) return json({ error: "No such order" }, 404);
  const cust = (Array.isArray(o.customer) ? o.customer[0] : o.customer) as { id: number; name: string; auth_user_id: string | null; zoho_contact_id: string | null } | null;
  if (!onBehalf) {
    // 0057: a login belongs to a company directly (customer.auth_user_id) or as one of its people
    const { data: mine } = await db.rpc("login_company", { p_auth_user: uid });
    if (!cust || Number(mine) !== Number(o.customer_id)) return json({ error: "That order belongs to a different customer" }, 403);
  } else if (!cust) return json({ error: "That order has no customer" }, 409);

  // already done (a retry after the response was lost)
  if (o.status === "confirmed") {
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

  // ── 3. Zoho, only from go-live on ─────────────────────────────────────────
  const { data: cfg } = await db.from("zoho_config").select("*").eq("id", 1).maybeSingle();
  const live = !!(cfg?.push_enabled && cfg?.push_from && new Date(cfg.push_from) <= new Date());
  const log: Logger = async (r) => { await db.from("zoho_push_log").insert({ ...r, actor: uid }); };

  let so: { salesorder_id: string; salesorder_number: string; status: string; created: boolean; warning?: string } | null = null;
  // 0062: accept through the quote's Zoho estimate when there is one
  const viaEstimate = !!(live && cfg?.estimates_enabled);
  if (viaEstimate && (!o.zoho_estimate_id || o.zoho_estimate_status === "deleted")) {
    const m = "Your quote is being finalised by our accounts team.";
    return json({ error: m, blockers: [{ kind: "estimate", message: m }], message: m }, 409);
  }
  let est: { status: string; number: string } | null = null;
  if (live) {
    await zohoInit(db);
    const missing = zohoMissing();
    if (missing.length) {
      await log({ doc_type: "salesorder", ctp_id: orderId, ctp_ref: o.number, action: "blocked", ok: false,
                  message: `Zoho not connected: ${missing.join(", ")}` });
      return json({ error: "Ordering is not connected to the accounts system on this server yet — please tell us and we will accept it by hand." }, 503);
    }
    try {
      if (viaEstimate) {
        const r = await salesOrderFromEstimate(db, orderId, o.zoho_estimate_id!, log);
        so = r; est = { status: r.estimate_status, number: r.estimate_number };
      } else so = await salesOrderFor(db, cfg, orderId, log);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await log({ doc_type: "salesorder", ctp_id: orderId, ctp_ref: o.number, action: e instanceof Blocked ? "blocked" : "error", ok: false, message: msg });
      await db.from("sales_order").update({ zoho_so_error: msg }).eq("id", orderId);
      return json({ error: `We could not raise the sales order in our accounts system, so nothing was accepted or reserved. Please try again in a minute; if it keeps failing, call us. (${msg})` }, 502);
    }
  }

  // ── 4. the one transaction ───────────────────────────────────────────────
  const { data: acc, error: accErr } = onBehalf
    ? await db.rpc("accept_quote_on_behalf", {
        order_id: orderId, p_staff: uid, p_note: note,
        p_zoho_salesorder_id: so?.salesorder_id ?? null, p_zoho_salesorder_number: so?.salesorder_number ?? null,
      })
    : await db.rpc("accept_quote", {
        order_id: orderId, p_auth_user: uid,
        p_zoho_salesorder_id: so?.salesorder_id ?? null, p_zoho_salesorder_number: so?.salesorder_number ?? null,
      });
  if (accErr) {
    // ── 5. compensate: a sales order we just created is removed again ──
    if (est && o.zoho_estimate_id) {
      await log({ doc_type: "estimate", ctp_id: orderId, ctp_ref: o.number, action: "error", ok: false, zoho_id: o.zoho_estimate_id,
                  message: `${o.number}: acceptance failed in CTP (${accErr.message}); Zoho estimate ${est.number} stays ACCEPTED — the customer can retry, or ask accounts.` });
    }
    if (so?.created) {
      try {
        await deleteSalesOrder(so.salesorder_id);
        await log({ doc_type: "salesorder", ctp_id: orderId, ctp_ref: o.number, action: "delete", ok: true, zoho_id: so.salesorder_id,
                    message: `${so.salesorder_number} deleted again: the acceptance failed (${accErr.message})` });
      } catch (delErr) {
        await log({ doc_type: "salesorder", ctp_id: orderId, ctp_ref: o.number, action: "error", ok: false, zoho_id: so.salesorder_id,
                    message: `ORPHAN: sales order ${so.salesorder_number} was created in Zoho but the acceptance failed (${accErr.message}) and deleting it failed too (${String(delErr)}). Delete it in Zoho by hand.` });
      }
    }
    return json({ error: `Nothing was accepted or reserved: ${accErr.message.replace(/^[A-Z0-9]+: /, "")}` }, 409);
  }
  // 0063: the CTP side is committed — now the estimate → accepted in Zoho
  if (est && o.zoho_estimate_id) {
    try { est.status = await markEstimateAccepted(o.zoho_estimate_id); }
    catch (e) {
      await log({ doc_type: "estimate", ctp_id: orderId, ctp_ref: o.number, action: "error", ok: false, zoho_id: o.zoho_estimate_id,
                  message: `Accepted in CTP (${so?.salesorder_number}) but Zoho would not mark estimate ${est.number} accepted: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  // Zoho's own status (open = confirmed, since 21 Oct) over accept_quote's default
  if (so) {
    await db.from("sales_order").update({ zoho_so_status: so.status === "existing" ? undefined : so.status,
      zoho_so_status_at: new Date().toISOString(), zoho_so_error: so.warning ?? null,
      ...(est ? { zoho_estimate_status: est.status, zoho_estimate_status_at: new Date().toISOString(), zoho_estimate_error: null } : {}) }).eq("id", orderId);
  }

  return json({ ok: true, already: acc?.already ?? false, order_id: orderId, number: o.number,
                zoho_salesorder_id: so?.salesorder_id ?? null, zoho_salesorder_number: so?.salesorder_number ?? null,
                zoho: live ? `sales order raised (${so?.status === "open" ? "confirmed" : so?.status ?? "draft"})` : "not sent: Zoho sending is off or before the go-live date",
                reserved_lines: acc?.reserved_lines ?? 0 });
});
