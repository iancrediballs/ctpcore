-- ============================================================================
--  CTP Core — Section diagrams as the part-panel diagram (migration 0010)
--  Ian's compiled per-CATEGORY exploded views (section_101..116.png) become
--  THE diagram shown in the item window. The diagram = the part's category
--  section (category.id == section number 101-116). The item badge = the
--  'New Item No.' from the master inventory sheet (part.diagram_ref, TEXT so
--  it can hold refs like 'A1'/'B22'). Sections 101-112 populated here;
--  113-116 refs to follow (image still shows via category).
-- ============================================================================

ALTER TABLE part ADD COLUMN diagram_ref TEXT;   -- section-relative item no (text)

-- 122 item refs (sections 101-112)
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

-- Rebuild part_detail so the panel diagram = the category's section view,
-- and the item badge = the section item ref (text).
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
  (SELECT amount_minor FROM price WHERE part_id=p.id AND tier='list' AND currency='USD'
        ORDER BY valid_from DESC LIMIT 1) AS price_usd_minor,
  (SELECT amount_minor FROM price WHERE part_id=p.id AND tier='list' AND currency='ZAR'
        ORDER BY valid_from DESC LIMIT 1) AS price_zar_minor,
  (SELECT path     FROM part_image WHERE part_id=p.id AND deleted_at IS NULL
        ORDER BY is_primary DESC, sort_order LIMIT 1) AS primary_image,
  (SELECT glb_path FROM part_model WHERE part_id=p.id AND deleted_at IS NULL LIMIT 1) AS model_3d,
  -- panel diagram = this part's CATEGORY section view (category.id == section number)
  (SELECT d.image_path FROM diagram d WHERE d.drawing_key='SEC'||p.category_id LIMIT 1) AS diagram_image,
  p.diagram_ref AS diagram_item
FROM part p
JOIN category c ON c.id = p.category_id
WHERE p.deleted_at IS NULL;
