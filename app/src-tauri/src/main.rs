// Prevent a console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::path::PathBuf;
use tauri::{Manager, State};

/// One search result row sent to the UI.
#[derive(Serialize)]
struct Hit {
    id: i64,
    sku: String,
    name: String,
    brand: Option<String>,
    on_hand: i64,
    price_cents: Option<i64>,
    matched_on: String,
}

struct Db(Mutex<Connection>);

/// Build the local SQLite database on first launch: schema + seed.
/// The migration SQL is the SAME verified files the Postgres spine mirrors.
fn init_db(path: &PathBuf) -> rusqlite::Result<Connection> {
    let fresh = !path.exists();
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
    )?;
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;

    // Versioned migration runner keyed on PRAGMA user_version, so new
    // migrations apply in order without wiping an existing local DB.
    let mut ver: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;

    if fresh {
        // Baseline (v1): core spine + seed.
        conn.execute_batch(include_str!("../migrations/0001_schema.sql"))?;
        conn.execute_batch(include_str!("../migrations/0002_seed.sql"))?;
        conn.execute_batch("PRAGMA user_version = 1;")?;
        ver = 1;
    } else if ver == 0 {
        // DB created before versioning already carries 0001+0002.
        conn.execute_batch("PRAGMA user_version = 1;")?;
        ver = 1;
    }

    // v1 → v2: sales / CRM spine.
    if ver < 2 {
        conn.execute_batch(include_str!("../migrations/0003_sales.sql"))?;
        conn.execute_batch("PRAGMA user_version = 2;")?;
        ver = 2;
    }

    // v2 → v3: accounting export (tax column + outbox).
    if ver < 3 {
        conn.execute_batch(include_str!("../migrations/0004_accounting.sql"))?;
        conn.execute_batch("PRAGMA user_version = 3;")?;
        ver = 3;
    }

    // v3 → v4: company profile (invoice letterhead).
    if ver < 4 {
        conn.execute_batch(include_str!("../migrations/0005_company.sql"))?;
        conn.execute_batch("PRAGMA user_version = 4;")?;
        ver = 4;
    }

    // v4 → v5: part media + internal locator (diagrams, photos, 3D, search rebuild).
    if ver < 5 {
        conn.execute_batch(include_str!("../migrations/0006_media_locator.sql"))?;
        conn.execute_batch("PRAGMA user_version = 5;")?;
        ver = 5;
    }

    // v5 → v6: FAW JH6 Shipment 01 catalogue import (161 parts + media).
    if ver < 6 {
        conn.execute_batch(include_str!("../migrations/0007_jh6_shipment01.sql"))?;
        conn.execute_batch("PRAGMA user_version = 6;")?;
        ver = 6;
    }

    // v6 → v7: diagram hotspots (clickable callouts → part profiles).
    if ver < 7 {
        conn.execute_batch(include_str!("../migrations/0008_hotspots.sql"))?;
        conn.execute_batch("PRAGMA user_version = 7;")?;
        ver = 7;
    }

    // v7 → v8: editable list price (ZAR).
    if ver < 8 {
        conn.execute_batch(include_str!("../migrations/0009_list_price.sql"))?;
        conn.execute_batch("PRAGMA user_version = 8;")?;
        ver = 8;
    }

    // v8 → v9: section diagrams (Ian's compiled per-category views) become the
    // part-panel diagram; text item ref (part.diagram_ref).
    if ver < 9 {
        conn.execute_batch(include_str!("../migrations/0010_section_diagrams.sql"))?;
        conn.execute_batch("PRAGMA user_version = 9;")?;
    }

    // v9 → v10: Jefrey's learned vocabulary (part_alias). Every operator
    // correction is written here, so the assistant improves with use instead
    // of needing to be retrained.
    if ver < 10 {
        conn.execute_batch(include_str!("../migrations/0011_jefrey_alias.sql"))?;
        conn.execute_batch("PRAGMA user_version = 10;")?;
    }

    // v10 → v11: retire the FleetView Phase-0 demo parts (FV-*) that shipped
    // in 0002_seed.sql, and fix the search trigger so a soft-deleted part
    // actually leaves the index.
    if ver < 11 {
        conn.execute_batch(include_str!("../migrations/0012_retire_seed_parts.sql"))?;
        conn.execute_batch("PRAGMA user_version = 11;")?;
    }

    // v11 -> v12: pricing reset. Re-keys list prices onto the right parts, moves
    // landed cost out of the price table into part_cost, loads official ZAR costs
    // (no more flat 17.00 FX), and adds price_tier for discounts + margin floors.
    if ver < 12 {
        conn.execute_batch(include_str!("../migrations/0013_pricing_reset.sql"))?;
        conn.execute_batch("PRAGMA user_version = 12;")?;
        ver = 12;
    }

    // v12 -> v13: real company identity on the letterhead (0005 shipped a
    // placeholder Chinese company and USD; this business is South African and
    // trades in rand).
    if ver < 13 {
        conn.execute_batch(include_str!("../migrations/0014_company_identity.sql"))?;
        conn.execute_batch("PRAGMA user_version = 13;")?;
    }

    Ok(conn)
}

/// Wrap raw user input as an FTS5 string literal so '/', '-', etc. are treated
/// as characters, not query operators. (Learned the hard way — see schema notes.)
fn fts_query(raw: &str) -> String {
    format!("\"{}\"", raw.replace('"', "\"\""))
}

#[tauri::command]
fn search_parts(query: String, db: State<Db>) -> Result<Vec<Hit>, String> {
    if query.trim().len() < 2 {
        return Ok(vec![]);
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    // Rank by FTS bm25; join live on-hand (derived from the ledger) + list price.
    let sql = r#"
        SELECT p.id, p.sku, p.name, b.name AS brand,
               COALESCE((SELECT SUM(delta) FROM stock_movement WHERE part_id = p.id), 0) AS on_hand,
               (SELECT amount_minor FROM price
                 WHERE part_id = p.id AND tier = 'list'
                 ORDER BY (currency <> 'USD'), valid_from DESC LIMIT 1) AS price_cents,
               COALESCE(
                 (SELECT x.xref_type || ' # ' || x.xref_number
                    FROM part_xref x
                   WHERE x.part_id = p.id
                     AND instr(lower(x.xref_number), lower(?2)) > 0
                   LIMIT 1),
                 -- also explain a match on the internal locator or OEM PN
                 CASE WHEN instr(lower(COALESCE(p.locator,'')),      lower(?2)) > 0 THEN 'locator ' || p.locator
                      WHEN instr(lower(COALESCE(p.inventory_pn,'')), lower(?2)) > 0 THEN 'inventory # ' || p.inventory_pn
                      WHEN instr(lower(COALESCE(p.catalogue_pn,'')), lower(?2)) > 0 THEN 'catalogue # ' || p.catalogue_pn
                 END) AS matched_xref
        FROM part_search
        JOIN part p              ON p.id = part_search.part_id
        LEFT JOIN brand b        ON b.id = p.brand_id
        WHERE part_search MATCH ?1
          AND p.deleted_at IS NULL
        ORDER BY bm25(part_search)
        LIMIT 50
    "#;
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![fts_query(&query), query], |r| {
            let matched_xref: Option<String> = r.get(6)?;
            let sku: String = r.get(1)?;
            Ok(Hit {
                id: r.get(0)?,
                sku: sku.clone(),
                name: r.get(2)?,
                brand: r.get(3)?,
                on_hand: r.get(4)?,
                price_cents: r.get(5)?,
                // explain WHY it matched — the counter sees the bridge from
                // the typed number to your SKU.
                matched_on: matched_xref.unwrap_or_else(|| format!("part {}", sku)),
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

// =========================================================================
//  INVENTORY OPS — the append-only ledger is the ONLY thing we mutate.
//  On-hand is always derived (SUM(delta) via the stock_on_hand view), never
//  stored. Every write is idempotent on client_uuid so an offline retry can
//  replay safely without double-counting. This is the whole architectural
//  bet, made concrete.
// =========================================================================

/// Live on-hand for one part at one location (derived from the ledger).
#[derive(Serialize)]
struct StockLine {
    location_id: i64,
    location_code: String,
    location_name: String,
    on_hand: i64,
    bin: Option<String>,
    reorder_point: Option<i64>,
    reorder_qty: Option<i64>,
}

/// One ledger entry, newest first, for the detail panel.
#[derive(Serialize)]
struct LedgerRow {
    id: i64,
    location_code: String,
    delta: i64,
    reason: String,
    created_at: String,
}

/// One product image (relative path under the app's /assets root).
#[derive(Serialize)]
struct PartImage {
    id: i64,
    path: String,
    kind: String,
    is_primary: bool,
}

#[derive(Serialize)]
struct PartDetail {
    id: i64,
    sku: String,
    // three-tier identity (see CTP_Internal_Naming_Convention.md)
    locator: Option<String>,       // FAW-JH6-D314-033  (internal, find-on-diagram)
    catalogue_pn: Option<String>,  // 2803035B1063      (OEM base PN, for reorder)
    inventory_pn: Option<String>,  // 2803035B1063-DQ   (exact received variant)
    mpn: Option<String>,
    name: String,
    side: Option<String>,
    make: Option<String>,
    model: Option<String>,
    drawing_no: Option<String>,
    diagram_item_no: Option<i64>,
    category_code: Option<String>,
    category_name: Option<String>,
    match_status: Option<String>,  // MATCHED / NOT IN CAT (catalogue reconciliation)
    notes: Option<String>,         // discrepancy / supplier-verify note
    status: Option<String>,        // active / superseded / discontinued
    brand: Option<String>,
    description: Option<String>,
    price_cents: Option<i64>,
    list_price_minor: Option<i64>,
    total_on_hand: i64,
    stock: Vec<StockLine>,
    ledger: Vec<LedgerRow>,
    // media — for visual identification at the counter / stock-take
    images: Vec<PartImage>,
    diagram_image: Option<String>, // exploded view this part appears on
    diagram_item: Option<String>,  // section-relative item ref (text, e.g. "A1")
    model_3d: Option<String>,      // optional .glb for the 3D viewer
}

/// Result of posting a movement: the new derived balance at that location.
#[derive(Serialize)]
struct PostResult {
    movement_id: i64,
    location_id: i64,
    on_hand: i64,
    duplicate: bool, // true when the client_uuid was already posted (idempotent no-op)
}

/// Reasons that must increase stock vs. decrease it. 'adjustment' and 'count'
/// may go either way (a correction can add or remove); 'transfer' is posted as
/// a balanced pair via transfer_stock, not here.
fn sign_ok(reason: &str, delta: i64) -> Result<(), String> {
    match reason {
        "receipt" | "return" => {
            if delta > 0 { Ok(()) } else { Err(format!("{reason} must be a positive quantity")) }
        }
        "sale" => {
            if delta < 0 { Ok(()) } else { Err("sale must be a negative quantity".into()) }
        }
        "adjustment" | "count" => {
            if delta != 0 { Ok(()) } else { Err("adjustment cannot be zero".into()) }
        }
        "transfer" => Err("use transfer_stock for transfers".into()),
        other => Err(format!("unknown reason '{other}'")),
    }
}

fn on_hand_at(conn: &Connection, part_id: i64, location_id: i64) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COALESCE(SUM(delta),0) FROM stock_movement WHERE part_id=?1 AND location_id=?2",
        rusqlite::params![part_id, location_id],
        |r| r.get(0),
    )
}

/// Append one stock movement. Idempotent: replaying the same client_uuid is a
/// no-op that returns the existing balance instead of double-posting.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn post_movement(
    part_id: i64,
    location_id: i64,
    delta: i64,
    reason: String,
    client_uuid: String,
    actor_id: Option<i64>,
    db: State<Db>,
) -> Result<PostResult, String> {
    if delta == 0 {
        return Err("delta cannot be zero".into());
    }
    sign_ok(&reason, delta)?;
    if client_uuid.trim().is_empty() {
        return Err("client_uuid is required for idempotent writes".into());
    }

    let conn = db.0.lock().map_err(|e| e.to_string())?;

    // Idempotency check first — if this exact write already landed, return it.
    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM stock_movement WHERE client_uuid = ?1",
            rusqlite::params![client_uuid],
            |r| r.get(0),
        )
        .ok();
    if let Some(mid) = existing {
        let on_hand = on_hand_at(&conn, part_id, location_id).map_err(|e| e.to_string())?;
        return Ok(PostResult { movement_id: mid, location_id, on_hand, duplicate: true });
    }

    conn.execute(
        "INSERT INTO stock_movement
            (part_id, location_id, delta, reason, client_uuid, actor_id, origin)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'local')",
        rusqlite::params![part_id, location_id, delta, reason, client_uuid, actor_id],
    )
    .map_err(|e| e.to_string())?;

    let movement_id = conn.last_insert_rowid();
    let on_hand = on_hand_at(&conn, part_id, location_id).map_err(|e| e.to_string())?;
    Ok(PostResult { movement_id, location_id, on_hand, duplicate: false })
}

/// Move stock between two locations as a balanced, atomic pair of ledger rows.
/// Two distinct client_uuids (caller passes both) keep each leg idempotent.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn transfer_stock(
    part_id: i64,
    from_location_id: i64,
    to_location_id: i64,
    qty: i64,
    out_uuid: String,
    in_uuid: String,
    actor_id: Option<i64>,
    db: State<Db>,
) -> Result<(), String> {
    if qty <= 0 {
        return Err("transfer qty must be positive".into());
    }
    if from_location_id == to_location_id {
        return Err("source and destination must differ".into());
    }
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    // Each leg uses INSERT OR IGNORE so a partial retry can't double-post.
    tx.execute(
        "INSERT OR IGNORE INTO stock_movement
            (part_id, location_id, delta, reason, client_uuid, actor_id, origin)
         VALUES (?1, ?2, ?3, 'transfer', ?4, ?5, 'local')",
        rusqlite::params![part_id, from_location_id, -qty, out_uuid, actor_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT OR IGNORE INTO stock_movement
            (part_id, location_id, delta, reason, client_uuid, actor_id, origin)
         VALUES (?1, ?2, ?3, 'transfer', ?4, ?5, 'local')",
        rusqlite::params![part_id, to_location_id, qty, in_uuid, actor_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Everything the inventory detail panel needs in one round-trip.
#[tauri::command]
fn part_detail(part_id: i64, db: State<Db>) -> Result<PartDetail, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    // Rich identity + media come straight from the part_detail view; brand is
    // joined from the underlying part row (the view doesn't expose brand_id).
    #[allow(clippy::type_complexity)]
    let (id, sku, locator, catalogue_pn, inventory_pn, mpn, name, side, make, model,
         drawing_no, diagram_item_no, category_code, category_name, match_status, notes,
         brand, description, price_cents, diagram_image, diagram_item, model_3d) = conn
        .query_row(
            r#"SELECT d.id, d.sku, d.locator, d.catalogue_pn, d.inventory_pn, d.mpn, d.name,
                      d.side, d.make, d.model, d.drawing_no, d.diagram_item_no,
                      d.category_code, d.category_name, d.match_status, d.notes,
                      b.name AS brand, d.description,
                      COALESCE(d.price_usd_minor,
                        (SELECT amount_minor FROM price WHERE part_id=d.id AND tier='list'
                          ORDER BY valid_from DESC LIMIT 1)),
                      d.diagram_image, d.diagram_item, d.model_3d
                 FROM part_detail d
                 LEFT JOIN part  p ON p.id = d.id
                 LEFT JOIN brand b ON b.id = p.brand_id
                WHERE d.id = ?1"#,
            rusqlite::params![part_id],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, Option<String>>(7)?,
                    r.get::<_, Option<String>>(8)?,
                    r.get::<_, Option<String>>(9)?,
                    r.get::<_, Option<String>>(10)?,
                    r.get::<_, Option<i64>>(11)?,
                    r.get::<_, Option<String>>(12)?,
                    r.get::<_, Option<String>>(13)?,
                    r.get::<_, Option<String>>(14)?,
                    r.get::<_, Option<String>>(15)?,
                    r.get::<_, Option<String>>(16)?,
                    r.get::<_, Option<String>>(17)?,
                    r.get::<_, Option<i64>>(18)?,
                    r.get::<_, Option<String>>(19)?,
                    r.get::<_, Option<String>>(20)?,
                    r.get::<_, Option<String>>(21)?,
                ))
            },
        )
        .map_err(|e| e.to_string())?;

    // All product images, primary first.
    let mut istmt = conn
        .prepare(
            r#"SELECT id, path, kind, is_primary FROM part_image
                WHERE part_id = ?1 AND deleted_at IS NULL
                ORDER BY is_primary DESC, sort_order"#,
        )
        .map_err(|e| e.to_string())?;
    let images: Vec<PartImage> = istmt
        .query_map(rusqlite::params![part_id], |r| {
            Ok(PartImage {
                id: r.get(0)?,
                path: r.get(1)?,
                kind: r.get(2)?,
                is_primary: r.get::<_, i64>(3)? != 0,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;

    // On-hand per location across ALL locations (left join so empty locs show 0).
    let mut stmt = conn
        .prepare(
            r#"SELECT l.id, l.code, l.name,
                      COALESCE(s.qty_on_hand,0),
                      sp.bin, sp.reorder_point, sp.reorder_qty
                 FROM location l
                 LEFT JOIN stock_on_hand s ON s.location_id = l.id AND s.part_id = ?1
                 LEFT JOIN stock_policy  sp ON sp.location_id = l.id AND sp.part_id = ?1
                WHERE l.deleted_at IS NULL
                ORDER BY l.id"#,
        )
        .map_err(|e| e.to_string())?;
    let stock: Vec<StockLine> = stmt
        .query_map(rusqlite::params![part_id], |r| {
            Ok(StockLine {
                location_id: r.get(0)?,
                location_code: r.get(1)?,
                location_name: r.get(2)?,
                on_hand: r.get(3)?,
                bin: r.get(4)?,
                reorder_point: r.get(5)?,
                reorder_qty: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;

    let total_on_hand: i64 = stock.iter().map(|s| s.on_hand).sum();

    // Recent ledger, newest first.
    let mut lstmt = conn
        .prepare(
            r#"SELECT m.id, l.code, m.delta, m.reason, m.created_at
                 FROM stock_movement m JOIN location l ON l.id = m.location_id
                WHERE m.part_id = ?1
                ORDER BY m.id DESC LIMIT 25"#,
        )
        .map_err(|e| e.to_string())?;
    let ledger: Vec<LedgerRow> = lstmt
        .query_map(rusqlite::params![part_id], |r| {
            Ok(LedgerRow {
                id: r.get(0)?,
                location_code: r.get(1)?,
                delta: r.get(2)?,
                reason: r.get(3)?,
                created_at: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;

    let status: Option<String> = conn
        .query_row("SELECT status FROM part WHERE id=?1", [part_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let list_price_minor: Option<i64> = conn
        .query_row("SELECT list_price_minor FROM part WHERE id=?1", [part_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    Ok(PartDetail {
        id, sku, locator, catalogue_pn, inventory_pn, mpn, name, side, make, model,
        drawing_no, diagram_item_no, category_code, category_name, match_status, notes, status,
        brand, description, price_cents, list_price_minor,
        total_on_hand, stock, ledger,
        images, diagram_image, diagram_item, model_3d,
    })
}

// =========================================================================
//  DIAGRAMS — exploded views with clickable hotspots that resolve to parts.
// =========================================================================
#[derive(Serialize)]
struct DiagramSummary {
    id: i64,
    drawing_key: String,
    title: String,
    section_code: Option<String>,
    image_path: Option<String>,
    hotspot_count: i64,
}

#[tauri::command]
fn list_diagrams(db: State<Db>) -> Result<Vec<DiagramSummary>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            r#"SELECT d.id, d.drawing_key, d.title, d.section_code, d.image_path,
                      (SELECT COUNT(*) FROM hotspot h WHERE h.diagram_id=d.id AND h.deleted_at IS NULL)
                 FROM diagram d
                WHERE d.deleted_at IS NULL AND d.image_path IS NOT NULL
                ORDER BY d.drawing_key"#,
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(DiagramSummary {
                id: r.get(0)?,
                drawing_key: r.get(1)?,
                title: r.get(2)?,
                section_code: r.get(3)?,
                image_path: r.get(4)?,
                hotspot_count: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct Hotspot {
    id: i64,
    part_id: Option<i64>,
    sku: Option<String>,
    locator: Option<String>,
    name: Option<String>,
    item_no: Option<String>,
    x: f64,
    y: f64,
    radius: f64,
}

#[derive(Serialize)]
struct DiagramFull {
    id: i64,
    drawing_key: String,
    title: String,
    image_path: Option<String>,
    img_w: Option<i64>,
    img_h: Option<i64>,
    hotspots: Vec<Hotspot>,
}

#[tauri::command]
fn get_diagram(diagram_id: i64, db: State<Db>) -> Result<DiagramFull, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let (id, drawing_key, title, image_path, img_w, img_h) = conn
        .query_row(
            r#"SELECT id, drawing_key, title, image_path, img_w, img_h
                 FROM diagram WHERE id=?1 AND deleted_at IS NULL"#,
            rusqlite::params![diagram_id],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<i64>>(4)?,
                    r.get::<_, Option<i64>>(5)?,
                ))
            },
        )
        .map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            r#"SELECT h.id, h.part_id, p.sku, p.locator, p.name, h.item_no, h.x, h.y, h.radius
                 FROM hotspot h LEFT JOIN part p ON p.id=h.part_id
                WHERE h.diagram_id=?1 AND h.deleted_at IS NULL
                ORDER BY h.id"#,
        )
        .map_err(|e| e.to_string())?;
    let hotspots = stmt
        .query_map(rusqlite::params![diagram_id], |r| {
            Ok(Hotspot {
                id: r.get(0)?,
                part_id: r.get(1)?,
                sku: r.get(2)?,
                locator: r.get(3)?,
                name: r.get(4)?,
                item_no: r.get(5)?,
                x: r.get(6)?,
                y: r.get(7)?,
                radius: r.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;
    Ok(DiagramFull { id, drawing_key, title, image_path, img_w, img_h, hotspots })
}

// =========================================================================
//  PARTS TABLE — dense one-row-per-part feed for the catalogue grid.
// =========================================================================
#[derive(Serialize)]
struct PartRow {
    id: i64,
    sku: String,
    locator: Option<String>,
    name: String,
    side: Option<String>,
    category_code: Option<String>,
    catalogue_pn: Option<String>,
    inventory_pn: Option<String>,
    status: Option<String>,
    match_status: Option<String>,
    qty_on_hand: i64,
    bin: Option<String>,
    price_cents: Option<i64>,
    has_photo: bool,
    has_diagram: bool,
    has_model: bool,
}

#[tauri::command]
fn list_parts(db: State<Db>) -> Result<Vec<PartRow>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            r#"SELECT id, sku, locator, name, side, category_code, catalogue_pn, inventory_pn,
                      status, match_status, qty_on_hand, bin, price_usd_minor,
                      (primary_image IS NOT NULL), (diagram_image IS NOT NULL), (model_3d IS NOT NULL)
                 FROM part_detail
                ORDER BY category_code, sku"#,
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(PartRow {
                id: r.get(0)?,
                sku: r.get(1)?,
                locator: r.get(2)?,
                name: r.get(3)?,
                side: r.get(4)?,
                category_code: r.get(5)?,
                catalogue_pn: r.get(6)?,
                inventory_pn: r.get(7)?,
                status: r.get(8)?,
                match_status: r.get(9)?,
                qty_on_hand: r.get(10)?,
                bin: r.get(11)?,
                price_cents: r.get(12)?,
                has_photo: r.get::<_, i64>(13)? != 0,
                has_diagram: r.get::<_, i64>(14)? != 0,
                has_model: r.get::<_, i64>(15)? != 0,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())
}

// =========================================================================
//  EDITING — part fields, images, hotspots, diagram upload. Files are written
//  under app/public/assets (dev path via CARGO_MANIFEST_DIR); image bytes come
//  from the webview as a Vec<u8> so no fs/dialog plugin is needed.
// =========================================================================
//
// Where uploaded photos and diagrams land.
//
// This used to be `env!("CARGO_MANIFEST_DIR")/../public/assets`, which is baked
// in AT COMPILE TIME and points at the developer's own source tree. In `tauri
// dev` that happens to be the folder Vite serves, so it worked. In a packaged
// .msi it is a path that does not exist on the machine — so every photo upload
// failed to write, and anything that had been written could never be served,
// because the installed app serves its bundled dist/ instead.
//
// Runtime resolution instead: use the source tree when it is actually there
// (dev, where hot-reload is the point), otherwise the per-user app-data dir
// alongside the database. OnceLock so the probe runs once, not per upload.
fn assets_root() -> &'static std::path::PathBuf {
    static ROOT: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
    ROOT.get_or_init(|| {
        let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..").join("public").join("assets");
        if dev.is_dir() {
            return dev;
        }
        // Packaged: mirror the DB location, which Tauri guarantees is writable.
        // Falls back to the executable's own folder only if even that fails.
        std::env::var_os("APPDATA")
            .map(std::path::PathBuf::from)
            .map(|p| p.join("net.chinatruckparts.fleetview").join("assets"))
            .or_else(|| {
                std::env::current_exe().ok()
                    .and_then(|p| p.parent().map(|d| d.join("assets")))
            })
            .unwrap_or_else(|| std::path::PathBuf::from("assets"))
    })
}

fn assets_dir(sub: &str) -> std::path::PathBuf {
    assets_root().join(sub)
}
fn now_stamp() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}
fn sanitize(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect();
    if s.is_empty() { "file".into() } else { s }
}

// Download any diagram whose image_path is still a remote URL (e.g. rusauto
// hotlink) to local disk and repoint the DB at the local copy, so exploded
// views always render — including fully offline. Idempotent: a cached diagram
// already has a local image_path and is skipped on the next run. Runs in a
// background thread on its own connection so it never blocks app startup.
fn cache_supplier_diagrams(db_path: std::path::PathBuf) {
    use std::io::Read;
    let conn = match Connection::open(&db_path) { Ok(c) => c, Err(_) => return };
    let _ = conn.busy_timeout(std::time::Duration::from_secs(8));
    let dir = assets_dir("diagrams/ru");
    if std::fs::create_dir_all(&dir).is_err() { return; }
    let rows: Vec<(i64, String)> = {
        let mut stmt = match conn.prepare(
            "SELECT id, image_path FROM diagram WHERE image_path LIKE 'http%'") {
            Ok(s) => s, Err(_) => return };
        let mapped = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)));
        match mapped { Ok(it) => it.filter_map(|x| x.ok()).collect(), Err(_) => return }
    };
    for (id, url) in rows {
        let fname = sanitize(url.rsplit('/').next().unwrap_or("diagram.gif"));
        let local = dir.join(&fname);
        if !local.exists() {
            match ureq::get(&url).set("User-Agent", "Mozilla/5.0").call() {
                Ok(resp) => {
                    let mut bytes: Vec<u8> = Vec::new();
                    if resp.into_reader().read_to_end(&mut bytes).is_ok() && bytes.len() > 64 {
                        if std::fs::write(&local, &bytes).is_err() { continue; }
                    } else { continue; }
                }
                Err(_) => continue,
            }
        }
        if local.exists() {
            let web = format!("assets/diagrams/ru/{}", fname);
            let _ = conn.execute("UPDATE diagram SET image_path=?1 WHERE id=?2",
                rusqlite::params![web, id]);
        }
    }
}

#[derive(Serialize)]
struct Cat { id: i64, code: String, name: String }

#[tauri::command]
fn list_categories(db: State<Db>) -> Result<Vec<Cat>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, code, name FROM category WHERE deleted_at IS NULL ORDER BY code")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok(Cat { id: r.get(0)?, code: r.get(1)?, name: r.get(2)? }))
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())
}

#[tauri::command]
fn create_part(name: String, category_id: i64, db: State<Db>) -> Result<i64, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let sku = format!("NEW-{}", now_stamp());
    conn.execute(
        "INSERT INTO part(sku, name, category_id, status, make, model) VALUES(?1, ?2, ?3, 'active', 'FAW', 'JH6')",
        rusqlite::params![sku, name, category_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

#[derive(Deserialize)]
struct PartEdit {
    name: String,
    side: Option<String>,
    make: Option<String>,
    model: Option<String>,
    drawing_no: Option<String>,
    diagram_item_no: Option<i64>,
    locator: Option<String>,
    catalogue_pn: Option<String>,
    inventory_pn: Option<String>,
    mpn: Option<String>,
    description: Option<String>,
    status: String,
    match_status: Option<String>,
    notes: Option<String>,
    category_id: i64,
    list_price_minor: Option<i64>,
}

#[tauri::command]
fn update_part(part_id: i64, patch: PartEdit, db: State<Db>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        r#"UPDATE part SET name=?2, side=?3, make=?4, model=?5, drawing_no=?6, diagram_item_no=?7,
             locator=?8, catalogue_pn=?9, inventory_pn=?10, mpn=?11, description=?12, status=?13,
             match_status=?14, notes=?15, category_id=?16, list_price_minor=?17,
             rev=rev+1, updated_at=datetime('now')
           WHERE id=?1"#,
        rusqlite::params![
            part_id, patch.name, patch.side, patch.make, patch.model, patch.drawing_no,
            patch.diagram_item_no, patch.locator, patch.catalogue_pn, patch.inventory_pn,
            patch.mpn, patch.description, patch.status, patch.match_status, patch.notes,
            patch.category_id, patch.list_price_minor
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn save_part_image(
    part_id: i64, filename: String, bytes: Vec<u8>, kind: String, db: State<Db>,
) -> Result<String, String> {
    let dir = assets_dir("photos");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let fname = format!("p{}_{}_{}", part_id, now_stamp(), sanitize(&filename));
    std::fs::write(dir.join(&fname), &bytes).map_err(|e| e.to_string())?;
    let rel = format!("assets/photos/{}", fname);
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let cnt: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM part_image WHERE part_id=?1 AND deleted_at IS NULL",
            [part_id], |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO part_image(part_id, path, kind, is_primary, sort_order) VALUES(?1,?2,?3,?4,?5)",
        rusqlite::params![part_id, rel, kind, if cnt == 0 { 1 } else { 0 }, cnt],
    )
    .map_err(|e| e.to_string())?;
    Ok(rel)
}

#[tauri::command]
fn remove_part_image(image_id: i64, db: State<Db>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("UPDATE part_image SET deleted_at=datetime('now') WHERE id=?1", [image_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn set_primary_image(image_id: i64, db: State<Db>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let pid: i64 = conn
        .query_row("SELECT part_id FROM part_image WHERE id=?1", [image_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    conn.execute("UPDATE part_image SET is_primary=0 WHERE part_id=?1", [pid])
        .map_err(|e| e.to_string())?;
    conn.execute("UPDATE part_image SET is_primary=1 WHERE id=?1", [image_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn add_hotspot(
    diagram_id: i64, x: f64, y: f64, part_id: Option<i64>, item_no: Option<String>, db: State<Db>,
) -> Result<i64, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO hotspot(diagram_id, part_id, item_no, x, y) VALUES(?1,?2,?3,?4,?5)",
        rusqlite::params![diagram_id, part_id, item_no, x, y],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
fn update_hotspot(
    id: i64, x: f64, y: f64, part_id: Option<i64>, item_no: Option<String>, db: State<Db>,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE hotspot SET x=?2, y=?3, part_id=?4, item_no=?5, rev=rev+1, updated_at=datetime('now') WHERE id=?1",
        rusqlite::params![id, x, y, part_id, item_no],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_hotspot(id: i64, db: State<Db>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("UPDATE hotspot SET deleted_at=datetime('now') WHERE id=?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn save_diagram(
    filename: String, bytes: Vec<u8>, title: String, img_w: i64, img_h: i64, db: State<Db>,
) -> Result<i64, String> {
    let dir = assets_dir("diagrams");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = now_stamp();
    let fname = format!("up_{}_{}", stamp, sanitize(&filename));
    std::fs::write(dir.join(&fname), &bytes).map_err(|e| e.to_string())?;
    let rel = format!("assets/diagrams/{}", fname);
    let key = format!("UP{}", stamp);
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        r#"INSERT INTO diagram(drawing_key, title, make, model, image_path, img_w, img_h)
             VALUES(?1, ?2, 'FAW', 'JH6', ?3, ?4, ?5)"#,
        rusqlite::params![key, title, rel, img_w, img_h],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
fn delete_diagram(diagram_id: i64, db: State<Db>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("UPDATE hotspot SET deleted_at=datetime('now') WHERE diagram_id=?1", [diagram_id])
        .map_err(|e| e.to_string())?;
    conn.execute("UPDATE diagram SET deleted_at=datetime('now') WHERE id=?1", [diagram_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// =========================================================================
//  SALES / CRM — a quote walks quote→confirmed→fulfilled→invoiced. Stock is
//  only ever touched at fulfillment, and only by APPENDING 'sale' rows to the
//  same ledger inventory ops use. Line prices are snapshotted at add time.
// =========================================================================

#[derive(Serialize)]
struct Customer {
    id: i64,
    code: String,
    name: String,
    contact: Option<String>,
    phone: Option<String>,
    price_tier: String,
}

#[derive(Serialize)]
struct OrderLine {
    id: i64,
    part_id: i64,
    sku: String,
    name: String,
    qty: i64,
    unit_price_minor: i64,
    line_total_minor: i64,
    on_hand: i64, // at the order's fulfilling location, derived from the ledger
}

#[derive(Serialize)]
struct OrderSummary {
    id: i64,
    number: String,
    customer_name: String,
    status: String,
    line_count: i64,
    subtotal_minor: i64,
    created_at: String,
}

#[derive(Serialize)]
struct OrderDetail {
    id: i64,
    number: String,
    status: String,
    customer_id: i64,
    customer_name: String,
    customer_tier: String,
    customer_contact: Option<String>,
    customer_phone: Option<String>,
    customer_email: Option<String>,
    location_id: i64,
    location_code: String,
    notes: Option<String>,
    lines: Vec<OrderLine>,
    subtotal_minor: i64,
    tax_rate_bps: i64,
    tax_minor: i64,
    total_minor: i64,
    fulfilled_at: Option<String>,
    created_at: String,
}

/// Tax in minor units from a subtotal and a basis-points rate, rounded half-up.
fn tax_of(subtotal_minor: i64, bps: i64) -> i64 {
    (subtotal_minor * bps + 5000) / 10000
}

#[derive(Serialize)]
struct Loc { id: i64, code: String, name: String }

#[tauri::command]
fn list_locations(db: State<Db>) -> Result<Vec<Loc>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, code, name FROM location WHERE deleted_at IS NULL ORDER BY id")
        .map_err(|e| e.to_string())?;
    let out = stmt
        .query_map([], |r| Ok(Loc { id: r.get(0)?, code: r.get(1)?, name: r.get(2)? }))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;
    Ok(out)
}

#[tauri::command]
fn list_customers(db: State<Db>) -> Result<Vec<Customer>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, code, name, contact, phone, price_tier
               FROM customer WHERE deleted_at IS NULL ORDER BY name",
        )
        .map_err(|e| e.to_string())?;
    let out = stmt
        .query_map([], |r| {
            Ok(Customer {
                id: r.get(0)?,
                code: r.get(1)?,
                name: r.get(2)?,
                contact: r.get(3)?,
                phone: r.get(4)?,
                price_tier: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;
    Ok(out)
}

#[tauri::command]
fn list_orders(db: State<Db>) -> Result<Vec<OrderSummary>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            r#"SELECT o.id, o.number, c.name, o.status,
                      COALESCE(t.line_count,0), COALESCE(t.subtotal_minor,0), o.created_at
                 FROM sales_order o
                 JOIN customer c ON c.id = o.customer_id
                 LEFT JOIN order_total t ON t.order_id = o.id
                WHERE o.deleted_at IS NULL
                ORDER BY o.id DESC LIMIT 100"#,
        )
        .map_err(|e| e.to_string())?;
    let out = stmt
        .query_map([], |r| {
            Ok(OrderSummary {
                id: r.get(0)?,
                number: r.get(1)?,
                customer_name: r.get(2)?,
                status: r.get(3)?,
                line_count: r.get(4)?,
                subtotal_minor: r.get(5)?,
                created_at: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;
    Ok(out)
}

#[tauri::command]
fn get_order(order_id: i64, db: State<Db>) -> Result<OrderDetail, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let (id, number, status, customer_id, customer_name, customer_tier,
         customer_contact, customer_phone, customer_email,
         location_id, location_code, notes, tax_rate_bps, fulfilled_at, created_at) = conn
        .query_row(
            r#"SELECT o.id, o.number, o.status, c.id, c.name, c.price_tier,
                      c.contact, c.phone, c.email,
                      l.id, l.code, o.notes, o.tax_rate_bps, o.fulfilled_at, o.created_at
                 FROM sales_order o
                 JOIN customer c ON c.id = o.customer_id
                 JOIN location l ON l.id = o.location_id
                WHERE o.id = ?1 AND o.deleted_at IS NULL"#,
            rusqlite::params![order_id],
            |r| Ok((
                r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?, r.get::<_, String>(4)?, r.get::<_, String>(5)?,
                r.get::<_, Option<String>>(6)?, r.get::<_, Option<String>>(7)?, r.get::<_, Option<String>>(8)?,
                r.get::<_, i64>(9)?, r.get::<_, String>(10)?, r.get::<_, Option<String>>(11)?,
                r.get::<_, i64>(12)?, r.get::<_, Option<String>>(13)?, r.get::<_, String>(14)?,
            )),
        )
        .map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            r#"SELECT sl.id, sl.part_id, p.sku, p.name, sl.qty, sl.unit_price_minor,
                      sl.qty * sl.unit_price_minor AS line_total,
                      COALESCE(s.qty_on_hand,0) AS on_hand
                 FROM sales_line sl
                 JOIN part p ON p.id = sl.part_id
                 LEFT JOIN stock_on_hand s ON s.part_id = sl.part_id AND s.location_id = ?2
                WHERE sl.order_id = ?1 AND sl.deleted_at IS NULL
                ORDER BY sl.id"#,
        )
        .map_err(|e| e.to_string())?;
    let lines: Vec<OrderLine> = stmt
        .query_map(rusqlite::params![order_id, location_id], |r| {
            Ok(OrderLine {
                id: r.get(0)?,
                part_id: r.get(1)?,
                sku: r.get(2)?,
                name: r.get(3)?,
                qty: r.get(4)?,
                unit_price_minor: r.get(5)?,
                line_total_minor: r.get(6)?,
                on_hand: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;

    let subtotal_minor: i64 = lines.iter().map(|l| l.line_total_minor).sum();
    let tax_minor = tax_of(subtotal_minor, tax_rate_bps);
    let total_minor = subtotal_minor + tax_minor;

    Ok(OrderDetail {
        id, number, status, customer_id, customer_name, customer_tier,
        customer_contact, customer_phone, customer_email,
        location_id, location_code, notes, lines, subtotal_minor,
        tax_rate_bps, tax_minor, total_minor, fulfilled_at, created_at,
    })
}

#[derive(Serialize, serde::Deserialize)]
struct Company {
    name: String,
    address: Option<String>,
    phone: Option<String>,
    email: Option<String>,
    tax_id: Option<String>,
    currency: String,
    terms: Option<String>,
}

#[tauri::command]
fn get_company(db: State<Db>) -> Result<Company, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT name, address, phone, email, tax_id, currency, terms FROM company WHERE id=1",
        [],
        |r| Ok(Company {
            name: r.get(0)?, address: r.get(1)?, phone: r.get(2)?, email: r.get(3)?,
            tax_id: r.get(4)?, currency: r.get(5)?, terms: r.get(6)?,
        }),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_company(company: Company, db: State<Db>) -> Result<Company, String> {
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE company SET name=?1, address=?2, phone=?3, email=?4, tax_id=?5,
                    currency=?6, terms=?7, rev=rev+1, updated_at=datetime('now') WHERE id=1",
            rusqlite::params![company.name, company.address, company.phone, company.email,
                              company.tax_id, company.currency, company.terms],
        )
        .map_err(|e| e.to_string())?;
    }
    get_company(db)
}

#[tauri::command]
fn create_order(customer_id: i64, location_id: i64, db: State<Db>) -> Result<OrderDetail, String> {
    let new_id = {
        let mut conn = db.0.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        // temp unique number, then stamp SO-<id> once we know the id
        let temp = format!("tmp-{}", uuid_like());
        tx.execute(
            "INSERT INTO sales_order (number, customer_id, location_id, status, origin)
             VALUES (?1, ?2, ?3, 'quote', 'local')",
            rusqlite::params![temp, customer_id, location_id],
        )
        .map_err(|e| e.to_string())?;
        let id = tx.last_insert_rowid();
        tx.execute(
            "UPDATE sales_order SET number = ?1 WHERE id = ?2",
            rusqlite::params![format!("SO-{}", 1000 + id), id],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        id
    };
    get_order(new_id, db)
}

/// Snapshot the price for a part at a customer's tier (fall back to list, then 0).
/// Price one order line: list price, less the customer's tier discount, floored
/// so a discount can never take the line below cost plus a minimum margin.
///
/// Before migration 0013 this read the `price` table while that table held landed
/// COST tagged as tier='list', so every line was charged at cost. 0013 moved cost
/// to part_cost and made tier='list' the genuine list price.
///
/// Returns 0 only when the part has no list price at all. That is deliberate: a
/// zero is visible and gets questioned, whereas a guessed number gets invoiced.
fn snapshot_price(conn: &Connection, part_id: i64, tier: &str) -> rusqlite::Result<i64> {
    // 1. The list price. price(tier='list') is authoritative; part.list_price_minor
    //    is the denormalised copy the part panel shows, used here as a fallback.
    let list: Option<i64> = conn
        .query_row(
            "SELECT amount_minor FROM price
              WHERE part_id = ?1 AND tier = 'list' AND deleted_at IS NULL
              ORDER BY valid_from DESC LIMIT 1",
            rusqlite::params![part_id],
            |r| r.get(0),
        )
        .ok()
        .or_else(|| {
            conn.query_row(
                "SELECT list_price_minor FROM part WHERE id = ?1",
                rusqlite::params![part_id],
                |r| r.get::<_, Option<i64>>(0),
            )
            .ok()
            .flatten()
        });

    let list = match list {
        Some(v) if v > 0 => v,
        _ => return Ok(0),
    };

    // 2. The customer's tier. An unknown tier means no discount, which is the
    //    safe direction to fail in.
    let (discount_bps, min_margin_bps): (i64, i64) = conn
        .query_row(
            "SELECT discount_bps, min_margin_bps FROM price_tier WHERE code = ?1",
            rusqlite::params![tier],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or((0, 1500));

    let discounted = list * (10_000 - discount_bps) / 10_000;

    // 3. The floor. margin = (price - cost) / price, so holding margin at
    //    min_margin_bps means price >= cost / (1 - min_margin).
    //    With no cost on file there is nothing to protect, so no floor.
    let cost: Option<i64> = conn
        .query_row(
            "SELECT amount_minor FROM part_cost
              WHERE part_id = ?1 AND currency = 'ZAR'
              ORDER BY valid_from DESC LIMIT 1",
            rusqlite::params![part_id],
            |r| r.get(0),
        )
        .ok();

    let floor = match cost {
        Some(c) if c > 0 && min_margin_bps < 10_000 => {
            (c * 10_000) / (10_000 - min_margin_bps) + 1
        }
        _ => 0,
    };

    // Never below the floor, never above list. The upper clamp only bites if a
    // part's own list margin is thinner than the tier minimum (today the thinnest
    // is 32.5%, well clear of the 15% default), and it stops the app ever charging
    // more than the list price it advertises.
    Ok(discounted.max(floor).min(list))
}

fn order_is_editable(conn: &Connection, order_id: i64) -> Result<String, String> {
    let status: String = conn
        .query_row(
            "SELECT status FROM sales_order WHERE id=?1 AND deleted_at IS NULL",
            rusqlite::params![order_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if status == "quote" || status == "confirmed" {
        Ok(status)
    } else {
        Err(format!("order is {status}; lines are locked"))
    }
}

#[tauri::command]
fn add_line(order_id: i64, part_id: i64, qty: i64, db: State<Db>) -> Result<OrderDetail, String> {
    if qty <= 0 {
        return Err("qty must be positive".into());
    }
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        order_is_editable(&conn, order_id)?;
        let tier: String = conn
            .query_row(
                "SELECT c.price_tier FROM sales_order o JOIN customer c ON c.id=o.customer_id
                  WHERE o.id=?1",
                rusqlite::params![order_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let price = snapshot_price(&conn, part_id, &tier).map_err(|e| e.to_string())?;
        // Upsert: re-adding the same part bumps qty (keeps the snapshot price).
        conn.execute(
            "INSERT INTO sales_line (order_id, part_id, qty, unit_price_minor, tier_at_add, origin)
             VALUES (?1, ?2, ?3, ?4, ?5, 'local')
             ON CONFLICT(order_id, part_id)
             DO UPDATE SET qty = qty + excluded.qty, rev = rev + 1,
                           updated_at = datetime('now'), deleted_at = NULL",
            rusqlite::params![order_id, part_id, qty, price, tier],
        )
        .map_err(|e| e.to_string())?;
    }
    get_order(order_id, db)
}

#[tauri::command]
fn update_line_qty(line_id: i64, qty: i64, db: State<Db>) -> Result<OrderDetail, String> {
    if qty <= 0 {
        return Err("qty must be positive (use remove to delete)".into());
    }
    let order_id = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let oid: i64 = conn
            .query_row("SELECT order_id FROM sales_line WHERE id=?1",
                rusqlite::params![line_id], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        order_is_editable(&conn, oid)?;
        conn.execute(
            "UPDATE sales_line SET qty=?1, rev=rev+1, updated_at=datetime('now') WHERE id=?2",
            rusqlite::params![qty, line_id],
        )
        .map_err(|e| e.to_string())?;
        oid
    };
    get_order(order_id, db)
}

#[tauri::command]
fn remove_line(line_id: i64, db: State<Db>) -> Result<OrderDetail, String> {
    let order_id = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let oid: i64 = conn
            .query_row("SELECT order_id FROM sales_line WHERE id=?1",
                rusqlite::params![line_id], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        order_is_editable(&conn, oid)?;
        // unfulfilled quote lines aren't history yet — hard delete keeps the
        // (order_id, part_id) unique slot free for a clean re-add.
        conn.execute("DELETE FROM sales_line WHERE id=?1", rusqlite::params![line_id])
            .map_err(|e| e.to_string())?;
        oid
    };
    get_order(order_id, db)
}

/// Allowed status hops that DON'T touch stock. Fulfillment has its own command.
#[tauri::command]
fn set_status(order_id: i64, status: String, db: State<Db>) -> Result<OrderDetail, String> {
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let cur: String = conn
            .query_row("SELECT status FROM sales_order WHERE id=?1 AND deleted_at IS NULL",
                rusqlite::params![order_id], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let allowed = match (cur.as_str(), status.as_str()) {
            ("quote", "confirmed")
            | ("confirmed", "quote")
            | ("quote", "cancelled")
            | ("confirmed", "cancelled")
            | ("fulfilled", "invoiced") => true,
            _ => false,
        };
        if !allowed {
            return Err(format!("can't move {cur} → {status} here"));
        }
        conn.execute(
            "UPDATE sales_order SET status=?1, rev=rev+1, updated_at=datetime('now') WHERE id=?2",
            rusqlite::params![status, order_id],
        )
        .map_err(|e| e.to_string())?;
    }
    get_order(order_id, db)
}

/// Fulfill: append one 'sale' movement per line to the ledger and mark the
/// order fulfilled. Idempotent — each leg's client_uuid is derived from the
/// line id, so re-running never issues stock twice.
#[tauri::command]
fn fulfill_order(order_id: i64, db: State<Db>) -> Result<OrderDetail, String> {
    {
        let mut conn = db.0.lock().map_err(|e| e.to_string())?;
        let (status, location_id): (String, i64) = conn
            .query_row(
                "SELECT status, location_id FROM sales_order WHERE id=?1 AND deleted_at IS NULL",
                rusqlite::params![order_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| e.to_string())?;
        if status != "quote" && status != "confirmed" {
            return Err(format!("order is {status}; can't fulfill"));
        }
        let line_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sales_line WHERE order_id=?1 AND deleted_at IS NULL",
                rusqlite::params![order_id], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if line_count == 0 {
            return Err("nothing to fulfill — order has no lines".into());
        }

        let tx = conn.transaction().map_err(|e| e.to_string())?;
        {
            let mut sel = tx
                .prepare("SELECT id, part_id, qty FROM sales_line
                           WHERE order_id=?1 AND deleted_at IS NULL")
                .map_err(|e| e.to_string())?;
            let lines: Vec<(i64, i64, i64)> = sel
                .query_map(rusqlite::params![order_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .map_err(|e| e.to_string())?
                .collect::<rusqlite::Result<_>>()
                .map_err(|e| e.to_string())?;
            for (line_id, part_id, qty) in lines {
                // deterministic uuid -> idempotent re-fulfill
                let cu = format!("so-{order_id}-line-{line_id}");
                tx.execute(
                    "INSERT OR IGNORE INTO stock_movement
                        (part_id, location_id, delta, reason, ref_type, ref_id, client_uuid, origin)
                     VALUES (?1, ?2, ?3, 'sale', 'sales_order', ?4, ?5, 'local')",
                    rusqlite::params![part_id, location_id, -qty, order_id, cu],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        tx.execute(
            "UPDATE sales_order SET status='fulfilled', fulfilled_at=datetime('now'),
                    rev=rev+1, updated_at=datetime('now') WHERE id=?1",
            rusqlite::params![order_id],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    get_order(order_id, db)
}

// =========================================================================
//  ACCOUNTING EXPORT — invoiced orders → QuickBooks (IIF) / Xero (CSV).
//  No general ledger here; we hand a clean file to the books and record the
//  push in an append-only outbox so we never double-post a transaction.
// =========================================================================

#[derive(Serialize)]
struct ExportRow {
    id: i64,
    number: String,
    customer_name: String,
    invoice_date: String,
    subtotal_minor: i64,
    tax_rate_bps: i64,
    total_minor: i64,
    exported_at: Option<String>, // for the chosen target; None = still queued
    batch_uuid: Option<String>,
}

#[derive(Serialize)]
struct ExportResult {
    batch_uuid: String,
    target: String,
    filename: String,
    content: String,
    exported_count: i64,
    skipped_count: i64, // already pushed to this target before (idempotent skip)
}

/// Set/clear order tax (basis points). Only while the order is still editable.
#[tauri::command]
fn set_tax_rate(order_id: i64, bps: i64, db: State<Db>) -> Result<OrderDetail, String> {
    if !(0..=10000).contains(&bps) {
        return Err("tax must be between 0 and 10000 bps (0–100%)".into());
    }
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        order_is_editable(&conn, order_id)?;
        conn.execute(
            "UPDATE sales_order SET tax_rate_bps=?1, rev=rev+1, updated_at=datetime('now') WHERE id=?2",
            rusqlite::params![bps, order_id],
        )
        .map_err(|e| e.to_string())?;
    }
    get_order(order_id, db)
}

#[tauri::command]
fn list_export_queue(target: String, db: State<Db>) -> Result<Vec<ExportRow>, String> {
    if target != "quickbooks" && target != "xero" {
        return Err("target must be 'quickbooks' or 'xero'".into());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            r#"SELECT o.id, o.number, c.name,
                      date(COALESCE(o.fulfilled_at, o.created_at)) AS inv_date,
                      COALESCE(t.subtotal_minor,0), o.tax_rate_bps,
                      ae.exported_at, ae.batch_uuid
                 FROM sales_order o
                 JOIN customer c ON c.id = o.customer_id
                 LEFT JOIN order_total t ON t.order_id = o.id
                 LEFT JOIN accounting_export ae
                        ON ae.order_id = o.id AND ae.target = ?1
                WHERE o.status = 'invoiced' AND o.deleted_at IS NULL
                ORDER BY o.id DESC"#,
        )
        .map_err(|e| e.to_string())?;
    let out = stmt
        .query_map(rusqlite::params![target], |r| {
            let subtotal: i64 = r.get(4)?;
            let bps: i64 = r.get(5)?;
            let tax = tax_of(subtotal, bps);
            Ok(ExportRow {
                id: r.get(0)?,
                number: r.get(1)?,
                customer_name: r.get(2)?,
                invoice_date: r.get(3)?,
                subtotal_minor: subtotal,
                tax_rate_bps: bps,
                total_minor: subtotal + tax,
                exported_at: r.get(6)?,
                batch_uuid: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// Render minor units as signed major-unit string, e.g. -1234 -> "-12.34".
fn dollars(minor: i64) -> String {
    let neg = minor < 0;
    let m = minor.abs();
    format!("{}{}.{:02}", if neg { "-" } else { "" }, m / 100, m % 100)
}

/// CSV field with minimal quoting.
fn csv(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// MM/DD/YYYY for QuickBooks IIF from a 'YYYY-MM-DD...' string.
fn iif_date(d: &str) -> String {
    if d.len() >= 10 {
        format!("{}/{}/{}", &d[5..7], &d[8..10], &d[0..4])
    } else {
        d.to_string()
    }
}

struct ExpOrder {
    number: String,
    customer: String,
    inv_date: String,
    due_date: String,
    tax_rate_bps: i64,
    lines: Vec<(String, String, i64, i64)>, // sku, name, qty, unit_price_minor
}

fn load_export_order(conn: &Connection, order_id: i64) -> rusqlite::Result<ExpOrder> {
    let (number, customer, inv_date, due_date, tax_rate_bps) = conn.query_row(
        r#"SELECT o.number, c.name,
                  date(COALESCE(o.fulfilled_at,o.created_at)),
                  date(COALESCE(o.fulfilled_at,o.created_at), '+30 days'),
                  o.tax_rate_bps
             FROM sales_order o JOIN customer c ON c.id=o.customer_id
            WHERE o.id=?1"#,
        rusqlite::params![order_id],
        |r| Ok((r.get::<_,String>(0)?, r.get::<_,String>(1)?, r.get::<_,String>(2)?,
                r.get::<_,String>(3)?, r.get::<_,i64>(4)?)),
    )?;
    let mut stmt = conn.prepare(
        "SELECT p.sku, p.name, sl.qty, sl.unit_price_minor
           FROM sales_line sl JOIN part p ON p.id=sl.part_id
          WHERE sl.order_id=?1 AND sl.deleted_at IS NULL ORDER BY sl.id",
    )?;
    let lines = stmt
        .query_map(rusqlite::params![order_id], |r| {
            Ok((r.get::<_,String>(0)?, r.get::<_,String>(1)?, r.get::<_,i64>(2)?, r.get::<_,i64>(3)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ExpOrder { number, customer, inv_date, due_date, tax_rate_bps, lines })
}

fn build_xero_csv(orders: &[ExpOrder]) -> String {
    let mut s = String::from(
        "ContactName,InvoiceNumber,InvoiceDate,DueDate,Description,Quantity,UnitAmount,AccountCode,TaxType\n",
    );
    for o in orders {
        let tax_type = if o.tax_rate_bps > 0 { "Tax on Sales" } else { "Tax Exempt" };
        for (sku, name, qty, price) in &o.lines {
            s.push_str(&format!(
                "{},{},{},{},{},{},{},{},{}\n",
                csv(&o.customer), csv(&o.number), o.inv_date, o.due_date,
                csv(&format!("{sku} — {name}")), qty, dollars(*price), "200", tax_type,
            ));
        }
    }
    s
}

fn build_quickbooks_iif(orders: &[ExpOrder]) -> String {
    let mut s = String::new();
    s.push_str("!TRNS\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\n");
    s.push_str("!SPL\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tQNTY\tPRICE\tMEMO\n");
    s.push_str("!ENDTRNS\n");
    for o in orders {
        let subtotal: i64 = o.lines.iter().map(|(_, _, q, p)| q * p).sum();
        let tax = tax_of(subtotal, o.tax_rate_bps);
        let total = subtotal + tax;
        let d = iif_date(&o.inv_date);
        s.push_str(&format!(
            "TRNS\tINVOICE\t{}\tAccounts Receivable\t{}\t{}\t{}\n",
            d, o.customer, dollars(total), o.number
        ));
        for (sku, name, qty, price) in &o.lines {
            let line_total = qty * price;
            s.push_str(&format!(
                "SPL\tINVOICE\t{}\tSales\t{}\t{}\t{}\t{}\t{}\n",
                d, o.customer, dollars(-line_total), -qty, dollars(*price),
                format!("{sku} - {name}")
            ));
        }
        if tax > 0 {
            s.push_str(&format!(
                "SPL\tINVOICE\t{}\tSales Tax Payable\t{}\t{}\t\t\tVAT\n",
                d, o.customer, dollars(-tax)
            ));
        }
        s.push_str("ENDTRNS\n");
    }
    s
}

fn cheap_hash(s: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// Export the given invoiced orders to one file for the target. Orders already
/// pushed to this target are skipped (the outbox UNIQUE(order_id,target) is the
/// idempotency guarantee), so re-running never double-posts to the books.
#[tauri::command]
fn export_accounting(
    target: String,
    order_ids: Vec<i64>,
    db: State<Db>,
) -> Result<ExportResult, String> {
    if target != "quickbooks" && target != "xero" {
        return Err("target must be 'quickbooks' or 'xero'".into());
    }
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    let batch_uuid = format!("BATCH-{}", uuid_like());

    let mut to_export: Vec<ExpOrder> = Vec::new();
    let mut export_ids: Vec<i64> = Vec::new();
    let mut skipped = 0i64;

    for oid in &order_ids {
        let status: String = conn
            .query_row("SELECT status FROM sales_order WHERE id=?1 AND deleted_at IS NULL",
                rusqlite::params![oid], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if status != "invoiced" {
            return Err(format!("order {oid} is {status}; only invoiced orders export"));
        }
        let already: bool = conn
            .query_row(
                "SELECT 1 FROM accounting_export WHERE order_id=?1 AND target=?2",
                rusqlite::params![oid, target], |_| Ok(true))
            .unwrap_or(false);
        if already { skipped += 1; continue; }
        to_export.push(load_export_order(&conn, *oid).map_err(|e| e.to_string())?);
        export_ids.push(*oid);
    }

    let content = if target == "xero" {
        build_xero_csv(&to_export)
    } else {
        build_quickbooks_iif(&to_export)
    };
    let hash = cheap_hash(&content);

    // Record the outbox rows atomically (idempotent on UNIQUE(order_id,target)).
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for oid in &export_ids {
        tx.execute(
            "INSERT OR IGNORE INTO accounting_export
                (order_id, target, batch_uuid, status, payload_hash, origin)
             VALUES (?1, ?2, ?3, 'exported', ?4, 'local')",
            rusqlite::params![oid, target, batch_uuid, hash],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;

    let ext = if target == "xero" { "csv" } else { "iif" };
    Ok(ExportResult {
        batch_uuid: batch_uuid.clone(),
        target,
        filename: format!("fleetview-{}-{}.{}", ext, &batch_uuid, ext),
        content,
        exported_count: export_ids.len() as i64,
        skipped_count: skipped,
    })
}

/// Cheap unique-ish token for the temporary order number (no uuid crate dep).
fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    format!("{n:x}")
}

/// Open a URL in the user's DEFAULT browser. window.open() is blocked inside the
/// Tauri/WebView2 webview (returns null), so the "Check price" link did nothing —
/// this shells out to the OS handler instead. http(s) only, no extra crates.
// =========================================================================
//  JEFREY — offline parts-identification assistant.
//
//  Rust does two things here and nothing more: hand the assistant a flat,
//  cheap snapshot of the catalogue, and persist what the operator teaches it.
//  All the matching happens in the front end against that snapshot, which is
//  why it works with no connection and answers in single-digit milliseconds.
// =========================================================================

/// One catalogue row, flattened for the matcher. Money is in ZAR minor units
/// exactly as stored — no float conversion happens on this side of the wire.
#[derive(Serialize)]
struct JefreyPart {
    id: i64,
    sku: String,
    name: String,
    side: Option<String>,
    inv_pn: Option<String>,
    cat_pn: Option<String>,
    locator: Option<String>,
    section: Option<String>,
    loc: Option<String>,
    qty: i64,
    cost_minor: Option<i64>,
    list_minor: Option<i64>,
    dwg: Option<String>,
    has_photo: bool,
    notes: Option<String>,
    match_status: Option<String>,
}

#[tauri::command]
fn jefrey_catalogue(db: State<Db>) -> Result<Vec<JefreyPart>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            r#"SELECT id, sku, name, side, inventory_pn, catalogue_pn, locator,
                      category_name, bin, qty_on_hand,
                      price_zar_minor, list_price_minor, drawing_no,
                      (primary_image IS NOT NULL), notes, match_status
                 FROM part_detail
                ORDER BY id"#,
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(JefreyPart {
                id: r.get(0)?,
                sku: r.get(1)?,
                name: r.get(2)?,
                side: r.get(3)?,
                inv_pn: r.get(4)?,
                cat_pn: r.get(5)?,
                locator: r.get(6)?,
                section: r.get(7)?,
                loc: r.get(8)?,
                qty: r.get(9)?,
                cost_minor: r.get(10)?,
                list_minor: r.get(11)?,
                dwg: r.get(12)?,
                has_photo: r.get(13)?,
                notes: r.get(14)?,
                match_status: r.get(15)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[derive(Serialize)]
struct AliasRow {
    phrase: String,
    part_id: i64,
    polarity: i64,
    hits: i64,
}

#[tauri::command]
fn jefrey_aliases(db: State<Db>) -> Result<Vec<AliasRow>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT phrase_norm, part_id, polarity, hits FROM part_alias")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(AliasRow { phrase: r.get(0)?, part_id: r.get(1)?, polarity: r.get(2)?, hits: r.get(3)? })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// Teach Jefrey. `polarity` 1 binds the phrase to the part; -1 records that
/// the operator rejected it, so it is never offered for that phrase again.
/// Re-teaching the same pair bumps the hit count rather than duplicating.
#[tauri::command]
fn jefrey_learn(
    phrase: String,
    part_id: i64,
    polarity: i64,
    db: State<Db>,
) -> Result<(), String> {
    let p = if polarity < 0 { -1 } else { 1 };
    let phrase = phrase.trim().to_lowercase();
    if phrase.is_empty() {
        return Err("empty phrase".into());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    // A positive teaching clears any prior rejection of the same pair —
    // the operator has changed their mind and that must win.
    if p == 1 {
        conn.execute(
            "DELETE FROM part_alias WHERE phrase_norm = ?1 AND part_id = ?2 AND polarity = -1",
            rusqlite::params![phrase, part_id],
        )
        .map_err(|e| e.to_string())?;
    }
    conn.execute(
        r#"INSERT INTO part_alias (phrase_norm, part_id, polarity)
           VALUES (?1, ?2, ?3)
           ON CONFLICT(phrase_norm, part_id, polarity)
           DO UPDATE SET hits = hits + 1, updated_at = datetime('now')"#,
        rusqlite::params![phrase, part_id, p],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn jefrey_forget(phrase: String, db: State<Db>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM part_alias WHERE phrase_norm = ?1",
        rusqlite::params![phrase.trim().to_lowercase()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// =========================================================================
//  PART LIFECYCLE — delete, restore, and the check that runs before either.
//
//  Deletion is ALWAYS soft. The ledger is append-only and a sales line must
//  keep resolving to the part it was raised against, so a part is retired by
//  stamping deleted_at, never by removing the row. That also makes every
//  delete instantly reversible, which is why the UI can skip the "are you
//  sure?" dialog and offer an undo instead.
// =========================================================================

/// What the operator should know before retiring a part.
#[derive(Serialize)]
struct DeleteCheck {
    part_id: i64,
    sku: String,
    name: String,
    on_hand: i64,
    open_orders: i64,
    open_order_refs: Vec<String>,
    historic_lines: i64,
    /// Hard stop: the part sits on an order still at 'quote' or 'confirmed'.
    /// Fulfilled, invoiced and cancelled orders are settled history and do not
    /// block — retiring the part cannot change what was already shipped.
    blocked: bool,
}

fn delete_check(conn: &Connection, part_id: i64) -> rusqlite::Result<DeleteCheck> {
    let (sku, name): (String, String) = conn.query_row(
        "SELECT sku, name FROM part WHERE id = ?1",
        [part_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let on_hand: i64 = conn.query_row(
        "SELECT COALESCE(SUM(delta), 0) FROM stock_movement WHERE part_id = ?1",
        [part_id],
        |r| r.get(0),
    )?;
    let mut stmt = conn.prepare(
        r#"SELECT o.id, COALESCE(o.status, '')
             FROM sales_line l JOIN sales_order o ON o.id = l.order_id
            WHERE l.part_id = ?1
              AND COALESCE(o.status, '') NOT IN ('fulfilled', 'invoiced', 'cancelled')"#,
    )?;
    let open: Vec<String> = stmt
        .query_map([part_id], |r| {
            let id: i64 = r.get(0)?;
            let st: String = r.get(1)?;
            Ok(format!("order #{} ({})", id, if st.is_empty() { "draft".into() } else { st }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let historic: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sales_line WHERE part_id = ?1",
        [part_id],
        |r| r.get(0),
    )?;
    Ok(DeleteCheck {
        part_id,
        sku,
        name,
        on_hand,
        open_orders: open.len() as i64,
        blocked: !open.is_empty(),
        open_order_refs: open,
        historic_lines: historic,
    })
}

#[tauri::command]
fn check_delete_part(part_id: i64, db: State<Db>) -> Result<DeleteCheck, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    delete_check(&conn, part_id).map_err(|e| e.to_string())
}

/// Retire a part. Refuses while it sits on a live order unless `force` is set.
/// Returns the same check so the UI can explain what just happened.
#[tauri::command]
fn delete_part(part_id: i64, force: Option<bool>, db: State<Db>) -> Result<DeleteCheck, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let check = delete_check(&conn, part_id).map_err(|e| e.to_string())?;
    if check.blocked && !force.unwrap_or(false) {
        return Err(format!(
            "{} is still on {}. Close or cancel it first, or force the delete.",
            check.sku,
            check.open_order_refs.join(", ")
        ));
    }
    conn.execute(
        "UPDATE part SET deleted_at = datetime('now'), rev = rev + 1,
                         updated_at = datetime('now') WHERE id = ?1",
        [part_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(check)
}

/// Undo a retirement. The row never went anywhere, so this is exact.
#[tauri::command]
fn restore_part(part_id: i64, db: State<Db>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE part SET deleted_at = NULL, rev = rev + 1,
                         updated_at = datetime('now') WHERE id = ?1",
        [part_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize)]
struct DeletedRow {
    id: i64,
    sku: String,
    name: String,
    category_code: Option<String>,
    inventory_pn: Option<String>,
    deleted_at: Option<String>,
}

#[tauri::command]
fn list_deleted_parts(db: State<Db>) -> Result<Vec<DeletedRow>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            r#"SELECT p.id, p.sku, p.name, c.code, p.inventory_pn, p.deleted_at
                 FROM part p LEFT JOIN category c ON c.id = p.category_id
                WHERE p.deleted_at IS NOT NULL
                ORDER BY p.deleted_at DESC"#,
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(DeletedRow {
                id: r.get(0)?,
                sku: r.get(1)?,
                name: r.get(2)?,
                category_code: r.get(3)?,
                inventory_pn: r.get(4)?,
                deleted_at: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("refused: only http(s) URLs".into());
    }
    #[cfg(target_os = "windows")]
    let spawned = std::process::Command::new("cmd").args(["/C", "start", "", &url]).spawn();
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let spawned = std::process::Command::new("xdg-open").arg(&url).spawn();
    spawned.map(|_| ()).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()
                .map_err(|e| format!("Could not locate the application data folder.\n\n{e}"))?;
            std::fs::create_dir_all(&dir).ok();
            let db_path = dir.join("fleetview.db");

            // A release build has no console (windows_subsystem = "windows"), so a
            // panic here used to mean the process simply vanished — no window, no
            // message, nothing to act on. Anyone hitting a locked or corrupted
            // database saw an app that "does not open". Report it instead, with
            // the path, so the problem is at least nameable.
            let conn = match init_db(&db_path) {
                Ok(c) => c,
                Err(e) => {
                    let msg = format!(
                        "CTP Core could not open its local database.\n\n\
                         {e}\n\n\
                         Database file:\n{}\n\n\
                         If this persists, close any other copy of CTP Core that is \
                         running. The cloud database is unaffected — nothing has been lost.",
                        db_path.display()
                    );
                    eprintln!("{msg}");
                    #[cfg(target_os = "windows")]
                    {
                        // A message box is the only channel a windowless build has.
                        let _ = std::process::Command::new("mshta")
                            .arg(format!(
                                "javascript:var s=new ActiveXObject('WScript.Shell');\
                                 s.Popup({:?},0,'CTP Core',16);close()",
                                msg
                            ))
                            .spawn()
                            .and_then(|mut c| c.wait());
                    }
                    return Err(msg.into());
                }
            };
            app.manage(Db(Mutex::new(conn)));
            // cache remote (rusauto) diagrams to local disk in the background
            std::thread::spawn(move || cache_supplier_diagrams(db_path));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            search_parts,
            post_movement,
            transfer_stock,
            part_detail,
            list_locations,
            list_customers,
            list_orders,
            get_order,
            create_order,
            add_line,
            update_line_qty,
            remove_line,
            set_status,
            fulfill_order,
            set_tax_rate,
            list_export_queue,
            export_accounting,
            get_company,
            set_company,
            list_diagrams,
            get_diagram,
            list_parts,
            list_categories,
            create_part,
            update_part,
            save_part_image,
            remove_part_image,
            set_primary_image,
            add_hotspot,
            update_hotspot,
            delete_hotspot,
            save_diagram,
            delete_diagram,
            open_url,
            check_delete_part,
            delete_part,
            restore_part,
            list_deleted_parts,
            jefrey_catalogue,
            jefrey_aliases,
            jefrey_learn,
            jefrey_forget
        ])
        .run(tauri::generate_context!())
        .expect("error while running CTP Core");
}
