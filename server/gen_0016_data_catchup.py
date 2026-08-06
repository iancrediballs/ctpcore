#!/usr/bin/env python3
"""
Generate server/0016_data_catchup.sql — the Postgres transcription of the
SQLite data changes in migrations 0010, 0012 and 0013.

Reads the migration files as the single source of truth so the output can be
regenerated and diffed rather than trusted. Run from the repo root:

    python server/gen_0016_data_catchup.py > server/0016_data_catchup.sql
"""
import re, sys, os

HERE = os.path.dirname(os.path.abspath(__file__))
MIG = os.environ.get("CTP_MIGRATIONS") or os.path.join(HERE, "..", "app", "src-tauri", "migrations")

def read(name):
    with open(os.path.join(MIG, name), encoding="utf-8") as f:
        return f.read()

m0010 = read("0010_section_diagrams.sql")
m0013 = read("0013_pricing_reset.sql")

# ---- 0010: diagram_ref ------------------------------------------------------
diagram_refs = re.findall(
    r"^UPDATE part SET diagram_ref='([^']*)' WHERE id=(\d+);", m0010, re.M)

# ---- 0013: part_cost --------------------------------------------------------
costs = re.findall(
    r"^INSERT INTO part_cost\(part_id,currency,amount_minor,valid_from,source\) "
    r"SELECT (\d+),'([A-Z]{3})',(\d+),'([\d-]+)','([^']*)' "
    r"WHERE EXISTS\(SELECT 1 FROM part WHERE id=\d+\);(.*)$", m0013, re.M)

# ---- 0013: part.list_price_minor -------------------------------------------
list_prices = re.findall(
    r"^UPDATE part SET list_price_minor=(\d+) WHERE id=(\d+);(.*)$", m0013, re.M)

# ---- 0013: price rows -------------------------------------------------------
prices = re.findall(
    r"^INSERT INTO price\(part_id,tier,currency,amount_minor,valid_from\) "
    r"SELECT (\d+),'([a-z]+)','([A-Z]{3})',(\d+),'([\d-]+)' "
    r"WHERE EXISTS\(SELECT 1 FROM part WHERE id=\d+\);", m0013, re.M)

# ---- 0013: price_tier seed --------------------------------------------------
tier_block = re.search(
    r"INSERT OR IGNORE INTO price_tier\(code,name,discount_bps,min_margin_bps\) VALUES\s*(.*?);",
    m0013, re.S)
tiers = re.findall(r"\('([^']+)',\s*'([^']+)',\s*(\d+),\s*(\d+)\)", tier_block.group(1))

EXPECT = {"diagram_ref": 122, "part_cost": 159, "list_price": 115, "price": 115, "tier": 3}
got = {"diagram_ref": len(diagram_refs), "part_cost": len(costs),
       "list_price": len(list_prices), "price": len(prices), "tier": len(tiers)}
if got != EXPECT:
    sys.exit(f"FATAL: parsed counts {got} != expected {EXPECT}")

out = []
w = out.append

w("""-- ============================================================================
--  CTP Core - migration 0016: data catch-up for the cloud Postgres
--
--  The Supabase copy was seeded on 2026-06-30 from SQLite at migration 0009.
--  Migration 0014 brought the SCHEMA up to 0013. This brings the DATA up to
--  0013 by replaying the three migrations that changed rows:
--
--    0010  section diagrams  -> part.diagram_ref on 122 parts
--    0012  retire seed parts -> remove the 12 FV-* FleetView demo parts
--    0013  pricing reset     -> cost out of `price` into `part_cost`,
--                               real list prices in, price_tier seeded
--
--  WHY THIS MATTERS: until it runs, all 334 tier='list' rows in Postgres hold
--  landed COST tagged as a selling price. Anything quoting off this database
--  sells at cost. Do not point a phone or a public surface at it until this
--  has been applied.
--
--  GENERATED FILE - do not hand-edit. Regenerate with:
--      python server/gen_0016_data_catchup.py > server/0016_data_catchup.sql
--  Source of truth: app/src-tauri/migrations/0010, 0012, 0013.
--
--  NOT ported on purpose: the part_search FTS5 table and the part_au trigger
--  (SQLite-only, not replicated by PowerSync - the web build rebuilds its own
--  index client-side), and the CREATE TABLE / CREATE VIEW statements from 0013
--  (already applied by 0014).
--
--  Order: run AFTER 0015_data_api_grants.sql.
--  Idempotent: safe to re-run. Wrapped in one transaction - all or nothing.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Pre-flight. Fail loudly rather than half-apply against the wrong shape.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.part_cost')  IS NULL THEN RAISE EXCEPTION 'part_cost missing - apply 0014 first'; END IF;
  IF to_regclass('public.price_tier') IS NULL THEN RAISE EXCEPTION 'price_tier missing - apply 0014 first'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='part' AND column_name='diagram_ref')
    THEN RAISE EXCEPTION 'part.diagram_ref missing - apply 0014 first'; END IF;
END $$;
""")

# ---------------------------------------------------------------------------
w("""
-- ===========================================================================
-- 1. From 0010 - the part panel's diagram is its category section view, and
--    diagram_ref is the balloon number to highlight on it. 122 parts.
-- ===========================================================================""")
for ref, pid in diagram_refs:
    w(f"UPDATE part SET diagram_ref='{ref}' WHERE id={pid};")

# ---------------------------------------------------------------------------
w("""
-- ===========================================================================
-- 2. From 0012 - retire the 12 FV-* FleetView demo parts.
--
--    Identified by the SKU prefix the 0002 seed gave them. The SQLite original
--    used a TEMP table; here the predicate is inlined, because a temp table
--    that dies between statements silently matches nothing and this migration
--    would then report success while changing not one row.
--
--    Parts already written onto a sales line are SOFT deleted - an invoice
--    must keep resolving to the line it was raised against. The rest go.
--    (As of 2026-08-06 no FV-* part is on a line, so all 12 hard delete;
--    the rule stays in the SQL so it is still correct if that changes.)
-- ===========================================================================

-- children first, while the parts still exist
DELETE FROM stock_movement WHERE part_id IN (SELECT id FROM part WHERE sku LIKE 'FV-%');
DELETE FROM price          WHERE part_id IN (SELECT id FROM part WHERE sku LIKE 'FV-%');
DELETE FROM stock_policy   WHERE part_id IN (SELECT id FROM part WHERE sku LIKE 'FV-%');
DELETE FROM part_xref      WHERE part_id IN (SELECT id FROM part WHERE sku LIKE 'FV-%');
DELETE FROM part_fitment   WHERE part_id IN (SELECT id FROM part WHERE sku LIKE 'FV-%');

-- on a sales line -> keep the row, mark it gone
UPDATE part
   SET deleted_at = now(),
       status     = 'discontinued'
 WHERE sku LIKE 'FV-%'
   AND deleted_at IS NULL
   AND id IN (SELECT part_id FROM sales_line);

-- never sold -> remove entirely
DELETE FROM part
 WHERE sku LIKE 'FV-%'
   AND id NOT IN (SELECT part_id FROM sales_line);

-- sweep up reference rows the demo parts were the only users of
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
""")

# ---------------------------------------------------------------------------
w("""
-- ===========================================================================
-- 3. From 0013 - the pricing reset.
--
--    3a. discount tiers, seeded at zero so behaviour is "charge list" until
--        real numbers are set. min_margin_bps is the floor a trade discount
--        may not cut through.
-- ===========================================================================""")
vals = ",\n  ".join(f"('{c}','{n}',{d},{m})" for c, n, d, m in tiers)
w(f"INSERT INTO price_tier(code,name,discount_bps,min_margin_bps) VALUES\n  {vals}\nON CONFLICT (code) DO NOTHING;")

w("""
--    3b. Evict cost from the price table. Every tier='list' row currently in
--        Postgres is landed cost wearing a list-price label; they come back
--        below as part_cost, and tier='list' is repopulated with real prices.
DELETE FROM price WHERE tier='list';

--    3c. Official landed cost, ZAR, from the Item Cost Price List. 159 parts.
--        Re-runnable: the same shipment date is cleared first.
DELETE FROM part_cost WHERE valid_from = TIMESTAMPTZ '2026-07-30';""")
for pid, cur, amt, vf, src, comment in costs:
    c = comment.strip()
    tail = f"  {c}" if c else ""
    w(f"INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) "
      f"SELECT {pid},'{cur}',{amt},TIMESTAMPTZ '{vf}','{src}' "
      f"WHERE EXISTS(SELECT 1 FROM part WHERE id={pid}) "
      f"ON CONFLICT (part_id,currency,valid_from) DO NOTHING;{tail}")

w("""
--    3d. The real list price, re-keyed on Item Code. 115 parts. Written to
--        both places the app reads it: part.list_price_minor for the panel and
--        price(tier='list') for order pricing. Parts absent from the Item
--        Price List are left NULL on purpose - better an empty field than a
--        number nobody chose.
UPDATE part SET list_price_minor = NULL WHERE id BETWEEN 1001 AND 1200;""")
for amt, pid, comment in list_prices:
    c = comment.strip()
    tail = f"  {c}" if c else ""
    w(f"UPDATE part SET list_price_minor={amt} WHERE id={pid};{tail}")

w("")
for pid, tier, cur, amt, vf in prices:
    w(f"INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) "
      f"SELECT {pid},'{tier}','{cur}',{amt},TIMESTAMPTZ '{vf}' "
      f"WHERE EXISTS(SELECT 1 FROM part WHERE id={pid}) "
      f"ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;")

# ---------------------------------------------------------------------------
w(f"""
-- ===========================================================================
-- 4. Verify before committing. Any mismatch aborts the whole migration.
-- ===========================================================================
DO $$
DECLARE
  n_fv       INT;
  n_ref      INT;
  n_cost     INT;
  n_list     INT;
  n_lp       INT;
  n_tier     INT;
  n_below    INT;
BEGIN
  SELECT count(*) INTO n_fv   FROM part WHERE sku LIKE 'FV-%' AND deleted_at IS NULL;
  SELECT count(*) INTO n_ref  FROM part WHERE diagram_ref IS NOT NULL;
  SELECT count(*) INTO n_cost FROM part_cost WHERE valid_from = TIMESTAMPTZ '2026-07-30';
  SELECT count(*) INTO n_list FROM price WHERE tier = 'list';
  SELECT count(*) INTO n_lp   FROM part WHERE list_price_minor IS NOT NULL;
  SELECT count(*) INTO n_tier FROM price_tier;

  IF n_fv   <> 0   THEN RAISE EXCEPTION 'FV-%% demo parts still live: %', n_fv; END IF;
  IF n_ref  <> {len(diagram_refs)} THEN RAISE EXCEPTION 'diagram_ref count is %, expected {len(diagram_refs)}', n_ref; END IF;
  IF n_cost <> {len(costs)} THEN RAISE EXCEPTION 'part_cost count is %, expected {len(costs)}', n_cost; END IF;
  IF n_list <> {len(prices)} THEN RAISE EXCEPTION 'price(list) count is %, expected {len(prices)}', n_list; END IF;
  IF n_lp   <> {len(list_prices)} THEN RAISE EXCEPTION 'list_price_minor count is %, expected {len(list_prices)}', n_lp; END IF;
  IF n_tier <  {len(tiers)} THEN RAISE EXCEPTION 'price_tier count is %, expected at least {len(tiers)}', n_tier; END IF;

  -- the whole point of the exercise: no list price may sit at or under cost
  SELECT count(*) INTO n_below
    FROM price pr
    JOIN part_cost pc ON pc.part_id = pr.part_id AND pc.currency = pr.currency
   WHERE pr.tier = 'list' AND pr.amount_minor <= pc.amount_minor;
  IF n_below > 0 THEN
    RAISE WARNING 'REVIEW: % list prices are at or below landed cost', n_below;
  END IF;

  RAISE NOTICE '0016 OK - % diagram_refs, % costs, % list prices, % tiers, 0 demo parts',
               n_ref, n_cost, n_list, n_tier;
END $$;

COMMIT;
""")

sys.stdout.write("\n".join(out) + "\n")
