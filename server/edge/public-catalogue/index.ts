// CTP Core — the public catalogue for chinatruckparts.co.za.
//
// verify_jwt is OFF: the public website calls this with no login. That is
// safe only because of what it returns: a WHITELIST of catalogue fields.
//
// Never returned, by design (Michelle, 26 Nov 2026; plan of 27 Nov 2026):
//   cost, PO prices, list price, price books, stock quantities, PO numbers,
//   supplier, locator, notes, Zoho ids, customers, orders.
//
// Stock is reduced to one word per part:
//   in_stock  -> "in_stock"
//   not in stock but on an open purchase order -> "back_order" (+ ETA date if Zoho has one)
//   otherwise -> "ask"
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ASSET_BASE = `${SUPABASE_URL}/storage/v1/object/public/ctp-assets/`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

type PartRow = {
  id: number; sku: string; catalogue_pn: string | null; name: string; description: string | null;
  make: string | null; model: string | null; side: string | null; part_type: string | null;
  in_stock: boolean | null; category_id: number | null; updated_at: string;
};

export type PublicPart = {
  sku: string;
  oem: string | null;
  name: string;
  description: string | null;
  make: string | null;
  model: string | null;
  side: string | null;
  category: string | null;
  availability: "in_stock" | "back_order" | "ask";
  eta: string | null;
  image: string | null;        // web variant (square, ~13 KB) when one can exist
  image_master: string | null; // full photo, the fallback if the variant 404s
  updated_at: string;
};

// Same rules as app/src/assets.ts (assetUrl / photoWebUrl).
function assetUrl(path: string): string {
  if (/^(https?:|data:|blob:)/i.test(path)) return path;
  return ASSET_BASE + path.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
}
function photoWebUrl(path: string): string | null {
  if (/^(https?:|data:|blob:)/i.test(path)) return null;
  const rel = path.replace(/^\/+/, "");
  if (!rel.startsWith("assets/photos/") || rel.startsWith("assets/photos/web/")) return null;
  const base = rel.slice(rel.lastIndexOf("/") + 1).replace(/\.[^.]*$/, "");
  return base ? `${ASSET_BASE}assets/photos/web/${encodeURIComponent(base)}.webp` : null;
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...extra },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "not configured" }, 500);

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const [parts, cats, imgs, bo] = await Promise.all([
    db.from("part")
      .select("id, sku, catalogue_pn, name, description, make, model, side, part_type, in_stock, category_id, updated_at")
      .is("deleted_at", null)
      .eq("status", "active")
      .order("name"),
    db.from("category").select("id, name").is("deleted_at", null),
    db.from("part_image").select("part_id, path, is_primary, sort_order").is("deleted_at", null),
    db.from("back_order_part").select("part_id, qty_on_po, next_eta"),
  ]);
  const err = parts.error ?? cats.error ?? imgs.error ?? bo.error;
  if (err) {
    console.error("public-catalogue query failed:", err.message);
    return json({ error: "catalogue unavailable" }, 502);
  }

  const catName = new Map<number, string>((cats.data ?? []).map((c) => [c.id as number, c.name as string]));

  // Primary photo first, then lowest sort_order.
  const image = new Map<number, { path: string; rank: number }>();
  for (const i of imgs.data ?? []) {
    const rank = (Number(i.is_primary) ? 0 : 1000) + (Number(i.sort_order) || 0);
    const cur = image.get(i.part_id as number);
    if (!cur || rank < cur.rank) image.set(i.part_id as number, { path: i.path as string, rank });
  }

  const onPo = new Map<number, string | null>();
  for (const b of bo.data ?? []) {
    if (b.part_id != null && Number(b.qty_on_po) > 0) onPo.set(b.part_id as number, (b.next_eta as string | null) ?? null);
  }

  const out: PublicPart[] = (parts.data as PartRow[]).map((p) => {
    const availability = p.in_stock ? "in_stock" : onPo.has(p.id) ? "back_order" : "ask";
    const img = image.get(p.id);
    return {
      sku: p.sku,
      oem: p.catalogue_pn,
      name: p.name,
      description: p.description,
      make: p.make,
      model: p.model,
      side: p.side,
      category: p.category_id != null ? catName.get(p.category_id) ?? null : null,
      availability,
      eta: availability === "back_order" ? onPo.get(p.id) ?? null : null,
      image: img ? photoWebUrl(img.path) ?? assetUrl(img.path) : null,
      image_master: img ? assetUrl(img.path) : null,
      updated_at: p.updated_at,
    };
  });

  return json(
    { generated_at: new Date().toISOString(), count: out.length, parts: out },
    200,
    { "Cache-Control": "public, max-age=300, s-maxage=300" },
  );
});
