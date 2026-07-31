-- Verification for migration 0013. Run against the app DB after first launch.
-- Expected results are in the comments.

-- 115 parts carry a list price (the Item Price List has 114 priced codes; 115
-- app parts map onto them because two share a code).
SELECT COUNT(*) AS parts_with_list_price
  FROM part WHERE list_price_minor IS NOT NULL AND deleted_at IS NULL;

-- 159 of the 161 parts have a landed cost. The two without are Cab Weld Assembly
-- and Roof Deflector L/H Support Tube Assembly, which have no Item Code match.
SELECT COUNT(*) AS parts_with_landed_cost FROM part_cost WHERE currency='ZAR';

-- 0 — cost must no longer be sitting in the price table.
SELECT COUNT(*) AS cost_still_in_price_table FROM price WHERE currency='USD';

-- 0 rows — nothing may list below its own landed cost.
SELECT p.sku, p.name, p.list_price_minor, c.amount_minor AS cost_minor
  FROM part p JOIN part_cost c ON c.part_id = p.id AND c.currency='ZAR'
 WHERE p.deleted_at IS NULL AND p.list_price_minor IS NOT NULL
   AND p.list_price_minor < c.amount_minor;

-- 0 — every customer's tier must resolve to a price_tier row.
SELECT COUNT(*) AS customers_with_unknown_tier
  FROM customer c LEFT JOIN price_tier t ON t.code = c.price_tier
 WHERE t.code IS NULL;

-- The 46 parts deliberately left unpriced, awaiting sign-off on the proposals.
SELECT id, sku, name FROM part
 WHERE deleted_at IS NULL AND list_price_minor IS NULL ORDER BY id;

-- Sanity: three prices you can check against the Item Price List by eye.
--   Front Bumper L/H          636062  (R6,360.62)
--   Front Bumper L/H Spoiler  107467  (R1,074.67)
--   Bumper L/H Bracket Asm    285641  (R2,856.41)
SELECT inventory_pn, name, list_price_minor FROM part
 WHERE inventory_pn IN ('2803035B1063-DQ','2803721B1063-G','2803645B1063')
   AND deleted_at IS NULL;
