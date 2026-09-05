// PowerSync client schema — the shape of the local synced SQLite (Phase B1).
// Mirrors the server tables in server/sync-streams.yaml. PowerSync auto-adds a
// text `id` column to every table, so we do NOT declare id here. All FK id
// columns are text on the client (PowerSync ids are text). Money = integer minor
// units; timestamps = text; is_primary/is_oem/flags = integer (0/1/rank).
import { column, Schema, Table } from "@powersync/web";
const category = new Table({
    parent_id: column.text, code: column.text, name: column.text, path: column.text,
    rev: column.integer, updated_at: column.text, deleted_at: column.text, origin: column.text,
});
const brand = new Table({
    code: column.text, name: column.text, is_oem: column.integer,
    rev: column.integer, updated_at: column.text, deleted_at: column.text, origin: column.text,
});
const part = new Table({
    sku: column.text, mpn: column.text, brand_id: column.text, category_id: column.text,
    name: column.text, description: column.text, uom: column.text, weight_g: column.integer,
    status: column.text, superseded_by: column.text, make: column.text, model: column.text,
    drawing_no: column.text, diagram_item_no: column.integer, locator: column.text,
    catalogue_pn: column.text, inventory_pn: column.text, side: column.text,
    match_status: column.text, notes: column.text, list_price_minor: column.integer,
    // diagram_ref: the balloon number to highlight on the part's category section
    // view. Text, not integer — refs like 'A1' exist. Added by SQLite 0010 and
    // Postgres 0014/0016; 122 of the 161 live parts carry one.
    diagram_ref: column.text,
    rev: column.integer, updated_at: column.text, deleted_at: column.text, origin: column.text,
}, { indexes: { cat: ["category_id"], locator: ["locator"] } });
const part_xref = new Table({
    part_id: column.text, xref_number: column.text, xref_brand: column.text,
    xref_type: column.text, confidence: column.integer,
    rev: column.integer, updated_at: column.text, deleted_at: column.text, origin: column.text,
}, { indexes: { part: ["part_id"] } });
const vehicle_model = new Table({
    make: column.text, model: column.text, variant: column.text,
    rev: column.integer, updated_at: column.text, deleted_at: column.text, origin: column.text,
});
const part_fitment = new Table({
    part_id: column.text, vehicle_id: column.text, engine: column.text,
    year_from: column.integer, year_to: column.integer, note: column.text,
    rev: column.integer, updated_at: column.text, deleted_at: column.text, origin: column.text,
}, { indexes: { part: ["part_id"], vehicle: ["vehicle_id"] } });
const location = new Table({
    code: column.text, name: column.text,
    rev: column.integer, updated_at: column.text, deleted_at: column.text, origin: column.text,
});
const stock_movement = new Table({
    part_id: column.text, location_id: column.text, delta: column.integer, reason: column.text,
    ref_type: column.text, ref_id: column.text, actor_id: column.text, client_uuid: column.text,
    created_at: column.text, origin: column.text,
}, { indexes: { partloc: ["part_id", "location_id"] } });
const stock_policy = new Table({
    part_id: column.text, location_id: column.text, bin: column.text,
    reorder_point: column.integer, reorder_qty: column.integer,
    rev: column.integer, updated_at: column.text, deleted_at: column.text, origin: column.text,
}, { indexes: { part: ["part_id"] } });
const price = new Table({
    part_id: column.text, tier: column.text, currency: column.text, amount_minor: column.integer,
    valid_from: column.text, rev: column.integer, updated_at: column.text,
    deleted_at: column.text, origin: column.text,
}, { indexes: { part: ["part_id"] } });
const customer = new Table({
    code: column.text, name: column.text, contact: column.text, phone: column.text,
    email: column.text, price_tier: column.text, notes: column.text, auth_user_id: column.text,
    rev: column.integer, updated_at: column.text, deleted_at: column.text, origin: column.text,
}, { indexes: { auth: ["auth_user_id"] } });
const sales_order = new Table({
    number: column.text, customer_id: column.text, location_id: column.text, status: column.text,
    currency: column.text, notes: column.text, fulfilled_at: column.text, tax_rate_bps: column.integer,
    // what the CUSTOMER did, kept apart from `status`, which staff own (0021)
    client_response: column.text, client_responded_at: column.text,
    rev: column.integer, created_at: column.text, updated_at: column.text,
    deleted_at: column.text, origin: column.text,
}, { indexes: { customer: ["customer_id"], status: ["status"] } });
const sales_line = new Table({
    order_id: column.text, part_id: column.text, qty: column.integer,
    unit_price_minor: column.integer, tier_at_add: column.text,
    // Denormalised from the order by a database trigger (0021). Sync rules
    // cannot join, so without this a client's own lines are unreachable —
    // sales_line knows its order, and the customer is one hop past that.
    customer_id: column.text,
    rev: column.integer, updated_at: column.text, deleted_at: column.text, origin: column.text,
}, { indexes: { order: ["order_id"], customer: ["customer_id"] } });
const company = new Table({
    name: column.text, address: column.text, phone: column.text, email: column.text,
    tax_id: column.text, currency: column.text, terms: column.text,
    rev: column.integer, updated_at: column.text, origin: column.text,
});
const diagram = new Table({
    drawing_key: column.text, title: column.text, section_code: column.text, make: column.text,
    model: column.text, image_path: column.text, model_3d_path: column.text, source: column.text,
    img_w: column.integer, img_h: column.integer,
    rev: column.integer, updated_at: column.text, deleted_at: column.text, origin: column.text,
});
const part_diagram_callout = new Table({
    part_id: column.text, diagram_id: column.text, item_no: column.integer, is_primary: column.integer,
    rev: column.integer, updated_at: column.text, deleted_at: column.text, origin: column.text,
}, { indexes: { diagram: ["diagram_id"], part: ["part_id"] } });
const part_image = new Table({
    part_id: column.text, path: column.text, kind: column.text, is_primary: column.integer,
    sort_order: column.integer, caption: column.text,
    rev: column.integer, updated_at: column.text, deleted_at: column.text, origin: column.text,
}, { indexes: { part: ["part_id"] } });
const part_model = new Table({
    part_id: column.text, glb_path: column.text, format: column.text, source: column.text,
    rev: column.integer, updated_at: column.text, deleted_at: column.text, origin: column.text,
}, { indexes: { part: ["part_id"] } });
const hotspot = new Table({
    diagram_id: column.text, part_id: column.text, item_no: column.text,
    x: column.real, y: column.real, radius: column.real,
    rev: column.integer, updated_at: column.text, deleted_at: column.text, origin: column.text,
}, { indexes: { diagram: ["diagram_id"], part: ["part_id"] } });
// ── staff-only tables (sync stream `ctp_staff`) ──────────────────────────────
// These carry what we paid and how low we will discount. They are in a separate
// sync stream precisely so they can be withheld from a customer login later;
// see the warning at the top of server/sync-streams.yaml.
// Landed cost, versioned by shipment date. Read the newest row per (part,
// currency) — never assume one row per part.
const part_cost = new Table({
    part_id: column.text, currency: column.text, amount_minor: column.integer,
    valid_from: column.text, source: column.text,
    rev: column.integer, updated_at: column.text, deleted_at: column.text, origin: column.text,
}, { indexes: { part: ["part_id"] } });
// Discount tiers. min_margin_bps is the floor a trade discount may not cut
// through — the guard that stops a discount selling below cost.
const price_tier = new Table({
    code: column.text, name: column.text,
    discount_bps: column.integer, min_margin_bps: column.integer,
    rev: column.integer, updated_at: column.text, deleted_at: column.text, origin: column.text,
}, { indexes: { code: ["code"] } });
// Jefrey's learned phrase→part mappings. polarity +1 teaches, -1 un-teaches.
const part_alias = new Table({
    phrase_norm: column.text, part_id: column.text, polarity: column.integer,
    hits: column.integer, source: column.text, created_at: column.text,
    rev: column.integer, updated_at: column.text, deleted_at: column.text, origin: column.text,
}, { indexes: { phrase: ["phrase_norm"], part: ["part_id"] } });
export const AppSchema = new Schema({
    category, brand, part, part_xref, vehicle_model, part_fitment, location,
    stock_movement, stock_policy, price, customer, sales_order, sales_line,
    company, diagram, part_diagram_callout, part_image, part_model, hotspot,
    part_cost, price_tier, part_alias,
});
