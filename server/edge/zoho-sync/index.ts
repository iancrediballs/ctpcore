// CTP Core — the Zoho pull.
//
// Reads every item from Zoho (Inventory by default, Books if ZOHO_API=books)
// and mirrors it into `zoho_item`: Zoho Item ID, SKU, name, status, Rate,
// Purchase Rate, stock on hand. Each Zoho item is linked to its CTP Core part by
// Item ID, then by SKU (= the Multicat code, see CTP_Internal_Naming_Convention
// v2.0), then by legacy CTP code.
//
// READ-ONLY TOWARDS ZOHO. Nothing here writes to Zoho. Write-back (sales orders,
// invoices) is a separate decision and not built.
//
// TWO MODES, chosen by the caller:
//   { "apply": false }  (default) — mirror only, and report what WOULD change in
//                       CTP Core: name, list price (Zoho Rate), landed cost
//                       (Zoho Purchase Rate).
//   { "apply": true }   — also write those changes: part.name, a new
//                       price(tier='list', ZAR) row + part.list_price_minor, a
//                       new part_cost(ZAR, basis 'landed') row. Prices and costs
//                       are versioned by valid_from, so history is kept.
// Zoho stock is ONLY mirrored (zoho_item.stock_on_hand). It is never written into
// the stock_movement ledger, so the two can be compared but never double-counted.
//
// SECRETS (Supabase → Edge Functions → Secrets; never in this repo):
//   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET  — Self Client, Zoho API console (refresh token: Vault, via zoho-auth)
//   ZOHO_ORG_ID      — Zoho organisation id
//   ZOHO_DC          — data centre domain suffix: com | eu | in | com.au | jp | ca | sa | uk
//   ZOHO_API         — inventory (default) | books
//   ZOHO_SYNC_TOKEN  — optional shared secret for scheduled runs (x-sync-token header)
//
// AUTH: a signed-in manager/admin (Settings → Zoho), or a scheduler presenting
// ZOHO_SYNC_TOKEN. verify_jwt can stay ON for the first; deploy with
// --no-verify-jwt only if a scheduler is used, the token check below still gates it.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { zohoInit as sharedInit, zohoToken } from "../_shared/zoho.ts";

const env = (k: string) => Deno.env.get(k) ?? "";
const SUPABASE_URL = env("SUPABASE_URL");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
let DC = env("ZOHO_DC") || "com";
const API = (env("ZOHO_API") || "inventory").toLowerCase();
let BASE = "";

// Refresh token from Vault (zoho-auth writes it), DC from zoho_config.dc;
// the env secrets remain only as a fallback. ZOHO_API picks Books or Inventory.
let REFRESH = "";
async function zohoInit(db: SupabaseClient) {
  const { data: tok } = await db.rpc("zoho_secret_get", { p_name: "zoho_refresh_token" });
  const { data: c } = await db.from("zoho_config").select("dc").eq("id", 1).maybeSingle();
  REFRESH = (tok as string | null) || "";   // Vault only: the env / integration_secret tokens are retired
  DC = c?.dc || env("ZOHO_DC") || "com";
  const host = DC === "ca" ? "https://www.zohoapis.ca" : `https://www.zohoapis.${DC}`;
  BASE = API === "books" ? `${host}/books/v3` : `${host}/inventory/v1`;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sync-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

type ZohoItem = {
  item_id: string; name: string; sku?: string; status?: string;
  rate?: number; purchase_rate?: number;
  stock_on_hand?: number | string; available_stock?: number | string;
  last_modified_time?: string;
};

const minor = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const norm = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();

async function accessToken(): Promise<string> {
  const p = new URLSearchParams({
    refresh_token: REFRESH, client_id: env("ZOHO_CLIENT_ID"),
    client_secret: env("ZOHO_CLIENT_SECRET"), grant_type: "refresh_token",
  });
  const accounts = DC === "ca" ? "https://accounts.zohocloud.ca" : `https://accounts.zoho.${DC}`;
  const r = await fetch(`${accounts}/oauth/v2/token`, { method: "POST", body: p });
  const b = await r.json().catch(() => ({}));
  if (!r.ok || !b.access_token) {
    // Never echo the response body: on some errors Zoho repeats the request.
    throw new Error(`Zoho token refresh failed (${r.status}${b.error ? ", " + b.error : ""}). ` +
      "Check ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET and the Vault token (zoho-auth).");
  }
  return b.access_token as string;
}

async function zohoItems(token: string): Promise<ZohoItem[]> {
  const base = `${BASE}/items`;
  const out: ZohoItem[] = [];
  for (let page = 1; page <= 50; page++) {
    const u = new URL(base);
    u.searchParams.set("organization_id", env("ZOHO_ORG_ID"));
    u.searchParams.set("page", String(page));
    u.searchParams.set("per_page", "200");
    u.searchParams.set("filter_by", "Status.All");
    const r = await fetch(u, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
    const b = await r.json().catch(() => ({}));
    if (!r.ok || (b.code !== undefined && b.code !== 0)) {
      throw new Error(`Zoho ${API} items failed (${r.status}): ${b.message ?? "no message"}`);
    }
    out.push(...((b.items ?? []) as ZohoItem[]));
    if (!b.page_context?.has_more_page) break;
  }
  return out;
}

async function authorise(req: Request, db: SupabaseClient): Promise<{ ok: boolean; actor: string | null; why?: string }> {
  const syncToken = env("ZOHO_SYNC_TOKEN");
  if (syncToken && req.headers.get("x-sync-token") === syncToken) return { ok: true, actor: null };
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return { ok: false, actor: null, why: "Not signed in" };
  const { data, error } = await db.auth.getUser(jwt);
  if (error || !data?.user) return { ok: false, actor: null, why: "Not signed in" };
  const { data: me } = await db.from("app_user").select("role").eq("id", data.user.id).maybeSingle();
  if (me?.role !== "manager" && me?.role !== "admin") {
    return { ok: false, actor: data.user.id, why: "Only a manager or admin can sync with Zoho" };
  }
  return { ok: true, actor: data.user.id };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const who = await authorise(req, db);
  if (!who.ok) return json({ error: who.why }, who.actor ? 403 : 401);

  await zohoInit(db);
  const missing = ["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_ORG_ID"].filter((k) => !env(k));
  if (!REFRESH) missing.push("refresh token (run zoho-auth)");
  if (missing.length) return json({ error: `Zoho is not connected yet. Missing secrets: ${missing.join(", ")}` }, 412);

  const body = await req.json().catch(() => ({}));
  const apply = body?.apply === true;

  const { data: run } = await db.from("zoho_sync_run").insert({ actor: who.actor }).select("id").single();
  const finish = (patch: Record<string, unknown>) =>
    run ? db.from("zoho_sync_run").update({ finished_at: new Date().toISOString(), ...patch }).eq("id", run.id) : null;

  try {
    await sharedInit(db);   // the shared, Vault-cached access token (0055)
    const items = await zohoItems(await zohoToken());

    // ── CTP Core side: parts, existing links, legacy codes, current price & cost
    const [{ data: parts }, { data: links }, { data: legacy }, { data: prices }, { data: costs }] = await Promise.all([
      db.from("part").select("id, sku, name, list_price_minor").is("deleted_at", null),
      db.from("zoho_item").select("zoho_item_id, part_id"),
      db.from("part_xref").select("part_id, xref_number").eq("xref_brand", "CTP legacy").is("deleted_at", null),
      db.from("price").select("part_id, amount_minor, valid_from").eq("tier", "list").eq("currency", "ZAR").is("deleted_at", null),
      db.from("part_cost").select("part_id, amount_minor, valid_from").eq("currency", "ZAR").is("deleted_at", null),
    ]);
    const bySku = new Map((parts ?? []).map((p) => [norm(p.sku), p]));
    const byId = new Map((parts ?? []).map((p) => [p.id, p]));
    const linked = new Map((links ?? []).map((l) => [l.zoho_item_id, l.part_id]));
    const byLegacy = new Map((legacy ?? []).map((x) => [norm(x.xref_number), x.part_id]));
    const latest = (rows: { part_id: number; amount_minor: number; valid_from: string }[] | null) => {
      const m = new Map<number, { amount_minor: number; valid_from: string }>();
      for (const r of rows ?? []) {
        const cur = m.get(r.part_id);
        if (!cur || r.valid_from > cur.valid_from) m.set(r.part_id, r);
      }
      return m;
    };
    const listNow = latest(prices);
    const costNow = latest(costs);

    const now = new Date().toISOString();
    const mirror: Record<string, unknown>[] = [];
    const changes: { sku: string; field: string; from: unknown; to: unknown }[] = [];
    const unmatched: { item_id: string; sku: string | null; name: string; status: string | null }[] = [];
    const nameUpd: { id: number; name: string }[] = [];
    const priceIns: Record<string, unknown>[] = [];
    const costIns: Record<string, unknown>[] = [];
    const listUpd: { id: number; list_price_minor: number }[] = [];

    for (const z of items) {
      const sku = (z.sku ?? "").trim();
      const partId = linked.get(z.item_id) ?? bySku.get(norm(sku))?.id ?? byLegacy.get(norm(sku)) ?? null;
      const status = (z.status ?? "").toLowerCase() || null;
      mirror.push({
        zoho_item_id: z.item_id, part_id: partId, sku: sku || "(no sku)", name: z.name, status,
        rate_minor: minor(z.rate), purchase_rate_minor: minor(z.purchase_rate),
        stock_on_hand: num(z.stock_on_hand), available_stock: num(z.available_stock),
        zoho_updated_at: z.last_modified_time ? new Date(z.last_modified_time).toISOString() : null,
        synced_at: now,
      });
      if (partId == null) {
        if (status !== "inactive") unmatched.push({ item_id: z.item_id, sku: sku || null, name: z.name, status });
        continue;
      }
      if (status === "inactive") continue; // never reprice from an inactive item
      const p = byId.get(partId);
      if (!p) continue;

      if (z.name && z.name.trim() && z.name.trim() !== p.name) {
        changes.push({ sku: p.sku, field: "name", from: p.name, to: z.name.trim() });
        nameUpd.push({ id: partId, name: z.name.trim() });
      }
      const rate = minor(z.rate);
      if (rate && rate > 0 && rate !== (listNow.get(partId)?.amount_minor ?? p.list_price_minor)) {
        changes.push({ sku: p.sku, field: "list_price_zar", from: (listNow.get(partId)?.amount_minor ?? p.list_price_minor ?? 0) / 100, to: rate / 100 });
        priceIns.push({ part_id: partId, tier: "list", currency: "ZAR", amount_minor: rate, valid_from: now, origin: "zoho-sync" });
        listUpd.push({ id: partId, list_price_minor: rate });
      } else if (rate && rate > 0 && p.list_price_minor !== rate) {
        listUpd.push({ id: partId, list_price_minor: rate });
      }
      const cost = minor(z.purchase_rate);
      if (cost && cost > 0 && cost !== costNow.get(partId)?.amount_minor) {
        changes.push({ sku: p.sku, field: "landed_cost_zar", from: (costNow.get(partId)?.amount_minor ?? 0) / 100, to: cost / 100 });
        costIns.push({ part_id: partId, currency: "ZAR", amount_minor: cost, valid_from: now,
                       source: "Zoho Purchase Rate (zoho-sync)", basis: "landed", origin: "zoho-sync" });
      }
    }

    // The mirror is always written — it is Zoho's view, not a CTP Core decision.
    for (let i = 0; i < mirror.length; i += 500) {
      const { error } = await db.from("zoho_item").upsert(mirror.slice(i, i + 500), { onConflict: "zoho_item_id" });
      if (error) throw new Error(`zoho_item upsert: ${error.message}`);
    }

    if (apply) {
      for (const u of nameUpd) {
        const { error } = await db.from("part").update({ name: u.name, updated_at: now }).eq("id", u.id);
        if (error) throw new Error(`part name ${u.id}: ${error.message}`);
      }
      if (priceIns.length) {
        const { error } = await db.from("price").insert(priceIns);
        if (error) throw new Error(`price insert: ${error.message}`);
      }
      for (const u of listUpd) {
        const { error } = await db.from("part").update({ list_price_minor: u.list_price_minor, updated_at: now }).eq("id", u.id);
        if (error) throw new Error(`list price ${u.id}: ${error.message}`);
      }
      if (costIns.length) {
        const { error } = await db.from("part_cost").insert(costIns);
        if (error) throw new Error(`part_cost insert: ${error.message}`);
      }
    }

    const linkedCount = mirror.filter((m) => m.part_id != null).length;
    const stockTotal = mirror.reduce((s, m) => s + (Number(m.stock_on_hand) || 0), 0);
    await finish({ ok: true, items_seen: items.length, linked: linkedCount, unmatched });
    return json({
      ok: true, applied: apply, api: API, items_seen: items.length, linked: linkedCount,
      zoho_stock_units: stockTotal, unmatched, changes,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finish({ ok: false, error: msg });
    return json({ ok: false, error: msg }, 502);
  }
});
