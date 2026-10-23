// CTP Core — swap a Zoho Self Client grant code for a refresh token (19 Oct 2026).
//
// The code expires minutes after it is generated, so the exchange is one call:
//   POST { "code": "1000.xxxx" }   (service_role JWT, or a signed-in admin; verify_jwt ON)
//
//   * The data centre is found by trying each Zoho accounts server in turn; a
//     code only works on its own DC, and a wrong DC never spends it.
//   * The refresh token goes straight into Supabase Vault (zoho_secret_put,
//     0048) and the DC into zoho_config.dc. zoho-push / zoho-sync read both.
//   * Then the new access token is used once to list the organisations, to
//     prove ZOHO_ORG_ID is reachable with it.
//   * The code and the tokens are never logged and never returned.
//
// POST { "action": "status" } says whether a token is stored, nothing more.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { zohoInit, zohoToken, zoho, findByReference } from "../_shared/zoho.ts";

const env = (k: string) => Deno.env.get(k) ?? "";
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

// accounts server per DC; the API host follows from it
const DCS: [string, string][] = [
  ["com", "https://accounts.zoho.com"], ["eu", "https://accounts.zoho.eu"],
  ["in", "https://accounts.zoho.in"], ["com.au", "https://accounts.zoho.com.au"],
  ["jp", "https://accounts.zoho.jp"], ["ca", "https://accounts.zohocloud.ca"],
  ["sa", "https://accounts.zoho.sa"], ["uk", "https://accounts.zoho.uk"],
  ["com.cn", "https://accounts.zoho.com.cn"],
];

async function isAdmin(req: Request, db: SupabaseClient): Promise<boolean> {
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!bearer) return false;
  // deployed WITH verify_jwt: the gateway has already checked the signature,
  // so a service_role claim here is genuine
  try {
    const claims = JSON.parse(atob(bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (claims.role === "service_role") return true;
  } catch { /* not a JWT */ }
  const { data } = await db.auth.getUser(bearer);
  if (!data?.user) return false;
  const { data: me } = await db.from("app_user").select("role").eq("id", data.user.id).maybeSingle();
  return me?.role === "admin";
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  if (!(await isAdmin(req, db))) return json({ error: "Admin only" }, 401);
  const body = await req.json().catch(() => ({}));

  if (body.action === "status") {
    const { data: tok } = await db.rpc("zoho_secret_get", { p_name: "zoho_refresh_token" });
    const { data: cfg } = await db.from("zoho_config").select("dc").eq("id", 1).maybeSingle();
    return json({ ok: true, refresh_token_stored: !!tok, dc: cfg?.dc ?? null,
                  client: !!env("ZOHO_CLIENT_ID") && !!env("ZOHO_CLIENT_SECRET"), org: env("ZOHO_ORG_ID") || null });
  }

  // Part photos -> Zoho item images (Ian, 20 Oct). One image per item: the
  // part's primary photo, else its first. Only ACTIVE Zoho items linked to a CTP
  // part, re-checked live in Zoho (same SKU, status active) right before the
  // upload. POST /items/{id}/image touches the image and nothing else.
  //   { action: "item_images", dry_run?: true, skus?: string[], offset?: 0, limit?: 25 }
  if (body.action === "item_images") {
    const { data: tok } = await db.rpc("zoho_secret_get", { p_name: "zoho_refresh_token" });
    const { data: cfg } = await db.from("zoho_config").select("dc").eq("id", 1).maybeSingle();
    if (!tok) return json({ ok: false, error: "No refresh token stored" }, 412);
    const dc = cfg?.dc || "com";
    const accounts = DCS.find(([d]) => d === dc)?.[1] ?? "https://accounts.zoho.com";
    void accounts;
    // the shared, Vault-cached access token (0055) — no new token per call
    await zohoInit(db);
    let t: { access_token: string };
    try { t = { access_token: await zohoToken() }; }
    catch (e) { return json({ ok: false, step: "refresh", error: e instanceof Error ? e.message : String(e) }, 502); }
    const host = dc === "ca" ? "https://www.zohoapis.ca" : `https://www.zohoapis.${dc}`;
    const base = `${host}/books/v3`;
    const org = env("ZOHO_ORG_ID");
    const auth = { Authorization: `Zoho-oauthtoken ${t.access_token}` };

    const { data: links, error: lerr } = await db.from("zoho_item")
      .select("zoho_item_id, sku, part_id").eq("status", "active").not("part_id", "is", null).order("sku");
    if (lerr) return json({ ok: false, error: lerr.message }, 500);
    const { data: imgs, error: ierr } = await db.from("part_image")
      .select("part_id, path, is_primary, sort_order, id").is("deleted_at", null)
      .order("is_primary", { ascending: false }).order("sort_order").order("id");
    if (ierr) return json({ ok: false, error: ierr.message }, 500);
    const pick = new Map<number, string>();
    for (const i of imgs ?? []) if (!pick.has(i.part_id)) pick.set(i.part_id, i.path);

    let rows = links ?? [];
    if (Array.isArray(body.skus) && body.skus.length) rows = rows.filter((x) => body.skus.includes(x.sku));
    const total = rows.length;
    const offset = Number(body.offset ?? 0), limit = Math.min(Number(body.limit ?? 25), body.dry_run ? 200 : 60);
    rows = rows.slice(offset, offset + limit);
    const assetBase = `${env("SUPABASE_URL")}/storage/v1/object/public/ctp-assets`;
    const out = { updated: [] as string[], no_image: [] as string[], skipped: [] as string[], failed: [] as string[], would_upload: [] as string[] };

    for (const l of rows) {
      const path = pick.get(l.part_id);
      if (!path) { out.no_image.push(l.sku); continue; }
      try {
        const g = await fetch(`${base}/items/${l.zoho_item_id}?organization_id=${org}`, { headers: auth });
        const gj = await g.json().catch(() => ({}));
        const item = gj.item;
        if (!item) { out.failed.push(`${l.sku}: item not found in Zoho (${g.status} ${gj.message ?? ""})`); continue; }
        if (String(item.sku ?? "") !== l.sku || item.status !== "active") {
          out.skipped.push(`${l.sku}: Zoho has sku "${item.sku}" status ${item.status}`); continue;
        }
        if (body.dry_run) { out.would_upload.push(`${l.sku} <- ${path}${item.image_name ? ` [Zoho image now: ${item.image_name}, doc ${item.image_document_id ?? "?"}]` : " [no Zoho image]"}`); continue; }
        const f = await fetch(`${assetBase}/${path.replace(/^\/+/, "")}`);
        if (!f.ok) { out.failed.push(`${l.sku}: photo not downloadable (${f.status}) ${path}`); continue; }
        const blob = await f.blob();
        const ext = (path.match(/\.(png|jpe?g|gif)$/i)?.[1] ?? "png").toLowerCase();
        const fd = new FormData();
        fd.append("image", new Blob([blob], { type: ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : "image/jpeg" }), `${l.sku}.${ext === "jpeg" ? "jpg" : ext}`);
        const u = await fetch(`${base}/items/${l.zoho_item_id}/image?organization_id=${org}`, { method: "POST", headers: auth, body: fd });
        const uj = await u.json().catch(() => ({}));
        if (!u.ok || (uj.code !== undefined && uj.code !== 0)) { out.failed.push(`${l.sku}: upload ${u.status} code ${uj.code ?? "?"} ${uj.message ?? ""}`); continue; }
        out.updated.push(l.sku);
      } catch (e) {
        out.failed.push(`${l.sku}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return json({ ok: out.failed.length === 0, total, offset, limit, next: offset + limit < total ? offset + limit : null, ...out });
  }

  // READ-ONLY assessment for the Zoho-first plan (docs/06): plan, settings,
  // inventory tracking, and which endpoints the current token can read.
  // 23 Oct: READ-ONLY plan probe for Zoho Inventory (Premium bought). GETs only:
  // the org's plan fields from Books and Inventory, rate-limit headers, and which
  // Inventory endpoints this token can reach (it carries Books scopes only).
  if (body.action === "inv_probe") {
    await zohoInit(db);
    const tk = await zohoToken();
    const org = env("ZOHO_ORG_ID");
    const get = async (base: string, path: string) => {
      const r = await fetch(`${base}${path}${path.includes("?") ? "&" : "?"}organization_id=${org}`, { headers: { Authorization: `Zoho-oauthtoken ${tk}` } });
      const j = await r.json().catch(() => ({}));
      return { status: r.status, code: j.code, message: j.message, j,
        limit: r.headers.get("x-rate-limit-limit"), remaining: r.headers.get("x-rate-limit-remaining") };
    };
    const books = "https://www.zohoapis.com/books/v3", inv = "https://www.zohoapis.com/inventory/v1";
    const pick = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) =>
      /plan|edition|inventory|warehouse|branch|location|version|addon|subscription|user|limit|product|is_|mode|country|currency_code|name$/i.test(k))
      .map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v)?.slice(0, 200) : v]));
    const bo = await get(books, `/organizations/${org}`);
    const io = await get(inv, `/organizations/${org}`);
    const probe: Record<string, string> = {};
    for (const path of ["/items?per_page=1", "/salesorders?per_page=1", "/packages?per_page=1", "/shipmentorders?per_page=1",
                        "/purchaseorders?per_page=1", "/purchasereceives?per_page=1", "/inventoryadjustments?per_page=1",
                        "/transferorders?per_page=1", "/settings/warehouses", "/locations", "/settings/preferences", "/users?per_page=50"]) {
      const x = await get(inv, path);
      probe["inventory" + path] = `${x.status}${x.code ? " code " + x.code : ""} ${x.code ? (x.message ?? "") : "ok"} limit=${x.limit ?? "-"}`;
    }
    const bu = await get(books, "/users?per_page=50");
    return json({ ok: true,
      books_org: pick(bo.j.organization ?? {}), books_status: bo.status, books_limit: bo.limit,
      inventory_org: pick(io.j.organization ?? {}), inventory_status: `${io.status}${io.code ? " code " + io.code + " " + io.message : ""}`, inventory_limit: io.limit,
      // deno-lint-ignore no-explicit-any
      books_users: bu.status === 200 ? (bu.j.users ?? []).map((u: any) => `${u.role_name ?? u.user_role}:${u.status}`) : `${bu.status} ${bu.message ?? ""}`,
      probe });
  }

  if (body.action === "assess") {
    await zohoInit(db);
    const tk = await zohoToken();
    const base = "https://www.zohoapis.com/books/v3";
    const org = env("ZOHO_ORG_ID");
    const get = async (path: string) => {
      const r = await fetch(`${base}${path}${path.includes("?") ? "&" : "?"}organization_id=${org}`, { headers: { Authorization: `Zoho-oauthtoken ${tk}` } });
      const j = await r.json().catch(() => ({}));
      return { status: r.status, code: j.code, message: j.message, j, limits: {
        remaining: r.headers.get("x-rate-limit-remaining"), limit: r.headers.get("x-rate-limit-limit"), reset: r.headers.get("x-rate-limit-reset") } };
    };
    const o = await get(`/organizations/${org}`);
    const oo = o.j.organization ?? {};
    const items = await get("/items?per_page=200&filter_by=Status.All");
    // deno-lint-ignore no-explicit-any
    const it = (items.j.items ?? []) as any[];
    const one = it[0] ? await get(`/items/${it[0].item_id}`) : null;
    const probe: Record<string, unknown> = {};
    for (const p of ["/estimates?per_page=1", "/salesorders?per_page=1", "/invoices?per_page=1", "/creditnotes?per_page=1",
                     "/customerpayments?per_page=1", "/vendorpayments?per_page=1", "/purchaseorders?per_page=1", "/bills?per_page=1",
                     "/pricebooks", "/settings/preferences", "/settings/warehouses", "/settings/branches", "/users/me"]) {
      const x = await get(p);
      probe[p] = `${x.status}${x.code ? " code " + x.code : ""}${x.code ? " " + (x.message ?? "") : ""}`;
    }
    const prefs = (await get("/settings/preferences")).j.preferences ?? {};
    return json({ ok: true,
      org: { name: oo.name, plan_type: oo.plan_type, plan_name: oo.plan_name, plan_period: oo.plan_period, country: oo.country,
             currency: oo.currency_code, is_inventory_enabled: oo.is_inventory_enabled ?? null, version: oo.version,
             // deno-lint-ignore no-explicit-any
             keys: Object.keys(oo).filter((k) => /plan|inventory|track|version|edition|warehouse|branch|location/i.test(k)).map((k) => `${k}=${JSON.stringify((oo as any)[k])}`) },
      rate_limit_headers: o.limits,
      items: { n: it.length,
        item_types: [...new Set(it.map((x) => x.item_type))], product_types: [...new Set(it.map((x) => x.product_type))],
        tracked: it.filter((x) => x.track_inventory === true || x.is_track_inventory === true || x.item_type === "inventory").length,
        with_stock_field: it.filter((x) => x.stock_on_hand !== undefined).length,
        stock_total: it.reduce((s, x) => s + (Number(x.stock_on_hand) || 0), 0),
        // deno-lint-ignore no-explicit-any
        sample_keys: one ? Object.keys(one.j.item ?? {}).filter((k) => /stock|inventory|track|warehouse|location|reorder|price|rate/i.test(k)).map((k) => `${k}=${JSON.stringify((one.j.item as any)[k])?.slice(0, 80)}`) : [] },
      // deno-lint-ignore no-explicit-any
      prefs: Object.keys(prefs).filter((k) => /inventory|stock|track|estimate|salesorder|price|discount|tax/i.test(k)).map((k) => `${k}=${JSON.stringify((prefs as any)[k])?.slice(0, 80)}`),
      probe });
  }

  // Admin test of the 21 Oct rule (sales orders CONFIRMED): a TEST sales order for
  // the Test Account contact, marked open, status read back, then removed
  // (delete, else void) — the same calls accept-quote makes.
  // 0062/0063 live test, the order the app uses. TEST estimate (draft, as "Send
  // quote") → the TEST stands in for accounts: edits the price and marks it sent
  // (the app itself never does either) → estimate accepted (the customer's act) →
  // the confirmed SO raised from its lines with estimate_id → read back → both deleted.
  if (body.action === "est_test") {
    await zohoInit(db);
    const { data: link } = await db.from("zoho_item").select("zoho_item_id, sku").eq("status", "active").not("part_id", "is", null).limit(1).single();
    const { data: tc } = await db.from("customer").select("zoho_contact_id").eq("code", "TESTACC").maybeSingle();
    if (!link || !tc?.zoho_contact_id) return json({ ok: false, error: "no test item/contact" }, 412);
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
    const ref = `CTP-TEST-EST-${stamp}`;
    const out: Record<string, unknown> = { stamp };
    // deno-lint-ignore no-explicit-any
    let est: any = null, so: any = null;
    try {
      est = (await zoho("POST", "/estimates", {}, { customer_id: tc.zoho_contact_id, reference_number: ref, is_inclusive_tax: false,
        line_items: [{ item_id: link.zoho_item_id, quantity: 1, rate: 1, description: `TEST ${link.sku}` }], notes: "CTP CORE TEST - DELETE ME" })).estimate;
      out.created = `${est.estimate_number} status=${est.status}`;
      out.found_by_reference = !!(await findByReference("estimates", ref));
      // accounts' side, simulated: change the price, then send (mark sent, no email)
      await zoho("PUT", `/estimates/${est.estimate_id}`, {}, { customer_id: tc.zoho_contact_id, reference_number: ref, is_inclusive_tax: false,
        line_items: [{ item_id: link.zoho_item_id, quantity: 2, rate: 1.5, description: `TEST ${link.sku}` }], notes: "CTP CORE TEST - DELETE ME" });
      await zoho("POST", `/estimates/${est.estimate_id}/status/sent`);
      const sent = (await zoho("GET", `/estimates/${est.estimate_id}`)).estimate;
      out.readback = { status: sent.status, total: sent.total, expiry: sent.expiry_date, is_emailed: sent.is_emailed,
        // deno-lint-ignore no-explicit-any
        lines: (sent.line_items ?? []).map((l: any) => `${l.quantity} x ${l.rate}`) };
      // the app's accept: estimate accepted (Zoho converts only accepted ones), then SO with estimate_id
      await zoho("POST", `/estimates/${est.estimate_id}/status/accepted`);
      const soBody = { customer_id: sent.customer_id, reference_number: ref, is_inclusive_tax: false,
        // deno-lint-ignore no-explicit-any
        line_items: (sent.line_items ?? []).map((l: any) => ({ item_id: l.item_id, quantity: l.quantity, rate: l.rate, description: l.description })),
        notes: "CTP CORE TEST - DELETE ME" };
      try { so = (await zoho("POST", "/salesorders", {}, { ...soBody, estimate_id: est.estimate_id })).salesorder; out.so_from_accepted_estimate = "accepted"; }
      catch (e) {
        out.so_from_accepted_estimate = "refused: " + (e instanceof Error ? e.message : String(e));
        so = (await zoho("POST", "/salesorders", {}, soBody)).salesorder;
      }
      await zoho("POST", `/salesorders/${so.salesorder_id}/status/open`);
      const soAfter = (await zoho("GET", `/salesorders/${so.salesorder_id}`)).salesorder;
      out.so = `${soAfter.salesorder_number} status=${soAfter.status} total=${soAfter.total} estimate_link=${soAfter.estimate_id ?? "none"}`;
      out.estimate_after_so = (await zoho("GET", `/estimates/${est.estimate_id}`)).estimate?.status;
      if (out.estimate_after_so === "sent") await zoho("POST", `/estimates/${est.estimate_id}/status/accepted`);
      out.estimate_final = (await zoho("GET", `/estimates/${est.estimate_id}`)).estimate?.status;
    } catch (e) {
      out.error = e instanceof Error ? e.message : String(e);
    } finally {
      for (const [k, id] of [["salesorders", so?.salesorder_id], ["estimates", est?.estimate_id]] as const) {
        if (!id) continue;
        try { await zoho("DELETE", `/${k}/${id}`); out[`removed_${k}`] = "deleted"; }
        catch (e) {
          try { await zoho("POST", `/${k}/${id}/status/void`); out[`removed_${k}`] = "voided"; }
          catch { out[`removed_${k}`] = "FAILED: " + (e instanceof Error ? e.message : String(e)); }
        }
      }
    }
    return json({ ok: !out.error && out.estimate_final === "accepted" && String(out.so).includes("status=open")
      && !String(out.removed_salesorders ?? "").startsWith("FAILED") && !String(out.removed_estimates ?? "").startsWith("FAILED"), ...out });
  }

  // Phase 3 (23 Oct): READ-ONLY stock reconciliation feed. GETs only, throttled
  // (~1.2 calls/s, under Zoho's 100/min).
  //   { part: "items" }                      every item: stock_on_hand, available_stock
  //   { part: "details", ids: [...] }        per item: committed, available-for-sale, opening stock
  //   { part: "docs" }                       bills, invoices, sales orders, credit notes (+ lines),
  //                                          and whether inventory adjustments are readable
  if (body.action === "stock_report") {
    await zohoInit(db);
    const nap = () => new Promise((r) => setTimeout(r, 800));
    // deno-lint-ignore no-explicit-any
    const all = async (path: string, key: string, extra: Record<string, string> = {}): Promise<any[]> => {
      // deno-lint-ignore no-explicit-any
      const out: any[] = [];
      for (let page = 1; page <= 20; page++) {
        const b = await zoho("GET", path, { ...extra, page: String(page), per_page: "200" });
        out.push(...(b[key] ?? []));
        if (!b.page_context?.has_more_page) break;
        await nap();
      }
      return out;
    };
    if (body.part === "items") {
      const items = await all("/items", "items");
      return json({ ok: true, items: items.map((i) => ({ item_id: String(i.item_id), sku: i.sku, name: i.name, status: i.status,
        item_type: i.item_type, track_inventory: i.track_inventory ?? i.is_track_inventory ?? null,
        stock_on_hand: i.stock_on_hand ?? null, available_stock: i.available_stock ?? null, actual_available_stock: i.actual_available_stock ?? null })) });
    }
    if (body.part === "details") {
      const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter((x: string) => /^\d+$/.test(x)).slice(0, 90);
      // deno-lint-ignore no-explicit-any
      const rows: any[] = [];
      for (const id of ids) {
        try {
          const i = (await zoho("GET", `/items/${id}`)).item;
          rows.push({ item_id: id, stock_on_hand: i.stock_on_hand, available_stock: i.available_stock, committed_stock: i.committed_stock,
            available_for_sale_stock: i.available_for_sale_stock, actual_available_stock: i.actual_available_stock,
            initial_stock: i.initial_stock, initial_stock_rate: i.initial_stock_rate, purchase_rate: i.purchase_rate, rate: i.rate });
        } catch (e) { rows.push({ item_id: id, error: e instanceof Error ? e.message : String(e) }); }
        await nap();
      }
      return json({ ok: true, rows });
    }
    if (body.part === "docs") {
      // deno-lint-ignore no-explicit-any
      const docs: any[] = [];
      const kinds = [["bills", "bills", "bill", "bill_id", "bill_number"], ["invoices", "invoices", "invoice", "invoice_id", "invoice_number"],
                     ["salesorders", "salesorders", "salesorder", "salesorder_id", "salesorder_number"],
                     ["creditnotes", "creditnotes", "creditnote", "creditnote_id", "creditnote_number"]] as const;
      for (const [path, listKey, oneKey, idKey, numKey] of kinds) {
        const list = await all(`/${path}`, listKey);
        for (const d of list) {
          await nap();
          try {
            const full = (await zoho("GET", `/${path}/${d[idKey]}`))[oneKey];
            docs.push({ kind: oneKey, number: full[numKey], status: full.status, date: full.date, reference: full.reference_number ?? null,
              contact: full.customer_name ?? full.vendor_name ?? null,
              // deno-lint-ignore no-explicit-any
              lines: (full.line_items ?? []).map((l: any) => ({ item_id: String(l.item_id ?? ""), sku: l.sku ?? null, qty: Number(l.quantity ?? 0) })) });
          } catch (e) { docs.push({ kind: oneKey, number: d[numKey], error: e instanceof Error ? e.message : String(e) }); }
        }
        await nap();
      }
      let adjustments: unknown = null;
      try { const b = await zoho("GET", "/inventoryadjustments", { per_page: "200" }); adjustments = { readable: true, count: (b.inventory_adjustments ?? []).length,
        // deno-lint-ignore no-explicit-any
        rows: (b.inventory_adjustments ?? []).map((x: any) => ({ id: x.inventory_adjustment_id, date: x.date, reason: x.reason, status: x.status, type: x.adjustment_type })) }; }
      catch (e) { adjustments = { readable: false, error: e instanceof Error ? e.message : String(e) }; }
      return json({ ok: true, docs, adjustments });
    }
    return json({ ok: false, error: "part = items | details | docs" }, 400);
  }

  // 23 Oct: live-test helper — plays ACCOUNTS on a TEST estimate (mark sent / delete / read).
  // Refuses any estimate whose reference is not a CTP test order (RQ-TEST-…).
  if (body.action === "test_estimate") {
    await zohoInit(db);
    const id = String(body.estimate_id ?? "");
    if (!/^\d+$/.test(id) || !["sent", "delete", "get"].includes(body.op)) return json({ ok: false, error: "estimate_id/op" }, 400);
    // deno-lint-ignore no-explicit-any
    let e: any;
    try { e = (await zoho("GET", `/estimates/${id}`)).estimate; }
    catch (err) { return json({ ok: true, status: "deleted", note: err instanceof Error ? err.message : String(err) }); }
    if (!String(e.reference_number ?? "").startsWith("RQ-TEST-")) return json({ ok: false, error: "not a CTP test estimate" }, 403);
    if (body.op === "sent") await zoho("POST", `/estimates/${id}/status/sent`);
    if (body.op === "delete") { await zoho("DELETE", `/estimates/${id}`); return json({ ok: true, deleted: e.estimate_number }); }
    const now = (await zoho("GET", `/estimates/${id}`)).estimate;
    return json({ ok: true, number: now.estimate_number, status: now.status, reference: now.reference_number, total: now.total });
  }

  if (body.action === "so_test") {
    await zohoInit(db);
    const { data: link } = await db.from("zoho_item").select("zoho_item_id, sku").eq("status", "active").not("part_id", "is", null).limit(1).single();
    const { data: tc } = await db.from("customer").select("zoho_contact_id").eq("code", "TESTACC").maybeSingle();
    if (!link || !tc?.zoho_contact_id) return json({ ok: false, error: "no test item/contact" }, 412);
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
    const out: Record<string, unknown> = { stamp };
    const so = (await zoho("POST", "/salesorders", {}, { customer_id: tc.zoho_contact_id, reference_number: `CTP-TEST-SO-${stamp}`,
      line_items: [{ item_id: link.zoho_item_id, quantity: 1, rate: 1, description: `TEST ${link.sku}` }], notes: "CTP CORE TEST - DELETE ME" })).salesorder;
    out.created = `${so.salesorder_number} status=${so.status}`;
    try {
      await zoho("POST", `/salesorders/${so.salesorder_id}/status/open`);
      const after = (await zoho("GET", `/salesorders/${so.salesorder_id}`)).salesorder;
      out.after_confirm = after?.status;
      const item = (await zoho("GET", `/items/${link.zoho_item_id}`)).item;
      out.item_committed_stock = item?.committed_stock; out.item_available_for_sale = item?.available_for_sale_stock;
    } finally {
      try { await zoho("DELETE", `/salesorders/${so.salesorder_id}`); out.removed = "deleted"; }
      catch (e) {
        out.delete_refused = e instanceof Error ? e.message : String(e);
        try { await zoho("POST", `/salesorders/${so.salesorder_id}/status/void`); out.removed = "voided"; }
        catch (e2) { out.removed = "FAILED: " + (e2 instanceof Error ? e2.message : String(e2)); }
      }
    }
    return json({ ok: out.after_confirm === "open" && String(out.removed).match(/deleted|voided/) !== null, ...out });
  }

  // READ-ONLY: one Zoho document, for verifying a live test
  //   { action: "doc", kind: "salesorders" | "invoices" | "contacts", id }
  if (body.action === "doc") {
    // 22 Oct: payments made against a customer, and the sales-receipt probe (read-only)
    if (body.kind === "customer_payments") {
      await zohoInit(db);
      const tk = await zohoToken();
      const get = async (p: string) => {
        const r = await fetch(`https://www.zohoapis.com/books/v3${p}${p.includes("?") ? "&" : "?"}organization_id=${env("ZOHO_ORG_ID")}`, { headers: { Authorization: `Zoho-oauthtoken ${tk}` } });
        return { status: r.status, j: await r.json().catch(() => ({})) };
      };
      const cid = String(body.id ?? "");
      const pays = await get(`/customerpayments?customer_id=${cid}&per_page=10`);
      const recs = await get(`/salesreceipts?customer_id=${cid}&per_page=10`);
      return json({ ok: true,
        // deno-lint-ignore no-explicit-any
        payments: { status: pays.status, msg: pays.j.message, rows: (pays.j.customerpayments ?? []).map((p: any) => `${p.payment_number} ${p.date} ${p.amount} ${p.payment_mode} inv:${p.invoice_numbers ?? ""} unused:${p.unused_amount}`) },
        // deno-lint-ignore no-explicit-any
        salesreceipts: { status: recs.status, msg: recs.j.message, rows: (recs.j.sales_receipts ?? recs.j.salesreceipts ?? []).map((s: any) => `${s.receipt_number ?? s.sales_receipt_number} ${s.date} ${s.total}`) } });
    }
    if (!["salesorders", "invoices", "contacts"].includes(body.kind) || !/^\d+$/.test(String(body.id ?? ""))) {
      return json({ ok: false, error: "kind/id" }, 400);
    }
    await zohoInit(db);
    const tk = await zohoToken();
    const r = await fetch(`https://www.zohoapis.com/books/v3/${body.kind}/${body.id}?organization_id=${env("ZOHO_ORG_ID")}`,
      { headers: { Authorization: `Zoho-oauthtoken ${tk}` } });
    const j = await r.json().catch(() => ({}));
    const d = j.salesorder ?? j.invoice ?? j.contact;
    if (!d) return json({ ok: false, status: r.status, error: j.message }, 502);
    return json({ ok: true, doc: {
      number: d.salesorder_number ?? d.invoice_number ?? d.contact_name, status: d.status, customer: d.customer_name,
      customer_id: d.customer_id, reference: d.reference_number, date: d.date, sub_total: d.sub_total, tax_total: d.tax_total, total: d.total,
      is_inclusive_tax: d.is_inclusive_tax, contact_type: d.contact_type, email: d.email,
      // deno-lint-ignore no-explicit-any
      lines: (d.line_items ?? []).map((l: any) => ({ sku: l.sku, name: l.name, qty: l.quantity, rate: l.rate, discount: l.discount,
        tax: `${l.tax_name ?? ""} ${l.tax_percentage ?? ""}%`, total: l.item_total, so_item: l.salesorder_item_id ?? null })),
      // deno-lint-ignore no-explicit-any
      salesorders: (d.salesorders ?? []).map((s: any) => s.salesorder_number), invoices: (d.invoices ?? []).map((i: any) => `${i.invoice_number}:${i.status}:${i.invoice_id}`),
      balance: d.balance, payment_made: d.payment_made, credits_applied: d.credits_applied,
      // deno-lint-ignore no-explicit-any
      payments: (d.payments ?? []).map((p: any) => `${p.payment_number ?? p.payment_id} ${p.date} ${p.amount} ${p.payment_mode ?? ""}`),
      invoiced_status: d.invoiced_status, order_status: d.order_status,
      // 22 Oct: what "Michelle's side is done" can be read from
      is_emailed: d.is_emailed, current_sub_status: d.current_sub_status, last_modified_time: d.last_modified_time,
      payment_terms: d.payment_terms, payment_terms_label: d.payment_terms_label,
      // deno-lint-ignore no-explicit-any
      state_keys: Object.keys(d).filter((k) => /email|sent|status|modified|approv|submit|terms|credit|outstanding|receivable|unused/i.test(k)).map((k) => `${k}=${JSON.stringify((d as any)[k])?.slice(0, 120)}`),
      // deno-lint-ignore no-explicit-any
      contact_keys: body.kind === "contacts" ? Object.keys(d).filter((k) => /tax|vat|gst|billing|address|person|email|phone|type|company|portal|place/i.test(k)).map((k) => `${k}=${JSON.stringify((d as any)[k])?.slice(0, 160)}`) : undefined,
    } });
  }

  // READ-ONLY preview: Zoho customer contacts vs CTP customers
  if (body.action === "contacts_preview") {
    await zohoInit(db);
    let tk: string;
    try { tk = await zohoToken(); } catch (e) { return json({ ok: false, error: String(e) }, 502); }
    const host = "https://www.zohoapis.com";
    // deno-lint-ignore no-explicit-any
    const zc: any[] = [];
    for (let page = 1; page <= 25; page++) {
      const u = new URL(`${host}/books/v3/contacts`);
      u.searchParams.set("organization_id", env("ZOHO_ORG_ID"));
      u.searchParams.set("contact_type", "customer"); u.searchParams.set("filter_by", "Status.Active");
      u.searchParams.set("page", String(page)); u.searchParams.set("per_page", "200");
      const r = await fetch(u, { headers: { Authorization: `Zoho-oauthtoken ${tk}` } });
      const j = await r.json().catch(() => ({}));
      if (j.code !== 0) return json({ ok: false, error: j.message ?? r.status }, 502);
      zc.push(...(j.contacts ?? []));
      if (!j.page_context?.has_more_page) break;
    }
    const { data: cust } = await db.from("customer").select("id, code, name, email, zoho_contact_id, deleted_at, auth_user_id");
    const n = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
    // deno-lint-ignore no-explicit-any
    const rows = zc.map((c: any) => {
      const live = (cust ?? []).filter((x) => !x.deleted_at);
      const byId = live.find((x) => x.zoho_contact_id === String(c.contact_id));
      const byName = live.find((x) => n(x.name) === n(c.contact_name) || n(x.name) === n(c.company_name));
      const byEmail = c.email ? live.find((x) => n(x.email) === n(c.email)) : undefined;
      const m = byId ?? byName ?? byEmail;
      return { zoho: c.contact_name, company: c.company_name, email: c.email || null, id: String(c.contact_id),
               match: m ? `${m.code} (${byId ? "id" : byName ? "name" : "email"})` : null };
    });
    // likely duplicates inside Zoho: same normalised name or same email
    const seen = new Map<string, string[]>();
    for (const c of zc) for (const k of [n(c.contact_name), c.email ? "@" + n(c.email) : ""]) if (k) seen.set(k, [...(seen.get(k) ?? []), c.contact_name]);
    return json({ ok: true, zoho_customers: zc.length, matched: rows.filter((r) => r.match).length, rows,
      zoho_dupes: [...seen.entries()].filter(([, v]) => v.length > 1).map(([k, v]) => `${k}: ${v.join(" | ")}`),
      ctp_customers: (cust ?? []).filter((x) => !x.deleted_at).map((x) => `${x.code}:${x.name}:${x.zoho_contact_id ?? "-"}`) });
  }

  // read-only health check: stored token -> access token -> org, items, taxes
  if (body.action === "check") {
    const { data: tok } = await db.rpc("zoho_secret_get", { p_name: "zoho_refresh_token" });
    const { data: cfg } = await db.from("zoho_config").select("dc").eq("id", 1).maybeSingle();
    if (!tok) return json({ ok: false, error: "No refresh token stored" }, 412);
    const dc = cfg?.dc || "com";
    const accounts = DCS.find(([d]) => d === dc)?.[1] ?? "https://accounts.zoho.com";
    void accounts;
    // the shared, Vault-cached access token (0055) — no new token per call
    await zohoInit(db);
    let t: { access_token: string };
    try { t = { access_token: await zohoToken() }; }
    catch (e) { return json({ ok: false, step: "refresh", error: e instanceof Error ? e.message : String(e) }, 502); }
    const host = dc === "ca" ? "https://www.zohoapis.ca" : `https://www.zohoapis.${dc}`;
    const api = (env("ZOHO_API") || "inventory").toLowerCase() === "books" ? "books/v3" : "inventory/v1";
    const get = async (path: string) => {
      const u = new URL(`${host}/${api}${path}`);
      u.searchParams.set("organization_id", env("ZOHO_ORG_ID"));
      const x = await fetch(u, { headers: { Authorization: `Zoho-oauthtoken ${t.access_token}` } });
      const j = await x.json().catch(() => ({}));
      return { status: x.status, code: j.code, message: j.message, j };
    };
    const items = await get("/items?per_page=200&filter_by=Status.All");
    const taxes = await get("/settings/taxes");
    const inv = await get("/invoices?per_page=200");
    const bills = await get("/bills?per_page=200");
    const sos = await get("/salesorders?per_page=200");
    return json({
      ok: [items, taxes, inv, bills, sos].every((x) => x.code === 0), dc, api,
      items: { status: items.status, n: items.j.items?.length, more: items.j.page_context?.has_more_page, msg: items.message },
      // deno-lint-ignore no-explicit-any
      taxes: (taxes.j.taxes ?? []).map((x: any) => `${x.tax_name} ${x.tax_percentage}%`),
      // deno-lint-ignore no-explicit-any
      invoices: { status: inv.status, n: inv.j.invoices?.length, numbers: (inv.j.invoices ?? []).map((x: any) => `${x.invoice_number}:${x.status}`).slice(0, 40), msg: inv.message },
      // deno-lint-ignore no-explicit-any
      // deno-lint-ignore no-explicit-any
      salesorders: { status: sos.status, n: sos.j.salesorders?.length, numbers: (sos.j.salesorders ?? []).map((x: any) => `${x.salesorder_number}:${x.status}:${x.reference_number ?? ""}`).slice(0, 40), msg: sos.message },
      bills: { status: bills.status, n: bills.j.bills?.length, numbers: (bills.j.bills ?? []).map((x: any) => `${x.bill_number}:${x.status}`).slice(0, 40), msg: bills.message },
    });
  }

  const code = String(body.code ?? "").trim();
  if (!code) return json({ ok: false, error: "No code given" }, 400);
  if (!env("ZOHO_CLIENT_ID") || !env("ZOHO_CLIENT_SECRET")) {
    return json({ ok: false, error: "ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET secrets missing" }, 412);
  }

  const tried: { dc: string; error: string }[] = [];
  for (const [dc, accounts] of DCS) {
    const p = new URLSearchParams({
      grant_type: "authorization_code", code,
      client_id: env("ZOHO_CLIENT_ID"), client_secret: env("ZOHO_CLIENT_SECRET"),
    });
    let b: Record<string, unknown> = {};
    try {
      const r = await fetch(`${accounts}/oauth/v2/token`, { method: "POST", body: p });
      b = await r.json().catch(() => ({}));
    } catch (e) {
      tried.push({ dc, error: "unreachable" });
      continue;
    }
    if (!b.refresh_token) {
      tried.push({ dc, error: String(b.error ?? (b.access_token ? "no refresh_token (code already used?)" : "no token")) });
      continue;
    }

    const { error: putErr } = await db.rpc("zoho_secret_put", { p_name: "zoho_refresh_token", p_value: String(b.refresh_token) });
    if (putErr) return json({ ok: false, dc, error: `token received but not stored: ${putErr.message}` }, 500);
    await db.from("zoho_config").update({ dc, updated_at: new Date().toISOString() }).eq("id", 1);
    if (b.access_token) {
      await db.rpc("zoho_secret_put", { p_name: "zoho_access_token",
        p_value: `${Date.now() + Number(b.expires_in ?? 3600) * 1000}|${b.access_token}` });
    }

    // prove the org is reachable
    const apiDomain = String(b.api_domain ?? (dc === "ca" ? "https://www.zohoapis.ca" : `https://www.zohoapis.${dc}`));
    const api = (env("ZOHO_API") || "inventory").toLowerCase() === "books" ? "books/v3" : "inventory/v1";
    let orgs: { id: string; name: string }[] = [];
    let orgError: string | null = null;
    try {
      const r = await fetch(`${apiDomain}/${api}/organizations`, { headers: { Authorization: `Zoho-oauthtoken ${b.access_token}` } });
      const o = await r.json().catch(() => ({}));
      if (!r.ok || (o.code !== undefined && o.code !== 0)) orgError = `${r.status}: ${o.message ?? "no message"}`;
      // deno-lint-ignore no-explicit-any
      orgs = ((o.organizations ?? []) as any[]).map((x) => ({ id: String(x.organization_id), name: String(x.name) }));
    } catch (e) {
      orgError = e instanceof Error ? e.message : String(e);
    }
    const org = env("ZOHO_ORG_ID");
    return json({
      ok: true, dc, api_domain: apiDomain, api, scope: b.scope ?? null,
      org_id: org, org_found: orgs.some((x) => x.id === org), organizations: orgs, org_error: orgError,
      tried,
    });
  }
  return json({ ok: false, error: "No Zoho data centre accepted the code", tried }, 400);
});
