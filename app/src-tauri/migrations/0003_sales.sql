-- ============================================================================
--  FleetView ERP — SALES / CRM spine (migration 0003)
--  One mutable document (sales_order) walks a lifecycle:
--     quote → confirmed → fulfilled → invoiced   (+ cancelled before fulfill)
--  Stock is NEVER touched until fulfillment, and then only by appending to the
--  stock_movement ledger (reason='sale', ref to the order) — same single source
--  of truth as inventory ops. Line prices are SNAPSHOTTED at add time so later
--  price-list changes never rewrite past quotes. Money in integer minor units.
-- ============================================================================
PRAGMA foreign_keys = ON;

CREATE TABLE customer (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  contact TEXT,
  phone TEXT,
  email TEXT,
  price_tier TEXT NOT NULL DEFAULT 'list' CHECK (price_tier IN ('list','trade','wholesale')),
  notes TEXT,
  rev INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, origin TEXT
);

CREATE TABLE sales_order (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,                 -- human ref, e.g. SO-1042
  customer_id INTEGER NOT NULL REFERENCES customer(id),
  location_id INTEGER NOT NULL REFERENCES location(id),  -- which stock fulfills
  status TEXT NOT NULL DEFAULT 'quote'
    CHECK (status IN ('quote','confirmed','fulfilled','invoiced','cancelled')),
  currency TEXT NOT NULL DEFAULT 'USD',
  notes TEXT,
  fulfilled_at TEXT,
  rev INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, origin TEXT
);
CREATE INDEX so_customer_idx ON sales_order(customer_id);
CREATE INDEX so_status_idx ON sales_order(status);

CREATE TABLE sales_line (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES sales_order(id) ON DELETE CASCADE,
  part_id INTEGER NOT NULL REFERENCES part(id),
  qty INTEGER NOT NULL CHECK (qty > 0),
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0), -- snapshot
  tier_at_add TEXT NOT NULL DEFAULT 'list',
  rev INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, origin TEXT,
  UNIQUE (order_id, part_id)
);
CREATE INDEX sl_order_idx ON sales_line(order_id);

-- Derived order total (qty * snapshot price), mirrors the ledger philosophy:
-- never store a total you can sum.
CREATE VIEW order_total AS
  SELECT order_id,
         SUM(qty)                       AS line_count,
         SUM(qty * unit_price_minor)    AS subtotal_minor
  FROM sales_line
  WHERE deleted_at IS NULL
  GROUP BY order_id;

-- --------------------------------------------------------- seed customers ----
INSERT INTO customer (id, code, name, contact, phone, price_tier) VALUES
 (1,'WALKIN','Walk-in / Cash', NULL, NULL, 'list'),
 (2,'HXFLEET','Hexi Fleet Services','Li Wei','+86 138 0011 2233','trade'),
 (3,'GSLOGI','Gansu Logistics Co.','Zhang Min','+86 139 0044 5566','wholesale'),
 (4,'DESERTHL','Desert Haul Ltd.','Ahmad Rashid','+971 50 123 4567','trade');

-- a couple of trade/wholesale prices so tier snapshotting is demonstrable
INSERT INTO price (part_id, tier, amount_minor) VALUES
 (1,'trade',17200),(1,'wholesale',15900),
 (2,'trade',1050),(2,'wholesale',900),
 (8,'trade',82000),(8,'wholesale',77500);
