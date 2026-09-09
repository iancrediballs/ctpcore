-- ============================================================================
--  CTP Core — PURCHASING, GOODS RECEIPT, LANDED COST AND REBATES (0024)
--
--  Cloud counterpart: server/0039_purchasing.sql. Same tables, same rules.
--
--  WHAT THIS IS FOR, in one line: the system can currently only watch stock
--  LEAVE. This is the half that records it ARRIVING, and therefore the half
--  that can say what it truly cost.
--
--  THE EQUATION EVERYTHING HERE SERVES
--
--      true cost = invoice + freight + duty + clearing − rebate earned
--
--  Landed costing and rebates are not two features that happen to touch. They
--  are the two halves of one number, and they are built together because
--  building either alone produces a figure that is confidently wrong.
--
--  ────────────────────────────────────────────────────────────────────────
--  THE ONE RULE THAT MUST NOT BE BROKEN
--
--  TWO COST FIGURES, NEVER ONE. They are separate columns from the first
--  commit because merging them is easy and unpicking them is not.
--
--    unit_cost_invoiced_minor  Money actually spent: invoice + freight + duty
--                              + clearing. CERTAIN. This is the ONLY figure a
--                              price floor, a stock valuation or an accounting
--                              export may read.
--
--    unit_cost_expected_minor  invoiced − rebate attributable. Contingent.
--                              For REPORTING and BUYING decisions only.
--
--  Why it matters, concretely: snapshot_price() computes the lowest quotable
--  price as cost / (1 - min_margin). If a rebate that has not been earned
--  reduces that cost, the app starts permitting discounts funded by money that
--  may never arrive — and an importer can discount its way to missing the very
--  threshold that was funding the discount. THE FLOOR NEVER MOVES ON MONEY
--  THAT HAS NOT ARRIVED. Only a SETTLED rebate may reduce the invoiced figure,
--  and then only forward, via a new row.
--  ────────────────────────────────────────────────────────────────────────
--
--  WHY part_landed_cost IS A NEW TABLE RATHER THAN COLUMNS ON part_cost
--
--  part_cost is keyed (part_id, currency, valid_from) and holds 159 rows
--  transcribed from a supplier PRICE LIST. Two receipts of the same part on
--  the same timestamp would collide on that key, and widening the key means
--  rebuilding a table that snapshot_price() reads on every quote. The additive
--  answer keys on (part_id, receipt_id) — which is what a landed cost actually
--  is, one per part per arrival — leaves the existing rows untouched with
--  their honest 'Item Cost Price List' source, and lets the price-list figures
--  stay as the fallback until a real receipt supersedes them.
--
--  WHAT THIS DOES NOT DO: it writes no stock. Receiving posts to the existing
--  stock_movement ledger and nowhere else — reason='receipt', ref_type=
--  'goods_receipt', ref_id=<receipt id>. There is no second stock concept, no
--  "pending stock", no quantity column anywhere in this file. The ledger stays
--  the single source of truth for how much of anything there is.
--
--  MONEY is integer minor units (cents) throughout, as everywhere else here.
--  FX RATES are integer parts-per-million (fx_rate_ppm): 18.4732 ZAR/USD is
--  18_473_200. Integers because a float rate multiplied across 161 lines
--  produces a total that does not reconcile with the invoice, and "the cents
--  do not add up" is the one bug an importer will never forgive.
-- ============================================================================
PRAGMA foreign_keys = ON;

BEGIN;

-- ══════════════════════════════════════════════════════════════════════════
--  1. SUPPLIER
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS supplier (
  id            INTEGER PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,          -- natural key; sync matches on this
  name          TEXT NOT NULL,
  contact       TEXT, phone TEXT, email TEXT, address TEXT,
  currency      TEXT NOT NULL DEFAULT 'ZAR',   -- what THEY invoice in
  -- Incoterm is not decoration. Under EXW the buyer pays everything and every
  -- freight charge is a landed-cost component; under CIF the supplier's
  -- invoice already contains freight and adding it again double-counts. Storing
  -- the term lets the system tell which mistake it is preventing.
  incoterm      TEXT CHECK (incoterm IS NULL OR incoterm IN
                  ('EXW','FCA','FOB','CFR','CIF','CPT','CIP','DAP','DPU','DDP')),
  payment_terms TEXT,
  lead_time_days INTEGER CHECK (lead_time_days IS NULL OR lead_time_days >= 0),
  notes         TEXT,
  client_uuid   TEXT,
  rev INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, origin TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS supplier_uuid_idx
  ON supplier(client_uuid) WHERE client_uuid IS NOT NULL;

-- ══════════════════════════════════════════════════════════════════════════
--  2. PURCHASE ORDER
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS purchase_order (
  id            INTEGER PRIMARY KEY,
  number        TEXT NOT NULL UNIQUE,          -- device-prefixed, like sales_order
  supplier_id   INTEGER NOT NULL REFERENCES supplier(id),
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
                  ('draft','sent','acknowledged','part_received','received',
                   'closed','cancelled')),
  currency      TEXT NOT NULL DEFAULT 'ZAR',   -- the SUPPLIER's currency
  -- The rate ASSUMED when ordering. The receipt carries the rate that actually
  -- applied (fx_rate_ppm there). The difference between them is a real cost
  -- movement the business should be able to see, not an error to hide.
  fx_rate_ppm_expected INTEGER CHECK (fx_rate_ppm_expected IS NULL
                                      OR fx_rate_ppm_expected > 0),
  ordered_at    TEXT, expected_at TEXT,
  notes         TEXT,
  client_uuid   TEXT,
  actor_id TEXT, actor_label TEXT, actor_source TEXT,
  rev INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, origin TEXT
);
CREATE INDEX IF NOT EXISTS po_supplier_idx ON purchase_order(supplier_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS po_uuid_idx
  ON purchase_order(client_uuid) WHERE client_uuid IS NOT NULL;

CREATE TABLE IF NOT EXISTS purchase_order_line (
  id            INTEGER PRIMARY KEY,
  order_id      INTEGER NOT NULL REFERENCES purchase_order(id) ON DELETE CASCADE,
  part_id       INTEGER NOT NULL REFERENCES part(id),
  qty_ordered   INTEGER NOT NULL CHECK (qty_ordered > 0),
  unit_cost_minor INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost_minor >= 0), -- PO currency
  expected_at   TEXT,                          -- lines can arrive separately
  rev INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, origin TEXT,
  -- One line per part per order. A second lot of the same part is a quantity
  -- change, not a second line — otherwise "how many are on order" needs a
  -- GROUP BY that somebody will eventually forget to write.
  UNIQUE (order_id, part_id)
);
CREATE INDEX IF NOT EXISTS pol_order_idx ON purchase_order_line(order_id);

-- NOTE, deliberately absent: there is no qty_received column on the PO line.
-- Received quantity is SUM(goods_receipt_line.qty_received) over posted,
-- unreversed receipts. A stored counter is a second source of truth and it
-- drifts the first time a receipt is reversed.

-- ══════════════════════════════════════════════════════════════════════════
--  3. GOODS RECEIPT
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS goods_receipt (
  id            INTEGER PRIMARY KEY,
  number        TEXT NOT NULL UNIQUE,
  supplier_id   INTEGER REFERENCES supplier(id),   -- NULL for an opening balance
  order_id      INTEGER REFERENCES purchase_order(id),  -- NULL: no PO existed
  kind          TEXT NOT NULL DEFAULT 'purchase' CHECK (kind IN
                  ('purchase','opening','warranty_replacement','return_in')),
  location_id   INTEGER NOT NULL REFERENCES location(id),
  received_at   TEXT NOT NULL DEFAULT (datetime('now')),
  supplier_invoice_ref   TEXT,
  supplier_invoice_total_minor INTEGER CHECK (supplier_invoice_total_minor IS NULL
                                              OR supplier_invoice_total_minor >= 0),
  invoice_currency TEXT NOT NULL DEFAULT 'ZAR',
  fx_rate_ppm   INTEGER NOT NULL DEFAULT 1000000 CHECK (fx_rate_ppm > 0),
  -- 1 when the costs on this receipt are a stated estimate rather than a
  -- measurement — the opening balance, or a receipt costed before the clearing
  -- agent has invoiced. It exists so those numbers can never be quoted as fact.
  cost_is_estimated INTEGER NOT NULL DEFAULT 0 CHECK (cost_is_estimated IN (0,1)),
  -- draft accumulates lines and writes NO stock. Receiving a container is not
  -- an atomic act: it takes hours, it gets interrupted, and the person counting
  -- is not the person holding the invoice. POSTING is the single moment stock
  -- moves. Without a draft state a half-counted container is already in stock
  -- and the shortfall looks like theft.
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
                  ('draft','posted','reversed')),
  posted_at     TEXT, reversed_at TEXT,
  notes         TEXT,
  client_uuid   TEXT,
  actor_id TEXT, actor_label TEXT, actor_source TEXT,
  rev INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, origin TEXT
);
CREATE INDEX IF NOT EXISTS gr_order_idx ON goods_receipt(order_id);
CREATE INDEX IF NOT EXISTS gr_supplier_idx ON goods_receipt(supplier_id, received_at);
CREATE UNIQUE INDEX IF NOT EXISTS gr_uuid_idx
  ON goods_receipt(client_uuid) WHERE client_uuid IS NOT NULL;

CREATE TABLE IF NOT EXISTS goods_receipt_line (
  id            INTEGER PRIMARY KEY,
  receipt_id    INTEGER NOT NULL REFERENCES goods_receipt(id) ON DELETE CASCADE,
  part_id       INTEGER NOT NULL REFERENCES part(id),
  -- NULLABLE on purpose. Suppliers send things you did not order. Forcing every
  -- receipt line to match a PO line means the receiver either lies or stops,
  -- and both are worse than recording what actually arrived and flagging it.
  order_line_id INTEGER REFERENCES purchase_order_line(id),
  qty_received  INTEGER NOT NULL CHECK (qty_received > 0),
  unit_cost_minor INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost_minor >= 0), -- invoice ccy
  rev INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, origin TEXT,
  UNIQUE (receipt_id, part_id)
);
CREATE INDEX IF NOT EXISTS grl_receipt_idx ON goods_receipt_line(receipt_id);
CREATE INDEX IF NOT EXISTS grl_part_idx ON goods_receipt_line(part_id);

-- ══════════════════════════════════════════════════════════════════════════
--  4. LANDED COST COMPONENTS
-- ══════════════════════════════════════════════════════════════════════════
-- Costs arrive AFTER the goods do — the clearing agent invoices in arrears — so
-- a receipt must accept components after it is posted and after the stock is
-- already selling. Landed cost is therefore recomputed as components arrive,
-- not calculated once.
CREATE TABLE IF NOT EXISTS receipt_cost (
  id            INTEGER PRIMARY KEY,
  receipt_id    INTEGER NOT NULL REFERENCES goods_receipt(id) ON DELETE CASCADE,
  component     TEXT NOT NULL CHECK (component IN
                  ('freight_sea','freight_air','freight_road','duty','vat_import',
                   'clearing','insurance','handling','finance','other')),
  amount_minor  INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency      TEXT NOT NULL DEFAULT 'ZAR',
  fx_rate_ppm   INTEGER NOT NULL DEFAULT 1000000 CHECK (fx_rate_ppm > 0),
  -- Each component allocates on its own basis because they behave differently:
  -- freight is properly weight, duty is a percentage of customs value, clearing
  -- is per-consignment. 'direct' is for a charge attributable to one line.
  allocation    TEXT NOT NULL DEFAULT 'by_value' CHECK (allocation IN
                  ('by_value','by_weight','by_units','direct')),
  direct_part_id INTEGER REFERENCES part(id),   -- required when allocation='direct'
  -- ⚠ IMPORT VAT IS USUALLY RECLAIMABLE AND THEREFORE NOT A LANDED COST.
  --   It is in the component list because it appears on the clearing agent's
  --   invoice and somebody will type it in. This flag decides whether it lands
  --   on the part. Default 1 (include); set 0 for anything reclaimed.
  is_landed     INTEGER NOT NULL DEFAULT 1 CHECK (is_landed IN (0,1)),
  supplier_ref  TEXT,                            -- clearing agent's invoice no.
  notes         TEXT,
  rev INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, origin TEXT,
  CHECK (allocation <> 'direct' OR direct_part_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS rc_receipt_idx ON receipt_cost(receipt_id);

-- ══════════════════════════════════════════════════════════════════════════
--  5. THE LANDED COST ITSELF — two figures, never one
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS part_landed_cost (
  id            INTEGER PRIMARY KEY,
  part_id       INTEGER NOT NULL REFERENCES part(id) ON DELETE CASCADE,
  receipt_id    INTEGER REFERENCES goods_receipt(id) ON DELETE CASCADE,
  currency      TEXT NOT NULL DEFAULT 'ZAR',    -- always the COMPANY's currency
  qty           INTEGER NOT NULL CHECK (qty > 0),

  -- the build-up, per unit, all converted to company currency
  unit_invoice_minor  INTEGER NOT NULL DEFAULT 0 CHECK (unit_invoice_minor  >= 0),
  unit_freight_minor  INTEGER NOT NULL DEFAULT 0 CHECK (unit_freight_minor  >= 0),
  unit_duty_minor     INTEGER NOT NULL DEFAULT 0 CHECK (unit_duty_minor     >= 0),
  unit_clearing_minor INTEGER NOT NULL DEFAULT 0 CHECK (unit_clearing_minor >= 0),
  unit_other_minor    INTEGER NOT NULL DEFAULT 0 CHECK (unit_other_minor    >= 0),

  -- ── THE CERTAIN FIGURE. Money actually spent. The ONLY one a price floor,
  --    a stock valuation or an accounting export may read.
  unit_cost_invoiced_minor INTEGER NOT NULL CHECK (unit_cost_invoiced_minor >= 0),

  -- ── THE CONTINGENT FIGURE. Reporting and buying decisions only.
  unit_rebate_minor        INTEGER NOT NULL DEFAULT 0 CHECK (unit_rebate_minor >= 0),
  unit_cost_expected_minor INTEGER NOT NULL CHECK (unit_cost_expected_minor >= 0),
  -- Which rebate states were allowed to contribute to unit_rebate_minor.
  -- 'settled' is the default and the safe one; 'accrued' includes money that
  -- is earned but not yet in hand and must never reach a price floor.
  rebate_basis  TEXT NOT NULL DEFAULT 'settled'
                CHECK (rebate_basis IN ('settled','claimed','accrued','none')),

  is_estimated  INTEGER NOT NULL DEFAULT 0 CHECK (is_estimated IN (0,1)),
  valid_from    TEXT NOT NULL DEFAULT (datetime('now')),
  source        TEXT,
  rev INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, origin TEXT,
  -- expected can never exceed invoiced: a rebate reduces cost, never adds to it
  CHECK (unit_cost_expected_minor <= unit_cost_invoiced_minor)
);
-- One landed cost per part per receipt. Recomputing a receipt's costs updates
-- these rows in place rather than adding more, which is what makes late-arriving
-- clearing invoices safe to enter.
CREATE UNIQUE INDEX IF NOT EXISTS plc_part_receipt_idx
  ON part_landed_cost(part_id, receipt_id) WHERE receipt_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS plc_part_idx
  ON part_landed_cost(part_id, valid_from DESC);

-- part_cost keeps its 159 price-list rows untouched and becomes the FALLBACK.
-- These columns exist so a reader can tell what a row is without guessing at
-- the free-text source, and so cloud/desktop shapes match (the cloud gained
-- rev/updated_at in 0034; the desktop never had them).
ALTER TABLE part_cost ADD COLUMN basis TEXT;      -- 'price_list' | 'landed' | 'manual'
ALTER TABLE part_cost ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;
ALTER TABLE part_cost ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
ALTER TABLE part_cost ADD COLUMN deleted_at TEXT;
UPDATE part_cost SET basis = 'price_list',
                     updated_at = COALESCE(NULLIF(updated_at,''), valid_from)
 WHERE basis IS NULL;

-- ══════════════════════════════════════════════════════════════════════════
--  6. DISCREPANCIES — a short is a CLAIM, not a stock adjustment
-- ══════════════════════════════════════════════════════════════════════════
-- The instinct is to treat a short delivery as an adjustment: expected 100, got
-- 97, write down 3. That is wrong in the direction that loses money. An
-- adjustment says "we were mistaken about what we had". A short says "we paid
-- for 100, received 97, and the supplier owes us 3". One is a correction. The
-- other is an asset.
CREATE TABLE IF NOT EXISTS receipt_discrepancy (
  id            INTEGER PRIMARY KEY,
  receipt_id    INTEGER NOT NULL REFERENCES goods_receipt(id) ON DELETE CASCADE,
  receipt_line_id INTEGER REFERENCES goods_receipt_line(id),
  part_id       INTEGER NOT NULL REFERENCES part(id),
  kind          TEXT NOT NULL CHECK (kind IN
                  ('short','over','damaged','wrong_part','quality')),
  qty           INTEGER NOT NULL CHECK (qty > 0),
  -- 'damaged' describes the goods, not the decision. Four physically different
  -- outcomes, and the disposition is what says whether stock increased:
  --   reject            no stock, claim raised   (a short is always this)
  --   accept_and_claim  stock increases, claim raised
  --   scrap_and_claim   stock increases then written off, claim raised
  --   accept_no_claim   stock increases, no claim — trivial, not worth paper
  disposition   TEXT NOT NULL DEFAULT 'reject' CHECK (disposition IN
                  ('reject','accept_and_claim','scrap_and_claim','accept_no_claim')),
  claim_value_minor INTEGER NOT NULL DEFAULT 0 CHECK (claim_value_minor >= 0),
  currency      TEXT NOT NULL DEFAULT 'ZAR',
  claim_id      INTEGER REFERENCES supplier_claim(id),
  photo_ref     TEXT,        -- evidence at the crate beats a claim three weeks later
  notes         TEXT,
  actor_id TEXT, actor_label TEXT, actor_source TEXT,
  rev INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, origin TEXT
);
CREATE INDEX IF NOT EXISTS rd_receipt_idx ON receipt_discrepancy(receipt_id);

-- ══════════════════════════════════════════════════════════════════════════
--  7. SUPPLIER RECOVERY — one ledger for everything the supplier owes back
-- ══════════════════════════════════════════════════════════════════════════
-- Shorts, damages, warranty, core exchange and rebates are normally built as
-- four unrelated modules. They are one thing: money owed back. They differ only
-- in how they are MEASURED — a rebate from a rule over a period, a short from a
-- single event at a receipt. They are identical in how they SETTLE: a credit
-- note, a deduction, or cash. Separate origination, one shared ledger.
CREATE TABLE IF NOT EXISTS supplier_claim (
  id            INTEGER PRIMARY KEY,
  number        TEXT NOT NULL UNIQUE,
  supplier_id   INTEGER NOT NULL REFERENCES supplier(id),
  kind          TEXT NOT NULL CHECK (kind IN
                  ('short','damage','warranty','core_return','price_variance','rebate')),
  origin_type   TEXT CHECK (origin_type IS NULL OR origin_type IN
                  ('receipt_discrepancy','rebate_accrual','manual')),
  origin_id     INTEGER,
  value_minor   INTEGER NOT NULL CHECK (value_minor >= 0),
  currency      TEXT NOT NULL DEFAULT 'ZAR',
  -- The gap between 'open' and 'submitted' is where recovery money actually
  -- dies. Not in the calculation — in the follow-up.
  state         TEXT NOT NULL DEFAULT 'open' CHECK (state IN
                  ('open','submitted','acknowledged','disputed','settled','written_off')),
  submitted_at  TEXT, settled_at TEXT,
  settlement_type TEXT CHECK (settlement_type IS NULL OR settlement_type IN
                  ('credit_note','deduction','cash')),
  settlement_ref  TEXT,
  settled_value_minor INTEGER CHECK (settled_value_minor IS NULL
                                     OR settled_value_minor >= 0),
  notes         TEXT,
  client_uuid   TEXT,
  actor_id TEXT, actor_label TEXT, actor_source TEXT,
  rev INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, origin TEXT
);
CREATE INDEX IF NOT EXISTS sc_supplier_idx ON supplier_claim(supplier_id, state);
CREATE UNIQUE INDEX IF NOT EXISTS sc_uuid_idx
  ON supplier_claim(client_uuid) WHERE client_uuid IS NOT NULL;

-- ══════════════════════════════════════════════════════════════════════════
--  8. REBATE AGREEMENTS — the rule is DATA, not code
-- ══════════════════════════════════════════════════════════════════════════
-- Rebate agreements are renegotiated annually. A system that needs a developer
-- for each new agreement is wrong even if the current terms were known
-- perfectly — and here they are not known at all yet. So every part of the rule
-- is a field, and the boss's answer becomes data entry rather than a release.
CREATE TABLE IF NOT EXISTS rebate_agreement (
  id            INTEGER PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  supplier_id   INTEGER NOT NULL REFERENCES supplier(id),
  name          TEXT,
  -- BASIS changes behaviour most. 'purchases' is knowable the moment a
  -- container is booked in. 'sales' cannot be — at receipt nothing is sold — so
  -- it accrues as stock moves and reconciles when the period closes.
  basis         TEXT NOT NULL DEFAULT 'purchases'
                CHECK (basis IN ('purchases','sales')),
  measure       TEXT NOT NULL DEFAULT 'volume_value'
                CHECK (measure IN ('volume_value','volume_qty','growth','flat_percent')),
  scope         TEXT NOT NULL DEFAULT 'supplier'
                CHECK (scope IN ('supplier','product_group','part')),
  period_start  TEXT NOT NULL,
  period_end    TEXT NOT NULL,
  -- ⚠ THE FIELD THAT IS EASY TO MISS AND EXPENSIVE TO MISS.
  --   incremental   — 2% on the first R1m, 3% on the next. Crossing a
  --                   threshold affects only what comes after it.
  --   retrospective — cross R2m and 3% applies to the WHOLE period from the
  --                   first rand. Crossing revalues everything already accrued.
  --   Under a retrospective scheme, being R50 000 short of a threshold does not
  --   cost 3% of R50 000 — it costs 1% of R2m. That is the difference between a
  --   rounding error and a reason to place another order this month.
  tier_mode     TEXT NOT NULL DEFAULT 'incremental'
                CHECK (tier_mode IN ('incremental','retrospective')),
  baseline_period_start TEXT, baseline_period_end TEXT,   -- growth schemes only
  settlement    TEXT NOT NULL DEFAULT 'credit_note'
                CHECK (settlement IN ('credit_note','deduction','cash')),
  currency      TEXT NOT NULL DEFAULT 'ZAR',
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','active','closed','superseded')),
  -- An agreement that changes is SUPERSEDED, never edited. Last year's claim
  -- must still reproduce last year's number when an auditor asks, and an edited
  -- agreement makes that impossible. It is also what makes a mid-year
  -- renegotiation representable: two agreements, two periods, no ambiguity.
  superseded_by_id INTEGER REFERENCES rebate_agreement(id),
  -- 1 when the terms are a working assumption rather than the supplier's
  -- actual agreement. Every screen showing a figure derived from a provisional
  -- agreement must say so.
  is_provisional INTEGER NOT NULL DEFAULT 1 CHECK (is_provisional IN (0,1)),
  notes         TEXT,
  client_uuid   TEXT,
  rev INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, origin TEXT,
  CHECK (period_end > period_start),
  CHECK (measure <> 'growth' OR (baseline_period_start IS NOT NULL
                                 AND baseline_period_end IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ra_supplier_idx
  ON rebate_agreement(supplier_id, status, period_start);

-- Rows only when scope <> 'supplier'.
CREATE TABLE IF NOT EXISTS rebate_agreement_scope (
  id            INTEGER PRIMARY KEY,
  agreement_id  INTEGER NOT NULL REFERENCES rebate_agreement(id) ON DELETE CASCADE,
  category_id   INTEGER REFERENCES category(id),
  part_id       INTEGER REFERENCES part(id),
  rev INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, origin TEXT,
  CHECK ((category_id IS NOT NULL) <> (part_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS ras_cat_idx
  ON rebate_agreement_scope(agreement_id, category_id) WHERE category_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ras_part_idx
  ON rebate_agreement_scope(agreement_id, part_id) WHERE part_id IS NOT NULL;

-- A stepped scheme is data, not logic. threshold_to NULL = open-ended top tier.
CREATE TABLE IF NOT EXISTS rebate_tier (
  id            INTEGER PRIMARY KEY,
  agreement_id  INTEGER NOT NULL REFERENCES rebate_agreement(id) ON DELETE CASCADE,
  threshold_from INTEGER NOT NULL CHECK (threshold_from >= 0),  -- minor units or qty
  threshold_to   INTEGER CHECK (threshold_to IS NULL OR threshold_to > threshold_from),
  rate_bps      INTEGER NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
  rev INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, origin TEXT,
  UNIQUE (agreement_id, threshold_from)
);
CREATE INDEX IF NOT EXISTS rt_agreement_idx ON rebate_tier(agreement_id, threshold_from);

-- ══════════════════════════════════════════════════════════════════════════
--  9. THE ACCRUAL LEDGER — append-only, exactly like stock_movement
-- ══════════════════════════════════════════════════════════════════════════
-- A rebate accrual is a financial assertion. It is corrected by a REVERSING
-- entry that points at what it reverses, never by an UPDATE. When the supplier
-- disputes a claim eight months later the argument is won by showing the
-- derivation, and a mutable table has no derivation to show.
--
-- The trap this design exists to avoid: a sales-based rebate accrued on a sale
-- that is later credited must reverse. If accruals are only ever added, a
-- business with a normal return rate overstates what it is owed every single
-- period and finds out when the supplier disagrees.
CREATE TABLE IF NOT EXISTS rebate_accrual (
  id            INTEGER PRIMARY KEY,
  agreement_id  INTEGER NOT NULL REFERENCES rebate_agreement(id),
  period_start  TEXT NOT NULL,
  period_end    TEXT NOT NULL,
  source_type   TEXT NOT NULL CHECK (source_type IN
                  ('goods_receipt','sales_order','manual_adjustment','tier_uplift')),
  source_id     INTEGER,
  part_id       INTEGER REFERENCES part(id),   -- NULL for a period-level uplift
  qty           INTEGER NOT NULL DEFAULT 0,
  measured_value_minor INTEGER NOT NULL DEFAULT 0,
  rate_bps_applied INTEGER NOT NULL DEFAULT 0,
  -- Signed: a reversal or a downward restatement is negative. The sum over a
  -- period is what is earned, which is why nothing here is ever deleted.
  amount_minor  INTEGER NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'ZAR',
  state         TEXT NOT NULL DEFAULT 'accrued' CHECK (state IN
                  ('accrued','claimable','claimed','settled','reversed')),
  reverses_id   INTEGER REFERENCES rebate_accrual(id),
  claim_id      INTEGER REFERENCES supplier_claim(id),
  note          TEXT,
  client_uuid   TEXT NOT NULL UNIQUE,   -- idempotency, same contract as the ledger
  actor_id TEXT, actor_label TEXT, actor_source TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  origin        TEXT
);
CREATE INDEX IF NOT EXISTS acc_agreement_idx
  ON rebate_accrual(agreement_id, period_start, state);
CREATE INDEX IF NOT EXISTS acc_source_idx ON rebate_accrual(source_type, source_id);
CREATE INDEX IF NOT EXISTS acc_part_idx ON rebate_accrual(part_id);

-- ══════════════════════════════════════════════════════════════════════════
--  10. VIEWS
-- ══════════════════════════════════════════════════════════════════════════

-- What is still outstanding on every purchase order line. Derived, never stored.
DROP VIEW IF EXISTS po_line_status;
CREATE VIEW po_line_status AS
  SELECT pol.id AS order_line_id, pol.order_id, pol.part_id, pol.qty_ordered,
         COALESCE((SELECT SUM(grl.qty_received)
                     FROM goods_receipt_line grl
                     JOIN goods_receipt gr ON gr.id = grl.receipt_id
                    WHERE grl.order_line_id = pol.id
                      AND gr.status = 'posted'
                      AND grl.deleted_at IS NULL), 0) AS qty_received
    FROM purchase_order_line pol
   WHERE pol.deleted_at IS NULL;

-- The current cost of every part: the newest landed cost if there is one, else
-- the price-list fallback. BOTH figures are carried through — anything that
-- constrains a price reads cost_invoiced_minor and nothing else.
DROP VIEW IF EXISTS part_current_cost;
CREATE VIEW part_current_cost AS
  SELECT p.id AS part_id,
         COALESCE(l.unit_cost_invoiced_minor, pc.amount_minor)        AS cost_invoiced_minor,
         COALESCE(l.unit_cost_expected_minor, pc.amount_minor)        AS cost_expected_minor,
         COALESCE(l.unit_rebate_minor, 0)                             AS rebate_minor,
         COALESCE(l.currency, pc.currency, 'ZAR')                     AS currency,
         CASE WHEN l.id IS NOT NULL THEN 'landed'
              WHEN pc.part_id IS NOT NULL THEN 'price_list'
              ELSE 'none' END                                         AS basis,
         COALESCE(l.is_estimated, 1)                                  AS is_estimated
    FROM part p
    LEFT JOIN part_landed_cost l
      ON l.id = (SELECT id FROM part_landed_cost x
                  WHERE x.part_id = p.id AND x.deleted_at IS NULL
                  ORDER BY x.valid_from DESC, x.id DESC LIMIT 1)
    LEFT JOIN part_cost pc
      ON pc.rowid = (SELECT rowid FROM part_cost y
                      WHERE y.part_id = p.id AND y.deleted_at IS NULL
                      ORDER BY y.valid_from DESC LIMIT 1)
   WHERE p.deleted_at IS NULL;

-- Rebate exposure: how much of reported profit depends on claims being made
-- and honoured. Nothing computed this before.
DROP VIEW IF EXISTS rebate_position;
CREATE VIEW rebate_position AS
  SELECT a.id AS agreement_id, a.code, a.supplier_id, a.basis, a.measure,
         a.tier_mode, a.period_start, a.period_end, a.is_provisional,
         COALESCE(SUM(r.amount_minor), 0) AS earned_minor,
         COALESCE(SUM(CASE WHEN r.state = 'accrued'   THEN r.amount_minor END), 0) AS accrued_minor,
         COALESCE(SUM(CASE WHEN r.state = 'claimable' THEN r.amount_minor END), 0) AS claimable_minor,
         COALESCE(SUM(CASE WHEN r.state = 'claimed'   THEN r.amount_minor END), 0) AS claimed_minor,
         COALESCE(SUM(CASE WHEN r.state = 'settled'   THEN r.amount_minor END), 0) AS settled_minor,
         COALESCE(SUM(CASE WHEN r.state IN ('accrued','claimable','claimed')
                           THEN r.amount_minor END), 0) AS exposure_minor
    FROM rebate_agreement a
    LEFT JOIN rebate_accrual r
      ON r.agreement_id = a.id AND r.state <> 'reversed'
   WHERE a.deleted_at IS NULL
   GROUP BY a.id;

-- ══════════════════════════════════════════════════════════════════════════
--  11. rev TRIGGERS for the new tables, same guard as 0018
-- ══════════════════════════════════════════════════════════════════════════
-- WHEN NEW.rev = OLD.rev means a writer that supplied its own rev (a sync
-- applying an upstream row) keeps it, and the trigger's own UPDATE does not
-- re-fire because on that pass NEW.rev <> OLD.rev.
DROP TRIGGER IF EXISTS supplier_touch_rev;
CREATE TRIGGER supplier_touch_rev AFTER UPDATE ON supplier WHEN NEW.rev = OLD.rev
BEGIN UPDATE supplier SET rev = OLD.rev + 1, updated_at = datetime('now') WHERE rowid = NEW.rowid; END;

DROP TRIGGER IF EXISTS purchase_order_touch_rev;
CREATE TRIGGER purchase_order_touch_rev AFTER UPDATE ON purchase_order WHEN NEW.rev = OLD.rev
BEGIN UPDATE purchase_order SET rev = OLD.rev + 1, updated_at = datetime('now') WHERE rowid = NEW.rowid; END;

DROP TRIGGER IF EXISTS purchase_order_line_touch_rev;
CREATE TRIGGER purchase_order_line_touch_rev AFTER UPDATE ON purchase_order_line WHEN NEW.rev = OLD.rev
BEGIN UPDATE purchase_order_line SET rev = OLD.rev + 1, updated_at = datetime('now') WHERE rowid = NEW.rowid; END;

DROP TRIGGER IF EXISTS goods_receipt_touch_rev;
CREATE TRIGGER goods_receipt_touch_rev AFTER UPDATE ON goods_receipt WHEN NEW.rev = OLD.rev
BEGIN UPDATE goods_receipt SET rev = OLD.rev + 1, updated_at = datetime('now') WHERE rowid = NEW.rowid; END;

DROP TRIGGER IF EXISTS goods_receipt_line_touch_rev;
CREATE TRIGGER goods_receipt_line_touch_rev AFTER UPDATE ON goods_receipt_line WHEN NEW.rev = OLD.rev
BEGIN UPDATE goods_receipt_line SET rev = OLD.rev + 1, updated_at = datetime('now') WHERE rowid = NEW.rowid; END;

DROP TRIGGER IF EXISTS receipt_cost_touch_rev;
CREATE TRIGGER receipt_cost_touch_rev AFTER UPDATE ON receipt_cost WHEN NEW.rev = OLD.rev
BEGIN UPDATE receipt_cost SET rev = OLD.rev + 1, updated_at = datetime('now') WHERE rowid = NEW.rowid; END;

DROP TRIGGER IF EXISTS part_landed_cost_touch_rev;
CREATE TRIGGER part_landed_cost_touch_rev AFTER UPDATE ON part_landed_cost WHEN NEW.rev = OLD.rev
BEGIN UPDATE part_landed_cost SET rev = OLD.rev + 1, updated_at = datetime('now') WHERE rowid = NEW.rowid; END;

DROP TRIGGER IF EXISTS part_cost_touch_rev;
CREATE TRIGGER part_cost_touch_rev AFTER UPDATE ON part_cost WHEN NEW.rev = OLD.rev
BEGIN UPDATE part_cost SET rev = OLD.rev + 1, updated_at = datetime('now') WHERE rowid = NEW.rowid; END;

DROP TRIGGER IF EXISTS receipt_discrepancy_touch_rev;
CREATE TRIGGER receipt_discrepancy_touch_rev AFTER UPDATE ON receipt_discrepancy WHEN NEW.rev = OLD.rev
BEGIN UPDATE receipt_discrepancy SET rev = OLD.rev + 1, updated_at = datetime('now') WHERE rowid = NEW.rowid; END;

DROP TRIGGER IF EXISTS supplier_claim_touch_rev;
CREATE TRIGGER supplier_claim_touch_rev AFTER UPDATE ON supplier_claim WHEN NEW.rev = OLD.rev
BEGIN UPDATE supplier_claim SET rev = OLD.rev + 1, updated_at = datetime('now') WHERE rowid = NEW.rowid; END;

DROP TRIGGER IF EXISTS rebate_agreement_touch_rev;
CREATE TRIGGER rebate_agreement_touch_rev AFTER UPDATE ON rebate_agreement WHEN NEW.rev = OLD.rev
BEGIN UPDATE rebate_agreement SET rev = OLD.rev + 1, updated_at = datetime('now') WHERE rowid = NEW.rowid; END;

DROP TRIGGER IF EXISTS rebate_agreement_scope_touch_rev;
CREATE TRIGGER rebate_agreement_scope_touch_rev AFTER UPDATE ON rebate_agreement_scope WHEN NEW.rev = OLD.rev
BEGIN UPDATE rebate_agreement_scope SET rev = OLD.rev + 1, updated_at = datetime('now') WHERE rowid = NEW.rowid; END;

DROP TRIGGER IF EXISTS rebate_tier_touch_rev;
CREATE TRIGGER rebate_tier_touch_rev AFTER UPDATE ON rebate_tier WHEN NEW.rev = OLD.rev
BEGIN UPDATE rebate_tier SET rev = OLD.rev + 1, updated_at = datetime('now') WHERE rowid = NEW.rowid; END;

-- rebate_accrual gets NO trigger, deliberately, for the same reason
-- stock_movement has none: it is append-only. Rows are never updated, so a
-- version counter would be meaningless. State changes (accrued -> claimable ->
-- claimed -> settled) are the one exception and are handled as explicit
-- transitions in code, not as edits to the amount.

-- ══════════════════════════════════════════════════════════════════════════
--  12. SEED — the supplier that already exists in fact but not in data
-- ══════════════════════════════════════════════════════════════════════════
-- One brand, one supplier, one warehouse. The row is created empty of contact
-- detail on purpose: empty fields are honest and fillable, and waiting for them
-- would block work that does not depend on them.
INSERT OR IGNORE INTO supplier (code, name, currency, incoterm, notes)
VALUES ('FAW', 'FAW Jiefang', 'ZAR', NULL,
        'Created by migration 0024. Currency and incoterm are defaults — '
        || 'set them when the real terms are known. Contact detail deliberately '
        || 'left blank rather than guessed.');

COMMIT;
