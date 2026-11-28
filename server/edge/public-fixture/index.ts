// CTP Core — the catalogue the PUBLIC website's copy of the app runs on.
//
// chinatruckparts.co.za runs the real CTP Core catalogue screens (Home, Find,
// the diagram viewer) with no login (Ian, 28 Nov 2026: "copy the app
// identically ... everything except prices"). Those screens read a local
// SQLite database shaped like the one PowerSync fills on a phone. This
// function returns the rows for it, as one JSON object keyed by table name.
//
// What it returns is the CUSTOMER sync bucket (server/sync-streams.yaml,
// "catalogue_customer"), column for column, and nothing more:
//   * no price, part_cost, price_tier, price_book*, stock_movement, stock_policy
//   * no customer, sales_order, sales_line, app_user
//   * part: the customer column list (no locator, inventory_pn, notes,
//     list_price_minor, supplier); in_stock is the one stock fact
//   * diagram: no `source`
//   * company: name, phone, email only
// Only live rows; parts only when status = 'active'.
// ?make=FAW&model=JH6 narrows parts and drawings to one truck (rows with no
// model, e.g. "Other parts", are kept for every truck).
//
// verify_jwt is OFF (public). Read-only, service role, cached 5 minutes.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

// Column lists copied from sync-streams.yaml (customer bucket). Keep in step.
const COLS = {
  category: "id, code, name, rev, updated_at, deleted_at",
  brand: "id, name, rev, updated_at, deleted_at",
  part: "id, sku, mpn, brand_id, category_id, name, description, uom, weight_g, status, superseded_by, make, model, drawing_no, diagram_item_no, catalogue_pn, side, diagram_ref, in_stock, part_type, rev, updated_at, deleted_at",
  part_xref: "id, part_id, xref_number, xref_brand, xref_type, confidence, rev, updated_at, deleted_at",
  vehicle_model: "id, make, model, variant, year_from, year_to, engine, notes, rev, updated_at, deleted_at",
  part_fitment: "id, part_id, vehicle_id, engine, year_from, year_to, note, rev, updated_at, deleted_at",
  part_image: "id, part_id, path, kind, is_primary, sort_order, caption, rev, updated_at, deleted_at",
  diagram: "id, drawing_key, title, section_code, make, model, image_path, model_3d_path, img_w, img_h, rev, updated_at, deleted_at",
  part_diagram_callout: "id, part_id, diagram_id, item_no, is_primary, rev, updated_at, deleted_at",
  hotspot: "id, diagram_id, part_id, item_no, x, y, radius, rev, updated_at, deleted_at, client_uuid",
  company: "id, name, phone, email",
} as const;

type Row = Record<string, unknown>;

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

  const url = new URL(req.url);
  const make = url.searchParams.get("make");
  const model = url.searchParams.get("model");
  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const live = (t: keyof typeof COLS) => {
    const q = db.from(t).select(COLS[t] as string);
    return t === "company" ? q : q.is("deleted_at", null);
  };
  const res = await Promise.all([
    live("category"), live("brand"), live("part").eq("status", "active"), live("part_xref"),
    live("vehicle_model"), live("part_fitment"), live("part_image"), live("diagram"),
    live("part_diagram_callout"), live("hotspot"), live("company"),
  ]);
  const bad = res.find((r) => r.error);
  if (bad?.error) {
    console.error("public-fixture query failed:", bad.error.message);
    return json({ error: "catalogue unavailable" }, 502);
  }
  const [category, brand, partAll, part_xref, vehicle_model, part_fitment, part_image, diagramAll,
    part_diagram_callout, hotspotAll, company] = res.map((r) => (r.data ?? []) as unknown as Row[]);

  const fits = (r: Row) => !model || r.model == null || (r.model === model && (!make || r.make == null || r.make === make));
  const part = partAll.filter(fits);
  const diagram = diagramAll.filter(fits);
  const pid = new Set(part.map((p) => String(p.id)));
  const did = new Set(diagram.map((d) => String(d.id)));
  const ofPart = (rows: Row[]) => rows.filter((r) => pid.has(String(r.part_id)));

  // Internal category names that mean nothing to the public (same as public-catalogue).
  const PUBLIC_CATEGORY: Record<string, string> = { "New from Zoho": "Other parts" };
  for (const c of category) c.name = PUBLIC_CATEGORY[c.name as string] ?? c.name;

  const out = {
    generated_at: new Date().toISOString(),
    category, brand, part,
    part_xref: ofPart(part_xref),
    vehicle_model,
    part_fitment: ofPart(part_fitment),
    part_image: ofPart(part_image),
    diagram,
    part_diagram_callout: ofPart(part_diagram_callout).filter((c) => did.has(String(c.diagram_id))),
    // An unlinked marker stays (the app shows it as such); one on a part that is
    // not public is dropped.
    hotspot: hotspotAll.filter((h) => did.has(String(h.diagram_id)) && (h.part_id == null || pid.has(String(h.part_id)))),
    company: company.slice(0, 1),
  };
  return json(out, 200, { "Cache-Control": "public, max-age=300, s-maxage=300" });
});
