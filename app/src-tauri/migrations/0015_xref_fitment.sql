-- ============================================================================
--  CTP Core — CROSS-REFERENCE & FITMENT (migration 0015)
--
--  The cloud database got these rows in migration 0027. This is the same fact
--  set for the desktop's local database, so the two do not hold different
--  answers to the same question. Divergence between them is the kind of thing
--  that stays invisible until the day someone compares a screen to a phone.
--
--  Both tables DO already contain rows — but only for the demo parts that
--  0002_seed created and 0012 later retired. The 161 real JH6 parts loaded by
--  0007 have never had a single cross-reference or fitment record.
--
--  Nothing here is invented. Every row derives from a column 0007 already set
--  on the part:
--     catalogue_pn   the number in the FAW parts catalogue
--     inventory_pn   our stock number, carrying grade suffixes (-DQ, -G) the
--                    catalogue number does not
--
--  xref_type is constrained to oem/aftermarket/competitor/supersession, and
--  only one is honestly true: catalogue_pn IS the manufacturer's own number, so
--  it goes in as 'oem'. Our inventory_pn is not an aftermarket or competitor
--  number and is NOT forced into one of those buckets to make it fit; where it
--  differs from the catalogue number it is recorded as a supersession, which is
--  the one label that genuinely describes the relationship.
--
--  Worth knowing: 0006 already puts catalogue_pn and inventory_pn into the FTS
--  body, so those numbers were already findable. What these rows add is the
--  same data the cloud holds, and a cleaner "matched on" explanation at the
--  counter. Inserting into part_xref fires the xref_ai trigger, which rebuilds
--  that part's search row — so the index stays correct with no extra step.
--
--  Idempotent: INSERT OR IGNORE against UNIQUE(part_id, xref_number, xref_type)
--  and against part_fitment's primary key.
-- ============================================================================
PRAGMA foreign_keys = ON;

-- ── the manufacturer's own catalogue number ───────────────────────────────
INSERT OR IGNORE INTO part_xref (part_id, xref_number, xref_brand, xref_type, confidence)
SELECT p.id, p.catalogue_pn, 'FAW', 'oem', 100
  FROM part p
 WHERE p.deleted_at IS NULL
   AND COALESCE(p.catalogue_pn,'') <> ''
   AND p.catalogue_pn IS NOT p.sku;

-- ── our stock number, where it differs from the catalogue ─────────────────
INSERT OR IGNORE INTO part_xref (part_id, xref_number, xref_brand, xref_type, confidence)
SELECT p.id, p.inventory_pn, 'CTP', 'supersession', 90
  FROM part p
 WHERE p.deleted_at IS NULL
   AND COALESCE(p.inventory_pn,'') <> ''
   AND p.inventory_pn IS NOT p.sku
   AND p.inventory_pn IS NOT p.catalogue_pn;

-- ── fitment ───────────────────────────────────────────────────────────────
-- Every part in this catalogue is a FAW JH6 part; that is what the business
-- imports and warehouses. vehicle_model id 10 is the JH6 row created by 0007.
-- Year and engine are left at their defaults rather than guessed — engine is
-- NOT NULL DEFAULT '' here, and a fabricated year range is worse than none,
-- because that is the field a customer trusts to decide a part fits.
INSERT OR IGNORE INTO part_fitment (part_id, vehicle_id, engine, note)
SELECT p.id, v.id, '', 'FAW JH6 range; specific variant not yet differentiated'
  FROM part p
  JOIN vehicle_model v ON v.make = 'FAW' AND v.model = 'JH6'
 WHERE p.deleted_at IS NULL;
