// Prevent a console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod purchasing;
mod sync;

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
        ver = 13;
    }

    // v13 -> v14: cross-reference and fitment for the real JH6 parts. Both
    // tables held rows only for the demo parts 0012 retired; the cloud got the
    // same fact set in its own migration 0027.
    if ver < 14 {
        conn.execute_batch(include_str!("../migrations/0015_xref_fitment.sql"))?;
        conn.execute_batch("PRAGMA user_version = 14;")?;
        ver = 14;
    }

    // v14 -> v15: the hosted app's URL moves out of App.tsx and onto the company
    // row. It was compiled into the installer, so a domain change meant shipping
    // a new .msi to every machine; now it is a settings edit. Cloud gets the same
    // column in its migration 0031.
    if ver < 15 {
        conn.execute_batch(include_str!("../migrations/0016_company_app_url.sql"))?;
        conn.execute_batch("PRAGMA user_version = 15;")?;
        ver = 15;
    }

    // v15 -> v16: SEC101-116 is the only diagram set. Retires the 32 D-series
    // plus SFW and SRD — 34 rows whose image files no longer exist anywhere, so
    // they rendered as broken images with hotspot markers floating over them.
    // Soft-delete only; the 91 hotspots stay dormant and attached. Cloud gets
    // the same rule in its migration 0032 (which retires 22 rusauto rows the
    // desktop never had).
    if ver < 16 {
        conn.execute_batch(include_str!("../migrations/0017_retire_non_sec_diagrams.sql"))?;
        conn.execute_batch("PRAGMA user_version = 16;")?;
        ver = 16;
    }

    // v16 -> v17: `rev` becomes one mechanism. Triggers maintain it on all 18
    // rev-bearing tables, and the ten hand-written `rev = rev + 1` statements
    // are removed from this file in the same commit — a window where both fire
    // would double-increment silently. Cloud gets the same rule in 0034.
    if ver < 17 {
        conn.execute_batch(include_str!("../migrations/0018_rev_triggers.sql"))?;
        conn.execute_batch("PRAGMA user_version = 17;")?;
        ver = 17;
    }

    // v17 -> v18: shape only. actor_id was INTEGER and app_user.id is a UUID, so
    // the audit column could never have held the identity it exists to record.
    // Re-typed to TEXT, plus actor_label (who acted, when there is no account)
    // and actor_source (which path stamped it — a server-derived record is not
    // the same as a client's claim). Nothing populates these yet; they are free
    // now because every value is NULL, and a data migration later.
    if ver < 18 {
        conn.execute_batch(include_str!("../migrations/0019_actor_identity_columns.sql"))?;
        conn.execute_batch("PRAGMA user_version = 18;")?;
        ver = 18;
    }

    // v18 -> v19: order numbers get a per-install namespace. `SO-{1000+rowid}`
    // repeats on every machine, and the cloud already holds SO-1001. Numbers are
    // now {quote_prefix}{device code}-{1000+id}. device_identity is local-only
    // and must never be added to the sync set — see the migration's own comment.
    if ver < 19 {
        conn.execute_batch(include_str!("../migrations/0020_device_identity.sql"))?;
        conn.execute_batch("PRAGMA user_version = 19;")?;
        ver = 19;
    }

    // v19 -> v20: sync foundations, schema only. Idempotency keys on the five
    // tables the desktop can create rows in offline (hotspot had NO unique
    // constraint at all); `local_session` added to actor_source for the offline
    // outbox case; and the sync watermark folded onto device_identity rather
    // than a second local-only table. Cloud gets 0036 and 0037.
    if ver < 20 {
        conn.execute_batch(include_str!("../migrations/0021_sync_foundations.sql"))?;
        conn.execute_batch("PRAGMA user_version = 20;")?;
        ver = 20;
    }

    // v20 -> v21: cached sign-in, so the counter keeps working offline. One row
    // per person because each person has their own login and a shared machine
    // sees several across a shift. Local-only — must never join the sync set.
    if ver < 21 {
        conn.execute_batch(include_str!("../migrations/0022_local_session.sql"))?;
        conn.execute_batch("PRAGMA user_version = 21;")?;
        ver = 21;
    }

    // v21 -> v22: one building, one warehouse. The seed shipped MAIN + SHOP and
    // the real shipment landed into WH; nobody chose to have three. Repoints
    // orders, ledger rows and bin policies onto WH and retires the other two —
    // soft-delete only, because the ledger references them. No stock is written
    // off: the migration asserts sum(delta) is unchanged and aborts if it is
    // not. Cloud gets the same rule in server/0038.
    //
    // This one CANNOT be left to sync. stock_movement has no updated_at — its
    // pull watermark is created_at, which a location repoint does not touch —
    // so a desktop that has already pulled those rows would never see the
    // correction. Both databases have to apply the rule themselves.
    if ver < 22 {
        conn.execute_batch(include_str!("../migrations/0023_single_location.sql"))?;
        conn.execute_batch("PRAGMA user_version = 22;")?;
        ver = 22;
    }

    // v22 -> v23: the inbound side. Suppliers, purchase orders, goods receipt,
    // landed cost and the rebate accrual engine. The system could only watch
    // stock leave; this is the half that records it arriving, and therefore the
    // half that can say what a part truly cost.
    //
    // Two cost figures from the first commit, never one: cost_invoiced is money
    // actually spent and is the ONLY figure a price floor may read;
    // cost_expected is net of rebate, for reporting. Merging them later is easy;
    // unpicking them once something reads the column is not. Cloud gets the same
    // rule in server/0039.
    if ver < 23 {
        conn.execute_batch(include_str!("../migrations/0024_purchasing.sql"))?;
        conn.execute_batch("PRAGMA user_version = 23;")?;
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
        // deleted_at guard: without it this re-fetches diagrams that have been
        // RETIRED, re-localising a third party's images for rows nothing shows.
        // The 22 rusauto rows are retired in 0017/0032 precisely so they stop
        // being used; this is the loop that would have quietly undone that.
        let mut stmt = match conn.prepare(
            "SELECT id, image_path FROM diagram
              WHERE image_path LIKE 'http%' AND deleted_at IS NULL") {
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
             updated_at=datetime('now')
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
        "UPDATE hotspot SET x=?2, y=?3, part_id=?4, item_no=?5, updated_at=datetime('now') WHERE id=?1",
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
    /// Base URL of the hosted phone app. Null falls back to the compiled
    /// default in the UI, so an unmigrated database still links somewhere real.
    app_url: Option<String>,
    /// Prefix half of an order number — the other half is this machine's device
    /// code. The cloud has carried this column since 0028 with nothing reading
    /// it; order numbering is its first consumer.
    quote_prefix: String,
}

#[tauri::command]
fn get_company(db: State<Db>) -> Result<Company, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT name, address, phone, email, tax_id, currency, terms, app_url, quote_prefix
           FROM company WHERE id=1",
        [],
        |r| Ok(Company {
            name: r.get(0)?, address: r.get(1)?, phone: r.get(2)?, email: r.get(3)?,
            tax_id: r.get(4)?, currency: r.get(5)?, terms: r.get(6)?, app_url: r.get(7)?,
            quote_prefix: r.get(8)?,
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
                    currency=?6, terms=?7, app_url=?8, quote_prefix=?9,
                    updated_at=datetime('now') WHERE id=1",
            rusqlite::params![company.name, company.address, company.phone, company.email,
                              company.tax_id, company.currency, company.terms, company.app_url,
                              company.quote_prefix],
        )
        .map_err(|e| e.to_string())?;
    }
    get_company(db)
}

#[tauri::command]
fn create_order(customer_id: i64, location_id: i64, db: State<Db>) -> Result<OrderDetail, String> {
    let new_id = {
        let mut conn = db.0.lock().map_err(|e| e.to_string())?;
        // This machine's namespace, and the shared prefix. Read before the
        // transaction so a first-run device-code insert is its own commit.
        let device = ensure_device_code(&conn)?;
        let prefix: String = conn
            .query_row(
                "SELECT COALESCE(NULLIF(quote_prefix, ''), 'QT-') FROM company WHERE id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap_or_else(|_| "QT-".to_string());

        let tx = conn.transaction().map_err(|e| e.to_string())?;
        // temp unique number, then stamp the real one once we know the id
        let temp = format!("tmp-{}", uuid_like());
        tx.execute(
            "INSERT INTO sales_order (number, customer_id, location_id, status, origin)
             VALUES (?1, ?2, ?3, 'quote', 'local')",
            rusqlite::params![temp, customer_id, location_id],
        )
        .map_err(|e| e.to_string())?;
        let id = tx.last_insert_rowid();
        // {prefix}{device}-{1000+id}, e.g. QT-A7K2-1001. The device code is what
        // makes this unique across installs: the local id alone repeats on every
        // machine, and the cloud already holds SO-1001. See migration 0020.
        tx.execute(
            "UPDATE sales_order SET number = ?1 WHERE id = ?2",
            rusqlite::params![format!("{}{}-{}", prefix, device, 1000 + id), id],
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

// ════════════════════════════════════════════════════════════════════════════
//  PURCHASING COMMANDS
//
//  The inbound side. These are deliberately thin: every calculation lives in
//  purchasing.rs, where it is tested against worked examples, and nothing here
//  does arithmetic of its own. A number computed in two places is a number that
//  will eventually disagree with itself.
// ════════════════════════════════════════════════════════════════════════════

#[derive(Serialize)]
struct SupplierRow {
    id: i64, code: String, name: String, currency: String,
    incoterm: Option<String>, contact: Option<String>, phone: Option<String>,
    email: Option<String>, lead_time_days: Option<i64>,
}

#[tauri::command]
fn list_suppliers(db: State<Db>) -> Result<Vec<SupplierRow>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut s = conn
        .prepare(
            "SELECT id, code, name, currency, incoterm, contact, phone, email, lead_time_days
               FROM supplier WHERE deleted_at IS NULL ORDER BY name",
        )
        .map_err(|e| e.to_string())?;
    let v = s
        .query_map([], |r| {
            Ok(SupplierRow {
                id: r.get(0)?, code: r.get(1)?, name: r.get(2)?, currency: r.get(3)?,
                incoterm: r.get(4)?, contact: r.get(5)?, phone: r.get(6)?,
                email: r.get(7)?, lead_time_days: r.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(v)
}

/// Create or update a supplier, keyed on `code` — the natural key sync matches
/// on, so the same supplier entered on two machines converges rather than
/// duplicating.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn upsert_supplier(
    code: String, name: String, currency: Option<String>, incoterm: Option<String>,
    contact: Option<String>, phone: Option<String>, email: Option<String>,
    lead_time_days: Option<i64>, db: State<Db>,
) -> Result<i64, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO supplier (code, name, currency, incoterm, contact, phone, email,
                               lead_time_days, origin)
         VALUES (?1,?2,COALESCE(?3,'ZAR'),?4,?5,?6,?7,?8,'local')
         ON CONFLICT(code) DO UPDATE SET
            name = excluded.name,
            currency = excluded.currency,
            incoterm = COALESCE(excluded.incoterm, supplier.incoterm),
            contact = COALESCE(excluded.contact, supplier.contact),
            phone = COALESCE(excluded.phone, supplier.phone),
            email = COALESCE(excluded.email, supplier.email),
            lead_time_days = COALESCE(excluded.lead_time_days, supplier.lead_time_days)",
        rusqlite::params![code, name, currency, incoterm, contact, phone, email, lead_time_days],
    )
    .map_err(|e| e.to_string())?;
    conn.query_row("SELECT id FROM supplier WHERE code = ?1", [&code], |r| r.get(0))
        .map_err(|e| e.to_string())
}

/// A document number in this machine's namespace: {prefix}{device}-{1000+id}.
/// Same scheme as sales orders (migration 0020) and for the same reason — a
/// local sequence alone repeats on every install.
fn mint_number(conn: &Connection, table: &str, prefix: &str, id: i64) -> Result<String, String> {
    let device = ensure_device_code(conn)?;
    let number = format!("{}{}-{}", prefix, device, 1000 + id);
    conn.execute(
        &format!("UPDATE {table} SET number = ?1 WHERE id = ?2"),
        rusqlite::params![number, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(number)
}

#[derive(Serialize)]
struct DocRef { id: i64, number: String }

#[tauri::command]
fn create_purchase_order(
    supplier_id: i64, currency: Option<String>, expected_at: Option<String>, db: State<Db>,
) -> Result<DocRef, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let ccy = match currency {
        Some(c) => c,
        None => conn
            .query_row("SELECT currency FROM supplier WHERE id = ?1", [supplier_id], |r| r.get(0))
            .unwrap_or_else(|_| "ZAR".to_string()),
    };
    conn.execute(
        "INSERT INTO purchase_order (number, supplier_id, currency, ordered_at, expected_at, origin)
         VALUES (?1, ?2, ?3, datetime('now'), ?4, 'local')",
        rusqlite::params![format!("tmp-{}", uuid_like()), supplier_id, ccy, expected_at],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    let number = mint_number(&conn, "purchase_order", "PO-", id)?;
    Ok(DocRef { id, number })
}

#[tauri::command]
fn add_po_line(
    order_id: i64, part_id: i64, qty: i64, unit_cost_minor: i64, db: State<Db>,
) -> Result<i64, String> {
    if qty <= 0 { return Err("quantity must be above zero".into()); }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO purchase_order_line (order_id, part_id, qty_ordered, unit_cost_minor, origin)
         VALUES (?1,?2,?3,?4,'local')
         ON CONFLICT(order_id, part_id) DO UPDATE SET
            qty_ordered = excluded.qty_ordered,
            unit_cost_minor = excluded.unit_cost_minor",
        rusqlite::params![order_id, part_id, qty, unit_cost_minor],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

#[derive(Serialize)]
struct PoLineRow {
    part_id: i64, sku: String, name: String,
    qty_ordered: i64, qty_received: i64, outstanding: i64, unit_cost_minor: i64,
}

#[derive(Serialize)]
struct PoDetail {
    id: i64, number: String, status: String, currency: String,
    supplier: String, ordered_at: Option<String>, expected_at: Option<String>,
    lines: Vec<PoLineRow>, total_minor: i64,
}

#[tauri::command]
fn purchase_order_detail(order_id: i64, db: State<Db>) -> Result<PoDetail, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let (number, status, currency, supplier, ordered_at, expected_at) = conn
        .query_row(
            "SELECT o.number, o.status, o.currency, s.name, o.ordered_at, o.expected_at
               FROM purchase_order o JOIN supplier s ON s.id = o.supplier_id
              WHERE o.id = ?1",
            [order_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?, r.get::<_, Option<String>>(4)?,
                    r.get::<_, Option<String>>(5)?)),
        )
        .map_err(|e| e.to_string())?;

    // qty_received comes from the po_line_status view, never from a column —
    // a stored counter drifts the first time a receipt is reversed.
    let mut s = conn
        .prepare(
            "SELECT pol.part_id, p.sku, p.name, pol.qty_ordered,
                    COALESCE(st.qty_received, 0), pol.unit_cost_minor
               FROM purchase_order_line pol
               JOIN part p ON p.id = pol.part_id
               LEFT JOIN po_line_status st ON st.order_line_id = pol.id
              WHERE pol.order_id = ?1 AND pol.deleted_at IS NULL
              ORDER BY pol.id",
        )
        .map_err(|e| e.to_string())?;
    let lines: Vec<PoLineRow> = s
        .query_map([order_id], |r| {
            let qo: i64 = r.get(3)?;
            let qr: i64 = r.get(4)?;
            Ok(PoLineRow {
                part_id: r.get(0)?, sku: r.get(1)?, name: r.get(2)?,
                qty_ordered: qo, qty_received: qr, outstanding: qo - qr,
                unit_cost_minor: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    let total_minor = lines.iter().map(|l| l.qty_ordered * l.unit_cost_minor).sum();
    Ok(PoDetail { id: order_id, number, status, currency, supplier, ordered_at, expected_at, lines, total_minor })
}

#[tauri::command]
fn create_goods_receipt(
    supplier_id: Option<i64>, order_id: Option<i64>, kind: Option<String>,
    location_id: Option<i64>, invoice_currency: Option<String>,
    fx_rate_ppm: Option<i64>, db: State<Db>,
) -> Result<DocRef, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    // One warehouse (migration 0023), so the location is not a question the
    // receiver should be asked. Kept as an argument for when that changes.
    let loc = match location_id {
        Some(l) => l,
        None => conn
            .query_row(
                "SELECT id FROM location WHERE deleted_at IS NULL ORDER BY id LIMIT 1",
                [], |r| r.get(0),
            )
            .map_err(|_| "no live location to receive into".to_string())?,
    };
    conn.execute(
        "INSERT INTO goods_receipt (number, supplier_id, order_id, kind, location_id,
                                    invoice_currency, fx_rate_ppm, origin)
         VALUES (?1,?2,?3,COALESCE(?4,'purchase'),?5,COALESCE(?6,'ZAR'),
                 COALESCE(?7,1000000),'local')",
        rusqlite::params![format!("tmp-{}", uuid_like()), supplier_id, order_id, kind,
                          loc, invoice_currency, fx_rate_ppm],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    let number = mint_number(&conn, "goods_receipt", "GR-", id)?;
    Ok(DocRef { id, number })
}

#[tauri::command]
fn add_receipt_line(
    receipt_id: i64, part_id: i64, qty: i64, unit_cost_minor: Option<i64>,
    order_line_id: Option<i64>, db: State<Db>,
) -> Result<i64, String> {
    if qty <= 0 { return Err("quantity must be above zero".into()); }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    // Default the cost from the PO line if there is one — the receiver has the
    // goods in front of them, not the price list.
    let cost = match unit_cost_minor {
        Some(c) => c,
        None => order_line_id
            .and_then(|l| conn.query_row(
                "SELECT unit_cost_minor FROM purchase_order_line WHERE id = ?1", [l], |r| r.get(0),
            ).ok())
            .unwrap_or(0),
    };
    conn.execute(
        "INSERT INTO goods_receipt_line (receipt_id, part_id, order_line_id,
                                         qty_received, unit_cost_minor, origin)
         VALUES (?1,?2,?3,?4,?5,'local')
         ON CONFLICT(receipt_id, part_id) DO UPDATE SET
            qty_received = excluded.qty_received,
            unit_cost_minor = excluded.unit_cost_minor,
            order_line_id = COALESCE(excluded.order_line_id, goods_receipt_line.order_line_id)",
        rusqlite::params![receipt_id, part_id, order_line_id, qty, cost],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn add_receipt_cost(
    receipt_id: i64, component: String, amount_minor: i64,
    allocation: Option<String>, direct_part_id: Option<i64>,
    is_landed: Option<bool>, currency: Option<String>, fx_rate_ppm: Option<i64>,
    supplier_ref: Option<String>, db: State<Db>,
) -> Result<i64, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    // Import VAT defaults to EXCLUDED from the part cost, because it is
    // normally reclaimable and including it would overstate cost on every part.
    // Everything else defaults to included.
    let landed = is_landed.unwrap_or(component != "vat_import");
    conn.execute(
        "INSERT INTO receipt_cost (receipt_id, component, amount_minor, currency,
                                   fx_rate_ppm, allocation, direct_part_id,
                                   is_landed, supplier_ref, origin)
         VALUES (?1,?2,?3,COALESCE(?4,'ZAR'),COALESCE(?5,1000000),
                 COALESCE(?6,'by_value'),?7,?8,?9,'local')",
        rusqlite::params![receipt_id, component, amount_minor, currency, fx_rate_ppm,
                          allocation, direct_part_id, if landed {1} else {0}, supplier_ref],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

/// What this receipt WOULD cost, without committing to it. Read-only, so the
/// receiver can see the landed figure before posting rather than after.
#[tauri::command]
fn preview_landed_cost(receipt_id: i64, db: State<Db>) -> Result<purchasing::LandedResult, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    purchasing::compute_landed(&conn, receipt_id)
}

/// Post a draft receipt: stock arrives, landed costs are written, purchase
/// rebates accrue. One transaction — a receipt is never half-posted.
#[tauri::command]
fn post_goods_receipt(receipt_id: i64, db: State<Db>) -> Result<purchasing::PostResult, String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let res = purchasing::post_receipt(&tx, receipt_id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(res)
}

/// Recompute a receipt's landed cost after late-arriving charges. The clearing
/// agent invoices in arrears, so this is the normal path, not an exception.
#[tauri::command]
fn recost_receipt(receipt_id: i64, db: State<Db>) -> Result<usize, String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let n = purchasing::write_landed(&tx, receipt_id, purchasing::RebateBasis::Settled)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(n)
}

#[derive(Serialize)]
struct CostNow {
    part_id: i64, sku: String,
    cost_invoiced_minor: i64, cost_expected_minor: i64, rebate_minor: i64,
    basis: String, is_estimated: bool,
    list_price_minor: i64,
    /// Margin against the CERTAIN cost. The honest one.
    margin_bps_invoiced: i64,
    /// Margin against cost net of settled rebate. The optimistic one, labelled
    /// rather than blended so nobody mistakes it for the first.
    margin_bps_expected: i64,
}

/// Both cost figures for a part, side by side with the margin each implies.
/// Showing them together is the point: the gap between them is the part of the
/// margin that depends on a rebate being claimed and honoured.
#[tauri::command]
fn part_cost_now(part_id: i64, db: State<Db>) -> Result<CostNow, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let (sku, ci, ce, reb, basis, est): (String, i64, i64, i64, String, i64) = conn
        .query_row(
            "SELECT p.sku,
                    COALESCE(c.cost_invoiced_minor,0), COALESCE(c.cost_expected_minor,0),
                    COALESCE(c.rebate_minor,0), c.basis, COALESCE(c.is_estimated,1)
               FROM part p JOIN part_current_cost c ON c.part_id = p.id
              WHERE p.id = ?1",
            [part_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .map_err(|e| e.to_string())?;
    let list: i64 = conn
        .query_row(
            "SELECT amount_minor FROM price
              WHERE part_id = ?1 AND tier = 'list' AND deleted_at IS NULL
              ORDER BY valid_from DESC LIMIT 1",
            [part_id], |r| r.get(0),
        )
        .unwrap_or(0);
    let bps = |cost: i64| if list > 0 { (list - cost) * 10_000 / list } else { 0 };
    Ok(CostNow {
        part_id, sku,
        cost_invoiced_minor: ci, cost_expected_minor: ce, rebate_minor: reb,
        basis, is_estimated: est == 1, list_price_minor: list,
        margin_bps_invoiced: bps(ci), margin_bps_expected: bps(ce),
    })
}

#[tauri::command]
fn rebate_standing(agreement_id: i64, db: State<Db>) -> Result<purchasing::RebateStanding, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    purchasing::rebate_standing(&conn, agreement_id)
}

#[derive(Serialize)]
struct AgreementRow {
    id: i64, code: String, supplier: String, basis: String, measure: String,
    tier_mode: String, period_start: String, period_end: String,
    status: String, is_provisional: bool,
}

#[tauri::command]
fn list_rebate_agreements(db: State<Db>) -> Result<Vec<AgreementRow>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut s = conn
        .prepare(
            "SELECT a.id, a.code, s.name, a.basis, a.measure, a.tier_mode,
                    a.period_start, a.period_end, a.status, a.is_provisional
               FROM rebate_agreement a JOIN supplier s ON s.id = a.supplier_id
              WHERE a.deleted_at IS NULL ORDER BY a.period_start DESC, a.code",
        )
        .map_err(|e| e.to_string())?;
    let v = s
        .query_map([], |r| {
            Ok(AgreementRow {
                id: r.get(0)?, code: r.get(1)?, supplier: r.get(2)?, basis: r.get(3)?,
                measure: r.get(4)?, tier_mode: r.get(5)?, period_start: r.get(6)?,
                period_end: r.get(7)?, status: r.get(8)?,
                is_provisional: r.get::<_, i64>(9)? == 1,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(v)
}

#[derive(Serialize)]
struct ClaimRow {
    id: i64, number: String, supplier: String, kind: String, state: String,
    value_minor: i64, created_at: String,
}

/// What the supplier owes back, and what has actually been asked for. The gap
/// between 'open' and 'submitted' is where this money dies.
#[tauri::command]
fn list_supplier_claims(open_only: Option<bool>, db: State<Db>) -> Result<Vec<ClaimRow>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let sql = if open_only.unwrap_or(false) {
        "SELECT c.id, c.number, s.name, c.kind, c.state, c.value_minor, c.created_at
           FROM supplier_claim c JOIN supplier s ON s.id = c.supplier_id
          WHERE c.deleted_at IS NULL AND c.state NOT IN ('settled','written_off')
          ORDER BY c.created_at DESC"
    } else {
        "SELECT c.id, c.number, s.name, c.kind, c.state, c.value_minor, c.created_at
           FROM supplier_claim c JOIN supplier s ON s.id = c.supplier_id
          WHERE c.deleted_at IS NULL ORDER BY c.created_at DESC"
    };
    let mut s = conn.prepare(sql).map_err(|e| e.to_string())?;
    let v = s
        .query_map([], |r| {
            Ok(ClaimRow {
                id: r.get(0)?, number: r.get(1)?, supplier: r.get(2)?, kind: r.get(3)?,
                state: r.get(4)?, value_minor: r.get(5)?, created_at: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(v)
}

/// Record a shortage, damage or wrong part — and raise the claim in the same
/// breath. A discrepancy without a claim is a note nobody acts on.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn record_discrepancy(
    receipt_id: i64, part_id: i64, kind: String, qty: i64,
    disposition: Option<String>, claim_value_minor: Option<i64>,
    notes: Option<String>, db: State<Db>,
) -> Result<i64, String> {
    if qty <= 0 { return Err("quantity must be above zero".into()); }
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    // A short is always 'reject': the goods never entered the building, so no
    // stock is written — the claim is the entire output.
    let disp = disposition.unwrap_or_else(|| {
        if kind == "short" { "reject".into() } else { "accept_and_claim".into() }
    });
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let supplier_id: Option<i64> = tx
        .query_row("SELECT supplier_id FROM goods_receipt WHERE id = ?1", [receipt_id],
                   |r| r.get(0))
        .map_err(|e| e.to_string())?;

    // Value the claim at what we paid for the goods, unless told otherwise.
    let value = match claim_value_minor {
        Some(v) => v,
        None => tx
            .query_row(
                "SELECT COALESCE(l.unit_cost_minor,0) * ?2
                   FROM goods_receipt_line l
                  WHERE l.receipt_id = ?1 AND l.part_id = ?3",
                rusqlite::params![receipt_id, qty, part_id], |r| r.get(0),
            )
            .unwrap_or(0),
    };

    let claim_id = if disp != "accept_no_claim" {
        if let Some(sid) = supplier_id {
            tx.execute(
                "INSERT INTO supplier_claim (number, supplier_id, kind, origin_type,
                                             value_minor, state, origin)
                 VALUES (?1,?2,?3,'receipt_discrepancy',?4,'open','local')",
                rusqlite::params![format!("tmp-{}", uuid_like()), sid,
                                  if kind == "short" { "short" } else { "damage" }, value],
            ).map_err(|e| e.to_string())?;
            let cid = tx.last_insert_rowid();
            let device = ensure_device_code(&tx)?;
            tx.execute(
                "UPDATE supplier_claim SET number = ?1 WHERE id = ?2",
                rusqlite::params![format!("CL-{}-{}", device, 1000 + cid), cid],
            ).map_err(|e| e.to_string())?;
            Some(cid)
        } else { None }
    } else { None };

    tx.execute(
        "INSERT INTO receipt_discrepancy (receipt_id, part_id, kind, qty, disposition,
                                          claim_value_minor, claim_id, notes, origin)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'local')",
        rusqlite::params![receipt_id, part_id, kind, qty, disp, value, claim_id, notes],
    ).map_err(|e| e.to_string())?;
    let id = tx.last_insert_rowid();

    if let Some(cid) = claim_id {
        tx.execute("UPDATE supplier_claim SET origin_id = ?1 WHERE id = ?2",
                   rusqlite::params![id, cid]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

#[derive(Serialize)]
struct PoSummary {
    id: i64, number: String, supplier: String, status: String,
    lines: i64, outstanding: i64, expected_at: Option<String>,
}

/// Orders that still owe something. The receiver's question is never "show me
/// every order ever" — it is "what is this pallet against".
#[tauri::command]
fn list_open_purchase_orders(db: State<Db>) -> Result<Vec<PoSummary>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut s = conn
        .prepare(
            "SELECT o.id, o.number, s.name, o.status,
                    COUNT(st.order_line_id),
                    COALESCE(SUM(st.qty_ordered - st.qty_received), 0),
                    o.expected_at
               FROM purchase_order o
               JOIN supplier s ON s.id = o.supplier_id
               LEFT JOIN po_line_status st ON st.order_id = o.id
              WHERE o.deleted_at IS NULL
                AND o.status IN ('draft','sent','acknowledged','part_received')
              GROUP BY o.id
             HAVING COALESCE(SUM(st.qty_ordered - st.qty_received), 0) > 0
              ORDER BY o.expected_at, o.id",
        )
        .map_err(|e| e.to_string())?;
    let v = s
        .query_map([], |r| {
            Ok(PoSummary {
                id: r.get(0)?, number: r.get(1)?, supplier: r.get(2)?, status: r.get(3)?,
                lines: r.get(4)?, outstanding: r.get(5)?, expected_at: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(v)
}

/// Copy everything still owed on an order onto this draft receipt.
/// Lines already counted by hand are left exactly as they are.
#[tauri::command]
fn pull_po_lines(receipt_id: i64, order_id: i64, db: State<Db>) -> Result<usize, String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let n = purchasing::pull_po_lines(&tx, receipt_id, order_id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(n)
}

/// Give the stock that was already here a costed origin.
///
/// ⚠ Adopts the existing ledger rows rather than posting new ones. Posting
///   would add the stock a second time — see purchasing::adopt_opening_stock.
#[tauri::command]
fn create_opening_receipt(db: State<Db>) -> Result<purchasing::OpeningResult, String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    let device = ensure_device_code(&conn)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let loc: i64 = tx
        .query_row(
            "SELECT id FROM location WHERE deleted_at IS NULL ORDER BY id LIMIT 1",
            [], |r| r.get(0),
        )
        .map_err(|_| "no live location".to_string())?;
    // Dated to the shipment the costs came from, not to today. The opening
    // balance is a statement about when this stock arrived, and 30 July is the
    // date on the Item Cost Price List those figures were taken from.
    tx.execute(
        "INSERT INTO goods_receipt (number, kind, location_id, received_at,
                                    invoice_currency, fx_rate_ppm, status,
                                    cost_is_estimated, notes, origin)
         VALUES (?1, 'opening', ?2, '2026-07-30 00:00:00', 'ZAR', 1000000, 'draft', 1,
                 'Opening balance. Stock that was on the shelf before the system '
                 || 'existed. Costs are the supplier Item Cost Price List, NOT '
                 || 'measured landed costs - treat every figure derived from '
                 || 'this receipt as an estimate until these units sell through.',
                 'local')",
        rusqlite::params![format!("tmp-{}", uuid_like()), loc],
    )
    .map_err(|e| e.to_string())?;
    let id = tx.last_insert_rowid();
    tx.execute(
        "UPDATE goods_receipt SET number = ?1 WHERE id = ?2",
        rusqlite::params![format!("GR-{}-{}", device, 1000 + id), id],
    )
    .map_err(|e| e.to_string())?;

    let res = purchasing::adopt_opening_stock(&tx, id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(res)
}

#[derive(Serialize)]
struct DiscrepancyRow {
    id: i64, sku: String, name: String, kind: String, qty: i64,
    disposition: String, claim_value_minor: i64, claim_number: Option<String>,
}

#[tauri::command]
fn list_discrepancies(receipt_id: i64, db: State<Db>) -> Result<Vec<DiscrepancyRow>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut s = conn
        .prepare(
            "SELECT d.id, p.sku, p.name, d.kind, d.qty, d.disposition,
                    d.claim_value_minor, c.number
               FROM receipt_discrepancy d
               JOIN part p ON p.id = d.part_id
               LEFT JOIN supplier_claim c ON c.id = d.claim_id
              WHERE d.receipt_id = ?1 AND d.deleted_at IS NULL
              ORDER BY d.id",
        )
        .map_err(|e| e.to_string())?;
    let v = s
        .query_map([receipt_id], |r| {
            Ok(DiscrepancyRow {
                id: r.get(0)?, sku: r.get(1)?, name: r.get(2)?, kind: r.get(3)?,
                qty: r.get(4)?, disposition: r.get(5)?, claim_value_minor: r.get(6)?,
                claim_number: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(v)
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
             DO UPDATE SET qty = qty + excluded.qty,
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
            "UPDATE sales_line SET qty=?1, updated_at=datetime('now') WHERE id=?2",
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
            "UPDATE sales_order SET status=?1, updated_at=datetime('now') WHERE id=?2",
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
                    updated_at=datetime('now') WHERE id=?1",
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
            "UPDATE sales_order SET tax_rate_bps=?1, updated_at=datetime('now') WHERE id=?2",
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

/// This install's numbering namespace, created on first use.
///
/// Order numbers are `{quote_prefix}{code}-{1000 + id}`. The code is what stops
/// two machines minting the same number from the same local rowid — see
/// migration 0020. It is a namespace, NOT an identity: it records which machine
/// minted a number, never who was using it.
///
/// Seeded from SQLite's RNG rather than the clock. `uuid_like()` is nanosecond
/// based, and two machines first run at the same instant is exactly the case
/// this has to survive.
fn ensure_device_code(conn: &Connection) -> Result<String, String> {
    if let Ok(code) = conn.query_row(
        "SELECT code FROM device_identity WHERE id = 1",
        [],
        |r| r.get::<_, String>(0),
    ) {
        if !code.trim().is_empty() {
            return Ok(code);
        }
    }
    // Crockford-style alphabet: no 0/O/1/I, because these get read aloud down a
    // telephone and written on paper.
    const ALPHABET: &[u8] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
    let raw: Vec<u8> = conn
        .query_row("SELECT randomblob(4)", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let code: String = raw
        .iter()
        .map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char)
        .collect();
    conn.execute(
        "INSERT INTO device_identity (id, code) VALUES (1, ?1)
         ON CONFLICT(id) DO UPDATE SET code = excluded.code",
        rusqlite::params![code],
    )
    .map_err(|e| e.to_string())?;
    Ok(code)
}

// ─── Stage B: pull-only sync ─────────────────────────────────────────────────
//
// Downloads cloud changes into fleetview.db. Never uploads — the worst this can
// do is make local data more current. It is also the reseed: the desktop and
// cloud have never synced, so the first pull is what makes them agree.
//
// Requires a signed-in user's access token. It calls PostgREST AS THAT USER,
// which is the whole reason for option (c): rows written later carry a
// server-derived actor rather than the device's word. Nothing here uploads yet,
// but the token is what makes the eventual upload attributable.

#[derive(Serialize)]
struct SyncReport {
    tables: Vec<sync::Applied>,
    stopped_at: Option<String>,
    error: Option<String>,
}

/// One table's worth of rows from PostgREST, oldest first so the watermark
/// advances monotonically even if the pull is interrupted part way.
fn fetch_table(
    base: &str, apikey: &str, token: &str, table: &str, since: Option<&str>,
) -> Result<Vec<serde_json::Value>, String> {
    let col = sync::watermark_col(table);
    let mut url = format!(
        "{base}/rest/v1/{table}?select={}&order={col}.asc&limit=1000",
        sync::select_for(table)
    );
    if let Some(w) = since {
        url.push_str(&format!("&{col}=gt.{}", urlencode(w)));
    }
    let resp = ureq::get(&url)
        .set("apikey", apikey)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Accept", "application/json")
        .call()
        .map_err(|e| format!("{table}: {e}"))?;
    // into_string + serde_json rather than ureq's `json` feature: serde_json is
    // already a dependency, so this needs no feature flag and no new crate.
    let text = resp.into_string().map_err(|e| format!("{table}: {e}"))?;
    let body: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("{table}: bad JSON: {e}"))?;
    Ok(body.as_array().cloned().unwrap_or_default())
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Pull every table in dependency order. Each table is its own transaction and
/// its watermark advances only on success, so an interruption leaves some
/// tables refreshed, others not, and a working app either way — never an empty
/// one, because nothing is deleted before downloading.
#[tauri::command]
fn sync_pull(
    supabase_url: String, apikey: String, token: String, db: State<Db>,
) -> Result<SyncReport, String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut report = SyncReport { tables: vec![], stopped_at: None, error: None };

    for table in sync::PULL_ORDER {
        let since = sync::get_watermark(&conn, table);
        let rows = match fetch_table(&supabase_url, &apikey, &token, table, since.as_deref()) {
            Ok(r) => r,
            Err(e) => {
                report.stopped_at = Some((*table).to_string());
                report.error = Some(e);
                return Ok(report); // partial success is still success
            }
        };
        let high = sync::max_watermark(table, &rows);
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let applied = sync::apply_rows(&tx, table, &rows).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        if let Some(h) = high {
            sync::set_watermark(&conn, table, &h).map_err(|e| e.to_string())?;
        }
        report.tables.push(applied);
    }

    conn.execute(
        "UPDATE device_identity
            SET last_sync_at = datetime('now'), last_sync_status = 'ok'
          WHERE id = 1",
        [],
    )
    .ok();
    Ok(report)
}

// ─── cached sign-in (offline working) ────────────────────────────────────────
//
// Rust stores and returns opaque strings here and makes no security decisions.
// The password verifier is computed in the app with Web Crypto (PBKDF2-SHA256);
// this layer never sees a password and could not check one if it wanted to.
// Keeping the crypto in one place — src/auth/offlineSession.ts — means there is
// exactly one implementation to get right rather than two that must agree.
//
// See migration 0022 for what is stored and, more importantly, what it does and
// does not protect against.

#[derive(Serialize)]
struct LocalSessionSummary {
    user_id: String,
    email: String,
    display_name: Option<String>,
    role: Option<String>,
    last_verified_at: String,
}

#[derive(Serialize)]
struct LocalSessionSecret {
    user_id: String,
    email: String,
    display_name: Option<String>,
    role: Option<String>,
    verifier: String,
    verifier_salt: String,
    verifier_iters: i64,
    refresh_token: Option<String>,
    last_verified_at: String,
}

/// Who has signed in on this machine before — the offline sign-in picker, and
/// the shift-handover list. Carries no verifier material.
#[tauri::command]
fn list_local_sessions(db: State<Db>) -> Result<Vec<LocalSessionSummary>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT user_id, email, display_name, role, last_verified_at
               FROM local_session ORDER BY last_verified_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(LocalSessionSummary {
                user_id: r.get(0)?,
                email: r.get(1)?,
                display_name: r.get(2)?,
                role: r.get(3)?,
                last_verified_at: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// The verifier material for one account, so the app can check a password with
/// no network. Returns None when this machine has never seen that person —
/// which is what makes the "first launch needs internet" message possible.
#[tauri::command]
fn get_local_session(email: String, db: State<Db>) -> Result<Option<LocalSessionSecret>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT user_id, email, display_name, role, verifier, verifier_salt,
                    verifier_iters, refresh_token, last_verified_at
               FROM local_session WHERE lower(email) = lower(?1)",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map(rusqlite::params![email.trim()], |r| {
            Ok(LocalSessionSecret {
                user_id: r.get(0)?,
                email: r.get(1)?,
                display_name: r.get(2)?,
                role: r.get(3)?,
                verifier: r.get(4)?,
                verifier_salt: r.get(5)?,
                verifier_iters: r.get(6)?,
                refresh_token: r.get(7)?,
                last_verified_at: r.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    match rows.next() {
        Some(r) => Ok(Some(r.map_err(|e| e.to_string())?)),
        None => Ok(None),
    }
}

/// Called after a SUCCESSFUL ONLINE sign-in, and only then. Refreshing the
/// verifier here is what makes a centrally-changed password take effect on this
/// machine, and stamping last_verified_at is what resets the offline window.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn save_local_session(
    user_id: String,
    email: String,
    display_name: Option<String>,
    role: Option<String>,
    verifier: String,
    verifier_salt: String,
    verifier_iters: i64,
    refresh_token: Option<String>,
    db: State<Db>,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO local_session
            (user_id, email, display_name, role, verifier, verifier_salt,
             verifier_iters, refresh_token, last_verified_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8, datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET
            email = excluded.email, display_name = excluded.display_name,
            role = excluded.role, verifier = excluded.verifier,
            verifier_salt = excluded.verifier_salt,
            verifier_iters = excluded.verifier_iters,
            refresh_token = excluded.refresh_token,
            last_verified_at = datetime('now')",
        rusqlite::params![user_id, email.trim(), display_name, role, verifier,
                          verifier_salt, verifier_iters, refresh_token],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Reset the offline clock after any successful server contact — a token
/// refresh counts, not only a typed sign-in. A machine that reaches the server
/// even once a week never sees a warning.
#[tauri::command]
fn touch_local_session(user_id: String, role: Option<String>, db: State<Db>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE local_session
            SET last_verified_at = datetime('now'),
                role = COALESCE(?2, role)
          WHERE user_id = ?1",
        rusqlite::params![user_id, role],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Forget one account on this machine. Used by "sign out and forget me", and by
/// an administrator clearing a departed employee off a shared counter.
#[tauri::command]
fn forget_local_session(user_id: String, db: State<Db>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM local_session WHERE user_id = ?1", rusqlite::params![user_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_device_code(db: State<Db>) -> Result<String, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    ensure_device_code(&conn)
}

/// Change this machine's numbering namespace. Only affects orders minted from
/// here AFTER the change — existing numbers are historical record and are never
/// rewritten.
#[tauri::command]
fn set_device_code(code: String, db: State<Db>) -> Result<String, String> {
    let clean: String = code
        .trim()
        .to_uppercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect();
    if clean.is_empty() {
        return Err("A device code needs at least one letter or digit.".into());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO device_identity (id, code) VALUES (1, ?1)
         ON CONFLICT(id) DO UPDATE SET code = excluded.code",
        rusqlite::params![clean],
    )
    .map_err(|e| e.to_string())?;
    Ok(clean)
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
        "UPDATE part SET deleted_at = datetime('now'),
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
        "UPDATE part SET deleted_at = NULL,
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
            get_device_code,
            set_device_code,
            sync_pull,
            list_suppliers,
            upsert_supplier,
            create_purchase_order,
            add_po_line,
            purchase_order_detail,
            create_goods_receipt,
            add_receipt_line,
            add_receipt_cost,
            preview_landed_cost,
            post_goods_receipt,
            recost_receipt,
            part_cost_now,
            rebate_standing,
            list_rebate_agreements,
            list_supplier_claims,
            record_discrepancy,
            list_open_purchase_orders,
            pull_po_lines,
            create_opening_receipt,
            list_discrepancies,
            list_local_sessions,
            get_local_session,
            save_local_session,
            touch_local_session,
            forget_local_session,
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
