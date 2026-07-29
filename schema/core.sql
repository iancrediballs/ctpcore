-- ============================================================================
--  FleetView ERP — CORE SCHEMA (the "spine")
--  Target: PostgreSQL 15+ (server, source of truth)
--  Mirrors to SQLite (FTS5 + trigram) on each client for local-first reads.
--
--  Design rules enforced here:
--    1. Money is ALWAYS integer minor units (cents). Never FLOAT for money.
--    2. Stock is an APPEND-ONLY LEDGER. Quantities are derived, never mutated
--       in place. This is what makes offline-first + audit trivial.
--    3. Every business row is "syncable": id + rev + updated_at + deleted_at.
--    4. Cross-reference (interchange) and vehicle fitment are first-class —
--       they are the differentiators a hollow ERP leaves out.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;        -- fuzzy part-number search
CREATE EXTENSION IF NOT EXISTS btree_gin;

CREATE SCHEMA IF NOT EXISTS core;
SET search_path TO core, public;

-- ----------------------------------------------------------------------------
--  Syncable-row convention
--  Copy these 4 columns onto every table that participates in sync:
--      rev         BIGINT   -- bumped on every write; client compares to detect change
--      updated_at  TIMESTAMPTZ
--      deleted_at  TIMESTAMPTZ  -- soft delete; never hard-delete synced rows
--      origin      TEXT     -- device/node id that last wrote (conflict forensics)
--  A single trigger keeps rev/updated_at honest. Defined once, applied to all.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_row() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  NEW.rev := COALESCE(OLD.rev, 0) + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ===========================================================================
--  TAXONOMY
-- ===========================================================================
CREATE TABLE category (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parent_id   BIGINT REFERENCES category(id) ON DELETE RESTRICT,
  code        TEXT NOT NULL UNIQUE,            -- short, stable, human-typeable
  name        TEXT NOT NULL,
  path        TEXT NOT NULL,                   -- materialized path e.g. 'engine/fuel/injectors'
  -- sync cols
  rev         BIGINT NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  origin      TEXT
);
CREATE INDEX category_parent_idx ON category(parent_id);
CREATE INDEX category_path_idx   ON category(path text_pattern_ops);
CREATE TRIGGER category_touch BEFORE UPDATE ON category
  FOR EACH ROW EXECUTE FUNCTION touch_row();

CREATE TABLE brand (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  is_oem      BOOLEAN NOT NULL DEFAULT false,
  rev         BIGINT NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  origin      TEXT
);
CREATE TRIGGER brand_touch BEFORE UPDATE ON brand
  FOR EACH ROW EXECUTE FUNCTION touch_row();

-- ===========================================================================
--  PART MASTER  (canonical record)
-- ===========================================================================
CREATE TABLE part (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku           TEXT NOT NULL UNIQUE,          -- your internal canonical number
  mpn           TEXT,                          -- manufacturer part number
  brand_id      BIGINT REFERENCES brand(id),
  category_id   BIGINT NOT NULL REFERENCES category(id),
  name          TEXT NOT NULL,
  description   TEXT,
  uom           TEXT NOT NULL DEFAULT 'EA',
  weight_g      INTEGER,                        -- integer grams, not float kg
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','superseded','discontinued')),
  superseded_by BIGINT REFERENCES part(id),    -- supersession chain
  -- full-text search document, kept in sync by trigger below
  search_doc    tsvector,
  rev           BIGINT NOT NULL DEFAULT 1,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  origin        TEXT
);

-- Fast search: GIN over the tsvector, plus trigram over the numbers people
-- actually type. Trigram is what makes "give me anything close to BX-4471"
-- return results in single-digit milliseconds across millions of rows.
CREATE INDEX part_search_idx ON part USING gin(search_doc);
CREATE INDEX part_sku_trgm   ON part USING gin(sku  gin_trgm_ops);
CREATE INDEX part_mpn_trgm   ON part USING gin(mpn  gin_trgm_ops);
CREATE INDEX part_name_trgm  ON part USING gin(name gin_trgm_ops);
CREATE INDEX part_category_idx ON part(category_id) WHERE deleted_at IS NULL;
CREATE INDEX part_brand_idx    ON part(brand_id)    WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION part_search_doc() RETURNS trigger AS $$
BEGIN
  NEW.search_doc :=
      setweight(to_tsvector('simple', coalesce(NEW.sku,'')),  'A')
   || setweight(to_tsvector('simple', coalesce(NEW.mpn,'')),  'A')
   || setweight(to_tsvector('english',coalesce(NEW.name,'')), 'B')
   || setweight(to_tsvector('english',coalesce(NEW.description,'')), 'C');
  NEW.updated_at := now();
  NEW.rev := COALESCE(OLD.rev, 0) + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER part_touch BEFORE INSERT OR UPDATE ON part
  FOR EACH ROW EXECUTE FUNCTION part_search_doc();

-- ---- DIFFERENTIATOR #1: cross-reference / interchange ----------------------
-- One part maps to many foreign numbers (OEM, aftermarket, competitor, super-
-- session). This table is the reason a customer calls YOU instead of guessing.
CREATE TABLE part_xref (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  part_id     BIGINT NOT NULL REFERENCES part(id) ON DELETE CASCADE,
  xref_number TEXT NOT NULL,
  xref_brand  TEXT,
  xref_type   TEXT NOT NULL
                CHECK (xref_type IN ('oem','aftermarket','competitor','supersession')),
  confidence  SMALLINT NOT NULL DEFAULT 100    -- 0-100, for imported/fuzzy links
                CHECK (confidence BETWEEN 0 AND 100),
  rev         BIGINT NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  origin      TEXT,
  UNIQUE (part_id, xref_number, xref_type)
);
CREATE INDEX xref_number_trgm ON part_xref USING gin(xref_number gin_trgm_ops);
CREATE INDEX xref_part_idx    ON part_xref(part_id);
CREATE TRIGGER xref_touch BEFORE UPDATE ON part_xref
  FOR EACH ROW EXECUTE FUNCTION touch_row();

-- ---- DIFFERENTIATOR #2: vehicle fitment / application ----------------------
CREATE TABLE vehicle_model (
  id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  make      TEXT NOT NULL,
  model     TEXT NOT NULL,
  variant   TEXT NOT NULL DEFAULT '',
  rev         BIGINT NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  origin      TEXT,
  UNIQUE (make, model, variant)
);
CREATE INDEX vehicle_make_model_idx ON vehicle_model(make, model);
CREATE TRIGGER vehicle_touch BEFORE UPDATE ON vehicle_model
  FOR EACH ROW EXECUTE FUNCTION touch_row();

CREATE TABLE part_fitment (
  part_id     BIGINT NOT NULL REFERENCES part(id) ON DELETE CASCADE,
  vehicle_id  BIGINT NOT NULL REFERENCES vehicle_model(id) ON DELETE RESTRICT,
  engine      TEXT NOT NULL DEFAULT '',
  year_from   SMALLINT,
  year_to     SMALLINT,
  note        TEXT,
  rev         BIGINT NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  origin      TEXT,
  PRIMARY KEY (part_id, vehicle_id, engine),
  CHECK (year_to IS NULL OR year_from IS NULL OR year_to >= year_from)
);
CREATE INDEX fitment_vehicle_idx ON part_fitment(vehicle_id);
CREATE TRIGGER fitment_touch BEFORE UPDATE ON part_fitment
  FOR EACH ROW EXECUTE FUNCTION touch_row();

-- ===========================================================================
--  INVENTORY  (append-only ledger model)
-- ===========================================================================
CREATE TABLE location (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  rev         BIGINT NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  origin      TEXT
);
CREATE TRIGGER location_touch BEFORE UPDATE ON location
  FOR EACH ROW EXECUTE FUNCTION touch_row();

-- The ledger. Every receipt, sale, adjustment, transfer, return is one
-- IMMUTABLE row with a signed delta. Nothing here is ever updated.
-- Two offline devices selling the same part just append two rows; when they
-- sync, reconciliation is a replay, not a conflict. THIS collapses the
-- hardest part of "local-first + banking-grade" into one table.
CREATE TABLE stock_movement (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  part_id     BIGINT NOT NULL REFERENCES part(id),
  location_id BIGINT NOT NULL REFERENCES location(id),
  delta       INTEGER NOT NULL CHECK (delta <> 0),   -- +receipt / -issue
  reason      TEXT NOT NULL
                CHECK (reason IN ('receipt','sale','adjustment','transfer','return','count')),
  ref_type    TEXT,                                  -- e.g. 'sales_order'
  ref_id      BIGINT,
  actor_id    BIGINT,
  -- client-supplied UUID guarantees idempotent sync (apply-once even on retry)
  client_uuid UUID NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  origin      TEXT
);
CREATE INDEX movement_part_loc_idx ON stock_movement(part_id, location_id);
CREATE INDEX movement_created_idx  ON stock_movement(created_at);

-- Reorder thresholds live separately (they ARE mutable config, not ledger).
CREATE TABLE stock_policy (
  part_id       BIGINT NOT NULL REFERENCES part(id) ON DELETE CASCADE,
  location_id   BIGINT NOT NULL REFERENCES location(id) ON DELETE CASCADE,
  bin           TEXT,
  reorder_point INTEGER,
  reorder_qty   INTEGER,
  rev         BIGINT NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  origin      TEXT,
  PRIMARY KEY (part_id, location_id)
);
CREATE TRIGGER stock_policy_touch BEFORE UPDATE ON stock_policy
  FOR EACH ROW EXECUTE FUNCTION touch_row();

-- On-hand is DERIVED. A materialized view gives O(1) reads; refresh on sync.
-- (Start with this; graduate to an incremental rollup table only if profiling
--  says you need it. Don't pre-optimize.)
CREATE MATERIALIZED VIEW stock_on_hand AS
  SELECT part_id, location_id, SUM(delta) AS qty_on_hand
  FROM stock_movement
  GROUP BY part_id, location_id;
CREATE UNIQUE INDEX stock_on_hand_pk ON stock_on_hand(part_id, location_id);

-- ===========================================================================
--  PRICING  (minor units, time-versioned)
-- ===========================================================================
CREATE TABLE price (
  part_id      BIGINT NOT NULL REFERENCES part(id) ON DELETE CASCADE,
  tier         TEXT NOT NULL DEFAULT 'list'
                 CHECK (tier IN ('list','trade','wholesale')),
  currency     CHAR(3) NOT NULL DEFAULT 'USD',
  amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),   -- cents, never float
  valid_from   TIMESTAMPTZ NOT NULL DEFAULT now(),
  rev          BIGINT NOT NULL DEFAULT 1,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ,
  origin       TEXT,
  PRIMARY KEY (part_id, tier, currency, valid_from)
);
CREATE TRIGGER price_touch BEFORE UPDATE ON price
  FOR EACH ROW EXECUTE FUNCTION touch_row();

-- ===========================================================================
--  MODULE SEAM (illustrative — NOT built in Phase 0)
--  CRM / Sales / Accounting live in their own schemas and reference core.part
--  by id only. They can be added later without touching anything above.
-- ===========================================================================
-- CREATE SCHEMA crm;   -- customer, contact, lead, follow_up_trigger ...
-- CREATE SCHEMA sales; -- quote, sales_order(line FK part.id), writes stock_movement
-- CREATE SCHEMA acct;  -- thin: syncs to QuickBooks/Xero. Do NOT build a GL early.

-- ============================================================================
--  Example: the lightning lookup that powers the Phase-0 demo screen.
--  Fuzzy match across SKU, MPN, name, AND every cross-reference number,
--  ranked, with live on-hand — one query.
-- ============================================================================
-- SELECT p.id, p.sku, p.name, b.name AS brand,
--        s.qty_on_hand,
--        similarity(p.sku, :q) AS score
-- FROM part p
-- LEFT JOIN brand b ON b.id = p.brand_id
-- LEFT JOIN stock_on_hand s ON s.part_id = p.id
-- WHERE p.deleted_at IS NULL
--   AND ( p.sku % :q OR p.mpn % :q OR p.name % :q
--         OR EXISTS (SELECT 1 FROM part_xref x
--                    WHERE x.part_id = p.id AND x.xref_number % :q) )
-- ORDER BY score DESC NULLS LAST
-- LIMIT 50;
