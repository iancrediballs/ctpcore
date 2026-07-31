-- ============================================================================
--  CTP Core - migration 0013: pricing reset
--
--  THREE FAULTS THIS FIXES
--  1. part.list_price_minor was filled by pasting a price column from the Item
--     Price List (ordered by Item Code) onto a sheet ordered by item/section, so
--     86 of 102 prices landed on the wrong part. Re-keyed here on Item Code.
--  2. The `price` table held COST while tagged tier='list'. Its own CHECK says
--     tier IN ('list','trade','wholesale') - it was always meant for SELLING
--     prices. Cost moves to a new part_cost table and tier='list' becomes the
--     real list price. This mislabelling is why snapshot_price() charged cost.
--  3. Costs were USD x a flat 17.00. The official cost list implies 19.97, so
--     official ZAR costs are loaded directly and no FX conversion remains.
--
--  SOURCES  Item Price List (Retail, excl VAT) and Item Cost Price List,
--           China Truck Parts (Pty) Ltd, joined on Item Code.
--  Idempotent: safe to re-run.
-- ============================================================================
PRAGMA foreign_keys = ON;

-- 1. discount tiers. Codes match customer.price_tier's CHECK. Seeded at zero so behaviour is 'charge list' until real
--    numbers are set. min_margin_bps is the floor snapshot_price() will not
--    discount through - the guard that stops a trade discount selling at a loss.
CREATE TABLE IF NOT EXISTS price_tier (
  code            TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  discount_bps    INTEGER NOT NULL DEFAULT 0    CHECK (discount_bps    BETWEEN 0 AND 9000),
  min_margin_bps  INTEGER NOT NULL DEFAULT 1500 CHECK (min_margin_bps  BETWEEN 0 AND 9000),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO price_tier(code,name,discount_bps,min_margin_bps) VALUES
  ('list',     'List / walk-in', 0, 1500),
  ('trade',    'Trade account',  0, 1500),
  ('wholesale','Wholesale',      0, 1500);

-- 2. landed cost gets its own home, versioned by shipment date.
CREATE TABLE IF NOT EXISTS part_cost (
  part_id      INTEGER NOT NULL REFERENCES part(id) ON DELETE CASCADE,
  currency     TEXT    NOT NULL DEFAULT 'ZAR',
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  valid_from   TEXT    NOT NULL DEFAULT (datetime('now')),
  source       TEXT,
  PRIMARY KEY (part_id, currency, valid_from)
);

-- 3. evict cost from the price table. These rows were USD/ZAR landed cost
--    masquerading as a list price; they are re-inserted below as part_cost.
DELETE FROM price WHERE tier='list';

-- 4. official landed cost, ZAR (159 parts)
DELETE FROM part_cost WHERE valid_from='2026-07-30';
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1001,'ZAR',119263,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1001);  -- 2803035B1063-DQ  Front Bumper L/H Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1002,'ZAR',119263,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1002);  -- 2803040B1063-DQ  Front Bumper R/H Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1003,'ZAR',102168,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1003);  -- 2803645B1063  Front Bumper L/H Bracket Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1004,'ZAR',102168,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1004);  -- 2803650B1063  Front Bumper R/H Bracket Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1005,'ZAR',6211,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1005);  -- 2803031B1063-G  Front Bumper L/H Decorative Panel
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1006,'ZAR',6210,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1006);  -- 2803032B1063-G  Front Bumper R/H Decorative Panel
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1007,'ZAR',7529,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1007);  -- 2803721B1063-G  Front Bumper L/H Spoiler
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1008,'ZAR',7528,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1008);  -- 2803722B1063-G  Front Bumper R/H Spoiler
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1009,'ZAR',148519,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1009);  -- 2803010B1063-DQ  Front Bumper Centre Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1010,'ZAR',14279,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1010);  -- 2803731B1063-G  Front Bumper Centre Spoiler
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1011,'ZAR',7129,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1011);  -- 2803821B1063  Front Bumper Centre Mesh Screen
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1012,'ZAR',15597,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1012);  -- 2803831B1063  Front Bumper Upper Mesh Screen
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1013,'ZAR',559,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1013);  -- 2803091B1063-G  Front Bumper Lower Tow Hook Cover
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1014,'ZAR',1997,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1014);  -- 2803761B1063  Spoiler L/H Connecting Bracket
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1015,'ZAR',1997,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1015);  -- 2803762B1063  Spoiler R/H Connecting Bracket
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1016,'ZAR',999,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1016);  -- 2803763B1063  Spoiler Centre Connecting Bracket
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1017,'ZAR',22127,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1017);  -- 2803015B1063-G  Front Bumper Intake Grille Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1018,'ZAR',7189,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1018);  -- 2803018B1063  Front Bumper Bug Shield
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1019,'ZAR',3954,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1019);  -- 2803052B1063  Front Bumper Primary Step
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1020,'ZAR',839,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1020);  -- 2803381B1063  Front Bumper Centre Lower L/H Decorati
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1021,'ZAR',839,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1021);  -- 2803382B1063  Front Bumper Centre Lower R/H Decorati
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1022,'ZAR',100849,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1022);  -- 2801070-1063  Front Crossmember Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1023,'ZAR',28956,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1023);  -- 2801090-1066  Front Spring Front Bracket Crossmember
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1024,'ZAR',111553,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1024);  -- 3711015-1544  Front Combination Lamp L/H Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1025,'ZAR',111554,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1025);  -- 3711020-1544  Front Combination Lamp R/H Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1026,'ZAR',42737,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1026);  -- 3732015-1063-C00  Front Fog Lamp L/H Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1027,'ZAR',42736,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1027);  -- 3732020-1063-C00  Front Fog Lamp R/H Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1028,'ZAR',45572,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1028);  -- 5004055-79H-C00  Cab Hydraulic Lock Assembly L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1029,'ZAR',52642,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1029);  -- 5004055-1063-C00  Cab Hydraulic Lock Assembly R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1030,'ZAR',119642,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1030);  -- 5001315B1063-C00  Rear Suspension Air Spring & Shock Abs
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1031,'ZAR',131265,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1031);  -- 5001315-1063A-C00  Rear Suspension Air Spring & Shock Abs
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1032,'ZAR',386505,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1032);  -- 5001010CB45  Cab Front Suspension Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1033,'ZAR',166013,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1033);  -- 5103121-H02-G  Front Fender L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1034,'ZAR',65982,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1034);  -- 5103122-B45-G  Front Fender R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1035,'ZAR',23565,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1035);  -- 5103181-B45  Second Step
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1036,'ZAR',29117,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1036);  -- 5103191-B45  Third Step
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1037,'ZAR',9945,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1037);  -- 5103135-B45  Front Fender Support Bracket Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1038,'ZAR',12921,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1038);  -- 5103131-B45-G  Rear Fender L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1039,'ZAR',12921,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1039);  -- 5103132-B45-G  Rear Fender R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1040,'ZAR',25144,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1040);  -- 5103161-H02  Front Wheel Upper Splash Shield L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1041,'ZAR',20849,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1041);  -- 5103162AB83  Front Wheel Upper Splash Shield R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1042,'ZAR',838,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1042);  -- 5103211-B45  Upper Splash Shield Small Door
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1043,'ZAR',12981,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1043);  -- 5103611-1063  L/H Engine Side Shield
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1044,'ZAR',12981,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1044);  -- 5103612-1600  R/H Engine Side Shield
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1045,'ZAR',4993,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1045);  -- 5109111-H02  L/H Door Sill Scuff Plate
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1046,'ZAR',2996,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1046);  -- 5109112-B45  R/H Door Sill Scuff Plate
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1047,'ZAR',94200,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1047);  -- 5407025-B45  Side Toolbox Cover Assembly L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1048,'ZAR',94200,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1048);  -- 5407025-B45  Side Toolbox Cover Assembly R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1049,'ZAR',6530,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1049);  -- 5407086-B45-C00  Side Toolbox Sealing Strip L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1050,'ZAR',6530,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1050);  -- 5407086-B45-C00  Side Toolbox Sealing Strip R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1051,'ZAR',16214,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1051);  -- 5302715-H02  Left A-pillar upper decorative panel a
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1052,'ZAR',16214,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1052);  -- 5302720-H02  Right A-pillar upper decorative panel 
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1053,'ZAR',12981,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1053);  -- 5302841-B45-G  Left A-pillar lower decorative plate
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1054,'ZAR',12981,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1054);  -- 5302842-B45-G  Right A-pillar lower decorative plate
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1055,'ZAR',5512,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1055);  -- 5302125-B90  L/H Handrail Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1056,'ZAR',5512,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1056);  -- 5302130-B90  R/H Handrail Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1057,'ZAR',999,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1057);  -- 5302171-B45  L/H Handrail Cover A
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1058,'ZAR',999,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1058);  -- 5302172-B45  R/H Handrail Cover A
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1059,'ZAR',34069,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1059);  -- 5302350-H02  Windshield Lower Trim Panel Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1060,'ZAR',143028,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1060);  -- 5302021-B45-G  Front Wall Outer Panel Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1061,'ZAR',6490,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1061);  -- 5302410-B45-C00  Gas Spring Assembly — Front Wall
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1062,'ZAR',1997,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1062);  -- 5302530-A01  Release Handle Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1063,'ZAR',13580,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1063);  -- 5302300-H02  Gas Spring Lower Mount Bracket Link As
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1064,'ZAR',2996,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1064);  -- 5302311-B45  Gas Spring Lower Mount Bracket Link Ba
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1065,'ZAR',21967,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1065);  -- 5302415-B45  L/H Handrail Bracket Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1066,'ZAR',21967,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1066);  -- 5302420-B45  R/H Handrail Bracket Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1067,'ZAR',15976,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1067);  -- 5302500-H02-C00  Front Wall Lock Strap Cable Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1068,'ZAR',658161,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1068);  -- 5300010-H02-DQ  Front Wall Welding Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1069,'ZAR',7589,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1069);  -- 5302051-B45  Front Wall Bug Screen A
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1070,'ZAR',6990,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1070);  -- 5302053-B45  Front Wall Bug Screen B
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1071,'ZAR',6990,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1071);  -- 5302056-B45  Front Wall Bug Screen C
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1072,'ZAR',26960,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1072);  -- 5302071-B45-G  Radiator Grille
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1073,'ZAR',4993,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1073);  -- 5302155-B45  L/H Front Wall Outer Panel Hinge Assem
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1074,'ZAR',4993,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1074);  -- 5302160-B45  R/H Front Wall Outer Panel Hinge Assem
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1075,'ZAR',1598,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1075);  -- 5302221-A01  Gas Spring Fixing Base — Front Wall
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1076,'ZAR',999,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1076);  -- 5302591-B45  Buffer Block A — Front Wall
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1077,'ZAR',13979,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1077);  -- 5302621-B45-G  L/H Deflector
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1078,'ZAR',13979,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1078);  -- 5302622-B45-G  R/H Deflector                         
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1079,'ZAR',19970,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1079);  -- 5302801-B45  Front Emblem
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1080,'ZAR',1103959,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1080);  -- 6100005-H02  Front Door Assembly L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1081,'ZAR',1103959,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1081);  -- 6100010-H02  Front Door Assembly R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1082,'ZAR',2257,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1082);  -- 6100031-B45  Front Door Rear Frame Trim Cover L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1083,'ZAR',2259,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1083);  -- 6100032-B45  Front Door Rear Frame Trim Cover R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1084,'ZAR',49727,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1084);  -- 6101585-B83  Front Door Lower Trim Panel Assembly L
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1085,'ZAR',49726,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1085);  -- 6101590-B83  Front Door Lower Trim Panel Assembly R
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1086,'ZAR',8027,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1086);  -- 6102151-B45-C00  Front Door Window Frame Upper Protecti
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1087,'ZAR',8027,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1087);  -- 6102152-B45-C00  Front Door Window Frame Upper Protecti
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1088,'ZAR',63985,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1088);  -- 6102015-H02-C00  Front Door Interior Trim Panel Assembl
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1089,'ZAR',63985,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1089);  -- 6102020-H02-C00  Front Door Interior Trim Panel Assembl
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1090,'ZAR',98673,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1090);  -- 6104015AB45-C00  Front Door Electric Window Lift Module
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1091,'ZAR',98673,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1091);  -- 6104020AB45-C00  Front Door Electric Window Lift Module
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1092,'ZAR',24404,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1092);  -- 6105025AB45-C00  Front Door Electric Lock Assembly L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1093,'ZAR',24404,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1093);  -- 6105030AB45-C00  Front Door Electric Lock Assembly R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1094,'ZAR',18913,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1094);  -- 6105045-B45-C00  Front Door Handle Assembly L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1095,'ZAR',18910,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1095);  -- 6105050-B45-C00  Front Door Handle Assembly R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1096,'ZAR',23904,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1096);  -- 6106015-B45-C00  Front Door Upper Hinge Assembly L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1097,'ZAR',23904,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1097);  -- 6106020-B45-C00  Front Door Upper Hinge Assembly R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1098,'ZAR',16575,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1098);  -- 6106055-B45-C00  Front Door Lower Hinge Assembly L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1099,'ZAR',16575,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1099);  -- 6106060-B45-C00  Front Door Lower Hinge Assembly R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1100,'ZAR',7529,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1100);  -- 6109015-B45-C00  Front Door Limiter Assembly L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1101,'ZAR',7529,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1101);  -- 6109015-B45-C00  Front Door Limiter Assembly R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1102,'ZAR',113670,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1102);  -- 8202015-H02-C00  Outer Rearview Mirror Assembly L/H — E
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1103,'ZAR',113670,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1103);  -- 8202020-H02-C00  Outer Rearview Mirror Assembly R/H — E
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1104,'ZAR',2396,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1104);  -- 8202061-B45-C00-G  Outer Rearview Mirror L/H Lower Fixed 
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1105,'ZAR',2396,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1105);  -- 8202062-B45-C00-G  Outer Rearview Mirror R/H Lower Fixed 
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1106,'ZAR',14493,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1106);  -- 8219010-H02-C00  Top View Mirror Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1107,'ZAR',32557,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1107);  -- 8219020AH02-C00  Front Lower View Mirror Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1108,'ZAR',8747,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1108);  -- 5103031-1063  Primary Step
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1109,'ZAR',29195,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1109);  -- 5103021-1544-G  Step Decorative Cover L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1110,'ZAR',249130,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1110);  -- 5103010-1544  Front Lower Protection & Step Bracket 
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1111,'ZAR',29077,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1111);  -- 5103022-1544-G  Step Decorative Cover R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1112,'ZAR',8747,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1112);  -- 5103031-1063  Primary Step R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1113,'ZAR',300,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1113);  -- 5103061-1063  Step Decorative Cover Small Door Limit
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1114,'ZAR',609,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1114);  -- 5103052-1063-G  Step Decorative Cover Small Door
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1115,'ZAR',975,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1115);  -- 5103053-1063  Step Decorative Cover Small Door Fixin
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1116,'ZAR',17494,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1116);  -- 5103361A1600  Rear Mudguard L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1117,'ZAR',18373,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1117);  -- 5103362A1600  Rear Mudguard R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1118,'ZAR',33950,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1118);  -- 5103385-1600  Rear Mudguard Bracket Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1119,'ZAR',14378,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1119);  -- 5103373-1546  L/H Rear Mudguard Bracket Fixing Seat
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1120,'ZAR',14379,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1120);  -- 5103374-1546  R/H Rear Mudguard Bracket Fixing Seat
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1121,'ZAR',15876,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1121);  -- 5103510-1600  Front Wheel Rear Mudguard Fixing Brack
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1122,'ZAR',15396,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1122);  -- 5103511-1509  Rear Mudguard Fixing Bracket
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1123,'ZAR',92862,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1123);  -- 5205010-H02-C00  Windscreen Wiper Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1124,'ZAR',16975,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1124);  -- 5207010-H02-C00  Windscreen Washer Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1126,'ZAR',658161,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1126);  -- 5300010-H02-DQ  Front Wall Welding Assembly — Inner Bo
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1127,'ZAR',70595,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1127);  -- 5201010-B45  Windshield Upper Crossbeam Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1128,'ZAR',0,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1128);  -- 5100010-H02  Floor Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1129,'ZAR',478170,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1129);  -- 5600010-B45  Rear Panel Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1130,'ZAR',675056,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1130);  -- 5700010-B45  Top Cover Welding Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1131,'ZAR',472537,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1131);  -- 5400015-H02  L/H Side Outer Panel Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1132,'ZAR',472536,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1132);  -- 5400020-H02  R/H Side Outer Panel Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1133,'ZAR',154690,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1133);  -- 5401085-H02  L/H Side Inner Panel Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1134,'ZAR',154691,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1134);  -- 5401090-H02  R/H Side Inner Panel Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1135,'ZAR',65902,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1135);  -- 5704011-B45  Roof Sun Visor
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1136,'ZAR',1997,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1136);  -- 5704021-B45  Roof Sun Visor Bracket 1
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1137,'ZAR',1997,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1137);  -- 5704031-B45  Roof Sun Visor Bracket 2
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1138,'ZAR',13580,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1138);  -- 5704081-B45  Roof Trim Strip L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1139,'ZAR',13580,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1139);  -- 5704082-B45  Roof Trim Strip R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1140,'ZAR',141789,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1140);  -- 5704111CB45-G  Roof Deflector Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1141,'ZAR',20969,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1141);  -- 5704116CB45  Roof Deflector Adjustment Bracket
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1142,'ZAR',5991,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1142);  -- 5704130CB45  Deflector Front Hinge Assembly
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1143,'ZAR',24963,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1143);  -- 5704145CB45  Roof Deflector L/H Adjustment Support 
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1144,'ZAR',24963,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1144);  -- 5704150CB45  Roof Deflector R/H Adjustment Support 
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1146,'ZAR',13180,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1146);  -- 5704180CB45  Roof Deflector R/H Support Tube Assemb
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1147,'ZAR',9386,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1147);  -- 5704190-H40  R/H Lower Deflector Bracket Welding As
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1148,'ZAR',30954,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1148);  -- 5704211CB45-G  Upper Deflector L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1149,'ZAR',30954,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1149);  -- 5704212CB45-G  Upper Deflector R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1150,'ZAR',47929,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1150);  -- 5704221CB45-G  Lower Deflector L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1151,'ZAR',45932,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1151);  -- 5704222CB45-G  Lower Deflector R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1152,'ZAR',4393,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1152);  -- 5704231-H40  Upper Deflector Bracket L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1153,'ZAR',4393,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1153);  -- 5704232-H40  Upper Deflector Bracket R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1154,'ZAR',3994,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1154);  -- 5704241-H40  Lower Deflector Upper Bracket L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1155,'ZAR',4393,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1155);  -- 5704242-H40  Lower Deflector Upper Bracket R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1156,'ZAR',4393,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1156);  -- 5704251-H40                            
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1157,'ZAR',5990,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1157);  -- 5704262-H40  Lower Deflector Lower Bracket R/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1158,'ZAR',6990,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1158);  -- 5704281DB45  Lower Reinforcement Tube L/H
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1159,'ZAR',4593,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1159);  -- 5704282-H40  R/H Deflector Support Tube
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1160,'ZAR',4593,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1160);  -- 5704283CB45  Reinforcement Tube Fixing Bracket
INSERT INTO part_cost(part_id,currency,amount_minor,valid_from,source) SELECT 1161,'ZAR',92403,'2026-07-30','Item Cost Price List' WHERE EXISTS(SELECT 1 FROM part WHERE id=1161);  -- 8105010-1600-C00  Condenser Assembly

-- 5. the real list price, re-keyed on Item Code (115 parts), in both places the
--    app reads it: price(tier='list') for order pricing, part.list_price_minor
--    for the part panel. Parts absent from the Item Price List are left NULL on
--    purpose - better an empty field than a number nobody chose.
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

INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1001,'list','ZAR',636062,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1001);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1002,'list','ZAR',922507,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1002);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1003,'list','ZAR',285641,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1003);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1004,'list','ZAR',285641,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1004);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1005,'list','ZAR',91906,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1005);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1006,'list','ZAR',45281,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1006);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1007,'list','ZAR',107467,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1007);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1008,'list','ZAR',73861,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1008);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1009,'list','ZAR',464252,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1009);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1010,'list','ZAR',88733,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1010);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1011,'list','ZAR',36543,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1011);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1012,'list','ZAR',43188,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1012);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1013,'list','ZAR',49649,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1013);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1014,'list','ZAR',20762,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1014);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1015,'list','ZAR',89616,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1015);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1016,'list','ZAR',11565,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1016);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1017,'list','ZAR',464705,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1017);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1018,'list','ZAR',30398,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1018);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1019,'list','ZAR',10752,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1019);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1020,'list','ZAR',1436,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1020);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1021,'list','ZAR',1436,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1021);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1022,'list','ZAR',683442,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1022);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1023,'list','ZAR',375929,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1023);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1033,'list','ZAR',361548,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1033);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1034,'list','ZAR',286533,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1034);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1035,'list','ZAR',65852,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1035);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1036,'list','ZAR',125876,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1036);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1037,'list','ZAR',27816,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1037);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1038,'list','ZAR',198716,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1038);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1039,'list','ZAR',86906,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1039);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1040,'list','ZAR',91986,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1040);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1041,'list','ZAR',67930,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1041);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1042,'list','ZAR',3258,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1042);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1043,'list','ZAR',26522,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1043);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1044,'list','ZAR',83835,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1044);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1045,'list','ZAR',7400,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1045);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1046,'list','ZAR',6183,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1046);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1051,'list','ZAR',60159,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1051);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1052,'list','ZAR',60159,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1052);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1053,'list','ZAR',45484,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1053);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1054,'list','ZAR',45484,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1054);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1055,'list','ZAR',81945,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1055);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1056,'list','ZAR',81945,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1056);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1057,'list','ZAR',8775,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1057);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1058,'list','ZAR',28827,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1058);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1059,'list','ZAR',168485,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1059);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1060,'list','ZAR',870953,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1060);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1061,'list','ZAR',27482,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1061);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1062,'list','ZAR',6210,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1062);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1063,'list','ZAR',176523,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1063);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1064,'list','ZAR',7480,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1064);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1065,'list','ZAR',70639,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1065);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1066,'list','ZAR',59383,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1066);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1067,'list','ZAR',53173,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1067);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1068,'list','ZAR',1136256,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1068);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1069,'list','ZAR',34414,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1069);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1070,'list','ZAR',28670,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1070);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1071,'list','ZAR',39923,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1071);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1072,'list','ZAR',82504,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1072);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1073,'list','ZAR',20561,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1073);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1074,'list','ZAR',31583,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1074);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1075,'list','ZAR',4784,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1075);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1076,'list','ZAR',4269,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1076);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1077,'list','ZAR',156456,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1077);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1078,'list','ZAR',156456,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1078);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1079,'list','ZAR',94390,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1079);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1084,'list','ZAR',320721,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1084);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1085,'list','ZAR',451853,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1085);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1088,'list','ZAR',145000,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1088);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1089,'list','ZAR',145000,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1089);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1102,'list','ZAR',298339,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1102);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1103,'list','ZAR',298339,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1103);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1104,'list','ZAR',27169,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1104);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1105,'list','ZAR',23288,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1105);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1106,'list','ZAR',54596,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1106);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1107,'list','ZAR',75038,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1107);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1108,'list','ZAR',65705,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1108);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1109,'list','ZAR',154198,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1109);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1110,'list','ZAR',1416744,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1110);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1111,'list','ZAR',140180,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1111);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1112,'list','ZAR',65705,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1112);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1113,'list','ZAR',906,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1113);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1114,'list','ZAR',51944,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1114);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1115,'list','ZAR',4082,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1115);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1116,'list','ZAR',97543,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1116);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1117,'list','ZAR',83042,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1117);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1123,'list','ZAR',252422,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1123);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1124,'list','ZAR',61578,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1124);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1126,'list','ZAR',1136256,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1126);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1132,'list','ZAR',800000,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1132);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1135,'list','ZAR',227441,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1135);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1136,'list','ZAR',5344,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1136);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1137,'list','ZAR',11365,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1137);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1138,'list','ZAR',55269,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1138);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1139,'list','ZAR',55269,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1139);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1140,'list','ZAR',437115,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1140);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1141,'list','ZAR',36516,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1141);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1142,'list','ZAR',10637,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1142);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1143,'list','ZAR',52721,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1143);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1144,'list','ZAR',52723,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1144);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1146,'list','ZAR',25992,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1146);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1147,'list','ZAR',28506,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1147);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1148,'list','ZAR',115696,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1148);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1149,'list','ZAR',114935,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1149);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1150,'list','ZAR',313639,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1150);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1151,'list','ZAR',203840,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1151);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1152,'list','ZAR',7866,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1152);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1153,'list','ZAR',7866,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1153);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1154,'list','ZAR',7459,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1154);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1155,'list','ZAR',7947,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1155);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1156,'list','ZAR',7888,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1156);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1157,'list','ZAR',20724,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1157);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1158,'list','ZAR',14860,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1158);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1159,'list','ZAR',9580,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1159);
INSERT INTO price(part_id,tier,currency,amount_minor,valid_from) SELECT 1160,'list','ZAR',8933,'2026-07-30' WHERE EXISTS(SELECT 1 FROM part WHERE id=1160);

-- 6. part_detail: cost now comes from part_cost. Column names are unchanged so
--    main.rs needs no edit, but their meaning is now honest:
--      price_zar_minor = landed COST in ZAR   (Jefrey reads this as cost_minor)
--      price_usd_minor = NULL, USD cost is no longer tracked
--    Rust's price_cents falls through to price(tier='list'), which is now the
--    genuine list price - so the part panel shows list, not cost.
DROP VIEW IF EXISTS part_detail;
CREATE VIEW part_detail AS
SELECT
  p.id, p.sku, p.locator, p.name, p.description, p.side,
  p.make, p.model, p.drawing_no, p.diagram_item_no,
  p.catalogue_pn, p.inventory_pn, p.mpn,
  c.code  AS category_code, c.name AS category_name,
  p.status, p.match_status, p.notes, p.list_price_minor,
  COALESCE((SELECT SUM(delta) FROM stock_movement WHERE part_id=p.id),0) AS qty_on_hand,
  (SELECT bin FROM stock_policy WHERE part_id=p.id LIMIT 1) AS bin,
  NULL AS price_usd_minor,
  (SELECT amount_minor FROM part_cost WHERE part_id=p.id AND currency='ZAR'
        ORDER BY valid_from DESC LIMIT 1) AS price_zar_minor,
  (SELECT path FROM part_image WHERE part_id=p.id AND deleted_at IS NULL
        ORDER BY is_primary DESC, sort_order LIMIT 1) AS primary_image,
  (SELECT glb_path FROM part_model WHERE part_id=p.id AND deleted_at IS NULL LIMIT 1) AS model_3d,
  (SELECT d.image_path FROM diagram d WHERE d.drawing_key='SEC'||p.category_id LIMIT 1) AS diagram_image,
  p.diagram_ref AS diagram_item
FROM part p JOIN category c ON c.id = p.category_id
WHERE p.deleted_at IS NULL;

PRAGMA user_version = 12;
