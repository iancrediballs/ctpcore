//! CTP Core — purchasing, goods receipt, landed cost and rebates.
//!
//! THE EQUATION THIS MODULE EXISTS TO COMPUTE
//!
//!     true cost = invoice + freight + duty + clearing − rebate earned
//!
//! WHAT MAKES IT DIFFERENT FROM THE REST OF THE APP: everything here is money,
//! and money that does not add up is worse than money that is missing. So the
//! rules are stricter than elsewhere:
//!
//!   1. INTEGER MINOR UNITS ONLY. No floats anywhere in a money path. FX rates
//!      are integer parts-per-million. A float rate multiplied across 161 lines
//!      produces a total that does not reconcile with the invoice, and "the
//!      cents do not add up" is the one bug an importer never forgives.
//!
//!   2. ALLOCATION IS EXACT. Splitting R10 000 of freight across three parts
//!      by value must produce three numbers that sum to exactly 1 000 000
//!      cents — not 999 999. `allocate()` uses the largest-remainder method
//!      and its postcondition is asserted, not hoped for.
//!
//!   3. TWO COST FIGURES, NEVER ONE. `cost_invoiced` is money actually spent
//!      and is the only figure a price floor may read. `cost_expected` is net
//!      of rebate and is for reporting. THE FLOOR NEVER MOVES ON MONEY THAT
//!      HAS NOT ARRIVED — see `RebateBasis`.

use rusqlite::{Connection, Transaction};
use serde::{Deserialize, Serialize};

pub const PPM: i128 = 1_000_000;

// ═══════════════════════════════════════════════════════════════════════════
//  Pure arithmetic. No database, no I/O — so it can be tested exhaustively.
// ═══════════════════════════════════════════════════════════════════════════

/// Convert an amount into company currency at an integer ppm rate.
/// Rounds half away from zero, so 1.5 cents becomes 2 and −1.5 becomes −2.
/// i128 throughout: a 9-digit rand amount times a 7-digit rate overflows i64.
pub fn convert_minor(amount_minor: i64, fx_rate_ppm: i64) -> i64 {
    if fx_rate_ppm == PPM as i64 {
        return amount_minor; // exact identity, no rounding error to introduce
    }
    let n = amount_minor as i128 * fx_rate_ppm as i128;
    let rounded = if n >= 0 { n + PPM / 2 } else { n - PPM / 2 };
    (rounded / PPM) as i64
}

/// Apply a rate in basis points to an amount. 1500 bps = 15%.
/// Rounds half away from zero, same convention as `convert_minor`.
pub fn apply_bps(amount_minor: i64, rate_bps: i64) -> i64 {
    let n = amount_minor as i128 * rate_bps as i128;
    let rounded = if n >= 0 { n + 5_000 } else { n - 5_000 };
    (rounded / 10_000) as i64
}

/// Split `total` across `weights` so the parts sum to EXACTLY `total`.
///
/// Largest-remainder (Hamilton) method: give everyone their floor, then hand
/// the leftover cents one at a time to whoever was rounded down hardest. Ties
/// break on index so the result is deterministic — the same receipt recosted
/// twice must produce the same numbers, or the audit trail is noise.
///
/// Weights of zero receive zero. If every weight is zero the total is spread
/// evenly, because a consignment charge still has to land somewhere and
/// refusing to allocate it would silently understate cost.
pub fn allocate(total_minor: i64, weights: &[i64]) -> Vec<i64> {
    let n = weights.len();
    if n == 0 {
        return vec![];
    }
    let sum: i128 = weights.iter().map(|&w| w.max(0) as i128).sum();
    if sum == 0 {
        // Even split, remainder to the earliest indices.
        let base = total_minor / n as i64;
        let mut rem = total_minor - base * n as i64;
        return (0..n)
            .map(|_| {
                let extra = if rem > 0 { 1 } else { 0 };
                rem -= extra;
                base + extra
            })
            .collect();
    }

    let t = total_minor as i128;
    let mut out = Vec::with_capacity(n);
    // (remainder, index) for the leftover pass
    let mut rems: Vec<(i128, usize)> = Vec::with_capacity(n);
    let mut given: i128 = 0;
    for (i, &w) in weights.iter().enumerate() {
        let w = w.max(0) as i128;
        let exact = t * w;
        let share = exact.div_euclid(sum);
        let rem = exact.rem_euclid(sum);
        out.push(share as i64);
        rems.push((rem, i));
        given += share;
    }
    // Hand out the leftover, largest fractional part first.
    let mut leftover = t - given;
    rems.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    let mut k = 0usize;
    while leftover > 0 && k < rems.len() {
        out[rems[k].1] += 1;
        leftover -= 1;
        k += 1;
        if k == rems.len() && leftover > 0 {
            k = 0; // only possible when total > sum of weights; keep going round
        }
    }
    while leftover < 0 && k < rems.len() {
        out[rems[k].1] -= 1;
        leftover += 1;
        k += 1;
        if k == rems.len() && leftover < 0 {
            k = 0;
        }
    }
    debug_assert_eq!(out.iter().map(|&x| x as i128).sum::<i128>(), t);
    out
}

// ═══════════════════════════════════════════════════════════════════════════
//  Rebate tier arithmetic
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tier {
    pub threshold_from: i64,
    /// None = open-ended top tier.
    pub threshold_to: Option<i64>,
    pub rate_bps: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TierMode {
    /// 2% on the first R1m, 3% on the next. Crossing a threshold affects only
    /// what comes after it.
    Incremental,
    /// Cross R2m and 3% applies to the WHOLE period from the first rand.
    /// Crossing retroactively revalues everything already accrued — which is
    /// why "distance to next tier" is worth so much more under this mode.
    Retrospective,
}

impl TierMode {
    pub fn parse(s: &str) -> TierMode {
        match s {
            "retrospective" => TierMode::Retrospective,
            _ => TierMode::Incremental,
        }
    }
}

/// Total rebate earned at a measured volume. `tiers` need not be sorted.
///
/// This is the single function the whole engine's correctness rests on, which
/// is why it is pure, takes no database, and has a worked example per branch
/// in the tests below.
pub fn rebate_at(mode: TierMode, tiers: &[Tier], measured: i64) -> i64 {
    if measured <= 0 || tiers.is_empty() {
        return 0;
    }
    let mut t: Vec<Tier> = tiers.to_vec();
    t.sort_by_key(|x| x.threshold_from);

    match mode {
        TierMode::Incremental => {
            let mut total = 0i64;
            for tier in &t {
                if measured <= tier.threshold_from {
                    continue;
                }
                let upper = match tier.threshold_to {
                    Some(u) => u.min(measured),
                    None => measured,
                };
                let band = upper - tier.threshold_from;
                if band > 0 {
                    total += apply_bps(band, tier.rate_bps);
                }
            }
            total
        }
        TierMode::Retrospective => {
            // The rate of the highest tier whose threshold has been reached,
            // applied to everything.
            let mut rate = 0i64;
            for tier in &t {
                if measured >= tier.threshold_from {
                    rate = tier.rate_bps;
                }
            }
            apply_bps(measured, rate)
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct NextTier {
    pub threshold: i64,
    /// How much more volume is needed.
    pub gap: i64,
    /// What crossing it is worth — the FULL uplift, not the rate times the gap.
    /// Under a retrospective scheme these differ by orders of magnitude, and
    /// that difference is the entire reason this figure exists.
    pub uplift_minor: i64,
    pub rate_bps: i64,
}

/// The next threshold above `measured`, and what reaching it is worth.
pub fn next_tier(mode: TierMode, tiers: &[Tier], measured: i64) -> Option<NextTier> {
    let mut t: Vec<Tier> = tiers.to_vec();
    t.sort_by_key(|x| x.threshold_from);
    let nxt = t.iter().find(|x| x.threshold_from > measured)?;
    let now = rebate_at(mode, &t, measured);
    let then = rebate_at(mode, &t, nxt.threshold_from);
    Some(NextTier {
        threshold: nxt.threshold_from,
        gap: nxt.threshold_from - measured,
        uplift_minor: then - now,
        rate_bps: nxt.rate_bps,
    })
}

/// Which accrual states are allowed to reduce a cost figure.
///
/// ⚠ `Settled` is the default and the only safe answer for anything that
///   constrains a price. Allowing `Accrued` to reach a price floor lets the app
///   fund discounts with money that has not arrived, may never arrive, and may
///   be reversed — which is how an importer discounts its way to missing the
///   very threshold that was paying for the discount.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RebateBasis {
    None,
    Settled,
    Claimed,
    Accrued,
}

impl RebateBasis {
    pub fn parse(s: &str) -> RebateBasis {
        match s {
            "accrued" => RebateBasis::Accrued,
            "claimed" => RebateBasis::Claimed,
            "settled" => RebateBasis::Settled,
            _ => RebateBasis::None,
        }
    }
    pub fn as_str(&self) -> &'static str {
        match self {
            RebateBasis::None => "none",
            RebateBasis::Settled => "settled",
            RebateBasis::Claimed => "claimed",
            RebateBasis::Accrued => "accrued",
        }
    }
    /// The accrual states this basis counts.
    fn states(&self) -> &'static [&'static str] {
        match self {
            RebateBasis::None => &[],
            RebateBasis::Settled => &["settled"],
            RebateBasis::Claimed => &["claimed", "settled"],
            RebateBasis::Accrued => &["accrued", "claimable", "claimed", "settled"],
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Landed cost
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Debug, Clone, Serialize)]
pub struct LandedLine {
    pub part_id: i64,
    pub sku: String,
    pub qty: i64,
    pub unit_invoice_minor: i64,
    pub unit_freight_minor: i64,
    pub unit_duty_minor: i64,
    pub unit_clearing_minor: i64,
    pub unit_other_minor: i64,
    pub unit_cost_invoiced_minor: i64,
    /// Consignment-level totals, which are exact. Per-unit figures are these
    /// divided by qty and rounded, so unit × qty can differ from the total by
    /// less than a cent per unit. The totals are authoritative for reconciling
    /// against the supplier and clearing invoices.
    pub total_invoiced_minor: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct LandedResult {
    pub receipt_id: i64,
    pub lines: Vec<LandedLine>,
    pub goods_total_minor: i64,
    pub components_total_minor: i64,
    pub grand_total_minor: i64,
    /// Components excluded from the part cost — reclaimable import VAT and
    /// anything else flagged `is_landed = 0`. Reported rather than hidden, so
    /// a total that does not match the clearing invoice has a visible reason.
    pub excluded_minor: i64,
    /// Set when a `by_weight` component could not use weights because some part
    /// on the receipt has none, and fell back to `by_value`. Weight is missing
    /// on all 161 parts today, so this is the expected path, not an edge case.
    pub weight_fallbacks: Vec<String>,
}

struct RcLine {
    part_id: i64,
    sku: String,
    qty: i64,
    unit_cost_minor: i64, // invoice currency
    weight_g: Option<i64>,
}

/// Compute the landed cost for every line of a receipt. Pure read — writes
/// nothing — so it can be shown on screen before anyone commits to it.
pub fn compute_landed(conn: &Connection, receipt_id: i64) -> Result<LandedResult, String> {
    let (fx_ppm, _kind): (i64, String) = conn
        .query_row(
            "SELECT fx_rate_ppm, kind FROM goods_receipt WHERE id = ?1",
            [receipt_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| format!("receipt {receipt_id}: {e}"))?;

    let mut stmt = conn
        .prepare(
            "SELECT l.part_id, p.sku, l.qty_received, l.unit_cost_minor, p.weight_g
               FROM goods_receipt_line l JOIN part p ON p.id = l.part_id
              WHERE l.receipt_id = ?1 AND l.deleted_at IS NULL
              ORDER BY l.id",
        )
        .map_err(|e| e.to_string())?;
    let lines: Vec<RcLine> = stmt
        .query_map([receipt_id], |r| {
            Ok(RcLine {
                part_id: r.get(0)?,
                sku: r.get(1)?,
                qty: r.get(2)?,
                unit_cost_minor: r.get(3)?,
                weight_g: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;

    if lines.is_empty() {
        return Ok(LandedResult {
            receipt_id,
            lines: vec![],
            goods_total_minor: 0,
            components_total_minor: 0,
            grand_total_minor: 0,
            excluded_minor: 0,
            weight_fallbacks: vec![],
        });
    }

    // Goods value per line, converted to company currency ONCE per line. The
    // conversion happens on the line total rather than the unit price so a
    // fractional cent is not multiplied by the quantity.
    let goods: Vec<i64> = lines
        .iter()
        .map(|l| convert_minor(l.unit_cost_minor * l.qty, fx_ppm))
        .collect();
    let goods_total: i64 = goods.iter().sum();

    let n = lines.len();
    let mut freight = vec![0i64; n];
    let mut duty = vec![0i64; n];
    let mut clearing = vec![0i64; n];
    let mut other = vec![0i64; n];
    let mut components_total = 0i64;
    let mut excluded = 0i64;
    let mut fallbacks: Vec<String> = vec![];

    let mut cstmt = conn
        .prepare(
            "SELECT component, amount_minor, currency, fx_rate_ppm, allocation,
                    direct_part_id, is_landed
               FROM receipt_cost WHERE receipt_id = ?1 AND deleted_at IS NULL
              ORDER BY id",
        )
        .map_err(|e| e.to_string())?;
    let comps: Vec<(String, i64, String, i64, String, Option<i64>, i64)> = cstmt
        .query_map([receipt_id], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;

    for (component, amount, _ccy, c_fx, allocation, direct_part, is_landed) in comps {
        let amt = convert_minor(amount, c_fx);
        if is_landed == 0 {
            // Reclaimable import VAT and anything else deliberately excluded.
            excluded += amt;
            continue;
        }
        components_total += amt;

        let weights: Vec<i64> = match allocation.as_str() {
            "by_units" => lines.iter().map(|l| l.qty).collect(),
            "by_weight" => {
                if lines.iter().any(|l| l.weight_g.unwrap_or(0) <= 0) {
                    // Cannot weigh what has no weight. Fall back rather than
                    // silently treating a missing weight as zero, which would
                    // give heavy parts no freight at all.
                    fallbacks.push(component.clone());
                    goods.clone()
                } else {
                    lines
                        .iter()
                        .map(|l| l.weight_g.unwrap_or(0) * l.qty)
                        .collect()
                }
            }
            "direct" => {
                let target = direct_part.unwrap_or(-1);
                lines
                    .iter()
                    .map(|l| if l.part_id == target { 1 } else { 0 })
                    .collect()
            }
            _ => goods.clone(), // by_value
        };

        let split = allocate(amt, &weights);
        let bucket = match component.as_str() {
            "freight_sea" | "freight_air" | "freight_road" => &mut freight,
            "duty" => &mut duty,
            "clearing" | "handling" => &mut clearing,
            _ => &mut other,
        };
        for (i, v) in split.iter().enumerate() {
            bucket[i] += v;
        }
    }

    let out: Vec<LandedLine> = lines
        .iter()
        .enumerate()
        .map(|(i, l)| {
            let total = goods[i] + freight[i] + duty[i] + clearing[i] + other[i];
            // Per-unit is the line total divided by quantity. Rounded half up:
            // under-stating cost is the dangerous direction, because it is the
            // direction that lets a price floor drop.
            let per = |v: i64| (v + l.qty / 2) / l.qty;
            LandedLine {
                part_id: l.part_id,
                sku: l.sku.clone(),
                qty: l.qty,
                unit_invoice_minor: per(goods[i]),
                unit_freight_minor: per(freight[i]),
                unit_duty_minor: per(duty[i]),
                unit_clearing_minor: per(clearing[i]),
                unit_other_minor: per(other[i]),
                unit_cost_invoiced_minor: per(total),
                total_invoiced_minor: total,
            }
        })
        .collect();

    Ok(LandedResult {
        receipt_id,
        lines: out,
        goods_total_minor: goods_total,
        components_total_minor: components_total,
        grand_total_minor: goods_total + components_total,
        excluded_minor: excluded,
        weight_fallbacks: fallbacks,
    })
}

/// Write the computed landed cost into `part_landed_cost`, one row per part per
/// receipt, updated in place on recompute. `rebate_basis` decides which accrual
/// states may reduce the expected figure — and NOTHING may reduce the invoiced
/// one, which is why it is written from `compute_landed` alone.
pub fn write_landed(
    tx: &Transaction,
    receipt_id: i64,
    basis: RebateBasis,
) -> Result<usize, String> {
    let res = compute_landed(tx, receipt_id)?;
    let (is_est, received_at): (i64, String) = tx
        .query_row(
            "SELECT cost_is_estimated, received_at FROM goods_receipt WHERE id = ?1",
            [receipt_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;

    let mut written = 0usize;
    for line in &res.lines {
        let rebate_unit = rebate_per_unit(tx, receipt_id, line.part_id, line.qty, basis)?;
        // Expected can never exceed invoiced; the table CHECKs it too, but
        // clamping here gives a comprehensible number rather than an error if a
        // rebate is ever mis-entered larger than the cost.
        let expected = (line.unit_cost_invoiced_minor - rebate_unit).max(0);
        tx.execute(
            "INSERT INTO part_landed_cost
               (part_id, receipt_id, currency, qty,
                unit_invoice_minor, unit_freight_minor, unit_duty_minor,
                unit_clearing_minor, unit_other_minor,
                unit_cost_invoiced_minor, unit_rebate_minor,
                unit_cost_expected_minor, rebate_basis,
                is_estimated, valid_from, source)
             VALUES (?1,?2,'ZAR',?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
             -- The WHERE mirrors the PARTIAL unique index. SQLite matches an
             -- ON CONFLICT target against a full index unless the predicate is
             -- repeated here, and without it this fails at runtime rather than
             -- at compile time.
             ON CONFLICT(part_id, receipt_id) WHERE receipt_id IS NOT NULL
             DO UPDATE SET
                qty = excluded.qty,
                unit_invoice_minor = excluded.unit_invoice_minor,
                unit_freight_minor = excluded.unit_freight_minor,
                unit_duty_minor = excluded.unit_duty_minor,
                unit_clearing_minor = excluded.unit_clearing_minor,
                unit_other_minor = excluded.unit_other_minor,
                unit_cost_invoiced_minor = excluded.unit_cost_invoiced_minor,
                unit_rebate_minor = excluded.unit_rebate_minor,
                unit_cost_expected_minor = excluded.unit_cost_expected_minor,
                rebate_basis = excluded.rebate_basis,
                is_estimated = excluded.is_estimated,
                valid_from = excluded.valid_from,
                source = excluded.source",
            rusqlite::params![
                line.part_id,
                receipt_id,
                line.qty,
                line.unit_invoice_minor,
                line.unit_freight_minor,
                line.unit_duty_minor,
                line.unit_clearing_minor,
                line.unit_other_minor,
                line.unit_cost_invoiced_minor,
                rebate_unit,
                expected,
                basis.as_str(),
                is_est,
                received_at,
                format!("goods_receipt:{receipt_id}"),
            ],
        )
        .map_err(|e| e.to_string())?;
        written += 1;
    }
    Ok(written)
}

/// Rebate attributable to one part on one receipt, per unit.
fn rebate_per_unit(
    conn: &Connection,
    receipt_id: i64,
    part_id: i64,
    qty: i64,
    basis: RebateBasis,
) -> Result<i64, String> {
    let states = basis.states();
    if states.is_empty() || qty <= 0 {
        return Ok(0);
    }
    let placeholders = states.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT COALESCE(SUM(amount_minor), 0) FROM rebate_accrual
          WHERE source_type = 'goods_receipt' AND source_id = ?1
            AND part_id = ?2 AND state IN ({placeholders})"
    );
    let mut params: Vec<Box<dyn rusqlite::ToSql>> =
        vec![Box::new(receipt_id), Box::new(part_id)];
    for s in states {
        params.push(Box::new(*s));
    }
    let refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let total: i64 = conn
        .query_row(&sql, refs.as_slice(), |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok((total + qty / 2) / qty)
}

// ═══════════════════════════════════════════════════════════════════════════
//  Posting a receipt
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Debug, Serialize)]
pub struct PostResult {
    pub receipt_id: i64,
    pub movements: usize,
    pub landed_rows: usize,
    pub accruals: usize,
    pub units: i64,
}

/// Post a draft receipt: stock arrives, landed costs are written, purchase-based
/// rebates accrue. One transaction — a receipt is never half-posted.
///
/// Stock is written to `stock_movement` and NOWHERE else. `client_uuid` is
/// derived from the receipt line so a retried post inserts once, the same
/// contract the counter already relies on.
pub fn post_receipt(tx: &Transaction, receipt_id: i64) -> Result<PostResult, String> {
    let (status, location_id): (String, i64) = tx
        .query_row(
            "SELECT status, location_id FROM goods_receipt WHERE id = ?1",
            [receipt_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| format!("receipt {receipt_id}: {e}"))?;
    if status != "draft" {
        return Err(format!(
            "receipt {receipt_id} is '{status}'; only a draft can be posted"
        ));
    }

    let mut stmt = tx
        .prepare(
            "SELECT id, part_id, qty_received FROM goods_receipt_line
              WHERE receipt_id = ?1 AND deleted_at IS NULL ORDER BY id",
        )
        .map_err(|e| e.to_string())?;
    let rows: Vec<(i64, i64, i64)> = stmt
        .query_map([receipt_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);

    if rows.is_empty() {
        return Err(format!("receipt {receipt_id} has no lines"));
    }

    let mut movements = 0usize;
    let mut units = 0i64;
    for (line_id, part_id, qty) in &rows {
        let uuid = format!("grl-{line_id}");
        let n = tx
            .execute(
                "INSERT OR IGNORE INTO stock_movement
                   (part_id, location_id, delta, reason, ref_type, ref_id,
                    client_uuid, origin, actor_source)
                 VALUES (?1, ?2, ?3, 'receipt', 'goods_receipt', ?4, ?5, 'local', 'local_session')",
                rusqlite::params![part_id, location_id, qty, receipt_id, uuid],
            )
            .map_err(|e| e.to_string())?;
        movements += n;
        if n > 0 {
            units += qty;
        }
    }

    tx.execute(
        "UPDATE goods_receipt SET status = 'posted', posted_at = datetime('now')
          WHERE id = ?1",
        [receipt_id],
    )
    .map_err(|e| e.to_string())?;

    // Rebates accrue from the receipt, so they must be computed BEFORE the
    // landed cost that consumes them — otherwise the first write of
    // cost_expected would miss the rebate this very receipt earned.
    let accruals = accrue_purchases_for_receipt(tx, receipt_id)?;
    let landed_rows = write_landed(tx, receipt_id, RebateBasis::Settled)?;

    // Roll the PO forward if there is one.
    tx.execute(
        "UPDATE purchase_order SET status =
           CASE WHEN NOT EXISTS (
                  SELECT 1 FROM po_line_status s
                   WHERE s.order_id = purchase_order.id
                     AND s.qty_received < s.qty_ordered)
                THEN 'received' ELSE 'part_received' END
          WHERE id = (SELECT order_id FROM goods_receipt WHERE id = ?1)
            AND status IN ('sent','acknowledged','part_received')",
        [receipt_id],
    )
    .map_err(|e| e.to_string())?;

    Ok(PostResult {
        receipt_id,
        movements,
        landed_rows,
        accruals,
        units,
    })
}

// ═══════════════════════════════════════════════════════════════════════════
//  Rebate accrual
// ═══════════════════════════════════════════════════════════════════════════

/// Accrue purchase-based rebates for a posted receipt.
///
/// THE DELTA RULE, which is what makes retrospective tiers work without special
/// cases: each receipt accrues `rebate_at(cumulative_after) −
/// rebate_at(cumulative_before)`. Under an incremental scheme that is just this
/// receipt's own share. Under a retrospective scheme, the receipt that crosses
/// a threshold automatically accrues the uplift on ALL prior volume too,
/// because that is genuinely what crossing it earned.
pub fn accrue_purchases_for_receipt(
    tx: &Transaction,
    receipt_id: i64,
) -> Result<usize, String> {
    let (supplier_id, received_at): (Option<i64>, String) = tx
        .query_row(
            "SELECT supplier_id, received_at FROM goods_receipt WHERE id = ?1",
            [receipt_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    let Some(supplier_id) = supplier_id else {
        return Ok(0); // an opening balance has no supplier and earns nothing
    };

    let mut astmt = tx
        .prepare(
            "SELECT id, measure, scope, tier_mode, period_start, period_end
               FROM rebate_agreement
              WHERE supplier_id = ?1 AND basis = 'purchases' AND status = 'active'
                AND deleted_at IS NULL
                AND ?2 >= period_start AND ?2 < period_end",
        )
        .map_err(|e| e.to_string())?;
    let agreements: Vec<(i64, String, String, String, String, String)> = astmt
        .query_map(rusqlite::params![supplier_id, received_at], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;
    drop(astmt);

    let mut written = 0usize;
    for (agreement_id, measure, scope, mode_s, p_start, p_end) in agreements {
        let mode = TierMode::parse(&mode_s);
        let tiers = load_tiers(tx, agreement_id)?;
        if tiers.is_empty() {
            continue;
        }

        // What this receipt contributes, per part, within the agreement's scope.
        let per_part = receipt_measure_by_part(tx, receipt_id, agreement_id, &scope, &measure)?;
        let this_receipt: i64 = per_part.iter().map(|(_, v)| *v).sum();
        if this_receipt == 0 {
            continue;
        }

        // Everything already measured in this period, EXCLUDING this receipt —
        // so a re-post cannot double-count.
        let before = period_measure_before(
            tx,
            agreement_id,
            supplier_id,
            &scope,
            &measure,
            &p_start,
            &p_end,
            receipt_id,
        )?;
        let after = before + this_receipt;

        let delta = rebate_at(mode, &tiers, after) - rebate_at(mode, &tiers, before);
        if delta == 0 {
            continue;
        }

        // Attribute the earned amount across the parts that earned it, exactly.
        let weights: Vec<i64> = per_part.iter().map(|(_, v)| *v).collect();
        let split = allocate(delta, &weights);
        let effective_bps = if after > 0 {
            (delta as i128 * 10_000 / after as i128) as i64
        } else {
            0
        };

        for ((part_id, measured), amount) in per_part.iter().zip(split.iter()) {
            if *amount == 0 {
                continue;
            }
            let uuid = format!("acc-{agreement_id}-{receipt_id}-{part_id}");
            let n = tx
                .execute(
                    "INSERT OR IGNORE INTO rebate_accrual
                       (agreement_id, period_start, period_end, source_type, source_id,
                        part_id, qty, measured_value_minor, rate_bps_applied,
                        amount_minor, state, client_uuid, actor_source, note)
                     VALUES (?1,?2,?3,'goods_receipt',?4,?5,0,?6,?7,?8,'accrued',?9,
                             'local_session',?10)",
                    rusqlite::params![
                        agreement_id,
                        p_start,
                        p_end,
                        receipt_id,
                        part_id,
                        measured,
                        effective_bps,
                        amount,
                        uuid,
                        format!(
                            "{mode_s}: period {before} -> {after}, earned {delta} on this receipt"
                        ),
                    ],
                )
                .map_err(|e| e.to_string())?;
            written += n;
        }
    }
    Ok(written)
}

fn load_tiers(conn: &Connection, agreement_id: i64) -> Result<Vec<Tier>, String> {
    let mut s = conn
        .prepare(
            "SELECT threshold_from, threshold_to, rate_bps FROM rebate_tier
              WHERE agreement_id = ?1 AND deleted_at IS NULL ORDER BY threshold_from",
        )
        .map_err(|e| e.to_string())?;
    let v = s
        .query_map([agreement_id], |r| {
            Ok(Tier {
                threshold_from: r.get(0)?,
                threshold_to: r.get(1)?,
                rate_bps: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(v)
}

/// `true` when the part is inside the agreement's scope.
fn scope_clause(scope: &str) -> &'static str {
    match scope {
        "product_group" => {
            " AND EXISTS (SELECT 1 FROM rebate_agreement_scope s
                           WHERE s.agreement_id = ?A AND s.deleted_at IS NULL
                             AND s.category_id = (SELECT category_id FROM part WHERE id = l.part_id))"
        }
        "part" => {
            " AND EXISTS (SELECT 1 FROM rebate_agreement_scope s
                           WHERE s.agreement_id = ?A AND s.deleted_at IS NULL
                             AND s.part_id = l.part_id)"
        }
        _ => "", // 'supplier' — everything from that supplier counts
    }
}

/// What one receipt contributes to the measure, per part.
/// `volume_value` measures in company-currency minor units; `volume_qty` in units.
fn receipt_measure_by_part(
    conn: &Connection,
    receipt_id: i64,
    agreement_id: i64,
    scope: &str,
    measure: &str,
) -> Result<Vec<(i64, i64)>, String> {
    let value_expr = if measure == "volume_qty" {
        "l.qty_received"
    } else {
        // Line value in company currency, at the receipt's own rate.
        "CAST((l.unit_cost_minor * l.qty_received) * g.fx_rate_ppm / 1000000 AS INTEGER)"
    };
    let sql = format!(
        "SELECT l.part_id, {value_expr}
           FROM goods_receipt_line l
           JOIN goods_receipt g ON g.id = l.receipt_id
          WHERE l.receipt_id = ?1 AND l.deleted_at IS NULL{}
          ORDER BY l.id",
        scope_clause(scope).replace("?A", &agreement_id.to_string())
    );
    let mut s = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let v = s
        .query_map([receipt_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<(i64, i64)>>>()
        .map_err(|e| e.to_string())?;
    Ok(v)
}

/// Everything already measured in the period, excluding one receipt.
#[allow(clippy::too_many_arguments)]
fn period_measure_before(
    conn: &Connection,
    agreement_id: i64,
    supplier_id: i64,
    scope: &str,
    measure: &str,
    period_start: &str,
    period_end: &str,
    exclude_receipt: i64,
) -> Result<i64, String> {
    let value_expr = if measure == "volume_qty" {
        "l.qty_received"
    } else {
        "CAST((l.unit_cost_minor * l.qty_received) * g.fx_rate_ppm / 1000000 AS INTEGER)"
    };
    let sql = format!(
        "SELECT COALESCE(SUM({value_expr}), 0)
           FROM goods_receipt_line l
           JOIN goods_receipt g ON g.id = l.receipt_id
          WHERE g.supplier_id = ?1 AND g.status = 'posted' AND g.id <> ?2
            AND g.received_at >= ?3 AND g.received_at < ?4
            AND l.deleted_at IS NULL{}",
        scope_clause(scope).replace("?A", &agreement_id.to_string())
    );
    let v: i64 = conn
        .query_row(
            &sql,
            rusqlite::params![supplier_id, exclude_receipt, period_start, period_end],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(v)
}

/// Where an agreement stands: earned, unclaimed, and how far to the next tier.
#[derive(Debug, Serialize)]
pub struct RebateStanding {
    pub agreement_id: i64,
    pub code: String,
    pub is_provisional: bool,
    pub tier_mode: String,
    pub measured: i64,
    pub earned_minor: i64,
    pub claimable_minor: i64,
    pub claimed_minor: i64,
    pub settled_minor: i64,
    /// Earned but not yet settled — the part of reported profit that depends on
    /// claims being made and honoured.
    pub exposure_minor: i64,
    pub next: Option<NextTier>,
}

pub fn rebate_standing(conn: &Connection, agreement_id: i64) -> Result<RebateStanding, String> {
    let (code, supplier_id, measure, scope, mode_s, p_start, p_end, prov): (
        String, i64, String, String, String, String, String, i64,
    ) = conn
        .query_row(
            "SELECT code, supplier_id, measure, scope, tier_mode,
                    period_start, period_end, is_provisional
               FROM rebate_agreement WHERE id = ?1",
            [agreement_id],
            |r| {
                Ok((
                    r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?,
                    r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?,
                ))
            },
        )
        .map_err(|e| e.to_string())?;

    // Measured volume for the whole period: "before" with nothing excluded.
    let measured = period_measure_before(
        conn, agreement_id, supplier_id, &scope, &measure, &p_start, &p_end, -1,
    )?;
    let tiers = load_tiers(conn, agreement_id)?;
    let mode = TierMode::parse(&mode_s);

    let (earned, claimable, claimed, settled): (i64, i64, i64, i64) = conn
        .query_row(
            "SELECT COALESCE(SUM(amount_minor),0),
                    COALESCE(SUM(CASE WHEN state='claimable' THEN amount_minor END),0),
                    COALESCE(SUM(CASE WHEN state='claimed'   THEN amount_minor END),0),
                    COALESCE(SUM(CASE WHEN state='settled'   THEN amount_minor END),0)
               FROM rebate_accrual
              WHERE agreement_id = ?1 AND state <> 'reversed'",
            [agreement_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(|e| e.to_string())?;

    Ok(RebateStanding {
        agreement_id,
        code,
        is_provisional: prov == 1,
        tier_mode: mode_s,
        measured,
        earned_minor: earned,
        claimable_minor: claimable,
        claimed_minor: claimed,
        settled_minor: settled,
        exposure_minor: earned - settled,
        next: next_tier(mode, &tiers, measured),
    })
}

// ═══════════════════════════════════════════════════════════════════════════
//  Tests. Every calculation has a worked example with numbers in it.
//  Where possible the numbers are Ian's real ones: the FAW JH6 catalogue,
//  ZAR, one supplier, one warehouse.
// ═══════════════════════════════════════════════════════════════════════════
#[cfg(test)]
mod tests {
    use super::*;

    // ── conversion ────────────────────────────────────────────────────────
    #[test]
    fn identity_rate_is_exact() {
        // An identity rate must not round anything, or every ZAR-invoiced
        // receipt would drift by a cent per line for no reason.
        assert_eq!(convert_minor(119_263, 1_000_000), 119_263);
        assert_eq!(convert_minor(1, 1_000_000), 1);
    }

    #[test]
    fn conversion_rounds_half_away_from_zero() {
        // USD 100.00 at 18.4732 = ZAR 1847.32
        assert_eq!(convert_minor(10_000, 18_473_200), 184_732);
        // 1 cent at 18.4732 = 18.4732 cents -> 18
        assert_eq!(convert_minor(1, 18_473_200), 18);
        // exactly .5 rounds away from zero
        assert_eq!(convert_minor(1, 1_500_000), 2);
        assert_eq!(convert_minor(-1, 1_500_000), -2);
    }

    #[test]
    fn conversion_does_not_overflow() {
        // R10 000 000.00 at 18.4732 — would overflow i64 in the intermediate
        // product if this used i64 rather than i128.
        assert_eq!(convert_minor(1_000_000_000, 18_473_200), 18_473_200_000);
    }

    // ── allocation ────────────────────────────────────────────────────────
    #[test]
    fn allocation_sums_exactly_the_hard_case() {
        // R10 000.00 of freight across three equal parts is 3333.333... each.
        // The whole point: 333_334 + 333_333 + 333_333 = 1_000_000 exactly.
        let split = allocate(1_000_000, &[1, 1, 1]);
        assert_eq!(split, vec![333_334, 333_333, 333_333]);
        assert_eq!(split.iter().sum::<i64>(), 1_000_000);
    }

    #[test]
    fn allocation_is_proportional_to_value() {
        // Real costs: bumper L/H 1192.63, bracket 1021.68, spoiler 75.29.
        // R5000.00 of duty allocated by value.
        let weights = [119_263, 102_168, 7_529]; // sum 228 960
        let split = allocate(500_000, &weights);
        assert_eq!(split.iter().sum::<i64>(), 500_000);
        // Exact shares are 260445.056, 223113.208, 16441.737. Floors sum to
        // 499 999, so the single leftover cent goes to the largest fractional
        // part — the spoiler at .737, not the bumper at .056.
        assert_eq!(split, vec![260_445, 223_113, 16_442]);
        // 52.089% / 44.623% / 3.288% of the duty, matching the value shares.
        assert_eq!(split[0] * 10_000 / 500_000, 5208);
    }

    #[test]
    fn allocation_never_loses_a_cent_over_the_whole_catalogue() {
        // 161 parts, an awkward total. The invariant that matters: the parts
        // sum to the whole, every time, whatever the weights.
        for total in [1, 7, 99_999, 1_234_567, 561_485_00] {
            let weights: Vec<i64> = (1..=161).map(|i| i * 37 % 913 + 1).collect();
            let split = allocate(total, &weights);
            assert_eq!(
                split.iter().sum::<i64>(),
                total,
                "allocation lost cents at total {total}"
            );
            assert!(split.iter().all(|&x| x >= 0));
        }
    }

    #[test]
    fn allocation_with_no_weights_spreads_evenly() {
        // A consignment charge on a receipt where every weight is zero still
        // has to land somewhere; refusing would silently understate cost.
        let split = allocate(100, &[0, 0, 0]);
        assert_eq!(split, vec![34, 33, 33]);
        assert_eq!(split.iter().sum::<i64>(), 100);
    }

    #[test]
    fn direct_allocation_puts_everything_on_one_part() {
        let split = allocate(250_000, &[0, 1, 0]);
        assert_eq!(split, vec![0, 250_000, 0]);
    }

    // ── incremental tiers ─────────────────────────────────────────────────
    fn faw_tiers() -> Vec<Tier> {
        // The §7.5 default shape: 2% to R1m, 3% to R2m, 4% above.
        vec![
            Tier { threshold_from: 0,           threshold_to: Some(100_000_000), rate_bps: 200 },
            Tier { threshold_from: 100_000_000, threshold_to: Some(200_000_000), rate_bps: 300 },
            Tier { threshold_from: 200_000_000, threshold_to: None,              rate_bps: 400 },
        ]
    }

    #[test]
    fn incremental_below_first_threshold() {
        // R500 000 of purchases at 2% = R10 000.
        let r = rebate_at(TierMode::Incremental, &faw_tiers(), 50_000_000);
        assert_eq!(r, 1_000_000);
    }

    #[test]
    fn incremental_across_two_bands() {
        // R1.5m: 2% on the first R1m (R20 000) + 3% on the next R500k (R15 000)
        //      = R35 000.
        let r = rebate_at(TierMode::Incremental, &faw_tiers(), 150_000_000);
        assert_eq!(r, 3_500_000);
    }

    #[test]
    fn incremental_across_all_three() {
        // R2.5m: 20 000 + 30 000 + 4% of 500 000 (20 000) = R70 000.
        let r = rebate_at(TierMode::Incremental, &faw_tiers(), 250_000_000);
        assert_eq!(r, 7_000_000);
    }

    // ── retrospective tiers: the mode that is easy to miss ────────────────
    #[test]
    fn retrospective_applies_the_reached_rate_to_everything() {
        // R1.5m at the 3% band = 3% of the WHOLE 1.5m = R45 000,
        // against R35 000 under incremental. Same tiers, same volume,
        // R10 000 difference — which is why tier_mode is a stored field.
        let r = rebate_at(TierMode::Retrospective, &faw_tiers(), 150_000_000);
        assert_eq!(r, 4_500_000);
        assert_eq!(rebate_at(TierMode::Incremental, &faw_tiers(), 150_000_000), 3_500_000);
    }

    #[test]
    fn retrospective_threshold_crossing_is_worth_far_more_than_the_gap() {
        // Sitting at R999 999.00, R1.00 short of the R1m threshold.
        let measured = 99_999_900;
        let n = next_tier(TierMode::Retrospective, &faw_tiers(), measured).unwrap();
        assert_eq!(n.threshold, 100_000_000);
        assert_eq!(n.gap, 100); // R1.00 more of purchases

        // Naive thinking: "3% of R1 = 3 cents, not worth an order."
        // Reality: the rate on the entire period goes 2% -> 3%.
        //   before: 2% of 999 999.00 = 19 999.98
        //   after:  3% of 1 000 000.00 = 30 000.00
        //   uplift = 10 000.02
        assert_eq!(n.uplift_minor, 1_000_002);
        // Buying R1 more earns R10 000 more. THIS is the number that changes
        // buying behaviour, and only if it arrives before the period closes.
        assert!(n.uplift_minor > n.gap * 1_000);
    }

    #[test]
    fn incremental_threshold_crossing_is_worth_only_the_gap() {
        // The same position under an incremental scheme is worth almost
        // nothing — which is the correct answer, and the contrast is the point.
        let n = next_tier(TierMode::Incremental, &faw_tiers(), 99_999_900).unwrap();
        assert_eq!(n.gap, 100);
        assert_eq!(n.uplift_minor, 2); // 2% of R1.00
    }

    #[test]
    fn no_next_tier_at_the_top() {
        assert!(next_tier(TierMode::Incremental, &faw_tiers(), 500_000_000).is_none());
    }

    #[test]
    fn zero_and_negative_volume_earn_nothing() {
        assert_eq!(rebate_at(TierMode::Incremental, &faw_tiers(), 0), 0);
        assert_eq!(rebate_at(TierMode::Retrospective, &faw_tiers(), -5), 0);
        assert_eq!(rebate_at(TierMode::Incremental, &[], 999), 0);
    }

    #[test]
    fn delta_accrual_reconstructs_the_total_under_both_modes() {
        // The property the accrual engine depends on: accruing the DELTA on
        // each receipt must sum to the same answer as computing the whole
        // period at once. If this fails, a business's rebate is wrong by
        // whatever the receipts happened to be.
        for mode in [TierMode::Incremental, TierMode::Retrospective] {
            let receipts = [30_000_000i64, 45_000_000, 60_000_000, 90_000_000];
            let mut cumulative = 0i64;
            let mut summed = 0i64;
            for r in receipts {
                let before = cumulative;
                cumulative += r;
                summed += rebate_at(mode, &faw_tiers(), cumulative)
                    - rebate_at(mode, &faw_tiers(), before);
            }
            assert_eq!(
                summed,
                rebate_at(mode, &faw_tiers(), cumulative),
                "delta accrual diverged from the period total under {mode:?}"
            );
        }
    }

    #[test]
    fn apply_bps_rounds_correctly() {
        assert_eq!(apply_bps(100_000_000, 200), 2_000_000); // 2% of R1m
        assert_eq!(apply_bps(1, 5_000), 1); // 50% of 1c = 0.5c -> 1c
        assert_eq!(apply_bps(3, 3_333), 1); // 33.33% of 3c = 0.99c -> 1c
        assert_eq!(apply_bps(0, 10_000), 0);
    }

    // ═════════════════════════════════════════════════════════════════════
    //  End-to-end, against a real copy of Ian's database.
    //  Set CTP_TEST_DB to a COPY at schema v23. Skipped when unset.
    // ═════════════════════════════════════════════════════════════════════

    /// Each database test gets its OWN copy of the source database.
    ///
    /// Not fastidiousness: `period_measure_before` sums every posted receipt
    /// for a supplier in the period, so one test's posted receipt silently
    /// changes another test's measured volume and its expected rebate. Shared
    /// state would make these tests pass or fail depending on the order they
    /// happened to run in, which is worse than having no tests.
    fn open_db(tag: &str) -> Option<Connection> {
        let src = std::env::var("CTP_TEST_DB").ok()?;
        let dst = format!("{src}.{tag}.tmp");
        let _ = std::fs::remove_file(&dst);
        std::fs::copy(&src, &dst).ok()?;
        Connection::open(dst).ok()
    }

    /// Build one receipt of three real FAW JH6 parts at their real ZAR costs,
    /// add real-shaped freight, duty and clearing, and assert the landed cost
    /// to the cent.
    ///
    ///   CTP-BMP-001-L  Front Bumper L/H          10 @ 1192.63 = 11 926.30
    ///   CTP-BMP-003-L  Front Bumper L/H Bracket   5 @ 1021.68 =  5 108.40
    ///   CTP-BMP-007-L  Front Bumper L/H Spoiler  20 @   75.29 =  1 505.80
    ///                                        goods total      = 18 540.50
    ///   freight_sea  4 000.00   by_value
    ///   duty         2 000.00   by_value
    ///   clearing     1 500.00   by_units
    ///   vat_import   2 781.08   NOT landed (reclaimable) — must be excluded
    ///                            landed additions        =  7 500.00
    ///                            grand total             = 26 040.50
    fn build_receipt(conn: &mut Connection, tag: &str) -> i64 {
        let tx = conn.transaction().unwrap();
        tx.execute(
            "INSERT INTO goods_receipt (number, supplier_id, kind, location_id,
                                        received_at, invoice_currency, fx_rate_ppm, status)
             VALUES (?1, (SELECT id FROM supplier WHERE code='FAW'),
                     'purchase', (SELECT id FROM location WHERE code='WH'),
                     '2026-09-09 08:00:00', 'ZAR', 1000000, 'draft')",
            [format!("GR-TEST-{tag}")],
        )
        .unwrap();
        let rid = tx.last_insert_rowid();
        for (sku, qty, unit) in [
            ("CTP-BMP-001-L", 10i64, 119_263i64),
            ("CTP-BMP-003-L", 5, 102_168),
            ("CTP-BMP-007-L", 20, 7_529),
        ] {
            tx.execute(
                "INSERT INTO goods_receipt_line (receipt_id, part_id, qty_received, unit_cost_minor)
                 VALUES (?1, (SELECT id FROM part WHERE sku = ?2), ?3, ?4)",
                rusqlite::params![rid, sku, qty, unit],
            )
            .unwrap();
        }
        for (comp, amt, alloc, landed) in [
            ("freight_sea", 400_000i64, "by_value", 1i64),
            ("duty", 200_000, "by_value", 1),
            ("clearing", 150_000, "by_units", 1),
            ("vat_import", 278_108, "by_value", 0), // reclaimable
        ] {
            tx.execute(
                "INSERT INTO receipt_cost (receipt_id, component, amount_minor,
                                           allocation, is_landed)
                 VALUES (?1,?2,?3,?4,?5)",
                rusqlite::params![rid, comp, amt, alloc, landed],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        rid
    }

    #[test]
    fn landed_cost_is_exact_against_real_parts() {
        const TAG: &str = "landed";
        let Some(mut conn) = open_db(TAG) else {
            eprintln!("skipped: set CTP_TEST_DB");
            return;
        };
        let rid = build_receipt(&mut conn, TAG);
        let r = compute_landed(&conn, rid).unwrap();

        // Goods: 1_192_630 + 510_840 + 150_580 = 1_854_050
        assert_eq!(r.goods_total_minor, 1_854_050, "goods total");
        // Landed components only: 400_000 + 200_000 + 150_000 = 750_000
        assert_eq!(r.components_total_minor, 750_000, "landed components");
        // Reclaimable import VAT is reported, not buried, and not costed in.
        assert_eq!(r.excluded_minor, 278_108, "excluded import VAT");
        assert_eq!(r.grand_total_minor, 2_604_050, "grand total");

        // THE INVARIANT THAT MATTERS: the per-line totals reconstitute the
        // consignment exactly. Not approximately — exactly.
        let summed: i64 = r.lines.iter().map(|l| l.total_invoiced_minor).sum();
        assert_eq!(summed, r.grand_total_minor, "line totals must sum to the whole");

        // Line 1, the bumper. Value share 1_192_630 / 1_854_050 = 64.3255%.
        //   freight  400_000 by value  -> 257_303
        //   duty     200_000 by value  -> 128_651
        //   clearing by UNITS: 10 of 35 -> 42_857
        //   line total = 1_192_630 + 257_303 + 128_651 + 42_857 = 1_621_441
        //   per unit over 10 = 162_144  (R1 621.44 against an invoice R1 192.63)
        //
        // The 257_303 is worth a note. The naive share is 257_302.06, so the
        // floor is 257_302 — but all three lines are rounded down and there are
        // three leftover cents to hand back, so every line gets one. Doing this
        // arithmetic by hand gets it wrong, which is the argument for the test.
        let b = &r.lines[0];
        assert_eq!(b.sku, "CTP-BMP-001-L");
        assert_eq!(b.unit_invoice_minor, 119_263);
        assert_eq!(b.unit_freight_minor, 25_730);
        assert_eq!(b.unit_duty_minor, 12_865);
        assert_eq!(b.unit_clearing_minor, 4_286);
        assert_eq!(b.total_invoiced_minor, 1_621_441);
        assert_eq!(b.unit_cost_invoiced_minor, 162_144);

        // A by_units charge must come out identical per unit on every line —
        // that is what "per unit" means, and it is a cheap check that the
        // allocation basis was actually honoured.
        assert!(r.lines.iter().all(|l| l.unit_clearing_minor == 4_286));

        // The commercial punchline, and the reason this module exists: the
        // landed cost is 35.95% above the supplier's price list. Every margin
        // the system reported before today was overstated by roughly this, and
        // the 15% tier floor was being enforced against the smaller number.
        let uplift_bps = (b.unit_cost_invoiced_minor - 119_263) * 10_000 / 119_263;
        assert_eq!(uplift_bps, 3595);

        // Weight allocation is unavailable — 0 of 161 parts carry a weight — so
        // nothing here should claim to have used it.
        assert!(r.weight_fallbacks.is_empty(), "no by_weight component was used");
    }

    #[test]
    fn by_weight_falls_back_and_says_so() {
        const TAG: &str = "weightfb";
        let Some(mut conn) = open_db(TAG) else {
            eprintln!("skipped: set CTP_TEST_DB");
            return;
        };
        let rid = build_receipt(&mut conn, TAG);
        conn.execute(
            "UPDATE receipt_cost SET allocation='by_weight'
              WHERE receipt_id=?1 AND component='freight_sea'",
            [rid],
        )
        .unwrap();
        let r = compute_landed(&conn, rid).unwrap();
        // Silently treating a missing weight as zero would give heavy parts no
        // freight at all. Falling back is right; falling back QUIETLY is not.
        assert_eq!(r.weight_fallbacks, vec!["freight_sea".to_string()]);
        assert_eq!(r.grand_total_minor, 2_604_050);
    }

    #[test]
    fn posting_moves_stock_once_and_writes_both_cost_figures() {
        const TAG: &str = "posting";
        let Some(mut conn) = open_db(TAG) else {
            eprintln!("skipped: set CTP_TEST_DB");
            return;
        };
        let rid = build_receipt(&mut conn, TAG);
        let before: i64 = conn
            .query_row("SELECT COALESCE(SUM(delta),0) FROM stock_movement", [], |r| r.get(0))
            .unwrap();

        let tx = conn.transaction().unwrap();
        let res = post_receipt(&tx, rid).unwrap();
        tx.commit().unwrap();
        assert_eq!(res.movements, 3);
        assert_eq!(res.units, 35);
        assert_eq!(res.landed_rows, 3);

        let after: i64 = conn
            .query_row("SELECT COALESCE(SUM(delta),0) FROM stock_movement", [], |r| r.get(0))
            .unwrap();
        assert_eq!(after - before, 35, "35 units arrived");

        // Posting twice must not move stock twice — same contract as the
        // counter's idempotency, and the reason client_uuid is derived from the
        // receipt LINE rather than generated fresh.
        let tx = conn.transaction().unwrap();
        let again = post_receipt(&tx, rid);
        tx.commit().unwrap();
        assert!(again.is_err(), "a posted receipt cannot be posted again");
        let after2: i64 = conn
            .query_row("SELECT COALESCE(SUM(delta),0) FROM stock_movement", [], |r| r.get(0))
            .unwrap();
        assert_eq!(after2, after, "stock did not move a second time");

        // Both cost figures written, and with no settled rebate they agree.
        let (inv, exp, basis): (i64, i64, String) = conn
            .query_row(
                "SELECT unit_cost_invoiced_minor, unit_cost_expected_minor, rebate_basis
                   FROM part_landed_cost
                  WHERE receipt_id = ?1
                    AND part_id = (SELECT id FROM part WHERE sku='CTP-BMP-001-L')",
                [rid],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(inv, 162_144);
        assert_eq!(exp, 162_144);
        assert_eq!(basis, "settled");

        // And the current-cost view now prefers the landed figure over the
        // price list, for this part only.
        let (c_inv, c_basis): (i64, String) = conn
            .query_row(
                "SELECT cost_invoiced_minor, basis FROM part_current_cost
                  WHERE part_id = (SELECT id FROM part WHERE sku='CTP-BMP-001-L')",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(c_inv, 162_144);
        assert_eq!(c_basis, "landed");
    }

    #[test]
    fn accrued_rebate_never_reaches_the_price_floor() {
        const TAG: &str = "floor";
        let Some(mut conn) = open_db(TAG) else {
            eprintln!("skipped: set CTP_TEST_DB");
            return;
        };
        // A retrospective agreement whose first tier is met by this receipt.
        conn.execute(
            "INSERT INTO rebate_agreement
               (code, supplier_id, basis, measure, scope, period_start, period_end,
                tier_mode, settlement, status, is_provisional)
             VALUES ('TEST-RETRO', (SELECT id FROM supplier WHERE code='FAW'),
                     'purchases','volume_value','supplier',
                     '2026-01-01','2027-01-01','retrospective','credit_note',
                     'active', 1)",
            [],
        )
        .unwrap();
        let aid = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO rebate_tier (agreement_id, threshold_from, threshold_to, rate_bps)
             VALUES (?1, 0, 1000000, 200), (?1, 1000000, NULL, 500)",
            [aid],
        )
        .unwrap();

        let rid = build_receipt(&mut conn, TAG);
        let tx = conn.transaction().unwrap();
        let res = post_receipt(&tx, rid).unwrap();
        tx.commit().unwrap();
        assert!(res.accruals > 0, "the receipt earned a rebate");

        // Goods measured 1 854 050, which is over the 1 000 000 threshold, so
        // the retrospective rate is 5% of the WHOLE amount = 92 702 (rounded).
        let earned: i64 = conn
            .query_row(
                "SELECT COALESCE(SUM(amount_minor),0) FROM rebate_accrual WHERE agreement_id=?1",
                [aid],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(earned, 92_703, "5% of 1 854 050, allocated exactly");

        // ⚠ THE GUARANTEE. The rebate is 'accrued' — earned, not received. The
        //   invoiced cost, which is what snapshot_price() floors against, must
        //   be untouched by it.
        let (inv, exp, reb): (i64, i64, i64) = conn
            .query_row(
                "SELECT unit_cost_invoiced_minor, unit_cost_expected_minor, unit_rebate_minor
                   FROM part_landed_cost WHERE receipt_id=?1
                    AND part_id=(SELECT id FROM part WHERE sku='CTP-BMP-001-L')",
                [rid],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(inv, 162_144, "invoiced cost is unmoved by an unearned rebate");
        assert_eq!(reb, 0, "no SETTLED rebate, so none is deducted");
        assert_eq!(exp, 162_144);

        // Now settle it and recompute on the reporting basis. THIS is where the
        // rebate is allowed to show — and only here.
        conn.execute(
            "UPDATE rebate_accrual SET state='settled' WHERE agreement_id=?1",
            [aid],
        )
        .unwrap();
        let tx = conn.transaction().unwrap();
        write_landed(&tx, rid, RebateBasis::Settled).unwrap();
        tx.commit().unwrap();

        let (inv2, exp2, reb2): (i64, i64, i64) = conn
            .query_row(
                "SELECT unit_cost_invoiced_minor, unit_cost_expected_minor, unit_rebate_minor
                   FROM part_landed_cost WHERE receipt_id=?1
                    AND part_id=(SELECT id FROM part WHERE sku='CTP-BMP-001-L')",
                [rid],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(inv2, 162_144, "invoiced NEVER moves, settled or not");
        assert!(reb2 > 0, "a settled rebate does reduce the expected figure");
        assert_eq!(exp2, inv2 - reb2);
        // The bumper earned 5% of its own 1 192 630 = 59 632, over 10 units
        // = 5 963 per unit.
        assert_eq!(reb2, 5_963);
        assert_eq!(exp2, 156_181);
    }

    #[test]
    fn standing_reports_the_gap_that_changes_buying_behaviour() {
        const TAG: &str = "standing";
        let Some(mut conn) = open_db(TAG) else {
            eprintln!("skipped: set CTP_TEST_DB");
            return;
        };
        conn.execute(
            "INSERT INTO rebate_agreement
               (code, supplier_id, basis, measure, scope, period_start, period_end,
                tier_mode, settlement, status, is_provisional)
             VALUES ('TEST-STAND', (SELECT id FROM supplier WHERE code='FAW'),
                     'purchases','volume_value','supplier',
                     '2026-01-01','2027-01-01','retrospective','credit_note',
                     'active', 1)",
            [],
        )
        .unwrap();
        let aid = conn.last_insert_rowid();
        // Next tier at R100 000.00, well above this one receipt.
        conn.execute(
            "INSERT INTO rebate_tier (agreement_id, threshold_from, threshold_to, rate_bps)
             VALUES (?1, 0, 10000000, 200), (?1, 10000000, NULL, 400)",
            [aid],
        )
        .unwrap();
        let rid = build_receipt(&mut conn, TAG);
        let tx = conn.transaction().unwrap();
        post_receipt(&tx, rid).unwrap();
        tx.commit().unwrap();

        let s = rebate_standing(&conn, aid).unwrap();
        assert_eq!(s.measured, 1_854_050);
        assert!(s.is_provisional, "terms are an assumption until the boss confirms");
        let n = s.next.expect("there is a tier above");
        assert_eq!(n.threshold, 10_000_000);
        assert_eq!(n.gap, 8_145_950); // R81 459.50 more of purchases
        // Retrospective: reaching it takes the rate from 2% to 4% on
        // everything. 4% of 10 000 000 = 400 000 against 2% of 1 854 050
        // = 37 081. Uplift 362 919 — R3 629.19 for R81 459.50 of buying.
        assert_eq!(n.uplift_minor, 362_919);
        // Exposure: everything earned that is not yet settled.
        assert_eq!(s.exposure_minor, s.earned_minor);
    }

    // ── the price-floor guarantee ─────────────────────────────────────────
    #[test]
    fn rebate_basis_settled_excludes_unearned_money() {
        // The guarantee in one assertion: the default basis counts ONLY money
        // that has arrived. If this list ever grows to include 'accrued', the
        // price floor starts moving on money that may never come.
        assert_eq!(RebateBasis::Settled.states(), &["settled"]);
        assert_eq!(RebateBasis::None.states().len(), 0);
        // Accrued is available for REPORTING, and says so by including
        // everything short of reversed.
        assert_eq!(
            RebateBasis::Accrued.states(),
            &["accrued", "claimable", "claimed", "settled"]
        );
    }
}
