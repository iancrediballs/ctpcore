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
    const r = await fetch(`${accounts}/oauth/v2/token`, { method: "POST", body: new URLSearchParams({
      grant_type: "refresh_token", refresh_token: String(tok),
      client_id: env("ZOHO_CLIENT_ID"), client_secret: env("ZOHO_CLIENT_SECRET") }) });
    const t = await r.json().catch(() => ({}));
    if (!t.access_token) return json({ ok: false, step: "refresh", error: String(t.error ?? r.status) }, 502);
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

  // read-only health check: stored token -> access token -> org, items, taxes
  if (body.action === "check") {
    const { data: tok } = await db.rpc("zoho_secret_get", { p_name: "zoho_refresh_token" });
    const { data: cfg } = await db.from("zoho_config").select("dc").eq("id", 1).maybeSingle();
    if (!tok) return json({ ok: false, error: "No refresh token stored" }, 412);
    const dc = cfg?.dc || "com";
    const accounts = DCS.find(([d]) => d === dc)?.[1] ?? "https://accounts.zoho.com";
    const r = await fetch(`${accounts}/oauth/v2/token`, { method: "POST", body: new URLSearchParams({
      grant_type: "refresh_token", refresh_token: String(tok),
      client_id: env("ZOHO_CLIENT_ID"), client_secret: env("ZOHO_CLIENT_SECRET") }) });
    const t = await r.json().catch(() => ({}));
    if (!t.access_token) return json({ ok: false, step: "refresh", error: String(t.error ?? r.status) }, 502);
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
