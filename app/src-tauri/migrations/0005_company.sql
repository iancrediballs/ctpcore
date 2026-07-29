-- ============================================================================
--  FleetView ERP — COMPANY PROFILE (migration 0005)
--  Single-row seller identity used as the letterhead on quotes & invoices.
--  id is pinned to 1 so there is exactly one company record to read/update.
-- ============================================================================
PRAGMA foreign_keys = ON;

CREATE TABLE company (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  address TEXT,
  phone TEXT,
  email TEXT,
  tax_id TEXT,
  currency TEXT NOT NULL DEFAULT 'USD',
  terms TEXT,
  rev INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  origin TEXT
);

-- editable placeholders — Ian swaps these in Settings
INSERT INTO company (id, name, address, phone, email, tax_id, currency, terms) VALUES
 (1,
  'China Truck Parts Co., Ltd.',
  'No. 88 Heavy Industry Rd, Jinan, Shandong, China',
  '+86 531 8888 0000',
  'sales@chinatruckparts.com',
  'CN-91370100-XXXXXXXX',
  'USD',
  'Payment due within 30 days. Parts carry a 12-month manufacturer warranty against defects.');
