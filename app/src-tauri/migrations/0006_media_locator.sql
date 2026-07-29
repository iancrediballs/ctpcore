-- ============================================================================
--  CTP Core — Internal Locator + Part Media (diagrams, photos, 3D models)
-- ----------------------------------------------------------------------------
--  Adds the three-tier part identity used across sales / admin / stock-take:
--    1. sku            public CTP-SKU   (customer-facing, hides supply chain)   e.g. CTP-FND-001-L
--    2. locator        internal locator (Make-Model-Drawing-Item, human-find)   e.g. FAW-JH6-D314-033
--    3. catalogue_pn   OEM catalogue PN (used to REORDER stock from supplier)    e.g. 2803035B1063
--       inventory_pn   exact received variant incl. suffix                       e.g. 2803035B1063-DQ
--
--  Plus media so a staff member can VISUALLY identify a part:
--    diagram                exploded-view drawings / section views (+ optional 3D)
--    part_diagram_callout   which numbered balloon on a diagram = which part
--    part_image             photos / renders / raw shots (primary flagged)
--    part_model             per-part 3D model (.glb)
--
--  FTS5 trigram body is rebuilt so search matches public SKU, locator,
--  OEM/inventory PN, MPN, name, brand, and every cross-reference number.
-- ============================================================================
PRAGMA foreign_keys = ON;

-- ── 1. Internal locator + OEM ordering reference on the part ────────────────
ALTER TABLE part ADD COLUMN make             TEXT;     -- FAW
ALTER TABLE part ADD COLUMN model            TEXT;     -- JH6
ALTER TABLE part ADD COLUMN drawing_no       TEXT;     -- D314  (diagram.drawing_key)
ALTER TABLE part ADD COLUMN diagram_item_no  INTEGER;  -- 33    (balloon # on that diagram)
ALTER TABLE part ADD COLUMN locator          TEXT;     -- FAW-JH6-D314-033  (assembled)
ALTER TABLE part ADD COLUMN catalogue_pn     TEXT;     -- 2803035B1063      (base OEM PN, for reorder)
ALTER TABLE part ADD COLUMN inventory_pn     TEXT;     -- 2803035B1063-DQ   (exact received variant)
ALTER TABLE part ADD COLUMN side             TEXT CHECK (side IN ('L','R','C','B') OR side IS NULL);

CREATE UNIQUE INDEX IF NOT EXISTS part_locator_idx      ON part(locator)      WHERE locator IS NOT NULL;
CREATE INDEX        IF NOT EXISTS part_catalogue_pn_idx  ON part(catalogue_pn);
CREATE INDEX        IF NOT EXISTS part_inventory_pn_idx  ON part(inventory_pn);
CREATE INDEX        IF NOT EXISTS part_make_model_idx     ON part(make, model);

-- ── 2. Diagrams (exploded views / section views) ────────────────────────────
CREATE TABLE diagram (
  id           INTEGER PRIMARY KEY,
  drawing_key  TEXT NOT NULL UNIQUE,   -- 'D314', '105'  (matches part.drawing_no)
  title        TEXT NOT NULL,          -- 'Front Fender & Steps'
  section_code TEXT,                   -- '105' / 'FND'  (functional group)
  make         TEXT,                   -- FAW
  model        TEXT,                   -- JH6
  image_path   TEXT,                   -- relative path to the exploded PNG/SVG
  model_3d_path TEXT,                  -- optional section-level .glb
  source       TEXT,                   -- 'Multicat exploded export', etc.
  rev INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, origin TEXT
);
CREATE INDEX diagram_make_model_idx ON diagram(make, model);

-- ── 3. Part ↔ Diagram callout (the numbered balloon linking) ────────────────
CREATE TABLE part_diagram_callout (
  part_id    INTEGER NOT NULL REFERENCES part(id) ON DELETE CASCADE,
  diagram_id INTEGER NOT NULL REFERENCES diagram(id) ON DELETE CASCADE,
  item_no    INTEGER NOT NULL,         -- balloon number on the diagram
  is_primary INTEGER NOT NULL DEFAULT 1,-- the diagram a staffer should see first
  rev INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, origin TEXT,
  PRIMARY KEY (part_id, diagram_id)
);
CREATE INDEX callout_diagram_idx ON part_diagram_callout(diagram_id, item_no);

-- ── 4. Part images (photos / renders / raw) ─────────────────────────────────
CREATE TABLE part_image (
  id         INTEGER PRIMARY KEY,
  part_id    INTEGER NOT NULL REFERENCES part(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,            -- relative path to the image
  kind       TEXT NOT NULL DEFAULT 'photo'
               CHECK (kind IN ('photo','render','raw','thumb')),
  is_primary INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  caption    TEXT,
  rev INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, origin TEXT
);
CREATE INDEX image_part_idx ON part_image(part_id, is_primary DESC, sort_order);

-- ── 5. Part 3D models ───────────────────────────────────────────────────────
CREATE TABLE part_model (
  id        INTEGER PRIMARY KEY,
  part_id   INTEGER NOT NULL REFERENCES part(id) ON DELETE CASCADE,
  glb_path  TEXT NOT NULL,
  format    TEXT NOT NULL DEFAULT 'glb' CHECK (format IN ('glb','gltf','obj')),
  source    TEXT,                      -- 'Rodin export', 'scan', etc.
  rev INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, origin TEXT
);
CREATE INDEX model_part_idx ON part_model(part_id);

-- ── 6. Rebuild FTS body to include locator + OEM/inventory PNs ───────────────
--  (drop & recreate the body-building triggers; back-fill existing rows)
DROP TRIGGER IF EXISTS part_ai;
DROP TRIGGER IF EXISTS part_au;
DROP TRIGGER IF EXISTS xref_ai;
DROP TRIGGER IF EXISTS xref_au;
DROP TRIGGER IF EXISTS xref_ad;

CREATE TRIGGER part_ai AFTER INSERT ON part BEGIN
  INSERT INTO part_search(part_id, body) VALUES (NEW.id,
    NEW.sku||' '||COALESCE(NEW.mpn,'')||' '||NEW.name||' '||
    COALESCE(NEW.locator,'')||' '||COALESCE(NEW.catalogue_pn,'')||' '||COALESCE(NEW.inventory_pn,'')||' '||
    COALESCE((SELECT name FROM brand WHERE id=NEW.brand_id),'')||' '||
    COALESCE((SELECT group_concat(xref_number||' '||COALESCE(xref_brand,''),' ') FROM part_xref WHERE part_id=NEW.id),''));
END;
CREATE TRIGGER part_au AFTER UPDATE ON part BEGIN
  DELETE FROM part_search WHERE part_id=NEW.id;
  INSERT INTO part_search(part_id, body) VALUES (NEW.id,
    NEW.sku||' '||COALESCE(NEW.mpn,'')||' '||NEW.name||' '||
    COALESCE(NEW.locator,'')||' '||COALESCE(NEW.catalogue_pn,'')||' '||COALESCE(NEW.inventory_pn,'')||' '||
    COALESCE((SELECT name FROM brand WHERE id=NEW.brand_id),'')||' '||
    COALESCE((SELECT group_concat(xref_number||' '||COALESCE(xref_brand,''),' ') FROM part_xref WHERE part_id=NEW.id),''));
END;

-- helper body for xref triggers (rebuild whole row from part p)
CREATE TRIGGER xref_ai AFTER INSERT ON part_xref BEGIN
  DELETE FROM part_search WHERE part_id=NEW.part_id;
  INSERT INTO part_search(part_id, body)
  SELECT p.id, p.sku||' '||COALESCE(p.mpn,'')||' '||p.name||' '||
    COALESCE(p.locator,'')||' '||COALESCE(p.catalogue_pn,'')||' '||COALESCE(p.inventory_pn,'')||' '||
    COALESCE((SELECT name FROM brand WHERE id=p.brand_id),'')||' '||
    COALESCE((SELECT group_concat(xref_number||' '||COALESCE(xref_brand,''),' ') FROM part_xref WHERE part_id=p.id),'')
  FROM part p WHERE p.id=NEW.part_id;
END;
CREATE TRIGGER xref_au AFTER UPDATE ON part_xref BEGIN
  DELETE FROM part_search WHERE part_id=NEW.part_id;
  INSERT INTO part_search(part_id, body)
  SELECT p.id, p.sku||' '||COALESCE(p.mpn,'')||' '||p.name||' '||
    COALESCE(p.locator,'')||' '||COALESCE(p.catalogue_pn,'')||' '||COALESCE(p.inventory_pn,'')||' '||
    COALESCE((SELECT name FROM brand WHERE id=p.brand_id),'')||' '||
    COALESCE((SELECT group_concat(xref_number||' '||COALESCE(xref_brand,''),' ') FROM part_xref WHERE part_id=p.id),'')
  FROM part p WHERE p.id=NEW.part_id;
END;
CREATE TRIGGER xref_ad AFTER DELETE ON part_xref BEGIN
  DELETE FROM part_search WHERE part_id=OLD.part_id;
  INSERT INTO part_search(part_id, body)
  SELECT p.id, p.sku||' '||COALESCE(p.mpn,'')||' '||p.name||' '||
    COALESCE(p.locator,'')||' '||COALESCE(p.catalogue_pn,'')||' '||COALESCE(p.inventory_pn,'')||' '||
    COALESCE((SELECT name FROM brand WHERE id=p.brand_id),'')||' '||
    COALESCE((SELECT group_concat(xref_number||' '||COALESCE(xref_brand,''),' ') FROM part_xref WHERE part_id=p.id),'')
  FROM part p WHERE p.id=OLD.part_id;
END;

-- back-fill the search index for any rows that already exist
DELETE FROM part_search;
INSERT INTO part_search(part_id, body)
SELECT p.id, p.sku||' '||COALESCE(p.mpn,'')||' '||p.name||' '||
  COALESCE(p.locator,'')||' '||COALESCE(p.catalogue_pn,'')||' '||COALESCE(p.inventory_pn,'')||' '||
  COALESCE((SELECT name FROM brand WHERE id=p.brand_id),'')||' '||
  COALESCE((SELECT group_concat(xref_number||' '||COALESCE(xref_brand,''),' ') FROM part_xref WHERE part_id=p.id),'')
FROM part p;

-- ── 7. One-stop detail view for the Part card (sales / admin / stock-take) ───
CREATE VIEW part_detail AS
SELECT
  p.id, p.sku, p.locator, p.name, p.description, p.side,
  p.make, p.model, p.drawing_no, p.diagram_item_no,
  p.catalogue_pn, p.inventory_pn, p.mpn,
  c.code  AS category_code, c.name AS category_name,
  p.status,
  COALESCE((SELECT SUM(delta) FROM stock_movement WHERE part_id=p.id),0) AS qty_on_hand,
  (SELECT path     FROM part_image WHERE part_id=p.id AND deleted_at IS NULL
                   ORDER BY is_primary DESC, sort_order LIMIT 1)           AS primary_image,
  (SELECT glb_path FROM part_model WHERE part_id=p.id AND deleted_at IS NULL LIMIT 1) AS model_3d,
  (SELECT d.image_path FROM part_diagram_callout pdc
     JOIN diagram d ON d.id=pdc.diagram_id
     WHERE pdc.part_id=p.id ORDER BY pdc.is_primary DESC LIMIT 1)          AS diagram_image,
  (SELECT pdc.item_no FROM part_diagram_callout pdc
     WHERE pdc.part_id=p.id ORDER BY pdc.is_primary DESC LIMIT 1)          AS diagram_item
FROM part p
JOIN category c ON c.id = p.category_id
WHERE p.deleted_at IS NULL;
