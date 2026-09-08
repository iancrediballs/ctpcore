//! CTP Core — Stage B: pull-only sync from Supabase into the local database.
//!
//! WHAT THIS IS
//! The desktop reads and writes fleetview.db through Rust. This module brings
//! the cloud's changes DOWN into it. It never uploads — that is Stage C/D — so
//! the worst it can do is make local data more current.
//!
//! It is also THE RESEED. The desktop and cloud have never synced; the first
//! pull is what makes them agree. That is why it must merge rather than
//! replace, and why the merge is proven rather than assumed.
//!
//! THE THREE RULES, each of which exists because breaking it corrupts data
//!
//! 1. MATCH ON NATURAL KEYS, NEVER ON `id`. The two databases have independent
//!    id sequences: cloud `part.id = 1032` and local `part.id = 1032` are
//!    almost certainly different parts. Matching on id silently merges
//!    unrelated records and produces a database that looks fine and is wrong.
//!    Every statement below keys on sku / code / client_uuid / drawing_key, and
//!    foreign keys are resolved through those, never copied.
//!
//! 2. NEVER DELETE LOCAL ROWS BEFORE PULLING. A "clear and download" pull
//!    empties the counter's database, so a network failure half way turns a
//!    stale app into an unusable one. Rows are upserted; an interrupted pull
//!    leaves some tables refreshed, others not, and a working app either way.
//!
//! 3. ONE TRANSACTION PER TABLE, and the watermark moves only on success. A
//!    table is therefore always internally consistent, and a resumed pull
//!    continues instead of restarting.
//!
//! DELETIONS arrive as ordinary updates: every synced table except the ledger
//! carries `deleted_at`, so a retirement is a column change, not a missing row.
//! stock_movement has no `deleted_at` because it is append-only — rows are
//! never updated or removed, which is also why its watermark is `created_at`.

use rusqlite::{Connection, Transaction};
use serde::Serialize;
use serde_json::Value;

/// What one table's pull did. Reported per table so a partial sync can say
/// exactly how far it got rather than just "failed".
#[derive(Debug, Default, Serialize, Clone)]
pub struct Applied {
    pub table: String,
    pub seen: usize,
    pub inserted: usize,
    pub updated: usize,
    /// Rows the payload contained but that could not be applied — almost always
    /// a foreign key whose parent has not been pulled yet. Counted rather than
    /// silently dropped, because a non-zero value here means the table order is
    /// wrong and that is worth seeing.
    pub unresolved: usize,
}

fn s(row: &Value, key: &str) -> Option<String> {
    row.get(key).and_then(|v| v.as_str()).map(|v| v.to_string())
}
fn i(row: &Value, key: &str) -> Option<i64> {
    row.get(key).and_then(|v| v.as_i64())
}
/// A referenced row's natural key, as PostgREST returns an embedded resource:
/// `part(sku)` arrives as `{"part":{"sku":"CTP-..."}}`.
fn embedded(row: &Value, rel: &str, key: &str) -> Option<String> {
    row.get(rel)?.get(key)?.as_str().map(|v| v.to_string())
}

/// The order tables must be pulled in. Parents before children, because a child
/// row is dropped as `unresolved` if its parent is not present yet.
pub const PULL_ORDER: &[&str] = &[
    "category", "brand", "location", "part", "stock_movement",
];

/// The PostgREST select for each table. Embedded resources are how a child row
/// carries its parent's NATURAL key instead of the parent's cloud id — which is
/// what makes rule 1 possible.
pub fn select_for(table: &str) -> &'static str {
    match table {
        "category" => "code,name,rev,updated_at,deleted_at",
        "brand" => "code,name,rev,updated_at,deleted_at",
        "location" => "code,name,rev,updated_at,deleted_at",
        "part" => "sku,name,mpn,locator,catalogue_pn,inventory_pn,status,notes,\
                   list_price_minor,diagram_ref,rev,updated_at,deleted_at,\
                   category:category_id(code),brand:brand_id(code)",
        "stock_movement" => "client_uuid,delta,reason,created_at,origin,\
                             actor_id,actor_label,actor_source,\
                             part:part_id(sku),location:location_id(code)",
        _ => "*",
    }
}

/// Which column advances the watermark. Append-only tables have no updated_at.
pub fn watermark_col(table: &str) -> &'static str {
    match table {
        "stock_movement" => "created_at",
        _ => "updated_at",
    }
}

/// Apply one table's payload. Pure database work — no network — so it can be
/// tested against a real database copy, which is the only way to trust it.
pub fn apply_rows(tx: &Transaction, table: &str, rows: &[Value]) -> rusqlite::Result<Applied> {
    let mut a = Applied { table: table.to_string(), seen: rows.len(), ..Default::default() };
    match table {
        // ── simple code-keyed reference tables ─────────────────────────────
        "category" | "brand" | "location" => {
            for r in rows {
                let Some(code) = s(r, "code") else { a.unresolved += 1; continue };
                let n = tx.execute(
                    &format!(
                        "INSERT INTO {t} (code, name, rev, updated_at, deleted_at)
                         VALUES (?1, ?2, ?3, ?4, ?5)
                         ON CONFLICT(code) DO UPDATE SET
                            name = excluded.name, rev = excluded.rev,
                            updated_at = excluded.updated_at,
                            deleted_at = excluded.deleted_at",
                        t = table
                    ),
                    rusqlite::params![
                        code, s(r, "name").unwrap_or_default(),
                        i(r, "rev").unwrap_or(1), s(r, "updated_at"), s(r, "deleted_at")
                    ],
                )?;
                if n > 0 { a.updated += 1 } // SQLite reports 1 for both paths
            }
        }

        // ── part: keyed on sku, parents resolved by code ───────────────────
        "part" => {
            for r in rows {
                let Some(sku) = s(r, "sku") else { a.unresolved += 1; continue };
                let existed: bool = tx
                    .query_row("SELECT 1 FROM part WHERE sku = ?1", [&sku], |_| Ok(true))
                    .unwrap_or(false);
                tx.execute(
                    "INSERT INTO part (sku, name, mpn, locator, catalogue_pn, inventory_pn,
                                       status, notes, list_price_minor, diagram_ref,
                                       category_id, brand_id, rev, updated_at, deleted_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,
                             (SELECT id FROM category WHERE code = ?11),
                             (SELECT id FROM brand    WHERE code = ?12),
                             ?13,?14,?15)
                     ON CONFLICT(sku) DO UPDATE SET
                        name = excluded.name, mpn = excluded.mpn,
                        locator = excluded.locator, catalogue_pn = excluded.catalogue_pn,
                        inventory_pn = excluded.inventory_pn, status = excluded.status,
                        notes = excluded.notes, list_price_minor = excluded.list_price_minor,
                        diagram_ref = excluded.diagram_ref,
                        category_id = COALESCE(excluded.category_id, part.category_id),
                        brand_id = COALESCE(excluded.brand_id, part.brand_id),
                        rev = excluded.rev, updated_at = excluded.updated_at,
                        deleted_at = excluded.deleted_at",
                    rusqlite::params![
                        sku, s(r, "name").unwrap_or_default(), s(r, "mpn"), s(r, "locator"),
                        s(r, "catalogue_pn"), s(r, "inventory_pn"),
                        s(r, "status").unwrap_or_else(|| "active".into()), s(r, "notes"),
                        i(r, "list_price_minor"), s(r, "diagram_ref"),
                        embedded(r, "category", "code"), embedded(r, "brand", "code"),
                        i(r, "rev").unwrap_or(1), s(r, "updated_at"), s(r, "deleted_at")
                    ],
                )?;
                if existed { a.updated += 1 } else { a.inserted += 1 }
            }
        }

        // ── the ledger: append-only, deduplicated by client_uuid ───────────
        //
        // This is the table the whole reseed turns on. INSERT OR IGNORE against
        // the UNIQUE client_uuid means replaying rows the machine already has
        // is a no-op, so the first pull adds only what is genuinely new. A
        // plain INSERT would be rejected by the constraint rather than
        // double-counting a stock balance — the constraint is the safety net
        // under the code, not a substitute for it.
        "stock_movement" => {
            for r in rows {
                let (Some(uuid), Some(sku), Some(loc)) = (
                    s(r, "client_uuid"),
                    embedded(r, "part", "sku"),
                    embedded(r, "location", "code"),
                ) else { a.unresolved += 1; continue };

                let n = tx.execute(
                    "INSERT OR IGNORE INTO stock_movement
                        (part_id, location_id, delta, reason, client_uuid,
                         created_at, origin, actor_id, actor_label, actor_source)
                     SELECT p.id, l.id, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
                       FROM part p, location l
                      WHERE p.sku = ?1 AND l.code = ?2",
                    rusqlite::params![
                        sku, loc, i(r, "delta").unwrap_or(0),
                        s(r, "reason").unwrap_or_else(|| "adjustment".into()), uuid,
                        s(r, "created_at"), s(r, "origin").unwrap_or_else(|| "cloud".into()),
                        s(r, "actor_id"), s(r, "actor_label"), s(r, "actor_source")
                    ],
                )?;
                // 0 rows means either the uuid was already here (the common,
                // correct case on a reseed) or the part/location is unknown.
                if n > 0 {
                    a.inserted += 1;
                } else {
                    let known: bool = tx
                        .query_row(
                            "SELECT 1 FROM stock_movement WHERE client_uuid = ?1",
                            [&uuid], |_| Ok(true),
                        )
                        .unwrap_or(false);
                    if !known { a.unresolved += 1 }
                }
            }
        }

        _ => { a.unresolved = rows.len() }
    }
    Ok(a)
}

// ─── watermarks, stored on device_identity (local-only, never synced) ────────

pub fn get_watermark(conn: &Connection, table: &str) -> Option<String> {
    let raw: String = conn
        .query_row("SELECT sync_watermarks FROM device_identity WHERE id = 1", [], |r| r.get(0))
        .ok()?;
    serde_json::from_str::<Value>(&raw).ok()?.get(table)?.as_str().map(|s| s.to_string())
}

pub fn set_watermark(conn: &Connection, table: &str, value: &str) -> rusqlite::Result<()> {
    let raw: String = conn
        .query_row("SELECT sync_watermarks FROM device_identity WHERE id = 1", [], |r| r.get(0))
        .unwrap_or_else(|_| "{}".to_string());
    let mut map: Value = serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!({}));
    map[table] = Value::String(value.to_string());
    conn.execute(
        "UPDATE device_identity SET sync_watermarks = ?1 WHERE id = 1",
        rusqlite::params![map.to_string()],
    )?;
    Ok(())
}

/// The highest watermark value in a payload, so the next pull resumes from
/// exactly where this one stopped.
pub fn max_watermark(table: &str, rows: &[Value]) -> Option<String> {
    let col = watermark_col(table);
    rows.iter().filter_map(|r| s(r, col)).max()
}

// ─── tests ───────────────────────────────────────────────────────────────────
//
// These run against a COPY of a real database, never the live one. Set
// CTP_TEST_DB to a copy that has been migrated to v21; without it they skip,
// so `cargo test` on a machine without one is still green.
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn open() -> Option<Connection> {
        let p = std::env::var("CTP_TEST_DB").ok()?;
        Connection::open(p).ok()
    }

    /// THE RESEED. The desktop holds 160 seeded movements; the cloud holds
    /// those same 160 plus 39 of its own. Replaying all 199 must add exactly
    /// the 39 and change nothing else — no duplicates, no double-counted stock.
    #[test]
    fn first_pull_adds_only_new_movements() {
        let Some(mut conn) = open() else { eprintln!("skipped: set CTP_TEST_DB"); return };
        let before: i64 = conn
            .query_row("SELECT count(*) FROM stock_movement", [], |r| r.get(0)).unwrap();
        let sum_before: i64 = conn
            .query_row("SELECT COALESCE(SUM(delta),0) FROM stock_movement", [], |r| r.get(0)).unwrap();

        // Build a payload the way PostgREST would return it: every existing
        // client_uuid (as a full re-pull would), plus 39 cloud-only rows.
        let existing: Vec<(String, String, String)> = {
            let mut st = conn.prepare(
                "SELECT m.client_uuid, p.sku, l.code FROM stock_movement m
                   JOIN part p ON p.id = m.part_id
                   JOIN location l ON l.id = m.location_id").unwrap();
            let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
            rows.filter_map(|x| x.ok()).collect()
        };
        let (sku, loc) = (existing[0].1.clone(), existing[0].2.clone());

        let mut payload: Vec<Value> = existing.iter().map(|(u, s, l)| json!({
            "client_uuid": u, "delta": 1, "reason": "receipt",
            "created_at": "2026-09-08 00:00:44",
            "part": {"sku": s}, "location": {"code": l}
        })).collect();
        for n in 0..39 {
            payload.push(json!({
                "client_uuid": format!("cloud-only-{n}"), "delta": 5, "reason": "adjustment",
                "created_at": "2026-09-09 10:00:00", "origin": "cloud",
                "part": {"sku": sku}, "location": {"code": loc}
            }));
        }

        let tx = conn.transaction().unwrap();
        let a = apply_rows(&tx, "stock_movement", &payload).unwrap();
        tx.commit().unwrap();

        let after: i64 = conn
            .query_row("SELECT count(*) FROM stock_movement", [], |r| r.get(0)).unwrap();
        let sum_after: i64 = conn
            .query_row("SELECT COALESCE(SUM(delta),0) FROM stock_movement", [], |r| r.get(0)).unwrap();
        let distinct: i64 = conn
            .query_row("SELECT count(DISTINCT client_uuid) FROM stock_movement", [], |r| r.get(0)).unwrap();

        eprintln!("seen={} inserted={} unresolved={}", a.seen, a.inserted, a.unresolved);
        eprintln!("rows {before} -> {after}   sum(delta) {sum_before} -> {sum_after}");
        assert_eq!(after - before, 39, "must add exactly the 39 cloud-only rows");
        assert_eq!(a.inserted, 39, "and report them");
        assert_eq!(a.unresolved, 0, "every row resolved a part and location");
        assert_eq!(sum_after - sum_before, 195, "39 x 5 — the existing 160 were not re-counted");
        assert_eq!(distinct, after, "no duplicate client_uuid");
    }

    /// Re-running a pull must be a no-op. A sync that is not idempotent will
    /// double stock the first time a retry happens.
    #[test]
    fn second_pull_changes_nothing() {
        let Some(mut conn) = open() else { eprintln!("skipped: set CTP_TEST_DB"); return };
        let payload: Vec<Value> = {
            let mut st = conn.prepare(
                "SELECT m.client_uuid, p.sku, l.code, m.delta FROM stock_movement m
                   JOIN part p ON p.id = m.part_id
                   JOIN location l ON l.id = m.location_id LIMIT 50").unwrap();
            st.query_map([], |r| Ok(json!({
                "client_uuid": r.get::<_, String>(0)?, "delta": r.get::<_, i64>(3)?,
                "reason": "receipt", "created_at": "2026-09-08 00:00:44",
                "part": {"sku": r.get::<_, String>(1)?}, "location": {"code": r.get::<_, String>(2)?}
            }))).unwrap().filter_map(|x| x.ok()).collect()
        };
        let before: i64 = conn
            .query_row("SELECT count(*) FROM stock_movement", [], |r| r.get(0)).unwrap();
        let tx = conn.transaction().unwrap();
        let a = apply_rows(&tx, "stock_movement", &payload).unwrap();
        tx.commit().unwrap();
        let after: i64 = conn
            .query_row("SELECT count(*) FROM stock_movement", [], |r| r.get(0)).unwrap();
        assert_eq!(before, after, "replaying known rows must add nothing");
        assert_eq!(a.inserted, 0);
        assert_eq!(a.unresolved, 0, "known uuids are not 'unresolved'");
    }

    /// A movement whose part has not been pulled yet is COUNTED, not silently
    /// dropped — a non-zero unresolved means the table order is wrong, and that
    /// is worth seeing rather than discovering as missing stock later.
    #[test]
    fn unknown_part_is_reported_not_swallowed() {
        let Some(mut conn) = open() else { eprintln!("skipped: set CTP_TEST_DB"); return };
        let payload = vec![json!({
            "client_uuid": "orphan-1", "delta": 3, "reason": "receipt",
            "created_at": "2026-09-09 11:00:00",
            "part": {"sku": "NO-SUCH-PART"}, "location": {"code": "NO-SUCH-LOC"}
        })];
        let tx = conn.transaction().unwrap();
        let a = apply_rows(&tx, "stock_movement", &payload).unwrap();
        tx.rollback().unwrap();
        assert_eq!(a.inserted, 0);
        assert_eq!(a.unresolved, 1);
    }

    /// Deletions arrive as ordinary updates, because every synced table except
    /// the ledger carries deleted_at. A retirement must land as a column change.
    #[test]
    fn soft_delete_propagates_as_an_update() {
        let Some(mut conn) = open() else { eprintln!("skipped: set CTP_TEST_DB"); return };
        let code: String = conn
            .query_row("SELECT code FROM location LIMIT 1", [], |r| r.get(0)).unwrap();
        let payload = vec![json!({
            "code": code, "name": "Retired bin", "rev": 9,
            "updated_at": "2026-09-09 12:00:00", "deleted_at": "2026-09-09 12:00:00"
        })];
        let tx = conn.transaction().unwrap();
        apply_rows(&tx, "location", &payload).unwrap();
        let gone: Option<String> = tx
            .query_row("SELECT deleted_at FROM location WHERE code = ?1", [&code], |r| r.get(0))
            .unwrap();
        tx.rollback().unwrap();
        assert!(gone.is_some(), "a cloud retirement must arrive as deleted_at");
    }
}
