-- ============================================================================
--  CTP Core — editable List Price (ZAR) per part, back-filled from master.
-- ============================================================================
PRAGMA foreign_keys = ON;

ALTER TABLE part ADD COLUMN list_price_minor INTEGER;

DROP VIEW IF EXISTS part_detail;
CREATE VIEW part_detail AS
SELECT
  p.id, p.sku, p.locator, p.name, p.description, p.side,
  p.make, p.model, p.drawing_no, p.diagram_item_no,
  p.catalogue_pn, p.inventory_pn, p.mpn, p.match_status, p.notes,
  p.list_price_minor,
  c.code AS category_code, c.name AS category_name,
  p.status,
  COALESCE((SELECT SUM(delta) FROM stock_movement WHERE part_id=p.id),0) AS qty_on_hand,
  (SELECT bin FROM stock_policy WHERE part_id=p.id LIMIT 1) AS bin,
  (SELECT amount_minor FROM price WHERE part_id=p.id AND tier='list' AND currency='USD'
        ORDER BY valid_from DESC LIMIT 1) AS price_usd_minor,
  (SELECT amount_minor FROM price WHERE part_id=p.id AND tier='list' AND currency='ZAR'
        ORDER BY valid_from DESC LIMIT 1) AS price_zar_minor,
  (SELECT path FROM part_image WHERE part_id=p.id AND deleted_at IS NULL
        ORDER BY is_primary DESC, sort_order LIMIT 1) AS primary_image,
  (SELECT glb_path FROM part_model WHERE part_id=p.id AND deleted_at IS NULL LIMIT 1) AS model_3d,
  (SELECT d.image_path FROM part_diagram_callout pdc JOIN diagram d ON d.id=pdc.diagram_id
        WHERE pdc.part_id=p.id ORDER BY pdc.is_primary DESC LIMIT 1) AS diagram_image,
  (SELECT pdc.item_no FROM part_diagram_callout pdc
        WHERE pdc.part_id=p.id ORDER BY pdc.is_primary DESC LIMIT 1) AS diagram_item
FROM part p JOIN category c ON c.id=p.category_id
WHERE p.deleted_at IS NULL;

-- back-fill list prices (ZAR minor units) from the master sheet
UPDATE part SET list_price_minor=683442 WHERE id=1001;
UPDATE part SET list_price_minor=375929 WHERE id=1002;
UPDATE part SET list_price_minor=464252 WHERE id=1003;
UPDATE part SET list_price_minor=464705 WHERE id=1004;
UPDATE part SET list_price_minor=30398 WHERE id=1005;
UPDATE part SET list_price_minor=91906 WHERE id=1006;
UPDATE part SET list_price_minor=45281 WHERE id=1007;
UPDATE part SET list_price_minor=636062 WHERE id=1008;
UPDATE part SET list_price_minor=922507 WHERE id=1009;
UPDATE part SET list_price_minor=10757 WHERE id=1010;
UPDATE part SET list_price_minor=49649 WHERE id=1011;
UPDATE part SET list_price_minor=1436 WHERE id=1012;
UPDATE part SET list_price_minor=1436 WHERE id=1013;
UPDATE part SET list_price_minor=101467 WHERE id=1016;
UPDATE part SET list_price_minor=73861 WHERE id=1017;
UPDATE part SET list_price_minor=88733 WHERE id=1018;
UPDATE part SET list_price_minor=20762 WHERE id=1019;
UPDATE part SET list_price_minor=89616 WHERE id=1020;
UPDATE part SET list_price_minor=36543 WHERE id=1023;
UPDATE part SET list_price_minor=1416744 WHERE id=1024;
UPDATE part SET list_price_minor=154198 WHERE id=1025;
UPDATE part SET list_price_minor=140180 WHERE id=1026;
UPDATE part SET list_price_minor=65705 WHERE id=1027;
UPDATE part SET list_price_minor=4082 WHERE id=1028;
UPDATE part SET list_price_minor=960 WHERE id=1029;
UPDATE part SET list_price_minor=361508 WHERE id=1030;
UPDATE part SET list_price_minor=286533 WHERE id=1031;
UPDATE part SET list_price_minor=198716 WHERE id=1032;
UPDATE part SET list_price_minor=27816 WHERE id=1033;
UPDATE part SET list_price_minor=91986 WHERE id=1034;
UPDATE part SET list_price_minor=67930 WHERE id=1035;
UPDATE part SET list_price_minor=65852 WHERE id=1036;
UPDATE part SET list_price_minor=125876 WHERE id=1037;
UPDATE part SET list_price_minor=3258 WHERE id=1038;
UPDATE part SET list_price_minor=97543 WHERE id=1039;
UPDATE part SET list_price_minor=83042 WHERE id=1040;
UPDATE part SET list_price_minor=26522 WHERE id=1041;
UPDATE part SET list_price_minor=83835 WHERE id=1042;
UPDATE part SET list_price_minor=7400 WHERE id=1043;
UPDATE part SET list_price_minor=6183 WHERE id=1044;
UPDATE part SET list_price_minor=52422 WHERE id=1045;
UPDATE part SET list_price_minor=61578 WHERE id=1046;
UPDATE part SET list_price_minor=870953 WHERE id=1047;
UPDATE part SET list_price_minor=34414 WHERE id=1048;
UPDATE part SET list_price_minor=28670 WHERE id=1049;
UPDATE part SET list_price_minor=39923 WHERE id=1050;
UPDATE part SET list_price_minor=81945 WHERE id=1051;
UPDATE part SET list_price_minor=81945 WHERE id=1052;
UPDATE part SET list_price_minor=20561 WHERE id=1053;
UPDATE part SET list_price_minor=31583 WHERE id=1054;
UPDATE part SET list_price_minor=8775 WHERE id=1055;
UPDATE part SET list_price_minor=28827 WHERE id=1056;
UPDATE part SET list_price_minor=4784 WHERE id=1057;
UPDATE part SET list_price_minor=176523 WHERE id=1058;
UPDATE part SET list_price_minor=7480 WHERE id=1059;
UPDATE part SET list_price_minor=227482 WHERE id=1060;
UPDATE part SET list_price_minor=70639 WHERE id=1061;
UPDATE part SET list_price_minor=59383 WHERE id=1062;
UPDATE part SET list_price_minor=53172 WHERE id=1063;
UPDATE part SET list_price_minor=6210 WHERE id=1064;
UPDATE part SET list_price_minor=4269 WHERE id=1065;
UPDATE part SET list_price_minor=156156 WHERE id=1066;
UPDATE part SET list_price_minor=151156 WHERE id=1067;
UPDATE part SET list_price_minor=50159 WHERE id=1068;
UPDATE part SET list_price_minor=60159 WHERE id=1069;
UPDATE part SET list_price_minor=94390 WHERE id=1070;
UPDATE part SET list_price_minor=45484 WHERE id=1071;
UPDATE part SET list_price_minor=45484 WHERE id=1072;
UPDATE part SET list_price_minor=227441 WHERE id=1073;
UPDATE part SET list_price_minor=5344 WHERE id=1074;
UPDATE part SET list_price_minor=11385 WHERE id=1075;
UPDATE part SET list_price_minor=55269 WHERE id=1076;
UPDATE part SET list_price_minor=55269 WHERE id=1077;
UPDATE part SET list_price_minor=437115 WHERE id=1078;
UPDATE part SET list_price_minor=36516 WHERE id=1079;
UPDATE part SET list_price_minor=52121 WHERE id=1080;
UPDATE part SET list_price_minor=52723 WHERE id=1081;
UPDATE part SET list_price_minor=68155 WHERE id=1082;
UPDATE part SET list_price_minor=25992 WHERE id=1083;
UPDATE part SET list_price_minor=28506 WHERE id=1084;
UPDATE part SET list_price_minor=115696 WHERE id=1085;
UPDATE part SET list_price_minor=114935 WHERE id=1086;
UPDATE part SET list_price_minor=313639 WHERE id=1087;
UPDATE part SET list_price_minor=203840 WHERE id=1088;
UPDATE part SET list_price_minor=7866 WHERE id=1089;
UPDATE part SET list_price_minor=7866 WHERE id=1090;
UPDATE part SET list_price_minor=6459 WHERE id=1091;
UPDATE part SET list_price_minor=7947 WHERE id=1092;
UPDATE part SET list_price_minor=7888 WHERE id=1093;
UPDATE part SET list_price_minor=20724 WHERE id=1094;
UPDATE part SET list_price_minor=14860 WHERE id=1095;
UPDATE part SET list_price_minor=9380 WHERE id=1096;
UPDATE part SET list_price_minor=8933 WHERE id=1097;
UPDATE part SET list_price_minor=320721 WHERE id=1098;
UPDATE part SET list_price_minor=451853 WHERE id=1099;
UPDATE part SET list_price_minor=145000 WHERE id=1100;
UPDATE part SET list_price_minor=145000 WHERE id=1101;
UPDATE part SET list_price_minor=298339 WHERE id=1102;
UPDATE part SET list_price_minor=29669 WHERE id=1103;
UPDATE part SET list_price_minor=23288 WHERE id=1104;
UPDATE part SET list_price_minor=54596 WHERE id=1105;
UPDATE part SET list_price_minor=75038 WHERE id=1106;
