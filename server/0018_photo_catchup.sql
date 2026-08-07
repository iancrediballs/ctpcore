-- ============================================================================
--  CTP Core - migration 0018: the white cutouts reach the cloud
--
--  The RAW -> rembg pipeline produced a white-background cutout for very nearly
--  every part and made it primary in the LOCAL SQLite. That import never
--  reached Postgres, whose 124 of 142 image rows still point at
--  `assets/photos/raw_*.jpg`. So the desktop shows clean cutouts on white while
--  any web or phone client would show the raw shots. Same drift as 0010-0013,
--  same fix: replay it.
--
--  WHERE THE MAPPING COMES FROM - two sources, best evidence first:
--    144  Master_Cutouts_White/_master_manifest.csv, which names the
--         canonical master_png per item. item_no + 1000 = part.id, confirmed
--         against inventory_pn and catalogue_pn on 144 of 146 rows (the two
--         that differ - 1062 and 1124 - are the same part under a revised PN).
--     15  png_import.py's rule applied to the rest: normalise to [a-z0-9],
--         strip a `processed_` prefix / `.png` / `.CR2` tail / a SEPARATED
--         trailing sequence, match inventory_pn then catalogue_pn, shortest
--         filename wins. Not a new heuristic - the desktop importer's own.
--
--  RESULT: 159 of 161 live parts get a cutout, from 154 distinct files.
--  Parts with a photo goes 125 -> 159; exactly 2 parts end up with no image.
--
--  THE TWO PARTS WITH NO CUTOUT - there is genuinely no file for either, in
--  Master_Cutouts_White or anywhere else. Both are large structural weldments,
--  which is a plausible thing not to have photographed:
--    1125  CTP-CBY-001-C  Cab Weld Assembly     (5000020-H02-001 / 5000040EB45)
--    1128  CTP-CBY-004-C  Floor Assembly        (5100010-H02)
--  They keep whatever image they already had. If cutouts appear later, drop
--  them in app/public/assets/photos/master/ and add two rows here.
--
--  NOTHING IS DELETED. The raw rows are demoted to is_primary = 0, exactly as
--  png_import.py does on the desktop, so this reverses and the originals stay
--  in the part panel's thumbnail strip.
--
--  FILES: all 154 are in app/public/assets/photos/master/. Ten were copied
--  there from Master_Cutouts_White on 2026-08-06; the rest were already served.
--
--  AFTER THIS, RUN:  python server/sync_assets.py
--  The uploader is driven by what the database references, so it picks these up
--  with no code change. Until it runs the new paths 404 on web; the desktop
--  reads them from app/public/ and is correct immediately.
--
--  Idempotent: safe to re-run. One transaction - all or nothing.
-- ============================================================================
BEGIN;

-- A real table, not a TEMP one. A TEMP table with ON COMMIT DROP dies the
-- moment the CREATE commits if this is pasted into an editor that does not wrap
-- it in a single transaction, and every statement after it then silently
-- matches zero rows - a migration that reports success and changed nothing.
-- Same trap avoided in 0016.
DROP TABLE IF EXISTS cutout_map;
CREATE TABLE cutout_map (part_id BIGINT PRIMARY KEY, path TEXT NOT NULL);

INSERT INTO cutout_map (part_id, path) VALUES
  (1001, 'assets/photos/master/2803035B1063-DQ.png'),   -- CTP-BMP-001-L   [pn-match]
  (1002, 'assets/photos/master/2803040B1063-DQ.png'),   -- CTP-BMP-002-R   [pn-match]
  (1003, 'assets/photos/master/2803645B1063.png'),   -- CTP-BMP-003-L
  (1004, 'assets/photos/master/2803650B1063.png'),   -- CTP-BMP-004-R
  (1005, 'assets/photos/master/2803031B1063.png'),   -- CTP-BMP-005-L
  (1006, 'assets/photos/master/2803032B1063.png'),   -- CTP-BMP-006-R
  (1007, 'assets/photos/master/2803721B1063.png'),   -- CTP-BMP-007-L
  (1008, 'assets/photos/master/2803722B1063.png'),   -- CTP-BMP-008-R
  (1009, 'assets/photos/master/2803010B1063.png'),   -- CTP-BMP-009-C
  (1010, 'assets/photos/master/2803731B1063.png'),   -- CTP-BMP-010-C
  (1011, 'assets/photos/master/2803821B1063.png'),   -- CTP-BMP-011-C
  (1012, 'assets/photos/master/2803831B1063.png'),   -- CTP-BMP-012-C
  (1013, 'assets/photos/master/2803091B1063.png'),   -- CTP-BMP-013-C
  (1014, 'assets/photos/master/2803761B1063.png'),   -- CTP-BMP-014-L
  (1015, 'assets/photos/master/2803762B1063.png'),   -- CTP-BMP-015-R
  (1016, 'assets/photos/master/2803763B1063.png'),   -- CTP-BMP-016-C
  (1017, 'assets/photos/master/2803015B1063.png'),   -- CTP-BMP-017-C
  (1018, 'assets/photos/master/2803018B1063.png'),   -- CTP-BMP-018-C
  (1019, 'assets/photos/master/2803052B1063.png'),   -- CTP-BMP-019-C
  (1020, 'assets/photos/master/2803381B1063.png'),   -- CTP-BMP-020-L
  (1021, 'assets/photos/master/2803382B1063.png'),   -- CTP-BMP-021-R
  (1022, 'assets/photos/master/2801070-1063.png'),   -- CTP-CHX-001-C
  (1023, 'assets/photos/master/2801090-1066.png'),   -- CTP-CHX-002-C
  (1024, 'assets/photos/master/3711015-1063.png'),   -- CTP-LGT-001-L
  (1025, 'assets/photos/master/3711020-1063.png'),   -- CTP-LGT-002-R
  (1026, 'assets/photos/master/3732015-1063.png'),   -- CTP-LGT-003-L
  (1027, 'assets/photos/master/3732020-1063.png'),   -- CTP-LGT-004-R
  (1028, 'assets/photos/master/5004055-1063-C00.png'),   -- CTP-SUS-001-L
  (1029, 'assets/photos/master/5004055-1063-C00.png'),   -- CTP-SUS-002-R   [pn-match]
  (1030, 'assets/photos/master/5001315A1063-C00.png'),   -- CTP-SUS-003-L
  (1031, 'assets/photos/master/5001315A1063-C00-i31.png'),   -- CTP-SUS-004-R
  (1032, 'assets/photos/master/5001010-B45.png'),   -- CTP-SUS-005-C
  (1033, 'assets/photos/master/5103121-B45.png'),   -- CTP-FND-001-L
  (1034, 'assets/photos/master/5103122-B45.png'),   -- CTP-FND-002-R
  (1035, 'assets/photos/master/5103181-B45.png'),   -- CTP-FND-003-C
  (1036, 'assets/photos/master/5103191-B45.png'),   -- CTP-FND-004-C
  (1037, 'assets/photos/master/5103135-B45.png'),   -- CTP-FND-005-B
  (1038, 'assets/photos/master/5103125-B45.png'),   -- CTP-FND-006-L
  (1039, 'assets/photos/master/5103130-B45.png'),   -- CTP-FND-007-R
  (1040, 'assets/photos/master/5103161-B45.png'),   -- CTP-FND-008-L
  (1041, 'assets/photos/master/5103162AB83.png'),   -- CTP-FND-009-R
  (1042, 'assets/photos/master/5103211-B45.png'),   -- CTP-FND-010-C
  (1043, 'assets/photos/master/5103611-1063.png'),   -- CTP-FND-011-L
  (1044, 'assets/photos/master/5103612-1600.png'),   -- CTP-FND-012-R
  (1045, 'assets/photos/master/5109111-H02.png'),   -- CTP-FND-013-L
  (1046, 'assets/photos/master/5109112-B45.png'),   -- CTP-FND-014-R
  (1047, 'assets/photos/master/5407015-B45.png'),   -- CTP-TBX-001-L
  (1048, 'assets/photos/master/5407025-B45.png'),   -- CTP-TBX-002-R   [pn-match]
  (1049, 'assets/photos/master/5407086-B45-C00.png'),   -- CTP-TBX-003-L
  (1050, 'assets/photos/master/5407086-B45-C00.png'),   -- CTP-TBX-004-R   [pn-match]
  (1051, 'assets/photos/master/5302715-B45.png'),   -- CTP-INT-001-L
  (1052, 'assets/photos/master/5302720-B45.png'),   -- CTP-INT-002-R
  (1053, 'assets/photos/master/5302841-B45.png'),   -- CTP-INT-003-L
  (1054, 'assets/photos/master/5302842-B45.png'),   -- CTP-INT-004-R
  (1055, 'assets/photos/master/5302135-B45.png'),   -- CTP-INT-005-L
  (1056, 'assets/photos/master/5302140-B45.png'),   -- CTP-INT-006-R
  (1057, 'assets/photos/master/5302171-B45.png'),   -- CTP-INT-007-L
  (1058, 'assets/photos/master/5302172-B45.png'),   -- CTP-INT-008-R
  (1059, 'assets/photos/master/5302350-B45.png'),   -- CTP-INT-009-C
  (1060, 'assets/photos/master/5302010-B45.png'),   -- CTP-FWL-001-C
  (1061, 'assets/photos/master/5302410-B45-C00.png'),   -- CTP-FWL-002-C
  (1062, 'assets/photos/master/5302530-A01.png'),   -- CTP-FWL-003-C
  (1063, 'assets/photos/master/5302300-B45.png'),   -- CTP-FWL-004-C
  (1064, 'assets/photos/master/5302311-B45.png'),   -- CTP-FWL-005-C
  (1065, 'assets/photos/master/5302415-B45.png'),   -- CTP-FWL-006-L
  (1066, 'assets/photos/master/5302420-B45.png'),   -- CTP-FWL-007-R
  (1067, 'assets/photos/master/5302500-B45-C00.png'),   -- CTP-FWL-008-C
  (1068, 'assets/photos/master/5300010-B45.png'),   -- CTP-FWL-009-C
  (1069, 'assets/photos/master/5302051-B45.png'),   -- CTP-FWL-010-C
  (1070, 'assets/photos/master/5302053-B45.png'),   -- CTP-FWL-011-C
  (1071, 'assets/photos/master/5302056-B45.png'),   -- CTP-FWL-012-C
  (1072, 'assets/photos/master/5302071-B45.png'),   -- CTP-FWL-013-C
  (1073, 'assets/photos/master/5302155-B45.png'),   -- CTP-FWL-014-L
  (1074, 'assets/photos/master/5302160-B45.png'),   -- CTP-FWL-015-R
  (1075, 'assets/photos/master/5302221-A01.png'),   -- CTP-FWL-016-C
  (1076, 'assets/photos/master/5302591-B45.png'),   -- CTP-FWL-017-C
  (1077, 'assets/photos/master/5302621-B45.png'),   -- CTP-FWL-018-L
  (1078, 'assets/photos/master/5302622-B45.png'),   -- CTP-FWL-019-R
  (1079, 'assets/photos/master/5302801-B45.png'),   -- CTP-FWL-020-C
  (1080, 'assets/photos/master/6100015-B83.png'),   -- CTP-DOR-001-L
  (1081, 'assets/photos/master/6100020-B83.png'),   -- CTP-DOR-002-R
  (1082, 'assets/photos/master/6100031-B45.png'),   -- CTP-DOR-003-L   [pn-match]
  (1083, 'assets/photos/master/6100032-B45.png'),   -- CTP-DOR-004-R
  (1084, 'assets/photos/master/6101585-B83.png'),   -- CTP-DOR-005-L
  (1085, 'assets/photos/master/6101590-B83.png'),   -- CTP-DOR-006-R
  (1086, 'assets/photos/master/6102151-B45-C00.png'),   -- CTP-DOR-007-L
  (1087, 'assets/photos/master/6102152-B45-C00.png'),   -- CTP-DOR-008-R
  (1088, 'assets/photos/master/6102015-H02-C00.png'),   -- CTP-DOR-009-L
  (1089, 'assets/photos/master/6102020-H02-C00.png'),   -- CTP-DOR-010-R
  (1090, 'assets/photos/master/6104015AB45-C00.png'),   -- CTP-DOR-011-L
  (1091, 'assets/photos/master/6104020AB45-C00.png'),   -- CTP-DOR-012-R
  (1092, 'assets/photos/master/6105025AB45-C00.png'),   -- CTP-DOR-013-L
  (1093, 'assets/photos/master/6105030AB45-C00.png'),   -- CTP-DOR-014-R
  (1094, 'assets/photos/master/6105045-B45-C00.png'),   -- CTP-DOR-015-L
  (1095, 'assets/photos/master/6105050-B45-C00.png'),   -- CTP-DOR-016-R
  (1096, 'assets/photos/master/6106015-B45-C00.png'),   -- CTP-DOR-017-L
  (1097, 'assets/photos/master/6106020-B45-C00.png'),   -- CTP-DOR-018-R
  (1098, 'assets/photos/master/6106055-B45-C00.png'),   -- CTP-DOR-019-L
  (1099, 'assets/photos/master/6106060-B45-C00.png'),   -- CTP-DOR-020-R
  (1100, 'assets/photos/master/6109015-B45-C00.png'),   -- CTP-DOR-021-L
  (1101, 'assets/photos/master/6109015-B45-C00.png'),   -- CTP-DOR-022-R   [pn-match]
  (1102, 'assets/photos/master/8202015CB45-C00.png'),   -- CTP-MRR-001-L
  (1103, 'assets/photos/master/8202020CB45-C00.png'),   -- CTP-MRR-002-R
  (1104, 'assets/photos/master/8202061-B45-C00-G.png'),   -- CTP-MRR-003-L   [pn-match]
  (1105, 'assets/photos/master/8202062-B45-C00.png'),   -- CTP-MRR-004-R
  (1106, 'assets/photos/master/8219010-B45-C00.png'),   -- CTP-MRR-005-C
  (1107, 'assets/photos/master/8219020AB45-C00.png'),   -- CTP-MRR-006-C
  (1108, 'assets/photos/master/5103031-1063.png'),   -- CTP-STP-001-B
  (1109, 'assets/photos/master/5103021-1063.png'),   -- CTP-STP-002-L
  (1110, 'assets/photos/master/5103010-1544.png'),   -- CTP-STP-003-C
  (1111, 'assets/photos/master/5103022-1063.png'),   -- CTP-STP-004-R
  (1112, 'assets/photos/master/5103031-1063.png'),   -- CTP-STP-005-R   [pn-match]
  (1113, 'assets/photos/master/5103061-1063.png'),   -- CTP-STP-006-C
  (1114, 'assets/photos/master/5103052-1063.png'),   -- CTP-STP-007-C
  (1115, 'assets/photos/master/5103053-1063.png'),   -- CTP-STP-008-C
  (1116, 'assets/photos/master/5103361-1063.png'),   -- CTP-MUD-001-L
  (1117, 'assets/photos/master/5103362-1600.png'),   -- CTP-MUD-002-R
  (1118, 'assets/photos/master/5103385-1600.png'),   -- CTP-MUD-003-B
  (1119, 'assets/photos/master/5103373-1546.png'),   -- CTP-MUD-004-L
  (1120, 'assets/photos/master/5103374-1546.png'),   -- CTP-MUD-005-R
  (1121, 'assets/photos/master/5103510-1600.png'),   -- CTP-MUD-006-B
  (1122, 'assets/photos/master/5103510-1509.png'),   -- CTP-MUD-007-B
  (1123, 'assets/photos/master/5205010-B45-C00.png'),   -- CTP-WPR-001-C
  (1124, 'assets/photos/master/5207010-H02-C00.png'),   -- CTP-WPR-002-C
  (1126, 'assets/photos/master/5300010-B45.png'),   -- CTP-CBY-002-C   [pn-match]
  (1127, 'assets/photos/master/5201010-B45.png'),   -- CTP-CBY-003-C
  (1129, 'assets/photos/master/5600010-B45.png'),   -- CTP-CBY-005-C
  (1130, 'assets/photos/master/5700010-B45.png'),   -- CTP-CBY-006-C
  (1131, 'assets/photos/master/5400015-H02.png'),   -- CTP-CBY-007-L
  (1132, 'assets/photos/master/5400020-H02.png'),   -- CTP-CBY-008-R
  (1133, 'assets/photos/master/5401085-H02.png'),   -- CTP-CBY-009-L
  (1134, 'assets/photos/master/5401090-H02.png'),   -- CTP-CBY-010-R
  (1135, 'assets/photos/master/5704011-B45.png'),   -- CTP-DEF-001-C
  (1136, 'assets/photos/master/5704021-B45.png'),   -- CTP-DEF-002-C   [pn-match]
  (1137, 'assets/photos/master/5704031-B45.png'),   -- CTP-DEF-003-C
  (1138, 'assets/photos/master/5704081-B45.png'),   -- CTP-DEF-004-L
  (1139, 'assets/photos/master/5704082-B45.png'),   -- CTP-DEF-005-R
  (1140, 'assets/photos/master/5704111CB45.png'),   -- CTP-DEF-006-C
  (1141, 'assets/photos/master/5704116CB45.png'),   -- CTP-DEF-007-C
  (1142, 'assets/photos/master/5704130CB45.png'),   -- CTP-DEF-008-C
  (1143, 'assets/photos/master/5704145CB45.png'),   -- CTP-DEF-009-L
  (1144, 'assets/photos/master/5704150CB45.png'),   -- CTP-DEF-010-R
  (1145, 'assets/photos/master/5704175CB45.png'),   -- CTP-DEF-011-L
  (1146, 'assets/photos/master/5704180CB45.png'),   -- CTP-DEF-012-R
  (1147, 'assets/photos/master/5704190-H40.png'),   -- CTP-DEF-013-R
  (1148, 'assets/photos/master/5704211CB45.png'),   -- CTP-DEF-014-L
  (1149, 'assets/photos/master/5704212CB45.png'),   -- CTP-DEF-015-R
  (1150, 'assets/photos/master/5704221CB45.png'),   -- CTP-DEF-016-L
  (1151, 'assets/photos/master/5704222CB45.png'),   -- CTP-DEF-017-R
  (1152, 'assets/photos/master/5704231-H40.png'),   -- CTP-DEF-018-L   [pn-match]
  (1153, 'assets/photos/master/5704232-H40.png'),   -- CTP-DEF-019-R
  (1154, 'assets/photos/master/5704241-H40.png'),   -- CTP-DEF-020-L   [pn-match]
  (1155, 'assets/photos/master/5704242-H40.png'),   -- CTP-DEF-021-R   [pn-match]
  (1156, 'assets/photos/master/5704251-H40.png'),   -- CTP-DEF-022-L   [pn-match]
  (1157, 'assets/photos/master/5704262-H40.png'),   -- CTP-DEF-023-R
  (1158, 'assets/photos/master/5704281DB45.png'),   -- CTP-DEF-024-L
  (1159, 'assets/photos/master/5704282-H40.png'),   -- CTP-DEF-025-R
  (1160, 'assets/photos/master/5704283CB45.png'),   -- CTP-DEF-026-C
  (1161, 'assets/photos/master/8105010-1600-C00.png')   -- CTP-ACU-001-C
;

-- Every mapped part must still exist and be live, or the map is stale.
DO $$
DECLARE missing INT;
BEGIN
  SELECT count(*) INTO missing FROM cutout_map m
   WHERE NOT EXISTS (SELECT 1 FROM part p WHERE p.id = m.part_id AND p.deleted_at IS NULL);
  IF missing > 0 THEN
    RAISE EXCEPTION '% mapped part(s) missing or soft-deleted - regenerate 0018', missing;
  END IF;
END $$;

-- 1. Demote whatever was primary, EXCEPT the cutout itself. Excluding the
--    cutout is what makes a re-run safe: demote-then-insert would otherwise
--    strip the primary flag on the second pass and then skip the insert because
--    the row already exists, leaving the part with no primary image at all.
UPDATE part_image pi
   SET is_primary = 0,
       sort_order = GREATEST(pi.sort_order, 1),
       rev        = pi.rev + 1,
       updated_at = now()
  FROM cutout_map m
 WHERE pi.part_id    = m.part_id
   AND pi.deleted_at IS NULL
   AND pi.path      <> m.path
   AND pi.is_primary = 1;

-- 2. Add the cutout where it is not already there.
INSERT INTO part_image (part_id, path, kind, is_primary, sort_order)
SELECT m.part_id, m.path, 'photo', 1, 0
  FROM cutout_map m
 WHERE NOT EXISTS (
   SELECT 1 FROM part_image pi
    WHERE pi.part_id = m.part_id AND pi.path = m.path AND pi.deleted_at IS NULL);

-- 3. And make sure it is the primary one, for the re-run case where step 2
--    found it already present but demoted.
UPDATE part_image pi
   SET is_primary = 1,
       sort_order = 0,
       rev        = pi.rev + 1,
       updated_at = now()
  FROM cutout_map m
 WHERE pi.part_id    = m.part_id
   AND pi.path       = m.path
   AND pi.deleted_at IS NULL
   AND pi.is_primary <> 1;

DROP TABLE cutout_map;

-- ---------------------------------------------------------------------------
-- Verify. Aborts rather than reporting a success that is not one.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  n_cutout  INT;
  n_primary INT;
  n_double  INT;
  n_none    INT;
BEGIN
  SELECT count(*) INTO n_cutout
    FROM part_image WHERE deleted_at IS NULL AND path LIKE 'assets/photos/master/%';

  SELECT count(*) INTO n_primary
    FROM part_image WHERE deleted_at IS NULL AND is_primary = 1
                      AND path LIKE 'assets/photos/master/%';

  -- the invariant that actually matters: one primary per part, never two
  SELECT count(*) INTO n_double FROM (
    SELECT part_id FROM part_image WHERE deleted_at IS NULL AND is_primary = 1
     GROUP BY part_id HAVING count(*) > 1) d;

  SELECT count(*) INTO n_none FROM (
    SELECT part_id FROM part_image WHERE deleted_at IS NULL
     GROUP BY part_id HAVING count(*) FILTER (WHERE is_primary = 1) = 0) z;

  IF n_cutout  <> 159 THEN RAISE EXCEPTION 'cutout rows = %, expected 159', n_cutout; END IF;
  IF n_primary <> 159 THEN RAISE EXCEPTION 'cutouts primary = %, expected 159', n_primary; END IF;
  IF n_double  >  0   THEN RAISE EXCEPTION '% part(s) have more than one primary image', n_double; END IF;
  IF n_none    >  0   THEN RAISE EXCEPTION '% part(s) with images have no primary', n_none; END IF;

  RAISE NOTICE '0018 OK - % cutouts primary, one primary per part, raws demoted not deleted', n_primary;
END $$;

COMMIT;
