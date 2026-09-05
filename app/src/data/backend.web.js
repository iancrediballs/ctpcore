import { makeUuid } from "./uuid";
import { powerSync } from "../sync/system";
import { supabase } from "../sync/supabase";
// ─── plumbing ────────────────────────────────────────────────────────────────
let readyOnce = null;
/** PowerSync must be open before any read. Safe to call on every query. */
function ready() {
    if (!readyOnce)
        readyOnce = powerSync.init();
    return readyOnce;
}
async function all(sql, params = []) {
    await ready();
    return powerSync.getAll(sql, params);
}
async function one(sql, params = []) {
    await ready();
    return powerSync.getOptional(sql, params);
}
/**
 * A PowerSync text id as the integer the UI expects. Throws rather than
 * returning a wrong-but-plausible id: every view types partId as `number`, so a
 * silent 0 here would surface as "part not found" three layers away.
 */
function numId(v, what = "id") {
    const n = Number(v);
    if (!Number.isInteger(n)) {
        throw new Error(`[CTP web] ${what} "${String(v)}" is not an integer id. The desktop UI ` +
            `indexes parts by integer id; if the backend moved to UUIDs, the data ` +
            `seam (src/data) needs to carry string ids end to end.`);
    }
    return n;
}
const bool = (v) => Number(v) !== 0;
const str = (v) => (v == null ? "" : String(v));
const nstr = (v) => (v == null || v === "" ? null : String(v));
const nnum = (v) => (v == null ? null : Number(v));
// ─── the part_detail view, re-expressed ──────────────────────────────────────
// Mirrors migrations/0013_pricing_reset.sql's CREATE VIEW part_detail — the
// current definition, column for column, with no gaps.
//
// It used to have two holes (diagram_item and the ZAR cost), both because the
// backing columns had not reached Postgres or the sync config. Postgres 0016
// landed the data (122 diagram_refs, 159 part_cost rows) and part_cost is now
// carried by the `ctp_staff` sync stream, so both are read for real below.
const PART_DETAIL_SQL = `
  SELECT
    p.id                AS id,
    p.sku               AS sku,
    p.locator           AS locator,
    p.name              AS name,
    p.description       AS description,
    p.side              AS side,
    p.make              AS make,
    p.model             AS model,
    p.drawing_no        AS drawing_no,
    p.diagram_item_no   AS diagram_item_no,
    p.catalogue_pn      AS catalogue_pn,
    p.inventory_pn      AS inventory_pn,
    p.mpn               AS mpn,
    c.code              AS category_code,
    c.name              AS category_name,
    p.status            AS status,
    p.match_status      AS match_status,
    p.notes             AS notes,
    p.list_price_minor  AS list_price_minor,
    COALESCE((SELECT SUM(m.delta) FROM stock_movement m WHERE m.part_id = p.id), 0) AS qty_on_hand,
    (SELECT sp.bin FROM stock_policy sp WHERE sp.part_id = p.id LIMIT 1) AS bin,
    -- Migration 0013 moved landed cost out of the price table (where it sat
    -- mislabelled as tier='list') into part_cost, and made tier='list' the
    -- real list price. USD cost is no longer tracked, so price_usd_minor is
    -- NULL by definition — not a gap. Matches the view exactly.
    NULL                AS price_usd_minor,
    -- Landed COST, newest shipment first. Despite the column name this is what
    -- the view calls price_zar_minor and what Jefrey reads as cost_minor.
    -- part_cost is versioned by valid_from, so ORDER BY matters: without it a
    -- reprice would return whichever historical row SQLite happened to hit.
    (SELECT pc.amount_minor FROM part_cost pc
      WHERE pc.part_id = p.id AND pc.currency = 'ZAR' AND pc.deleted_at IS NULL
      ORDER BY pc.valid_from DESC LIMIT 1) AS price_zar_minor,
    (SELECT pi.path FROM part_image pi
      WHERE pi.part_id = p.id AND pi.deleted_at IS NULL
      ORDER BY pi.is_primary DESC, pi.sort_order LIMIT 1) AS primary_image,
    (SELECT pm.glb_path FROM part_model pm
      WHERE pm.part_id = p.id AND pm.deleted_at IS NULL LIMIT 1) AS model_3d,
    (SELECT d.image_path FROM diagram d
      WHERE d.drawing_key = 'SEC' || p.category_id LIMIT 1) AS diagram_image,
    p.diagram_ref       AS diagram_item
  FROM part p
  JOIN category c ON c.id = p.category_id
  WHERE p.deleted_at IS NULL
`;
/**
 * Fields the browser build cannot fill yet, and why. Logged once per session so
 * a missing value in the UI is explained in the console instead of looking like
 * a bug in the query.
 */
// Verified against Postgres on 2026-08-06: 161/161 live parts resolve to a SEC*
// section view and 122 carry a diagram_ref, so the DATA gaps are closed. What
// remains is not data.
const GAPS = [
    "3D models (.glb) are desktop-only — 37MB is not a thing to hand a phone. " +
        "Photos and diagrams DO resolve on web: they come from the ctp-assets " +
        "bucket via assetUrl(). (This line used to say images were broken on the " +
        "web. They were, until M2; leaving that text in sent the next person " +
        "hunting a bug that had already been fixed.)",
    "jefrey_learn / jefrey_forget — part_alias syncs now, but these are WRITES " +
        "and the PowerSync upload path is not ported yet (M0.3)",
];
let gapsLogged = false;
function noteGaps() {
    if (gapsLogged)
        return;
    gapsLogged = true;
    console.info("[CTP web] known data gaps in this build:\n  - " + GAPS.join("\n  - "));
}
// ─── search: a scan, not an FTS index ────────────────────────────────────────
//
// The desktop ranks by bm25 over an FTS5 trigram index built from
//   sku · mpn · name · locator · catalogue_pn · inventory_pn · brand.name · every xref
// (see migrations 0006/0012). PowerSync mirrors base tables only — there is no
// FTS index to query — so this scans the same field set with instr() and ranks
// in JS. At 173 live parts that is well under a frame; if the catalogue grows an
// order of magnitude, revisit with a client-side FTS5 table kept current by a
// PowerSync watch.
//
// The one honest behavioural difference: ordering. bm25 is a relevance score
// this cannot reproduce, so results are ranked by match specificity instead
// (exact identifier > prefix > substring > xref > name > brand only), tie-broken
// by shorter field then SKU. Same result SET as the desktop, sometimes a
// different order within it.
//
// Parity detail worth keeping: Rust guards on `query.trim().len() < 2`, but the
// index is `tokenize = 'trigram'`, so a 2-character MATCH finds nothing anyway.
// The effective desktop floor is 3, which is what this uses.
const MIN_QUERY = 3;
const SEARCH_SQL = `
  SELECT
    p.id, p.sku, p.name, p.mpn, p.locator, p.catalogue_pn, p.inventory_pn,
    b.name AS brand,
    COALESCE((SELECT SUM(m.delta) FROM stock_movement m WHERE m.part_id = p.id), 0) AS on_hand,
    -- Was ORDER BY (currency <> 'USD') first, preferring a USD row. Migration
    -- 0013 deleted every USD price and stopped tracking USD, so that tiebreak
    -- is dead code that would silently prefer a stale currency if one ever came
    -- back. Newest list price wins, full stop. deleted_at guard added to match
    -- the fallback in partDetail().
    (SELECT pr.amount_minor FROM price pr
      WHERE pr.part_id = p.id AND pr.tier = 'list' AND pr.deleted_at IS NULL
      ORDER BY pr.valid_from DESC LIMIT 1) AS price_cents,
    -- The two extra columns the mobile cards need. The desktop Hit type does
    -- not carry them (Rust search_parts predates the mobile shell); extra
    -- fields on a returned row are invisible to callers that don't read them.
    (SELECT sp.bin FROM stock_policy sp WHERE sp.part_id = p.id LIMIT 1) AS bin,
    (SELECT pi.path FROM part_image pi
      WHERE pi.part_id = p.id AND pi.deleted_at IS NULL
      ORDER BY pi.is_primary DESC, pi.sort_order LIMIT 1) AS thumb,
    (SELECT x.xref_type || ' # ' || x.xref_number FROM part_xref x
      WHERE x.part_id = p.id AND instr(lower(x.xref_number), ?) > 0 LIMIT 1) AS matched_xref,
    (SELECT group_concat(x2.xref_number || ' ' || COALESCE(x2.xref_brand, ''), ' ')
      FROM part_xref x2 WHERE x2.part_id = p.id) AS xref_body
  FROM part p
  LEFT JOIN brand b ON b.id = p.brand_id
  WHERE p.deleted_at IS NULL
    AND (
         instr(lower(p.sku), ?) > 0
      OR instr(lower(COALESCE(p.mpn, '')), ?) > 0
      OR instr(lower(p.name), ?) > 0
      OR instr(lower(COALESCE(p.locator, '')), ?) > 0
      OR instr(lower(COALESCE(p.catalogue_pn, '')), ?) > 0
      OR instr(lower(COALESCE(p.inventory_pn, '')), ?) > 0
      OR instr(lower(COALESCE(b.name, '')), ?) > 0
      OR EXISTS (SELECT 1 FROM part_xref x3
                  WHERE x3.part_id = p.id
                    AND (instr(lower(x3.xref_number), ?) > 0
                      OR instr(lower(COALESCE(x3.xref_brand, '')), ?) > 0))
    )
`;
/** Identifier fields, most specific first — this order drives the ranking. */
const ID_FIELDS = ["sku", "inventory_pn", "catalogue_pn", "locator", "mpn"];
/** Lower is better. Mirrors "how directly did this row match?". */
function score(row, term) {
    const idVals = ID_FIELDS.map((f) => str(row[f]).toLowerCase()).filter(Boolean);
    const xrefs = str(row["xref_body"]).toLowerCase();
    const name = str(row["name"]).toLowerCase();
    let tier = 5; // brand-only match, or nothing more specific
    let width = 999;
    for (const v of idVals) {
        if (v === term) {
            tier = Math.min(tier, 0);
            width = Math.min(width, v.length);
        }
        else if (v.startsWith(term)) {
            tier = Math.min(tier, 1);
            width = Math.min(width, v.length);
        }
        else if (v.includes(term)) {
            tier = Math.min(tier, 2);
            width = Math.min(width, v.length);
        }
    }
    if (tier > 2 && xrefs.includes(term)) {
        tier = 3;
        width = Math.min(width, xrefs.length);
    }
    if (tier > 3 && name.includes(term)) {
        tier = 4;
        width = Math.min(width, name.length);
    }
    return [tier, width, str(row["sku"])];
}
async function searchParts(query) {
    const term = query.trim().toLowerCase();
    if (term.length < MIN_QUERY)
        return [];
    // 1 binding for matched_xref + 9 in the WHERE clause = 10 copies of the term.
    const rows = await all(SEARCH_SQL, Array(10).fill(term));
    const ranked = rows
        .map((r) => ({ r, k: score(r, term) }))
        .sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.k[2].localeCompare(b.k[2]))
        .slice(0, 50);
    return ranked.map(({ r }) => {
        const sku = str(r["sku"]);
        // Explain WHY it matched, exactly as Rust does: a matching xref wins, then
        // locator / inventory # / catalogue #, else fall back to the SKU. A name-only
        // or mpn-only hit falls through to "part <sku>" on the desktop too — that is
        // parity, not an omission.
        let matched_on = nstr(r["matched_xref"]);
        if (!matched_on) {
            if (str(r["locator"]).toLowerCase().includes(term)) {
                matched_on = `locator ${str(r["locator"])}`;
            }
            else if (str(r["inventory_pn"]).toLowerCase().includes(term)) {
                matched_on = `inventory # ${str(r["inventory_pn"])}`;
            }
            else if (str(r["catalogue_pn"]).toLowerCase().includes(term)) {
                matched_on = `catalogue # ${str(r["catalogue_pn"])}`;
            }
        }
        return {
            id: numId(r["id"], "part.id"),
            sku,
            name: str(r["name"]),
            brand: nstr(r["brand"]),
            on_hand: Number(r["on_hand"]),
            price_cents: nnum(r["price_cents"]),
            matched_on: matched_on ?? `part ${sku}`,
            bin: nstr(r["bin"]),
            thumb: nstr(r["thumb"]),
        };
    });
}
// ─── part detail ─────────────────────────────────────────────────────────────
async function partDetail(partId) {
    noteGaps();
    const pid = String(partId);
    const d = await one(`SELECT * FROM (${PART_DETAIL_SQL}) WHERE id = ?`, [pid]);
    if (!d)
        throw new Error(`[CTP web] part ${partId} not found (or soft-deleted).`);
    const brand = await one(`SELECT b.name AS brand FROM part p LEFT JOIN brand b ON b.id = p.brand_id WHERE p.id = ?`, [pid]);
    const images = await all(`SELECT id, path, kind, is_primary FROM part_image
      WHERE part_id = ? AND deleted_at IS NULL
      ORDER BY is_primary DESC, sort_order`, [pid]);
    // Every location, left-joined, so empty ones still show a 0 line.
    const stock = await all(`SELECT l.id, l.code, l.name,
            COALESCE((SELECT SUM(m.delta) FROM stock_movement m
                       WHERE m.location_id = l.id AND m.part_id = ?), 0) AS on_hand,
            sp.bin, sp.reorder_point, sp.reorder_qty
       FROM location l
       LEFT JOIN stock_policy sp ON sp.location_id = l.id AND sp.part_id = ?
      WHERE l.deleted_at IS NULL
      ORDER BY CAST(l.id AS INTEGER)`, [pid, pid]);
    // Order by timestamp, not id. Locally-posted movements carry a UUID id until
    // the server acknowledges them and syncs back the bigint row; CAST(uuid AS
    // INTEGER) is 0, which would pin every fresh movement to the BOTTOM of the
    // ledger — exactly the row the person is looking for.
    const ledger = await all(`SELECT m.id, l.code AS location_code, m.delta, m.reason, m.created_at
       FROM stock_movement m JOIN location l ON l.id = m.location_id
      WHERE m.part_id = ?
      ORDER BY m.created_at DESC, m.id DESC LIMIT 25`, [pid]);
    // Rust: COALESCE(price_usd_minor, latest tier='list' in any currency).
    let priceCents = nnum(d["price_usd_minor"]);
    if (priceCents == null) {
        const fallback = await one(`SELECT amount_minor FROM price WHERE part_id = ? AND tier = 'list'
        AND deleted_at IS NULL ORDER BY valid_from DESC LIMIT 1`, [pid]);
        priceCents = nnum(fallback?.["amount_minor"]);
    }
    const stockLines = stock.map((s) => ({
        location_id: numId(s["id"], "location.id"),
        location_code: str(s["code"]),
        location_name: str(s["name"]),
        on_hand: Number(s["on_hand"]),
        bin: nstr(s["bin"]),
        reorder_point: nnum(s["reorder_point"]),
        reorder_qty: nnum(s["reorder_qty"]),
    }));
    return {
        id: numId(d["id"], "part.id"),
        sku: str(d["sku"]),
        locator: nstr(d["locator"]),
        catalogue_pn: nstr(d["catalogue_pn"]),
        inventory_pn: nstr(d["inventory_pn"]),
        mpn: nstr(d["mpn"]),
        name: str(d["name"]),
        side: nstr(d["side"]),
        make: nstr(d["make"]),
        model: nstr(d["model"]),
        drawing_no: nstr(d["drawing_no"]),
        diagram_item_no: nnum(d["diagram_item_no"]),
        category_code: nstr(d["category_code"]),
        category_name: nstr(d["category_name"]),
        match_status: nstr(d["match_status"]),
        notes: nstr(d["notes"]),
        status: nstr(d["status"]),
        brand: nstr(brand?.["brand"]),
        description: nstr(d["description"]),
        price_cents: priceCents,
        list_price_minor: nnum(d["list_price_minor"]),
        total_on_hand: stockLines.reduce((t, s) => t + s.on_hand, 0),
        stock: stockLines,
        // numId() would THROW on the UUID a locally-posted movement carries before
        // its round-trip — taking the whole part sheet down for the seconds (or
        // offline hours) the row sits in the upload queue. Ledger ids are display
        // keys, nothing more, so an unsynced row gets a stable negative stand-in.
        ledger: ledger.map((m, i) => {
            const n = Number(m["id"]);
            return {
                id: Number.isInteger(n) ? n : -(i + 1),
                location_code: str(m["location_code"]),
                delta: Number(m["delta"]),
                reason: str(m["reason"]),
                created_at: str(m["created_at"]),
            };
        }),
        images: images.map((i) => ({
            id: numId(i["id"], "part_image.id"),
            path: str(i["path"]),
            kind: str(i["kind"]),
            is_primary: bool(i["is_primary"]),
        })),
        diagram_image: nstr(d["diagram_image"]),
        diagram_item: nstr(d["diagram_item"]),
        model_3d: nstr(d["model_3d"]),
    };
}
// ─── flat lists ──────────────────────────────────────────────────────────────
async function listParts() {
    noteGaps();
    // price_cents used to read price_usd_minor, which this file defines as a
    // literal NULL — so every row in the Parts table showed a blank price. The
    // desktop's list_parts COALESCEs USD onto the latest tier='list' row, so the
    // correct source post-0013 is simply the list price. Selected alongside the
    // view rather than inside it, because part_detail has no such column.
    const rows = await all(`SELECT v.*,
            (SELECT pr.amount_minor FROM price pr
              WHERE pr.part_id = v.id AND pr.tier = 'list' AND pr.deleted_at IS NULL
              ORDER BY pr.valid_from DESC LIMIT 1) AS list_row_minor
       FROM (${PART_DETAIL_SQL}) v
      ORDER BY v.category_code, v.sku`);
    return rows.map((r) => ({
        id: numId(r["id"], "part.id"),
        sku: str(r["sku"]),
        locator: nstr(r["locator"]),
        name: str(r["name"]),
        side: nstr(r["side"]),
        category_code: nstr(r["category_code"]),
        catalogue_pn: nstr(r["catalogue_pn"]),
        inventory_pn: nstr(r["inventory_pn"]),
        status: nstr(r["status"]),
        match_status: nstr(r["match_status"]),
        qty_on_hand: Number(r["qty_on_hand"]),
        bin: nstr(r["bin"]),
        price_cents: nnum(r["list_row_minor"]) ?? nnum(r["list_price_minor"]),
        // The mobile cards want the actual thumbnail path, not just the boolean.
        // Desktop list_parts has no such field; extra fields are invisible to it.
        image: nstr(r["primary_image"]),
        has_photo: r["primary_image"] != null,
        has_diagram: r["diagram_image"] != null,
        has_model: r["model_3d"] != null,
    }));
}
async function jefreyCatalogue() {
    noteGaps();
    const rows = await all(`SELECT * FROM (${PART_DETAIL_SQL}) ORDER BY CAST(id AS INTEGER)`);
    return rows.map((r) => ({
        id: numId(r["id"], "part.id"),
        sku: str(r["sku"]),
        name: str(r["name"]),
        side: nstr(r["side"]),
        inv_pn: nstr(r["inventory_pn"]),
        cat_pn: nstr(r["catalogue_pn"]),
        locator: nstr(r["locator"]),
        section: nstr(r["category_name"]),
        loc: nstr(r["bin"]),
        qty: Number(r["qty_on_hand"]),
        cost_minor: nnum(r["price_zar_minor"]),
        list_minor: nnum(r["list_price_minor"]),
        dwg: nstr(r["drawing_no"]),
        has_photo: r["primary_image"] != null,
        notes: nstr(r["notes"]),
        match_status: nstr(r["match_status"]),
    }));
}
// Web-only (no Rust counterpart): the mobile home page's section cards.
//
// Each card gets TWO pictures and the UI falls back from the first to the
// second: `image` is the "where is it on the lorry" locator — the truck
// line-art with this section lit up, generated by server/make_sections.py and
// keyed by category CODE, so no database row points at it and adding a
// category cannot break a query. `diagram` is the OEM exploded view, which is
// authoritative but too fine-lined to read at card size.
async function listSections() {
    const rows = await all(`SELECT c.id, c.code, c.name,
            (SELECT d.image_path FROM diagram d WHERE d.drawing_key = 'SEC' || c.id LIMIT 1) AS diagram,
            (SELECT COUNT(*) FROM part p WHERE p.category_id = c.id AND p.deleted_at IS NULL) AS parts
       FROM category c WHERE c.deleted_at IS NULL ORDER BY c.code`);
    return rows.map((r) => ({
        id: numId(r["id"], "category.id"),
        code: str(r["code"]),
        name: str(r["name"]),
        // `_v2` is a cache-buster, not decoration: the bucket serves
        // `immutable, max-age=1y` and the service worker caches images
        // first-hit-wins, so a redrawn locator MUST arrive under a new key or
        // phones keep the old one forever. make_sections.py's SUFFIX and this
        // string move together.
        image: `assets/sections/${str(r["code"])}_v2.png`,
        diagram: nstr(r["diagram"]),
        parts: Number(r["parts"]),
    }));
}
async function listCategories() {
    const rows = await all(`SELECT id, code, name FROM category WHERE deleted_at IS NULL ORDER BY code`);
    return rows.map((r) => ({
        id: numId(r["id"], "category.id"),
        code: str(r["code"]),
        name: str(r["name"]),
    }));
}
async function listLocations() {
    const rows = await all(`SELECT id, code, name FROM location WHERE deleted_at IS NULL ORDER BY CAST(id AS INTEGER)`);
    return rows.map((r) => ({
        id: numId(r["id"], "location.id"),
        code: str(r["code"]),
        name: str(r["name"]),
    }));
}
async function getCompany() {
    // Rust reads `WHERE id=1`; there is only ever one company row.
    const c = (await one(`SELECT name, address, phone, email, tax_id, currency, terms
                 FROM company WHERE id = '1'`)) ??
        (await one(`SELECT name, address, phone, email, tax_id, currency, terms
                 FROM company LIMIT 1`));
    if (!c)
        throw new Error("[CTP web] no company row has synced yet.");
    return {
        name: str(c["name"]),
        address: nstr(c["address"]),
        phone: nstr(c["phone"]),
        email: nstr(c["email"]),
        tax_id: nstr(c["tax_id"]),
        currency: str(c["currency"]),
        terms: nstr(c["terms"]),
    };
}
// ─── the first write: post_movement ──────────────────────────────────────────
//
// Mirrors the Rust command's contract exactly:
//   * sign policy lives HERE, not in the UI: receipt/return force +|delta|,
//     sale forces -|delta|, adjustment takes the delta as given. A UI bug can
//     therefore never book a sale that ADDS stock.
//   * zero-delta movements are refused — an empty ledger row is noise.
//   * client_uuid is the idempotency key. The row is INSERTed locally with a
//     generated UUID id; PowerSync queues it, SupabaseConnector uploads it
//     WITHOUT that id (Postgres assigns the bigint identity) and with
//     ON CONFLICT (client_uuid) DO NOTHING, so a retry after a dropped
//     connection can never double-book stock. The ledger is append-only —
//     mistakes are corrected by posting the inverse, never by editing.
//
// Reads pick the local row up instantly (on_hand is SUM(delta) over the local
// table), so the UI updates offline and the sync happens when it happens.
const MOVEMENT_REASONS = ["receipt", "sale", "return", "adjustment"];
/**
 * Move stock between two locations.
 *
 * A transfer is not a special kind of record — it is two ordinary ledger lines
 * that happen to sum to zero: minus n from where it was, plus n where it went.
 * That is the whole point of an append-only ledger. There is nothing to keep
 * consistent afterwards, because on-hand at both locations is derived from the
 * same rows that were just written.
 *
 * Each leg carries its OWN client_uuid. The upload path upserts on that column
 * with ignoreDuplicates, so a retry after a dropped connection re-sends both
 * legs and books neither of them twice. Two uuids rather than one because they
 * are two rows: sharing a key would make the second leg look like a duplicate
 * of the first and get silently dropped, leaving stock destroyed rather than
 * moved.
 *
 * Not wrapped in a transaction, and it does not need to be: PowerSync applies
 * the local writes in order, and if only the first leg ever reached the server
 * the result is a visible shortfall at one location, not a silent imbalance.
 * A ledger cannot half-succeed into a wrong number — only into an incomplete
 * one, which a count corrects.
 */
async function transferStock(a) {
    const partId = numId(a["partId"], "partId");
    const fromId = numId(a["fromLocationId"], "fromLocationId");
    const toId = numId(a["toLocationId"], "toLocationId");
    const qty = Number(a["qty"]);
    const outUuid = str(a["outUuid"]);
    const inUuid = str(a["inUuid"]);
    const actorId = a["actorId"] == null ? null : String(a["actorId"]);
    if (!Number.isInteger(qty) || qty <= 0) {
        throw new Error("[CTP web] transfer_stock: quantity must be a whole number above zero.");
    }
    if (fromId === toId) {
        throw new Error("[CTP web] transfer_stock: pick two different locations.");
    }
    if (!outUuid || !inUuid || outUuid === inUuid) {
        throw new Error("[CTP web] transfer_stock: each leg needs its own idempotency key.");
    }
    await ready();
    const now = new Date().toISOString();
    const leg = async (locationId, delta, clientUuid) => powerSync.execute(`INSERT INTO stock_movement (id, part_id, location_id, delta, reason, client_uuid, actor_id, created_at)
       VALUES (?, ?, ?, ?, 'transfer', ?, ?, ?)`, [makeUuid(), String(partId), String(locationId), delta, clientUuid, actorId, now]);
    await leg(fromId, -qty, outUuid);
    await leg(toId, qty, inUuid);
    return qty;
}
async function postMovement(a) {
    const partId = numId(a["partId"], "partId");
    const locationId = numId(a["locationId"], "locationId");
    const raw = Number(a["delta"]);
    const reason = str(a["reason"]);
    const clientUuid = str(a["clientUuid"]);
    const actorId = a["actorId"] == null ? null : String(a["actorId"]);
    if (!Number.isInteger(raw) || raw === 0) {
        throw new Error(`[CTP web] post_movement: delta must be a non-zero integer, got "${String(a["delta"])}".`);
    }
    if (!MOVEMENT_REASONS.includes(reason)) {
        throw new Error(`[CTP web] post_movement: reason "${reason}" is not one of ${MOVEMENT_REASONS.join("/")}.`);
    }
    if (!clientUuid) {
        throw new Error("[CTP web] post_movement: clientUuid is required (it is the idempotency key).");
    }
    const delta = reason === "sale" ? -Math.abs(raw)
        : reason === "receipt" || reason === "return" ? Math.abs(raw)
            : raw;
    await ready();
    await powerSync.execute(`INSERT INTO stock_movement (id, part_id, location_id, delta, reason, client_uuid, actor_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
        makeUuid(),
        String(partId),
        String(locationId),
        delta,
        reason,
        clientUuid,
        actorId,
        new Date().toISOString(),
    ]);
    return delta;
}
// ─── a client's own requests and quotes ──────────────────────────────────────
//
// Reads the local database, so it works offline and updates itself the moment
// staff price the quote server-side. Only the client's own orders are here at
// all — the ctp_client_orders bucket is parameterised on their customer row —
// so this needs no WHERE on identity, and must not pretend to be a security
// boundary by adding one.
async function myRequests() {
    const orders = await all(`SELECT id, number, status, currency, notes, created_at,
            client_response, client_responded_at
       FROM sales_order
      WHERE deleted_at IS NULL
      ORDER BY created_at DESC, CAST(id AS INTEGER) DESC
      LIMIT 50`);
    const out = [];
    for (const o of orders) {
        const lines = await all(`SELECT sl.id, sl.qty, sl.unit_price_minor, p.sku, p.name, p.catalogue_pn
         FROM sales_line sl LEFT JOIN part p ON p.id = sl.part_id
        WHERE sl.order_id = ? AND sl.deleted_at IS NULL
        ORDER BY CAST(sl.id AS INTEGER)`, [String(o["id"])]);
        const mapped = lines.map((l) => ({
            id: numId(l["id"], "sales_line.id"),
            qty: Number(l["qty"]),
            unit_price_minor: nnum(l["unit_price_minor"]),
            sku: str(l["sku"]),
            // A line whose part has not synced still has to render — it is their
            // order either way, and a blank row reads as data loss.
            name: nstr(l["name"]) ?? "(part unavailable)",
            catalogue_pn: nstr(l["catalogue_pn"]),
        }));
        const priced = mapped.length > 0 && mapped.every((l) => (l.unit_price_minor ?? 0) > 0);
        out.push({
            id: numId(o["id"], "sales_order.id"),
            number: str(o["number"]),
            status: str(o["status"]),
            currency: str(o["currency"]),
            notes: nstr(o["notes"]),
            created_at: str(o["created_at"]),
            client_response: nstr(o["client_response"]),
            client_responded_at: nstr(o["client_responded_at"]),
            priced,
            total_minor: mapped.reduce((t, l) => t + (l.unit_price_minor ?? 0) * l.qty, 0),
            lines: mapped,
        });
    }
    return out;
}
// ─── the staff order desk ────────────────────────────────────────────────────
//
// Reads from the local database, which for staff carries every order via the
// ctp_data bucket. Grouped by what the order is WAITING ON rather than by its
// status name, because "quote" means two different jobs depending on whether
// anyone has priced it: one is ours, one is the customer's.
async function staffOrders() {
    const orders = await all(`SELECT so.id, so.number, so.status, so.currency, so.notes, so.created_at,
            so.client_response, so.client_responded_at,
            c.name AS customer_name, c.contact AS customer_contact
       FROM sales_order so LEFT JOIN customer c ON c.id = so.customer_id
      WHERE so.deleted_at IS NULL
      ORDER BY so.created_at DESC, CAST(so.id AS INTEGER) DESC
      LIMIT 60`);
    const out = [];
    for (const o of orders) {
        const lines = await all(`SELECT sl.id, sl.qty, sl.unit_price_minor, sl.part_id,
              p.sku, p.name, p.catalogue_pn
         FROM sales_line sl LEFT JOIN part p ON p.id = sl.part_id
        WHERE sl.order_id = ? AND sl.deleted_at IS NULL
        ORDER BY CAST(sl.id AS INTEGER)`, [String(o["id"])]);
        const mapped = lines.map((l) => ({
            id: numId(l["id"], "sales_line.id"),
            part_id: numId(l["part_id"], "part_id"),
            qty: Number(l["qty"]),
            unit_price_minor: Number(l["unit_price_minor"] ?? 0),
            sku: str(l["sku"]),
            name: nstr(l["name"]) ?? "(part unavailable)",
            catalogue_pn: nstr(l["catalogue_pn"]),
        }));
        const status = str(o["status"]);
        const unpriced = mapped.filter((l) => l.unit_price_minor <= 0).length;
        out.push({
            id: numId(o["id"], "sales_order.id"),
            number: str(o["number"]),
            status,
            customer_name: nstr(o["customer_name"]) ?? "—",
            customer_contact: nstr(o["customer_contact"]),
            notes: nstr(o["notes"]),
            created_at: str(o["created_at"]),
            client_response: nstr(o["client_response"]),
            client_responded_at: nstr(o["client_responded_at"]),
            unpriced,
            total_minor: mapped.reduce((t, l) => t + l.unit_price_minor * l.qty, 0),
            // The queue this order sits in. Derived here so every surface agrees.
            stage: status === "quote" && (unpriced > 0 || mapped.length === 0) ? "to_price"
                : status === "quote" ? "with_customer"
                    : status === "confirmed" ? "to_pick"
                        : status,
            lines: mapped,
        });
    }
    return out;
}
async function priceQuote(a) {
    const orderId = numId(a["orderId"], "orderId");
    const raw = Array.isArray(a["lines"]) ? a["lines"] : [];
    const lines = raw.map((it) => {
        const o = (it ?? {});
        return { line_id: Number(o["line_id"]), unit_price_minor: Math.round(Number(o["unit_price_minor"])) };
    }).filter((l) => Number.isInteger(l.line_id) && l.unit_price_minor > 0);
    if (lines.length === 0)
        throw new Error("[CTP web] no prices to save.");
    const { data, error } = await supabase.rpc("price_quote", { order_id: orderId, lines });
    if (error)
        throw new Error(`[CTP web] could not save prices: ${error.message}`);
    return data;
}
async function fillFromList(a) {
    const orderId = numId(a["orderId"], "orderId");
    const { data, error } = await supabase.rpc("fill_quote_from_list", { order_id: orderId });
    if (error)
        throw new Error(`[CTP web] could not fill prices: ${error.message}`);
    return data;
}
/** Accept or decline a quote. All the rules live in the database (0021). */
async function respondToQuote(a) {
    const orderId = numId(a["orderId"], "orderId");
    const accept = a["accept"] === true;
    const { data, error } = await supabase.rpc("respond_to_quote", {
        order_id: orderId,
        accept,
    });
    if (error)
        throw new Error(`[CTP web] could not send your answer: ${error.message}`);
    return data;
}
// ─── staff photo admin ───────────────────────────────────────────────────────
//
// Same doctrine as the order RPCs: the phone holds no table write grants, so
// each of these is a SECURITY DEFINER function (0024) that checks is_staff()
// against the app_user ROW. Hiding the buttons from clients is cosmetic; the
// function is the control.
//
// Deleting touches two worlds in a fixed order: the ROW first (soft delete —
// every reader filters deleted_at, so the photo vanishes from all devices on
// the next sync pass), then the storage OBJECT, best-effort. A row without a
// file is invisible; a file without a row is merely untidy. The reverse order
// could leave a broken image on every phone if the second step failed.
async function adminDeletePhoto(a) {
    const imageId = numId(a["imageId"], "imageId");
    const { data, error } = await supabase.rpc("admin_delete_photo", { image_id: imageId });
    if (error)
        throw new Error(`[CTP web] could not delete the photo: ${error.message}`);
    const path = data?.["path"];
    if (typeof path === "string" && path.startsWith("assets/photos/")) {
        const { error: se } = await supabase.storage.from("ctp-assets").remove([path]);
        if (se)
            console.warn("[CTP web] photo row retired but the file stayed behind:", se.message);
    }
    return data;
}
async function adminSetPrimaryPhoto(a) {
    const imageId = numId(a["imageId"], "imageId");
    const { data, error } = await supabase.rpc("admin_set_primary_photo", { image_id: imageId });
    if (error)
        throw new Error(`[CTP web] could not set the primary photo: ${error.message}`);
    return data;
}
// Upload the FILE first, then register the ROW — the opposite order would
// leave every device rendering a broken image while the upload ran. Keys
// follow the same pattern the desktop sync uses (p{part}_{ms}_{name}) and a
// fresh timestamp every time, because the bucket caches immutably for a year:
// there is no such thing as replacing a key, only minting a new one.
async function adminAddPhoto(a) {
    const partId = numId(a["partId"], "partId");
    const blob = a["blob"];
    if (!(blob instanceof Blob) || blob.size === 0) {
        throw new Error("[CTP web] no image to upload.");
    }
    const stem = String(a["filename"] ?? "photo")
        .replace(/\.[^.]*$/, "")
        .replace(/[^A-Za-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "photo";
    const ext = blob.type === "image/png" ? "png" : "jpg";
    const path = `assets/photos/p${partId}_${Date.now()}_${stem}.${ext}`;
    const { error: ue } = await supabase.storage.from("ctp-assets")
        .upload(path, blob, { contentType: blob.type || "image/jpeg", cacheControl: "31536000" });
    if (ue)
        throw new Error(`[CTP web] upload failed: ${ue.message}`);
    const { data, error } = await supabase.rpc("admin_add_photo", { part_id: partId, path });
    if (error) {
        // The file made it up but the row didn't. Sweep the orphan so a retry
        // doesn't collide with a half-registered key.
        await supabase.storage.from("ctp-assets").remove([path]).catch(() => undefined);
        throw new Error(`[CTP web] could not register the photo: ${error.message}`);
    }
    return data;
}
// ─── what is actually on this device ─────────────────────────────────────────
//
// Counts rows in the local database, table by table. This exists because of a
// specific failure mode: sync rules are the ONLY thing keeping cost and margin
// off a customer's phone (PowerSync replicates as powersync_role, which
// bypasses RLS), and a rule that syncs nothing looks exactly like a rule that
// was never written. You cannot tell from the dashboard. You can tell from
// here.
//
// Deliberately NOT a generic "run this SQL" hole — the table list is fixed and
// only counts are returned, so this can answer "did cost reach me?" without
// ever becoming a way to read what it contains.
const AUDIT_TABLES = [
    "part", "part_image", "diagram", "category", // expected on every device
    "part_cost", "price", "price_tier", // money — staff only
    "stock_policy", "stock_movement", "location", // bins + movements — staff only
    "customer", "sales_order", "sales_line", // other people's business
    "part_alias",
];
async function deviceAudit() {
    await ready();
    const out = [];
    for (const t of AUDIT_TABLES) {
        try {
            const r = await powerSync.getOptional(`SELECT count(*) AS n FROM ${t}`);
            out.push({ table: t, rows: Number(r?.n ?? 0) });
        }
        catch {
            // table absent from the local schema entirely — also an answer, and a
            // safer one than a missing row.
            out.push({ table: t, rows: -1 });
        }
    }
    return out;
}
// ─── a customer asking for parts ─────────────────────────────────────────────
//
// The ONE write in this file that does not go through PowerSync. Migration
// 0020's `request_parts` creates the order and its lines in a single server
// transaction, because a request is a parent row plus children that reference
// it, and PowerSync does not map a local id onto the server-assigned one — the
// lines would point at an order id that no longer exists after upload.
//
// The trade is that this needs signal. That is the right trade here and the
// wrong one for the stock counter, which is why they are built differently:
// nobody submits a parts enquiry from a dead spot in the warehouse, but people
// count stock there all day.
async function requestParts(a) {
    const raw = Array.isArray(a["items"]) ? a["items"] : [];
    const items = raw
        .map((it) => {
        const o = (it ?? {});
        return { part_id: Number(o["part_id"]), qty: Number(o["qty"] ?? 1) };
    })
        .filter((i) => Number.isInteger(i.part_id) && i.qty > 0);
    if (items.length === 0)
        throw new Error("[CTP web] request_parts: nothing to request.");
    const note = a["note"] == null ? null : String(a["note"]).slice(0, 2000);
    const { data, error } = await supabase.rpc("request_parts", { items, note });
    if (error) {
        // The function raises readable messages for the cases that matter (no
        // customer link, unknown part). Surface them rather than a generic failure.
        throw new Error(`[CTP web] request failed: ${error.message}`);
    }
    return data;
}
// ─── registry ────────────────────────────────────────────────────────────────
const PORTED = {
    search_parts: (a) => searchParts(String(a["query"] ?? "")),
    part_detail: (a) => partDetail(Number(a["partId"])),
    list_parts: () => listParts(),
    list_categories: () => listCategories(),
    list_sections: () => listSections(),
    list_locations: () => listLocations(),
    jefrey_catalogue: () => jefreyCatalogue(),
    get_company: () => getCompany(),
    post_movement: (a) => postMovement(a),
    transfer_stock: (a) => transferStock(a),
    request_parts: (a) => requestParts(a),
    my_requests: () => myRequests(),
    respond_to_quote: (a) => respondToQuote(a),
    staff_orders: () => staffOrders(),
    price_quote: (a) => priceQuote(a),
    fill_quote_from_list: (a) => fillFromList(a),
    device_audit: () => deviceAudit(),
    admin_delete_photo: (a) => adminDeletePhoto(a),
    admin_set_primary_photo: (a) => adminSetPrimaryPhoto(a),
    admin_add_photo: (a) => adminAddPhoto(a),
};
export const webBackend = {
    async call(cmd, args) {
        const handler = PORTED[cmd];
        if (!handler) {
            throw new Error(`[CTP web] "${cmd}" is not available in the browser build yet. ` +
                `It still lives in the Rust layer — port it in src/data/backend.web.ts.`);
        }
        return (await handler(args ?? {}));
    },
};
/** True when a command works in the browser build. Use to hide desktop-only UI on mobile. */
export function isPortedToWeb(cmd) {
    return cmd in PORTED;
}
