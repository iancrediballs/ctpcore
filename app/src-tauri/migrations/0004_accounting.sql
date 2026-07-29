-- ============================================================================
--  FleetView ERP — ACCOUNTING EXPORT (migration 0004)
--  We do NOT keep a general ledger. Invoiced orders are pushed to QuickBooks /
--  Xero. This is the append-only OUTBOX that records each push exactly once per
--  target, so retries and reconnects never double-post a transaction into the
--  customer's books. The invoiced sales_order/sales_line rows are already
--  immutable (editing is locked past 'confirmed'), so they ARE the snapshot.
-- ============================================================================
PRAGMA foreign_keys = ON;

-- Optional tax, basis points (e.g. 1300 = 13% VAT). Derived tax/total are never
-- stored — computed from the line snapshots, same as every other total.
ALTER TABLE sales_order ADD COLUMN tax_rate_bps INTEGER NOT NULL DEFAULT 0;

CREATE TABLE accounting_export (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES sales_order(id),
  target TEXT NOT NULL CHECK (target IN ('quickbooks','xero')),
  batch_uuid TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'exported' CHECK (status IN ('exported','error')),
  external_ref TEXT,           -- id the accounting system returns, once wired live
  payload_hash TEXT,           -- integrity of what we handed off
  exported_at TEXT NOT NULL DEFAULT (datetime('now')),
  origin TEXT,
  UNIQUE (order_id, target)    -- one push per order per target — idempotency spine
);
CREATE INDEX acct_export_target_idx ON accounting_export(target, exported_at);
