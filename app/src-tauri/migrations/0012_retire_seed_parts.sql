-- ============================================================================
--  CTP Core — retire the FleetView Phase-0 demo catalogue.
--
--  0002_seed.sql shipped 12 invented parts (FV-*) with invented stock, prices,
--  cross-references and fitments, plus the categories, brands and vehicle
--  models that supported them. They were scaffolding for the very first search
--  demo and they have been sitting alongside the real JH6 catalogue ever since.
--  None of it describes anything on Ian's shelves.
--
--  This migration removes them, and repairs a real bug found on the way in:
--  the part_au trigger re-indexed every UPDATE unconditionally, so a
--  soft-deleted part stayed searchable forever.
-- ============================================================================
PRAGMA foreign_keys = ON;

-- --------------------------------------------------------------------------
-- 1. Soft delete must actually remove a part from the search index.
--    Without the deleted_at guard below, "deleting" a part hid it from every
--    list while leaving it live at the counter search box — the worst of both.
-- --------------------------------------------------------------------------
DROP TRIGGER IF EXISTS part_au;
CREATE TRIGGER part_au AFTER UPDATE ON part BEGIN
  DELETE FROM part_search WHERE part_id = NEW.id;
  INSERT INTO part_search(part_id, body)
  SELECT NEW.id,
    NEW.sku||' '||COALESCE(NEW.mpn,'')||' '||NEW.name||' '||
    COALESCE(NEW.locator,'')||' '||COALESCE(NEW.catalogue_pn,'')||' '||COALESCE(NEW.inventory_pn,'')||' '||
    COALESCE((SELECT name FROM brand WHERE id=NEW.brand_id),'')||' '||
    COALESCE((SELECT group_concat(xref_number||' '||COALESCE(xref_brand,''),' ') FROM part_xref WHERE part_id=NEW.id),'')
  WHERE NEW.deleted_at IS NULL;
END;

-- --------------------------------------------------------------------------
-- 2. Identify the demo parts once, by the SKU prefix the seed gave them.
-- --------------------------------------------------------------------------
CREATE TEMP TABLE seed_part AS
SELECT id FROM part WHERE sku LIKE 'FV-%';

-- --------------------------------------------------------------------------
-- 3. Drop the fake ledger. stock_movement has no ON DELETE CASCADE — the
--    append-only ledger is deliberately hard to touch — so these rows go
--    explicitly. They are safe to remove precisely because they never recorded
--    a real receipt: no stock ever moved.
-- --------------------------------------------------------------------------
DELETE FROM stock_movement WHERE part_id IN (SELECT id FROM seed_part);

-- Everything else hanging off these parts cascades, but be explicit so this
-- migration reads as a complete statement of what is being removed.
DELETE FROM price         WHERE part_id IN (SELECT id FROM seed_part);
DELETE FROM stock_policy  WHERE part_id IN (SELECT id FROM seed_part);
DELETE FROM part_xref     WHERE part_id IN (SELECT id FROM seed_part);
DELETE FROM part_fitment  WHERE part_id IN (SELECT id FROM seed_part);
DELETE FROM part_search   WHERE part_id IN (SELECT id FROM seed_part);

-- --------------------------------------------------------------------------
-- 4. Remove the parts themselves.
--    Anything already written onto a sales order is soft-deleted instead —
--    an invoice must keep resolving to the line it was raised against, even
--    for a part that should never have existed.
-- --------------------------------------------------------------------------
UPDATE part
   SET deleted_at = datetime('now'),
       status     = 'discontinued'
 WHERE id IN (SELECT id FROM seed_part)
   AND id IN (SELECT part_id FROM sales_line);

DELETE FROM part
 WHERE id IN (SELECT id FROM seed_part)
   AND id NOT IN (SELECT part_id FROM sales_line);

-- --------------------------------------------------------------------------
-- 5. Sweep up what the demo parts were the only users of. Categories, brands
--    and vehicle models are only removed when nothing real still points at
--    them, so the JH6 catalogue is untouched.
-- --------------------------------------------------------------------------
DELETE FROM vehicle_model
 WHERE id NOT IN (SELECT vehicle_id FROM part_fitment)
   AND (make, model) IN (VALUES ('Sinotruk','HOWO A7'),('Sinotruk','HOWO T7H'),
                                ('Shacman','X3000'),('FAW','J6'),('Dongfeng','KL'));

DELETE FROM brand
 WHERE id NOT IN (SELECT brand_id FROM part WHERE brand_id IS NOT NULL)
   AND code IN ('BOSCH','MANN','FLG','KNORR','SACHS','HOLSET','SINO','WEICHAI');

DELETE FROM category
 WHERE id NOT IN (SELECT category_id FROM part)
   AND id NOT IN (SELECT parent_id FROM category WHERE parent_id IS NOT NULL)
   AND code IN ('FILT','FUEL','BRAKE','ENG','DRV','ELEC','COOL');

DROP TABLE seed_part;

-- --------------------------------------------------------------------------
-- 6. Rebuild the search index from what is actually left and live.
-- --------------------------------------------------------------------------
DELETE FROM part_search;
INSERT INTO part_search(part_id, body)
SELECT p.id,
  p.sku||' '||COALESCE(p.mpn,'')||' '||p.name||' '||
  COALESCE(p.locator,'')||' '||COALESCE(p.catalogue_pn,'')||' '||COALESCE(p.inventory_pn,'')||' '||
  COALESCE((SELECT name FROM brand WHERE id=p.brand_id),'')||' '||
  COALESCE((SELECT group_concat(xref_number||' '||COALESCE(xref_brand,''),' ') FROM part_xref WHERE part_id=p.id),'')
FROM part p
WHERE p.deleted_at IS NULL;
