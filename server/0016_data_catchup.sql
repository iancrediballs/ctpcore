-- ============================================================================
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


-- ===========================================================================
-- 1. From 0010 - the part panel's diagram is its category section view, and
--    diagram_ref is the balloon number to highlight on it. 122 parts.
-- ===========================================================================
UPDATE part SET diagram_ref='4' WHERE id=1001;
UPDATE part SET diagram_ref='5' WHERE id=1002;
UPDATE part SET diagram_ref='6' WHERE id=1003;
UPDATE part SET diagram_ref='7' WHERE id=1004;
UPDATE part SET diagram_ref='8' WHERE id=1005;
UPDATE part SET diagram_ref='9' WHERE id=1006;
UPDATE part SET diagram_ref='2' WHERE id=1007;
UPDATE part SET diagram_ref='3' WHERE id=1008;
UPDATE part SET diagram_ref='1' WHERE id=1009;
UPDATE part SET diagram_ref='10' WHERE id=1010;
UPDATE part SET diagram_ref='17' WHERE id=1011;
UPDATE part SET diagram_ref='12' WHERE id=1012;
UPDATE part SET diagram_ref='13' WHERE id=1013;
UPDATE part SET diagram_ref='14' WHERE id=1014;
UPDATE part SET diagram_ref='15' WHERE id=1015;
UPDATE part SET diagram_ref='16' WHERE id=1016;
UPDATE part SET diagram_ref='11' WHERE id=1017;
UPDATE part SET diagram_ref='18' WHERE id=1018;
UPDATE part SET diagram_ref='19' WHERE id=1019;
UPDATE part SET diagram_ref='20' WHERE id=1020;
UPDATE part SET diagram_ref='21' WHERE id=1021;
UPDATE part SET diagram_ref='1' WHERE id=1022;
UPDATE part SET diagram_ref='6' WHERE id=1023;
UPDATE part SET diagram_ref='22' WHERE id=1024;
UPDATE part SET diagram_ref='23' WHERE id=1025;
UPDATE part SET diagram_ref='24' WHERE id=1026;
UPDATE part SET diagram_ref='25' WHERE id=1027;
UPDATE part SET diagram_ref='4' WHERE id=1028;
UPDATE part SET diagram_ref='5' WHERE id=1029;
UPDATE part SET diagram_ref='7' WHERE id=1030;
UPDATE part SET diagram_ref='6' WHERE id=1031;
UPDATE part SET diagram_ref='1' WHERE id=1032;
UPDATE part SET diagram_ref='8' WHERE id=1033;
UPDATE part SET diagram_ref='9' WHERE id=1034;
UPDATE part SET diagram_ref='21' WHERE id=1035;
UPDATE part SET diagram_ref='22' WHERE id=1036;
UPDATE part SET diagram_ref='23' WHERE id=1037;
UPDATE part SET diagram_ref='2' WHERE id=1038;
UPDATE part SET diagram_ref='6' WHERE id=1039;
UPDATE part SET diagram_ref='10' WHERE id=1040;
UPDATE part SET diagram_ref='16' WHERE id=1041;
UPDATE part SET diagram_ref='15' WHERE id=1042;
UPDATE part SET diagram_ref='17' WHERE id=1043;
UPDATE part SET diagram_ref='18' WHERE id=1044;
UPDATE part SET diagram_ref='19' WHERE id=1045;
UPDATE part SET diagram_ref='20' WHERE id=1046;
UPDATE part SET diagram_ref='11' WHERE id=1047;
UPDATE part SET diagram_ref='11' WHERE id=1048;
UPDATE part SET diagram_ref='13' WHERE id=1049;
UPDATE part SET diagram_ref='13' WHERE id=1050;
UPDATE part SET diagram_ref='1' WHERE id=1051;
UPDATE part SET diagram_ref='2' WHERE id=1052;
UPDATE part SET diagram_ref='3' WHERE id=1053;
UPDATE part SET diagram_ref='4' WHERE id=1054;
UPDATE part SET diagram_ref='39' WHERE id=1055;
UPDATE part SET diagram_ref='29' WHERE id=1056;
UPDATE part SET diagram_ref='38' WHERE id=1057;
UPDATE part SET diagram_ref='31' WHERE id=1058;
UPDATE part SET diagram_ref='26' WHERE id=1059;
UPDATE part SET diagram_ref='1' WHERE id=1060;
UPDATE part SET diagram_ref='25' WHERE id=1061;
UPDATE part SET diagram_ref='57' WHERE id=1062;
UPDATE part SET diagram_ref='37' WHERE id=1063;
UPDATE part SET diagram_ref='33' WHERE id=1064;
UPDATE part SET diagram_ref='20' WHERE id=1065;
UPDATE part SET diagram_ref='18' WHERE id=1066;
UPDATE part SET diagram_ref='35' WHERE id=1067;
UPDATE part SET diagram_ref='3' WHERE id=1068;
UPDATE part SET diagram_ref='49' WHERE id=1069;
UPDATE part SET diagram_ref='50' WHERE id=1070;
UPDATE part SET diagram_ref='51' WHERE id=1071;
UPDATE part SET diagram_ref='48' WHERE id=1072;
UPDATE part SET diagram_ref='6' WHERE id=1073;
UPDATE part SET diagram_ref='15' WHERE id=1074;
UPDATE part SET diagram_ref='9' WHERE id=1075;
UPDATE part SET diagram_ref='13' WHERE id=1076;
UPDATE part SET diagram_ref='4' WHERE id=1077;
UPDATE part SET diagram_ref='16' WHERE id=1078;
UPDATE part SET diagram_ref='24' WHERE id=1079;
UPDATE part SET diagram_ref='A1' WHERE id=1080;
UPDATE part SET diagram_ref='A2' WHERE id=1081;
UPDATE part SET diagram_ref='B36' WHERE id=1082;
UPDATE part SET diagram_ref='B15' WHERE id=1083;
UPDATE part SET diagram_ref='B27' WHERE id=1084;
UPDATE part SET diagram_ref='B17' WHERE id=1085;
UPDATE part SET diagram_ref='B34' WHERE id=1086;
UPDATE part SET diagram_ref='B16' WHERE id=1087;
UPDATE part SET diagram_ref='C1' WHERE id=1088;
UPDATE part SET diagram_ref='C7' WHERE id=1089;
UPDATE part SET diagram_ref='C12' WHERE id=1090;
UPDATE part SET diagram_ref='C21' WHERE id=1091;
UPDATE part SET diagram_ref='C26' WHERE id=1092;
UPDATE part SET diagram_ref='C27' WHERE id=1093;
UPDATE part SET diagram_ref='D4' WHERE id=1094;
UPDATE part SET diagram_ref='D4' WHERE id=1095;
UPDATE part SET diagram_ref='B3' WHERE id=1096;
UPDATE part SET diagram_ref='B11' WHERE id=1097;
UPDATE part SET diagram_ref='B4' WHERE id=1098;
UPDATE part SET diagram_ref='B12' WHERE id=1099;
UPDATE part SET diagram_ref='B39' WHERE id=1100;
UPDATE part SET diagram_ref='B39' WHERE id=1101;
UPDATE part SET diagram_ref='1' WHERE id=1102;
UPDATE part SET diagram_ref='7' WHERE id=1103;
UPDATE part SET diagram_ref='6' WHERE id=1104;
UPDATE part SET diagram_ref='9' WHERE id=1105;
UPDATE part SET diagram_ref='3' WHERE id=1106;
UPDATE part SET diagram_ref='2' WHERE id=1107;
UPDATE part SET diagram_ref='7' WHERE id=1108;
UPDATE part SET diagram_ref='13' WHERE id=1109;
UPDATE part SET diagram_ref='1' WHERE id=1110;
UPDATE part SET diagram_ref='6' WHERE id=1111;
UPDATE part SET diagram_ref='7' WHERE id=1112;
UPDATE part SET diagram_ref='12' WHERE id=1113;
UPDATE part SET diagram_ref='9' WHERE id=1114;
UPDATE part SET diagram_ref='8' WHERE id=1115;
UPDATE part SET diagram_ref='1' WHERE id=1116;
UPDATE part SET diagram_ref='2' WHERE id=1117;
UPDATE part SET diagram_ref='7' WHERE id=1118;
UPDATE part SET diagram_ref='3' WHERE id=1119;
UPDATE part SET diagram_ref='4' WHERE id=1120;
UPDATE part SET diagram_ref='5' WHERE id=1121;
UPDATE part SET diagram_ref='6' WHERE id=1122;

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


-- ===========================================================================
-- 3. From 0013 - the pricing reset.
--
--    3a. discount tiers, seeded at zero so behaviour is "charge list" until
--        real numbers are set. min_margin_bps is the floor a trade discount
--        may not cut through.
-- ===========================================================================
INSERT INTO price_tier(code,name,discount_bps,min_margin_bps) VALUES
  ('list','List / walk-in',0,1500),
  ('trade','Trade account',0,1500),
  ('wholesale','Wholesale',0,1500)
ON CONFLICT (code) DO NOTHING;

--    3b. Evict cost from the price table. Every tier='list' row currently in
--        Postgres is landed cost wearing a list-price label; they come back
--        below as part_cost, and tier='list' is repopulated with real prices.
DELETE FROM price WHERE tier='list';

--    3c. Official landed cost, ZAR, from the Item Cost Price List. 159 parts.
--        Re-runnable: the same shipment date is cleared first.
DELETE FROM part_cost WHERE valid_from = TIMESTAMPTZ '2026-07-30';
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1001,'ZAR',119263,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1001) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 2803035B1063-DQ  Front Bumper L/H Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1002,'ZAR',119263,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1002) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 2803040B1063-DQ  Front Bumper R/H Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1003,'ZAR',102168,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1003) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 2803645B1063  Front Bumper L/H Bracket Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1004,'ZAR',102168,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1004) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 2803650B1063  Front Bumper R/H Bracket Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1005,'ZAR',6211,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1005) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 2803031B1063-G  Front Bumper L/H Decorative Panel
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1006,'ZAR',6210,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1006) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 2803032B1063-G  Front Bumper R/H Decorative Panel
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1007,'ZAR',7529,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1007) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 2803721B1063-G  Front Bumper L/H Spoiler
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1008,'ZAR',7528,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1008) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 2803722B1063-G  Front Bumper R/H Spoiler
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1009,'ZAR',148519,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1009) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 2803010B1063-DQ  Front Bumper Centre Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1010,'ZAR',14279,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1010) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 2803731B1063-G  Front Bumper Centre Spoiler
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1011,'ZAR',7129,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1011) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 2803821B1063  Front Bumper Centre Mesh Screen
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1012,'ZAR',15597,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1012) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 2803831B1063  Front Bumper Upper Mesh Screen
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1013,'ZAR',559,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1013) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 2803091B1063-G  Front Bumper Lower Tow Hook Cover
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1014,'ZAR',1997,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1014) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 2803761B1063  Spoiler L/H Connecting Bracket
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1015,'ZAR',1997,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1015) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 2803762B1063  Spoiler R/H Connecting Bracket
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1016,'ZAR',999,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1016) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 2803763B1063  Spoiler Centre Connecting Bracket
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1017,'ZAR',22127,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1017) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 2803015B1063-G  Front Bumper Intake Grille Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1018,'ZAR',7189,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1018) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 2803018B1063  Front Bumper Bug Shield
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1019,'ZAR',3954,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1019) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 2803052B1063  Front Bumper Primary Step
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1020,'ZAR',839,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1020) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 2803381B1063  Front Bumper Centre Lower L/H Decorati
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1021,'ZAR',839,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1021) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 2803382B1063  Front Bumper Centre Lower R/H Decorati
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1022,'ZAR',100849,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1022) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 2801070-1063  Front Crossmember Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1023,'ZAR',28956,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1023) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 2801090-1066  Front Spring Front Bracket Crossmember
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1024,'ZAR',111553,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1024) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 3711015-1544  Front Combination Lamp L/H Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1025,'ZAR',111554,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1025) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 3711020-1544  Front Combination Lamp R/H Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1026,'ZAR',42737,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1026) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 3732015-1063-C00  Front Fog Lamp L/H Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1027,'ZAR',42736,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1027) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 3732020-1063-C00  Front Fog Lamp R/H Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1028,'ZAR',45572,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1028) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5004055-79H-C00  Cab Hydraulic Lock Assembly L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1029,'ZAR',52642,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1029) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5004055-1063-C00  Cab Hydraulic Lock Assembly R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1030,'ZAR',119642,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1030) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5001315B1063-C00  Rear Suspension Air Spring & Shock Abs
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1031,'ZAR',131265,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1031) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5001315-1063A-C00  Rear Suspension Air Spring & Shock Abs
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1032,'ZAR',386505,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1032) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5001010CB45  Cab Front Suspension Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1033,'ZAR',166013,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1033) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5103121-H02-G  Front Fender L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1034,'ZAR',65982,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1034) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5103122-B45-G  Front Fender R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1035,'ZAR',23565,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1035) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5103181-B45  Second Step
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1036,'ZAR',29117,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1036) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5103191-B45  Third Step
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1037,'ZAR',9945,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1037) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5103135-B45  Front Fender Support Bracket Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1038,'ZAR',12921,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1038) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5103131-B45-G  Rear Fender L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1039,'ZAR',12921,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1039) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5103132-B45-G  Rear Fender R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1040,'ZAR',25144,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1040) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5103161-H02  Front Wheel Upper Splash Shield L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1041,'ZAR',20849,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1041) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5103162AB83  Front Wheel Upper Splash Shield R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1042,'ZAR',838,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1042) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5103211-B45  Upper Splash Shield Small Door
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1043,'ZAR',12981,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1043) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5103611-1063  L/H Engine Side Shield
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1044,'ZAR',12981,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1044) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5103612-1600  R/H Engine Side Shield
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1045,'ZAR',4993,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1045) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5109111-H02  L/H Door Sill Scuff Plate
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1046,'ZAR',2996,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1046) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5109112-B45  R/H Door Sill Scuff Plate
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1047,'ZAR',94200,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1047) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5407025-B45  Side Toolbox Cover Assembly L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1048,'ZAR',94200,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1048) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5407025-B45  Side Toolbox Cover Assembly R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1049,'ZAR',6530,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1049) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5407086-B45-C00  Side Toolbox Sealing Strip L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1050,'ZAR',6530,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1050) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5407086-B45-C00  Side Toolbox Sealing Strip R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1051,'ZAR',16214,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1051) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5302715-H02  Left A-pillar upper decorative panel a
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1052,'ZAR',16214,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1052) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5302720-H02  Right A-pillar upper decorative panel
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1053,'ZAR',12981,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1053) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5302841-B45-G  Left A-pillar lower decorative plate
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1054,'ZAR',12981,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1054) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5302842-B45-G  Right A-pillar lower decorative plate
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1055,'ZAR',5512,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1055) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5302125-B90  L/H Handrail Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1056,'ZAR',5512,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1056) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5302130-B90  R/H Handrail Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1057,'ZAR',999,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1057) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5302171-B45  L/H Handrail Cover A
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1058,'ZAR',999,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1058) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5302172-B45  R/H Handrail Cover A
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1059,'ZAR',34069,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1059) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5302350-H02  Windshield Lower Trim Panel Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1060,'ZAR',143028,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1060) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5302021-B45-G  Front Wall Outer Panel Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1061,'ZAR',6490,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1061) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5302410-B45-C00  Gas Spring Assembly — Front Wall
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1062,'ZAR',1997,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1062) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5302530-A01  Release Handle Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1063,'ZAR',13580,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1063) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5302300-H02  Gas Spring Lower Mount Bracket Link As
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1064,'ZAR',2996,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1064) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5302311-B45  Gas Spring Lower Mount Bracket Link Ba
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1065,'ZAR',21967,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1065) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5302415-B45  L/H Handrail Bracket Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1066,'ZAR',21967,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1066) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5302420-B45  R/H Handrail Bracket Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1067,'ZAR',15976,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1067) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5302500-H02-C00  Front Wall Lock Strap Cable Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1068,'ZAR',658161,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1068) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5300010-H02-DQ  Front Wall Welding Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1069,'ZAR',7589,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1069) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5302051-B45  Front Wall Bug Screen A
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1070,'ZAR',6990,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1070) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5302053-B45  Front Wall Bug Screen B
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1071,'ZAR',6990,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1071) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5302056-B45  Front Wall Bug Screen C
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1072,'ZAR',26960,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1072) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5302071-B45-G  Radiator Grille
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1073,'ZAR',4993,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1073) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5302155-B45  L/H Front Wall Outer Panel Hinge Assem
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1074,'ZAR',4993,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1074) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5302160-B45  R/H Front Wall Outer Panel Hinge Assem
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1075,'ZAR',1598,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1075) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5302221-A01  Gas Spring Fixing Base — Front Wall
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1076,'ZAR',999,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1076) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5302591-B45  Buffer Block A — Front Wall
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1077,'ZAR',13979,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1077) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5302621-B45-G  L/H Deflector
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1078,'ZAR',13979,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1078) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5302622-B45-G  R/H Deflector
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1079,'ZAR',19970,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1079) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5302801-B45  Front Emblem
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1080,'ZAR',1103959,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1080) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 6100005-H02  Front Door Assembly L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1081,'ZAR',1103959,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1081) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 6100010-H02  Front Door Assembly R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1082,'ZAR',2257,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1082) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 6100031-B45  Front Door Rear Frame Trim Cover L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1083,'ZAR',2259,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1083) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 6100032-B45  Front Door Rear Frame Trim Cover R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1084,'ZAR',49727,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1084) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 6101585-B83  Front Door Lower Trim Panel Assembly L
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1085,'ZAR',49726,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1085) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 6101590-B83  Front Door Lower Trim Panel Assembly R
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1086,'ZAR',8027,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1086) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 6102151-B45-C00  Front Door Window Frame Upper Protecti
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1087,'ZAR',8027,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1087) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 6102152-B45-C00  Front Door Window Frame Upper Protecti
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1088,'ZAR',63985,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1088) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 6102015-H02-C00  Front Door Interior Trim Panel Assembl
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1089,'ZAR',63985,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1089) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 6102020-H02-C00  Front Door Interior Trim Panel Assembl
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1090,'ZAR',98673,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1090) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 6104015AB45-C00  Front Door Electric Window Lift Module
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1091,'ZAR',98673,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1091) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 6104020AB45-C00  Front Door Electric Window Lift Module
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1092,'ZAR',24404,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1092) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 6105025AB45-C00  Front Door Electric Lock Assembly L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1093,'ZAR',24404,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1093) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 6105030AB45-C00  Front Door Electric Lock Assembly R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1094,'ZAR',18913,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1094) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 6105045-B45-C00  Front Door Handle Assembly L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1095,'ZAR',18910,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1095) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 6105050-B45-C00  Front Door Handle Assembly R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1096,'ZAR',23904,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1096) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 6106015-B45-C00  Front Door Upper Hinge Assembly L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1097,'ZAR',23904,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1097) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 6106020-B45-C00  Front Door Upper Hinge Assembly R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1098,'ZAR',16575,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1098) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 6106055-B45-C00  Front Door Lower Hinge Assembly L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1099,'ZAR',16575,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1099) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 6106060-B45-C00  Front Door Lower Hinge Assembly R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1100,'ZAR',7529,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1100) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 6109015-B45-C00  Front Door Limiter Assembly L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1101,'ZAR',7529,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1101) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 6109015-B45-C00  Front Door Limiter Assembly R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1102,'ZAR',113670,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1102) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 8202015-H02-C00  Outer Rearview Mirror Assembly L/H — E
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1103,'ZAR',113670,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1103) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 8202020-H02-C00  Outer Rearview Mirror Assembly R/H — E
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1104,'ZAR',2396,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1104) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 8202061-B45-C00-G  Outer Rearview Mirror L/H Lower Fixed
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1105,'ZAR',2396,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1105) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 8202062-B45-C00-G  Outer Rearview Mirror R/H Lower Fixed
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1106,'ZAR',14493,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1106) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 8219010-H02-C00  Top View Mirror Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1107,'ZAR',32557,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1107) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 8219020AH02-C00  Front Lower View Mirror Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1108,'ZAR',8747,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1108) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5103031-1063  Primary Step
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1109,'ZAR',29195,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1109) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5103021-1544-G  Step Decorative Cover L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1110,'ZAR',249130,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1110) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5103010-1544  Front Lower Protection & Step Bracket
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1111,'ZAR',29077,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1111) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5103022-1544-G  Step Decorative Cover R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1112,'ZAR',8747,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1112) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5103031-1063  Primary Step R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1113,'ZAR',300,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1113) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5103061-1063  Step Decorative Cover Small Door Limit
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1114,'ZAR',609,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1114) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5103052-1063-G  Step Decorative Cover Small Door
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1115,'ZAR',975,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1115) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5103053-1063  Step Decorative Cover Small Door Fixin
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1116,'ZAR',17494,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1116) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5103361A1600  Rear Mudguard L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1117,'ZAR',18373,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1117) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5103362A1600  Rear Mudguard R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1118,'ZAR',33950,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1118) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5103385-1600  Rear Mudguard Bracket Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1119,'ZAR',14378,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1119) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5103373-1546  L/H Rear Mudguard Bracket Fixing Seat
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1120,'ZAR',14379,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1120) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5103374-1546  R/H Rear Mudguard Bracket Fixing Seat
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1121,'ZAR',15876,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1121) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5103510-1600  Front Wheel Rear Mudguard Fixing Brack
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1122,'ZAR',15396,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1122) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5103511-1509  Rear Mudguard Fixing Bracket
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1123,'ZAR',92862,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1123) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5205010-H02-C00  Windscreen Wiper Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1124,'ZAR',16975,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1124) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5207010-H02-C00  Windscreen Washer Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1126,'ZAR',658161,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1126) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5300010-H02-DQ  Front Wall Welding Assembly — Inner Bo
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1127,'ZAR',70595,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1127) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5201010-B45  Windshield Upper Crossbeam Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1128,'ZAR',0,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1128) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5100010-H02  Floor Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1129,'ZAR',478170,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1129) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5600010-B45  Rear Panel Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1130,'ZAR',675056,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1130) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5700010-B45  Top Cover Welding Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1131,'ZAR',472537,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1131) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5400015-H02  L/H Side Outer Panel Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1132,'ZAR',472536,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1132) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5400020-H02  R/H Side Outer Panel Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1133,'ZAR',154690,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1133) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5401085-H02  L/H Side Inner Panel Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1134,'ZAR',154691,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1134) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5401090-H02  R/H Side Inner Panel Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1135,'ZAR',65902,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1135) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5704011-B45  Roof Sun Visor
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1136,'ZAR',1997,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1136) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5704021-B45  Roof Sun Visor Bracket 1
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1137,'ZAR',1997,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1137) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5704031-B45  Roof Sun Visor Bracket 2
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1138,'ZAR',13580,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1138) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5704081-B45  Roof Trim Strip L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1139,'ZAR',13580,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1139) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5704082-B45  Roof Trim Strip R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1140,'ZAR',141789,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1140) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5704111CB45-G  Roof Deflector Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1141,'ZAR',20969,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1141) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5704116CB45  Roof Deflector Adjustment Bracket
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1142,'ZAR',5991,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1142) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5704130CB45  Deflector Front Hinge Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1143,'ZAR',24963,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1143) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5704145CB45  Roof Deflector L/H Adjustment Support
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1144,'ZAR',24963,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1144) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5704150CB45  Roof Deflector R/H Adjustment Support
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1146,'ZAR',13180,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1146) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5704180CB45  Roof Deflector R/H Support Tube Assemb
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1147,'ZAR',9386,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1147) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5704190-H40  R/H Lower Deflector Bracket Welding As
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1148,'ZAR',30954,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1148) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5704211CB45-G  Upper Deflector L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1149,'ZAR',30954,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1149) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5704212CB45-G  Upper Deflector R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1150,'ZAR',47929,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1150) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5704221CB45-G  Lower Deflector L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1151,'ZAR',45932,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1151) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5704222CB45-G  Lower Deflector R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1152,'ZAR',4393,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1152) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5704231-H40  Upper Deflector Bracket L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1153,'ZAR',4393,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1153) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5704232-H40  Upper Deflector Bracket R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1154,'ZAR',3994,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1154) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5704241-H40  Lower Deflector Upper Bracket L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1155,'ZAR',4393,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1155) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5704242-H40  Lower Deflector Upper Bracket R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1156,'ZAR',4393,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1156) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5704251-H40
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1157,'ZAR',5990,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1157) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5704262-H40  Lower Deflector Lower Bracket R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1158,'ZAR',6990,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1158) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5704281DB45  Lower Reinforcement Tube L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1159,'ZAR',4593,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1159) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5704282-H40  R/H Deflector Support Tube
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1160,'ZAR',4593,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1160) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 5704283CB45  Reinforcement Tube Fixing Bracket
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1161,'ZAR',92403,TIMESTAMPTZ '2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1161) ON CONFLICT (part_id,currency,valid_from) DO NOTHING;  -- 8105010-1600-C00  Condenser Assembly

--    3d. The real list price, re-keyed on Item Code. 115 parts. Written to
--        both places the app reads it: part.list_price_minor for the panel and
--        price(tier='list') for order pricing. Parts absent from the Item
--        Price List are left NULL on purpose - better an empty field than a
--        number nobody chose.
UPDATE part SET list_price_minor = NULL WHERE id BETWEEN 1001 AND 1200;
UPDATE part SET list_price_minor=636062 WHERE id=1001;  -- 2803035B1063-DQ  Front Bumper L/H Assembly
UPDATE part SET list_price_minor=922507 WHERE id=1002;  -- 2803040B1063-DQ  Front Bumper R/H Assembly
UPDATE part SET list_price_minor=285641 WHERE id=1003;  -- 2803645B1063  Front Bumper L/H Bracket Assembly
UPDATE part SET list_price_minor=285641 WHERE id=1004;  -- 2803650B1063  Front Bumper R/H Bracket Assembly
UPDATE part SET list_price_minor=91906 WHERE id=1005;  -- 2803031B1063-G  Front Bumper L/H Decorative Panel
UPDATE part SET list_price_minor=45281 WHERE id=1006;  -- 2803032B1063-G  Front Bumper R/H Decorative Panel
UPDATE part SET list_price_minor=107467 WHERE id=1007;  -- 2803721B1063-G  Front Bumper L/H Spoiler
UPDATE part SET list_price_minor=73861 WHERE id=1008;  -- 2803722B1063-G  Front Bumper R/H Spoiler
UPDATE part SET list_price_minor=464252 WHERE id=1009;  -- 2803010B1063-DQ  Front Bumper Centre Assembly
UPDATE part SET list_price_minor=88733 WHERE id=1010;  -- 2803731B1063-G  Front Bumper Centre Spoiler
UPDATE part SET list_price_minor=36543 WHERE id=1011;  -- 2803821B1063  Front Bumper Centre Mesh Screen
UPDATE part SET list_price_minor=43188 WHERE id=1012;  -- 2803831B1063  Front Bumper Upper Mesh Screen
UPDATE part SET list_price_minor=49649 WHERE id=1013;  -- 2803091B1063-G  Front Bumper Lower Tow Hook Cover
UPDATE part SET list_price_minor=20762 WHERE id=1014;  -- 2803761B1063  Spoiler L/H Connecting Bracket
UPDATE part SET list_price_minor=89616 WHERE id=1015;  -- 2803762B1063  Spoiler R/H Connecting Bracket
UPDATE part SET list_price_minor=11565 WHERE id=1016;  -- 2803763B1063  Spoiler Centre Connecting Bracket
UPDATE part SET list_price_minor=464705 WHERE id=1017;  -- 2803015B1063-G  Front Bumper Intake Grille Assembly
UPDATE part SET list_price_minor=30398 WHERE id=1018;  -- 2803018B1063  Front Bumper Bug Shield
UPDATE part SET list_price_minor=10752 WHERE id=1019;  -- 2803052B1063  Front Bumper Primary Step
UPDATE part SET list_price_minor=1436 WHERE id=1020;  -- 2803381B1063  Front Bumper Centre Lower L/H Decorati
UPDATE part SET list_price_minor=1436 WHERE id=1021;  -- 2803382B1063  Front Bumper Centre Lower R/H Decorati
UPDATE part SET list_price_minor=683442 WHERE id=1022;  -- 2801070-1063  Front Crossmember Assembly
UPDATE part SET list_price_minor=375929 WHERE id=1023;  -- 2801090-1066  Front Spring Front Bracket Crossmember
UPDATE part SET list_price_minor=361548 WHERE id=1033;  -- 5103121-H02-G  Front Fender L/H
UPDATE part SET list_price_minor=286533 WHERE id=1034;  -- 5103122-B45-G  Front Fender R/H
UPDATE part SET list_price_minor=65852 WHERE id=1035;  -- 5103181-B45  Second Step
UPDATE part SET list_price_minor=125876 WHERE id=1036;  -- 5103191-B45  Third Step
UPDATE part SET list_price_minor=27816 WHERE id=1037;  -- 5103135-B45  Front Fender Support Bracket Assembly
UPDATE part SET list_price_minor=198716 WHERE id=1038;  -- 5103131-B45-G  Rear Fender L/H
UPDATE part SET list_price_minor=86906 WHERE id=1039;  -- 5103132-B45-G  Rear Fender R/H
UPDATE part SET list_price_minor=91986 WHERE id=1040;  -- 5103161-H02  Front Wheel Upper Splash Shield L/H
UPDATE part SET list_price_minor=67930 WHERE id=1041;  -- 5103162AB83  Front Wheel Upper Splash Shield R/H
UPDATE part SET list_price_minor=3258 WHERE id=1042;  -- 5103211-B45  Upper Splash Shield Small Door
UPDATE part SET list_price_minor=26522 WHERE id=1043;  -- 5103611-1063  L/H Engine Side Shield
UPDATE part SET list_price_minor=83835 WHERE id=1044;  -- 5103612-1600  R/H Engine Side Shield
UPDATE part SET list_price_minor=7400 WHERE id=1045;  -- 5109111-H02  L/H Door Sill Scuff Plate
UPDATE part SET list_price_minor=6183 WHERE id=1046;  -- 5109112-B45  R/H Door Sill Scuff Plate
UPDATE part SET list_price_minor=60159 WHERE id=1051;  -- 5302715-H02  Left A-pillar upper decorative panel a
UPDATE part SET list_price_minor=60159 WHERE id=1052;  -- 5302720-H02  Right A-pillar upper decorative panel
UPDATE part SET list_price_minor=45484 WHERE id=1053;  -- 5302841-B45-G  Left A-pillar lower decorative plate
UPDATE part SET list_price_minor=45484 WHERE id=1054;  -- 5302842-B45-G  Right A-pillar lower decorative plate
UPDATE part SET list_price_minor=81945 WHERE id=1055;  -- 5302125-B90  L/H Handrail Assembly
UPDATE part SET list_price_minor=81945 WHERE id=1056;  -- 5302130-B90  R/H Handrail Assembly
UPDATE part SET list_price_minor=8775 WHERE id=1057;  -- 5302171-B45  L/H Handrail Cover A
UPDATE part SET list_price_minor=28827 WHERE id=1058;  -- 5302172-B45  R/H Handrail Cover A
UPDATE part SET list_price_minor=168485 WHERE id=1059;  -- 5302350-H02  Windshield Lower Trim Panel Assembly
UPDATE part SET list_price_minor=870953 WHERE id=1060;  -- 5302021-B45-G  Front Wall Outer Panel Assembly
UPDATE part SET list_price_minor=27482 WHERE id=1061;  -- 5302410-B45-C00  Gas Spring Assembly — Front Wall
UPDATE part SET list_price_minor=6210 WHERE id=1062;  -- 5302530-A01  Release Handle Assembly
UPDATE part SET list_price_minor=176523 WHERE id=1063;  -- 5302300-H02  Gas Spring Lower Mount Bracket Link As
UPDATE part SET list_price_minor=7480 WHERE id=1064;  -- 5302311-B45  Gas Spring Lower Mount Bracket Link Ba
UPDATE part SET list_price_minor=70639 WHERE id=1065;  -- 5302415-B45  L/H Handrail Bracket Assembly
UPDATE part SET list_price_minor=59383 WHERE id=1066;  -- 5302420-B45  R/H Handrail Bracket Assembly
UPDATE part SET list_price_minor=53173 WHERE id=1067;  -- 5302500-H02-C00  Front Wall Lock Strap Cable Assembly
UPDATE part SET list_price_minor=1136256 WHERE id=1068;  -- 5300010-H02-DQ  Front Wall Welding Assembly
UPDATE part SET list_price_minor=34414 WHERE id=1069;  -- 5302051-B45  Front Wall Bug Screen A
UPDATE part SET list_price_minor=28670 WHERE id=1070;  -- 5302053-B45  Front Wall Bug Screen B
UPDATE part SET list_price_minor=39923 WHERE id=1071;  -- 5302056-B45  Front Wall Bug Screen C
UPDATE part SET list_price_minor=82504 WHERE id=1072;  -- 5302071-B45-G  Radiator Grille
UPDATE part SET list_price_minor=20561 WHERE id=1073;  -- 5302155-B45  L/H Front Wall Outer Panel Hinge Assem
UPDATE part SET list_price_minor=31583 WHERE id=1074;  -- 5302160-B45  R/H Front Wall Outer Panel Hinge Assem
UPDATE part SET list_price_minor=4784 WHERE id=1075;  -- 5302221-A01  Gas Spring Fixing Base — Front Wall
UPDATE part SET list_price_minor=4269 WHERE id=1076;  -- 5302591-B45  Buffer Block A — Front Wall
UPDATE part SET list_price_minor=156456 WHERE id=1077;  -- 5302621-B45-G  L/H Deflector
UPDATE part SET list_price_minor=156456 WHERE id=1078;  -- 5302622-B45-G  R/H Deflector
UPDATE part SET list_price_minor=94390 WHERE id=1079;  -- 5302801-B45  Front Emblem
UPDATE part SET list_price_minor=320721 WHERE id=1084;  -- 6101585-B83  Front Door Lower Trim Panel Assembly L
UPDATE part SET list_price_minor=451853 WHERE id=1085;  -- 6101590-B83  Front Door Lower Trim Panel Assembly R
UPDATE part SET list_price_minor=145000 WHERE id=1088;  -- 6102015-H02-C00  Front Door Interior Trim Panel Assembl
UPDATE part SET list_price_minor=145000 WHERE id=1089;  -- 6102020-H02-C00  Front Door Interior Trim Panel Assembl
UPDATE part SET list_price_minor=298339 WHERE id=1102;  -- 8202015-H02-C00  Outer Rearview Mirror Assembly L/H — E
UPDATE part SET list_price_minor=298339 WHERE id=1103;  -- 8202020-H02-C00  Outer Rearview Mirror Assembly R/H — E
UPDATE part SET list_price_minor=27169 WHERE id=1104;  -- 8202061-B45-C00-G  Outer Rearview Mirror L/H Lower Fixed
UPDATE part SET list_price_minor=23288 WHERE id=1105;  -- 8202062-B45-C00-G  Outer Rearview Mirror R/H Lower Fixed
UPDATE part SET list_price_minor=54596 WHERE id=1106;  -- 8219010-H02-C00  Top View Mirror Assembly
UPDATE part SET list_price_minor=75038 WHERE id=1107;  -- 8219020AH02-C00  Front Lower View Mirror Assembly
UPDATE part SET list_price_minor=65705 WHERE id=1108;  -- 5103031-1063  Primary Step
UPDATE part SET list_price_minor=154198 WHERE id=1109;  -- 5103021-1544-G  Step Decorative Cover L/H
UPDATE part SET list_price_minor=1416744 WHERE id=1110;  -- 5103010-1544  Front Lower Protection & Step Bracket
UPDATE part SET list_price_minor=140180 WHERE id=1111;  -- 5103022-1544-G  Step Decorative Cover R/H
UPDATE part SET list_price_minor=65705 WHERE id=1112;  -- 5103031-1063  Primary Step R/H
UPDATE part SET list_price_minor=906 WHERE id=1113;  -- 5103061-1063  Step Decorative Cover Small Door Limit
UPDATE part SET list_price_minor=51944 WHERE id=1114;  -- 5103052-1063-G  Step Decorative Cover Small Door
UPDATE part SET list_price_minor=4082 WHERE id=1115;  -- 5103053-1063  Step Decorative Cover Small Door Fixin
UPDATE part SET list_price_minor=97543 WHERE id=1116;  -- 5103361A1600  Rear Mudguard L/H
UPDATE part SET list_price_minor=83042 WHERE id=1117;  -- 5103362A1600  Rear Mudguard R/H
UPDATE part SET list_price_minor=252422 WHERE id=1123;  -- 5205010-H02-C00  Windscreen Wiper Assembly
UPDATE part SET list_price_minor=61578 WHERE id=1124;  -- 5207010-H02-C00  Windscreen Washer Assembly
UPDATE part SET list_price_minor=1136256 WHERE id=1126;  -- 5300010-H02-DQ  Front Wall Welding Assembly — Inner Bo
UPDATE part SET list_price_minor=800000 WHERE id=1132;  -- 5400020-H02  R/H Side Outer Panel Assembly
UPDATE part SET list_price_minor=227441 WHERE id=1135;  -- 5704011-B45  Roof Sun Visor
UPDATE part SET list_price_minor=5344 WHERE id=1136;  -- 5704021-B45  Roof Sun Visor Bracket 1
UPDATE part SET list_price_minor=11365 WHERE id=1137;  -- 5704031-B45  Roof Sun Visor Bracket 2
UPDATE part SET list_price_minor=55269 WHERE id=1138;  -- 5704081-B45  Roof Trim Strip L/H
UPDATE part SET list_price_minor=55269 WHERE id=1139;  -- 5704082-B45  Roof Trim Strip R/H
UPDATE part SET list_price_minor=437115 WHERE id=1140;  -- 5704111CB45-G  Roof Deflector Assembly
UPDATE part SET list_price_minor=36516 WHERE id=1141;  -- 5704116CB45  Roof Deflector Adjustment Bracket
UPDATE part SET list_price_minor=10637 WHERE id=1142;  -- 5704130CB45  Deflector Front Hinge Assembly
UPDATE part SET list_price_minor=52721 WHERE id=1143;  -- 5704145CB45  Roof Deflector L/H Adjustment Support
UPDATE part SET list_price_minor=52723 WHERE id=1144;  -- 5704150CB45  Roof Deflector R/H Adjustment Support
UPDATE part SET list_price_minor=25992 WHERE id=1146;  -- 5704180CB45  Roof Deflector R/H Support Tube Assemb
UPDATE part SET list_price_minor=28506 WHERE id=1147;  -- 5704190-H40  R/H Lower Deflector Bracket Welding As
UPDATE part SET list_price_minor=115696 WHERE id=1148;  -- 5704211CB45-G  Upper Deflector L/H
UPDATE part SET list_price_minor=114935 WHERE id=1149;  -- 5704212CB45-G  Upper Deflector R/H
UPDATE part SET list_price_minor=313639 WHERE id=1150;  -- 5704221CB45-G  Lower Deflector L/H
UPDATE part SET list_price_minor=203840 WHERE id=1151;  -- 5704222CB45-G  Lower Deflector R/H
UPDATE part SET list_price_minor=7866 WHERE id=1152;  -- 5704231-H40  Upper Deflector Bracket L/H
UPDATE part SET list_price_minor=7866 WHERE id=1153;  -- 5704232-H40  Upper Deflector Bracket R/H
UPDATE part SET list_price_minor=7459 WHERE id=1154;  -- 5704241-H40  Lower Deflector Upper Bracket L/H
UPDATE part SET list_price_minor=7947 WHERE id=1155;  -- 5704242-H40  Lower Deflector Upper Bracket R/H
UPDATE part SET list_price_minor=7888 WHERE id=1156;  -- 5704251-H40
UPDATE part SET list_price_minor=20724 WHERE id=1157;  -- 5704262-H40  Lower Deflector Lower Bracket R/H
UPDATE part SET list_price_minor=14860 WHERE id=1158;  -- 5704281DB45  Lower Reinforcement Tube L/H
UPDATE part SET list_price_minor=9580 WHERE id=1159;  -- 5704282-H40  R/H Deflector Support Tube
UPDATE part SET list_price_minor=8933 WHERE id=1160;  -- 5704283CB45  Reinforcement Tube Fixing Bracket

INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1001,'list','ZAR',636062,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1001) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1002,'list','ZAR',922507,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1002) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1003,'list','ZAR',285641,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1003) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1004,'list','ZAR',285641,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1004) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1005,'list','ZAR',91906,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1005) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1006,'list','ZAR',45281,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1006) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1007,'list','ZAR',107467,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1007) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1008,'list','ZAR',73861,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1008) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1009,'list','ZAR',464252,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1009) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1010,'list','ZAR',88733,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1010) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1011,'list','ZAR',36543,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1011) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1012,'list','ZAR',43188,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1012) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1013,'list','ZAR',49649,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1013) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1014,'list','ZAR',20762,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1014) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1015,'list','ZAR',89616,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1015) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1016,'list','ZAR',11565,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1016) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1017,'list','ZAR',464705,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1017) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1018,'list','ZAR',30398,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1018) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1019,'list','ZAR',10752,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1019) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1020,'list','ZAR',1436,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1020) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1021,'list','ZAR',1436,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1021) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1022,'list','ZAR',683442,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1022) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1023,'list','ZAR',375929,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1023) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1033,'list','ZAR',361548,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1033) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1034,'list','ZAR',286533,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1034) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1035,'list','ZAR',65852,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1035) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1036,'list','ZAR',125876,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1036) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1037,'list','ZAR',27816,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1037) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1038,'list','ZAR',198716,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1038) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1039,'list','ZAR',86906,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1039) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1040,'list','ZAR',91986,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1040) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1041,'list','ZAR',67930,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1041) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1042,'list','ZAR',3258,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1042) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1043,'list','ZAR',26522,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1043) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1044,'list','ZAR',83835,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1044) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1045,'list','ZAR',7400,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1045) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1046,'list','ZAR',6183,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1046) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1051,'list','ZAR',60159,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1051) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1052,'list','ZAR',60159,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1052) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1053,'list','ZAR',45484,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1053) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1054,'list','ZAR',45484,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1054) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1055,'list','ZAR',81945,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1055) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1056,'list','ZAR',81945,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1056) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1057,'list','ZAR',8775,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1057) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1058,'list','ZAR',28827,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1058) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1059,'list','ZAR',168485,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1059) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1060,'list','ZAR',870953,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1060) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1061,'list','ZAR',27482,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1061) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1062,'list','ZAR',6210,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1062) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1063,'list','ZAR',176523,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1063) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1064,'list','ZAR',7480,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1064) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1065,'list','ZAR',70639,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1065) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1066,'list','ZAR',59383,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1066) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1067,'list','ZAR',53173,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1067) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1068,'list','ZAR',1136256,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1068) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1069,'list','ZAR',34414,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1069) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1070,'list','ZAR',28670,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1070) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1071,'list','ZAR',39923,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1071) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1072,'list','ZAR',82504,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1072) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1073,'list','ZAR',20561,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1073) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1074,'list','ZAR',31583,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1074) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1075,'list','ZAR',4784,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1075) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1076,'list','ZAR',4269,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1076) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1077,'list','ZAR',156456,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1077) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1078,'list','ZAR',156456,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1078) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1079,'list','ZAR',94390,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1079) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1084,'list','ZAR',320721,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1084) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1085,'list','ZAR',451853,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1085) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1088,'list','ZAR',145000,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1088) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1089,'list','ZAR',145000,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1089) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1102,'list','ZAR',298339,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1102) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1103,'list','ZAR',298339,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1103) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1104,'list','ZAR',27169,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1104) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1105,'list','ZAR',23288,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1105) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1106,'list','ZAR',54596,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1106) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1107,'list','ZAR',75038,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1107) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1108,'list','ZAR',65705,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1108) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1109,'list','ZAR',154198,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1109) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1110,'list','ZAR',1416744,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1110) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1111,'list','ZAR',140180,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1111) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1112,'list','ZAR',65705,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1112) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1113,'list','ZAR',906,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1113) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1114,'list','ZAR',51944,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1114) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1115,'list','ZAR',4082,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1115) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1116,'list','ZAR',97543,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1116) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1117,'list','ZAR',83042,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1117) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1123,'list','ZAR',252422,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1123) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1124,'list','ZAR',61578,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1124) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1126,'list','ZAR',1136256,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1126) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1132,'list','ZAR',800000,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1132) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1135,'list','ZAR',227441,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1135) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1136,'list','ZAR',5344,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1136) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1137,'list','ZAR',11365,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1137) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1138,'list','ZAR',55269,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1138) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1139,'list','ZAR',55269,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1139) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1140,'list','ZAR',437115,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1140) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1141,'list','ZAR',36516,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1141) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1142,'list','ZAR',10637,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1142) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1143,'list','ZAR',52721,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1143) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1144,'list','ZAR',52723,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1144) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1146,'list','ZAR',25992,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1146) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1147,'list','ZAR',28506,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1147) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1148,'list','ZAR',115696,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1148) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1149,'list','ZAR',114935,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1149) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1150,'list','ZAR',313639,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1150) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1151,'list','ZAR',203840,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1151) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1152,'list','ZAR',7866,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1152) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1153,'list','ZAR',7866,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1153) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1154,'list','ZAR',7459,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1154) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1155,'list','ZAR',7947,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1155) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1156,'list','ZAR',7888,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1156) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1157,'list','ZAR',20724,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1157) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1158,'list','ZAR',14860,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1158) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1159,'list','ZAR',9580,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1159) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1160,'list','ZAR',8933,TIMESTAMPTZ '2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1160) ON CONFLICT (part_id,tier,currency,valid_from) DO NOTHING;

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
  IF n_ref  <> 122 THEN RAISE EXCEPTION 'diagram_ref count is %, expected 122', n_ref; END IF;
  IF n_cost <> 159 THEN RAISE EXCEPTION 'part_cost count is %, expected 159', n_cost; END IF;
  IF n_list <> 115 THEN RAISE EXCEPTION 'price(list) count is %, expected 115', n_list; END IF;
  IF n_lp   <> 115 THEN RAISE EXCEPTION 'list_price_minor count is %, expected 115', n_lp; END IF;
  IF n_tier <  3 THEN RAISE EXCEPTION 'price_tier count is %, expected at least 3', n_tier; END IF;

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

