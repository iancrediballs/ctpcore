-- ============================================================================
--  FleetView ERP — LOCAL SQLite mirror of the core spine
--  Target: SQLite 3.34+ (needs the FTS5 'trigram' tokenizer)
--  Mirrors schema/core.sql (Postgres server-of-record). Append-only stock
--  ledger, money in integer minor units, every business row carries sync
--  columns (rev/updated_at/deleted_at/origin).
-- ============================================================================
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE category (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES category(id),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, origin TEXT
);

CREATE TABLE brand (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  is_oem INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, origin TEXT
);

CREATE TABLE part (
  id INTEGER PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  mpn TEXT,
  brand_id INTEGER REFERENCES brand(id),
  category_id INTEGER NOT NULL REFERENCES category(id),
  name TEXT NOT NULL,
  description TEXT,
  uom TEXT NOT NULL DEFAULT 'EA',
  weight_g INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','discontinued')),
  superseded_by INTEGER REFERENCES part(id),
  rev INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, origin TEXT
);
CREATE INDEX part_category_idx ON part(category_id);
CREATE INDEX part_brand_idx ON part(brand_id);

CREATE TABLE part_xref (
  id INTEGER PRIMARY KEY,
  part_id INTEGER NOT NULL REFERENCES part(id) ON DELETE CASCADE,
  xref_number TEXT NOT NULL,
  xref_brand TEXT,
  xref_type TEXT NOT NULL CHECK (xref_type IN ('oem','aftermarket','competitor','supersession')),
  confidence INTEGER NOT NULL DEFAULT 100 CHECK (confidence BETWEEN 0 AND 100),
  rev INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, origin TEXT,
  UNIQUE (part_id, xref_number, xref_type)
);
CREATE INDEX xref_part_idx ON part_xref(part_id);

CREATE TABLE vehicle_model (
  id INTEGER PRIMARY KEY,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  variant TEXT NOT NULL DEFAULT '',
  rev INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, origin TEXT,
  UNIQUE (make, model, variant)
);

CREATE TABLE part_fitment (
  part_id INTEGER NOT NULL REFERENCES part(id) ON DELETE CASCADE,
  vehicle_id INTEGER NOT NULL REFERENCES vehicle_model(id),
  engine TEXT NOT NULL DEFAULT '',
  year_from INTEGER, year_to INTEGER, note TEXT,
  rev INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, origin TEXT,
  PRIMARY KEY (part_id, vehicle_id, engine)
);
CREATE INDEX fitment_vehicle_idx ON part_fitment(vehicle_id);

CREATE TABLE location (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, origin TEXT
);

CREATE TABLE stock_movement (
  id INTEGER PRIMARY KEY,
  part_id INTEGER NOT NULL REFERENCES part(id),
  location_id INTEGER NOT NULL REFERENCES location(id),
  delta INTEGER NOT NULL CHECK (delta <> 0),
  reason TEXT NOT NULL CHECK (reason IN ('receipt','sale','adjustment','transfer','return','count')),
  ref_type TEXT, ref_id INTEGER, actor_id INTEGER,
  client_uuid TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  origin TEXT
);
CREATE INDEX movement_part_loc_idx ON stock_movement(part_id, location_id);

CREATE TABLE stock_policy (
  part_id INTEGER NOT NULL REFERENCES part(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES location(id) ON DELETE CASCADE,
  bin TEXT, reorder_point INTEGER, reorder_qty INTEGER,
  rev INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, origin TEXT,
  PRIMARY KEY (part_id, location_id)
);

CREATE TABLE price (
  part_id INTEGER NOT NULL REFERENCES part(id) ON DELETE CASCADE,
  tier TEXT NOT NULL DEFAULT 'list' CHECK (tier IN ('list','trade','wholesale')),
  currency TEXT NOT NULL DEFAULT 'USD',
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  valid_from TEXT NOT NULL DEFAULT (datetime('now')),
  rev INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, origin TEXT,
  PRIMARY KEY (part_id, tier, currency, valid_from)
);

CREATE VIEW stock_on_hand AS
  SELECT part_id, location_id, SUM(delta) AS qty_on_hand
  FROM stock_movement GROUP BY part_id, location_id;

-- FTS5 trigram lightning index: SKU + MPN + name + brand + every xref number/brand
CREATE VIRTUAL TABLE part_search USING fts5(part_id UNINDEXED, body, tokenize = 'trigram');

CREATE TRIGGER part_ai AFTER INSERT ON part BEGIN
  INSERT INTO part_search(part_id, body) VALUES (NEW.id,
    NEW.sku||' '||COALESCE(NEW.mpn,'')||' '||NEW.name||' '||
    COALESCE((SELECT name FROM brand WHERE id=NEW.brand_id),'')||' '||
    COALESCE((SELECT group_concat(xref_number||' '||COALESCE(xref_brand,''),' ') FROM part_xref WHERE part_id=NEW.id),''));
END;
CREATE TRIGGER part_au AFTER UPDATE ON part BEGIN
  DELETE FROM part_search WHERE part_id=NEW.id;
  INSERT INTO part_search(part_id, body) VALUES (NEW.id,
    NEW.sku||' '||COALESCE(NEW.mpn,'')||' '||NEW.name||' '||
    COALESCE((SELECT name FROM brand WHERE id=NEW.brand_id),'')||' '||
    COALESCE((SELECT group_concat(xref_number||' '||COALESCE(xref_brand,''),' ') FROM part_xref WHERE part_id=NEW.id),''));
END;
CREATE TRIGGER part_ad AFTER DELETE ON part BEGIN
  DELETE FROM part_search WHERE part_id=OLD.id;
END;
CREATE TRIGGER xref_ai AFTER INSERT ON part_xref BEGIN
  DELETE FROM part_search WHERE part_id=NEW.part_id;
  INSERT INTO part_search(part_id, body)
  SELECT p.id, p.sku||' '||COALESCE(p.mpn,'')||' '||p.name||' '||
    COALESCE((SELECT name FROM brand WHERE id=p.brand_id),'')||' '||
    COALESCE((SELECT group_concat(xref_number||' '||COALESCE(xref_brand,''),' ') FROM part_xref WHERE part_id=p.id),'')
  FROM part p WHERE p.id=NEW.part_id;
END;
CREATE TRIGGER xref_au AFTER UPDATE ON part_xref BEGIN
  DELETE FROM part_search WHERE part_id=NEW.part_id;
  INSERT INTO part_search(part_id, body)
  SELECT p.id, p.sku||' '||COALESCE(p.mpn,'')||' '||p.name||' '||
    COALESCE((SELECT name FROM brand WHERE id=p.brand_id),'')||' '||
    COALESCE((SELECT group_concat(xref_number||' '||COALESCE(xref_brand,''),' ') FROM part_xref WHERE part_id=p.id),'')
  FROM part p WHERE p.id=NEW.part_id;
END;
CREATE TRIGGER xref_ad AFTER DELETE ON part_xref BEGIN
  DELETE FROM part_search WHERE part_id=OLD.part_id;
  INSERT INTO part_search(part_id, body)
  SELECT p.id, p.sku||' '||COALESCE(p.mpn,'')||' '||p.name||' '||
    COALESCE((SELECT name FROM brand WHERE id=p.brand_id),'')||' '||
    COALESCE((SELECT group_concat(xref_number||' '||COALESCE(xref_brand,''),' ') FROM part_xref WHERE part_id=p.id),'')
  FROM part p WHERE p.id=OLD.part_id;
END;
