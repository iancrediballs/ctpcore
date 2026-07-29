-- ============================================================================
--  CTP Core — Diagram hotspots (clickable callouts -> part profiles)
--  hotspot(x,y) in image-pixel space; auto-imported from the CAD explorer
--  FIGS (marks) + PARTS (figure-local callout #) bridge. Section-overview
--  diagrams added too (annotate later in the editor).
-- ============================================================================
PRAGMA foreign_keys = ON;

ALTER TABLE diagram ADD COLUMN img_w INTEGER;
ALTER TABLE diagram ADD COLUMN img_h INTEGER;

CREATE TABLE hotspot (
  id INTEGER PRIMARY KEY,
  diagram_id INTEGER NOT NULL REFERENCES diagram(id) ON DELETE CASCADE,
  part_id    INTEGER REFERENCES part(id) ON DELETE CASCADE,
  item_no    TEXT,            -- figure-local callout number shown in the marker
  x REAL NOT NULL,            -- image-pixel coordinates (scale by img_w/img_h)
  y REAL NOT NULL,
  radius REAL NOT NULL DEFAULT 58,
  rev INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT, origin TEXT
);
CREATE INDEX hotspot_diagram_idx ON hotspot(diagram_id);
CREATE INDEX hotspot_part_idx ON hotspot(part_id);

-- diagram pixel dimensions (for hotspot coordinate scaling)
UPDATE diagram SET img_w=2657, img_h=2390 WHERE drawing_key='D212';
UPDATE diagram SET img_w=3027, img_h=2511 WHERE drawing_key='D216';
UPDATE diagram SET img_w=3080, img_h=2251 WHERE drawing_key='D217';
UPDATE diagram SET img_w=1275, img_h=2049 WHERE drawing_key='D267';
UPDATE diagram SET img_w=1868, img_h=1990 WHERE drawing_key='D276';
UPDATE diagram SET img_w=3467, img_h=2562 WHERE drawing_key='D298';
UPDATE diagram SET img_w=1803, img_h=2129 WHERE drawing_key='D306';
UPDATE diagram SET img_w=2828, img_h=2323 WHERE drawing_key='D307';
UPDATE diagram SET img_w=3144, img_h=2513 WHERE drawing_key='D314';
UPDATE diagram SET img_w=3001, img_h=1951 WHERE drawing_key='D319';
UPDATE diagram SET img_w=1860, img_h=2343 WHERE drawing_key='D322';
UPDATE diagram SET img_w=2319, img_h=2466 WHERE drawing_key='D325';
UPDATE diagram SET img_w=2524, img_h=2548 WHERE drawing_key='D331';
UPDATE diagram SET img_w=3088, img_h=2407 WHERE drawing_key='D332';
UPDATE diagram SET img_w=2105, img_h=2300 WHERE drawing_key='D333';
UPDATE diagram SET img_w=2514, img_h=2276 WHERE drawing_key='D339';
UPDATE diagram SET img_w=3273, img_h=2427 WHERE drawing_key='D368';
UPDATE diagram SET img_w=3036, img_h=2396 WHERE drawing_key='D373';
UPDATE diagram SET img_w=2761, img_h=2481 WHERE drawing_key='D374';
UPDATE diagram SET img_w=2299, img_h=2532 WHERE drawing_key='D375';
UPDATE diagram SET img_w=2816, img_h=2536 WHERE drawing_key='D378';
UPDATE diagram SET img_w=2938, img_h=2482 WHERE drawing_key='D379';
UPDATE diagram SET img_w=2367, img_h=2398 WHERE drawing_key='D381';
UPDATE diagram SET img_w=2852, img_h=2528 WHERE drawing_key='D383';
UPDATE diagram SET img_w=2776, img_h=2532 WHERE drawing_key='D392';
UPDATE diagram SET img_w=2823, img_h=2502 WHERE drawing_key='D394';
UPDATE diagram SET img_w=3251, img_h=2524 WHERE drawing_key='D396';
UPDATE diagram SET img_w=3006, img_h=2449 WHERE drawing_key='D397';
UPDATE diagram SET img_w=3032, img_h=2455 WHERE drawing_key='D398';
UPDATE diagram SET img_w=3038, img_h=2491 WHERE drawing_key='D400';

-- section-overview diagrams (16 compiled exploded views)
INSERT INTO diagram(drawing_key,title,section_code,make,model,image_path) VALUES
 ('SEC101','Front Bumper — overview','BMP','FAW','JH6','assets/diagrams/section_101.png'),
 ('SEC102','Chassis — overview','CHX','FAW','JH6','assets/diagrams/section_102.png'),
 ('SEC103','Lighting — overview','LGT','FAW','JH6','assets/diagrams/section_103.png'),
 ('SEC104','Cab Suspension — overview','SUS','FAW','JH6','assets/diagrams/section_104.png'),
 ('SEC105','Fender — overview','FND','FAW','JH6','assets/diagrams/section_105.png'),
 ('SEC106','Side Toolbox — overview','TBX','FAW','JH6','assets/diagrams/section_106.png'),
 ('SEC107','Cab Interior — overview','INT','FAW','JH6','assets/diagrams/section_107.png'),
 ('SEC108','Front Wall — overview','FWL','FAW','JH6','assets/diagrams/section_108.png'),
 ('SEC109','Front Door — overview','DOR','FAW','JH6','assets/diagrams/section_109.png'),
 ('SEC110','Mirror — overview','MRR','FAW','JH6','assets/diagrams/section_110.png'),
 ('SEC111','Steps & Trim — overview','STP','FAW','JH6','assets/diagrams/section_111.png'),
 ('SEC112','Mudguard — overview','MUD','FAW','JH6','assets/diagrams/section_112.png'),
 ('SEC113','Wiper — overview','WPR','FAW','JH6','assets/diagrams/section_113.png'),
 ('SEC114','Cab Body — overview','CBY','FAW','JH6','assets/diagrams/section_114.png'),
 ('SEC115','Roof Deflector — overview','DEF','FAW','JH6','assets/diagrams/section_115.png'),
 ('SEC116','Air Conditioning — overview','ACU','FAW','JH6','assets/diagrams/section_116.png');

-- auto hotspots: part (by name) on diagram D<fig> at (x,y), local callout item_no
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'1',1013.0,140.0 FROM diagram d JOIN part p ON p.name='Front Bumper L/H Assembly' WHERE d.drawing_key='D216';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'1',239.0,1866.0 FROM diagram d JOIN part p ON p.name='Front Bumper L/H Assembly' WHERE d.drawing_key='D216';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'2',1003.0,58.0 FROM diagram d JOIN part p ON p.name='Front Bumper R/H Assembly' WHERE d.drawing_key='D216';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'3',879.0,1457.0 FROM diagram d JOIN part p ON p.name='Front Bumper L/H Bracket Assembly' WHERE d.drawing_key='D216';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'6',218.0,200.0 FROM diagram d JOIN part p ON p.name='Front Bumper R/H Decorative Panel' WHERE d.drawing_key='D216';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'7',1076.0,850.0 FROM diagram d JOIN part p ON p.name='Front Bumper L/H Spoiler' WHERE d.drawing_key='D216';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'8',1082.0,958.0 FROM diagram d JOIN part p ON p.name='Front Bumper R/H Spoiler' WHERE d.drawing_key='D216';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'9',2700.0,655.0 FROM diagram d JOIN part p ON p.name='Front Bumper Centre Assembly' WHERE d.drawing_key='D216';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'10',2695.0,1518.0 FROM diagram d JOIN part p ON p.name='Front Bumper Centre Spoiler' WHERE d.drawing_key='D216';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'11',2965.0,1098.0 FROM diagram d JOIN part p ON p.name='Front Bumper Centre Mesh Screen' WHERE d.drawing_key='D216';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'12',2331.0,107.0 FROM diagram d JOIN part p ON p.name='Front Bumper Upper Mesh Screen' WHERE d.drawing_key='D216';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'13',2523.0,768.0 FROM diagram d JOIN part p ON p.name='Front Bumper Lower Tow Hook Cover' WHERE d.drawing_key='D216';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'26',1152.0,1289.0 FROM diagram d JOIN part p ON p.name='Spoiler L/H Connecting Bracket' WHERE d.drawing_key='D216';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'27',2372.0,1305.0 FROM diagram d JOIN part p ON p.name='Spoiler R/H Connecting Bracket' WHERE d.drawing_key='D216';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'28',1707.0,1205.0 FROM diagram d JOIN part p ON p.name='Spoiler Centre Connecting Bracket' WHERE d.drawing_key='D216';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'28',2097.0,1242.0 FROM diagram d JOIN part p ON p.name='Spoiler Centre Connecting Bracket' WHERE d.drawing_key='D216';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'30',278.0,803.0 FROM diagram d JOIN part p ON p.name='Front Bumper Intake Grille Assembly' WHERE d.drawing_key='D217';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'31',383.0,1271.0 FROM diagram d JOIN part p ON p.name='Front Bumper Bug Shield' WHERE d.drawing_key='D217';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'32',2493.0,291.0 FROM diagram d JOIN part p ON p.name='Front Bumper Primary Step' WHERE d.drawing_key='D217';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'33',2631.0,1563.0 FROM diagram d JOIN part p ON p.name='Front Bumper Centre Lower L/H Decorative Panel' WHERE d.drawing_key='D217';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'34',1554.0,1533.0 FROM diagram d JOIN part p ON p.name='Front Bumper Centre Lower R/H Decorative Panel' WHERE d.drawing_key='D217';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'1',204.0,1643.0 FROM diagram d JOIN part p ON p.name='Front Crossmember Assembly' WHERE d.drawing_key='D212';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'6',795.0,1496.0 FROM diagram d JOIN part p ON p.name='Front Spring Front Bracket Crossmember Welding Assembly' WHERE d.drawing_key='D212';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'1',50.0,317.0 FROM diagram d JOIN part p ON p.name='Front Combination Lamp L/H Assembly' WHERE d.drawing_key='D267';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'1',50.0,317.0 FROM diagram d JOIN part p ON p.name='Front Combination Lamp R/H Assembly' WHERE d.drawing_key='D267';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'1',129.0,974.0 FROM diagram d JOIN part p ON p.name='Front Fog Lamp L/H Assembly' WHERE d.drawing_key='D276';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'1',129.0,974.0 FROM diagram d JOIN part p ON p.name='Front Fog Lamp R/H Assembly' WHERE d.drawing_key='D276';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'1',3045.0,125.0 FROM diagram d JOIN part p ON p.name='Cab Hydraulic Lock Assembly R/H' WHERE d.drawing_key='D298';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'2',2302.0,573.0 FROM diagram d JOIN part p ON p.name='Rear Suspension Air Spring & Shock Absorber Assembly R/H' WHERE d.drawing_key='D298';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'1',231.0,199.0 FROM diagram d JOIN part p ON p.name='Front Fender L/H' WHERE d.drawing_key='D314';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'2',232.0,292.0 FROM diagram d JOIN part p ON p.name='Front Fender R/H' WHERE d.drawing_key='D314';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'3',51.0,499.0 FROM diagram d JOIN part p ON p.name='Secondary Step' WHERE d.drawing_key='D314';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'4',574.0,77.0 FROM diagram d JOIN part p ON p.name='Tertiary Step' WHERE d.drawing_key='D314';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'4',1365.0,938.0 FROM diagram d JOIN part p ON p.name='Tertiary Step' WHERE d.drawing_key='D314';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'8',2298.0,618.0 FROM diagram d JOIN part p ON p.name='Front Wheel Upper Splash Shield L/H' WHERE d.drawing_key='D314';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'9',2294.0,721.0 FROM diagram d JOIN part p ON p.name='Front Wheel Upper Splash Shield R/H' WHERE d.drawing_key='D314';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'9',1644.0,1591.0 FROM diagram d JOIN part p ON p.name='Front Wheel Upper Splash Shield R/H' WHERE d.drawing_key='D314';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'11',1031.0,1882.0 FROM diagram d JOIN part p ON p.name='Upper Splash Shield Small Door' WHERE d.drawing_key='D314';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'4',2799.0,328.0 FROM diagram d JOIN part p ON p.name='L/H Door Sill Scuff Plate' WHERE d.drawing_key='D383';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'3',527.0,1106.0 FROM diagram d JOIN part p ON p.name='Side Toolbox Sealing Strip L/H' WHERE d.drawing_key='D325';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'3',527.0,1106.0 FROM diagram d JOIN part p ON p.name='Side Toolbox Sealing Strip R/H' WHERE d.drawing_key='D325';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'10',2462.0,293.0 FROM diagram d JOIN part p ON p.name='Front Pillar Guard Assembly L/H' WHERE d.drawing_key='D332';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'11',997.0,174.0 FROM diagram d JOIN part p ON p.name='Front Pillar Guard Assembly R/H' WHERE d.drawing_key='D332';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'12',2883.0,1014.0 FROM diagram d JOIN part p ON p.name='Front Pillar L/H Lower Hinge Guard' WHERE d.drawing_key='D332';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'12',2883.0,1014.0 FROM diagram d JOIN part p ON p.name='Front Pillar R/H Lower Hinge Guard' WHERE d.drawing_key='D332';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'7',147.0,1416.0 FROM diagram d JOIN part p ON p.name='L/H Handrail Cover A' WHERE d.drawing_key='D332';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'8',51.0,1293.0 FROM diagram d JOIN part p ON p.name='R/H Handrail Cover A' WHERE d.drawing_key='D332';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'9',1188.0,1603.0 FROM diagram d JOIN part p ON p.name='Windshield Lower Trim Panel Assembly' WHERE d.drawing_key='D332';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'4',1976.0,1352.0 FROM diagram d JOIN part p ON p.name='Gas Spring Assembly — Front Wall' WHERE d.drawing_key='D333';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'4',1367.0,1499.0 FROM diagram d JOIN part p ON p.name='Gas Spring Assembly — Front Wall' WHERE d.drawing_key='D333';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'1',967.0,1998.0 FROM diagram d JOIN part p ON p.name='Gas Spring Lower Mount Bracket Link Assembly' WHERE d.drawing_key='D331';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'2',714.0,1707.0 FROM diagram d JOIN part p ON p.name='Gas Spring Lower Mount Bracket Link Base' WHERE d.drawing_key='D331';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'2',1332.0,1863.0 FROM diagram d JOIN part p ON p.name='Gas Spring Lower Mount Bracket Link Base' WHERE d.drawing_key='D331';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'3',1420.0,1679.0 FROM diagram d JOIN part p ON p.name='L/H Handrail Bracket Assembly' WHERE d.drawing_key='D331';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'4',199.0,1771.0 FROM diagram d JOIN part p ON p.name='R/H Handrail Bracket Assembly' WHERE d.drawing_key='D331';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'2',376.0,351.0 FROM diagram d JOIN part p ON p.name='Front Door Rear Frame Trim Cover L/H' WHERE d.drawing_key='D374';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'2',376.0,351.0 FROM diagram d JOIN part p ON p.name='Front Door Rear Frame Trim Cover R/H' WHERE d.drawing_key='D374';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'8',2270.0,692.0 FROM diagram d JOIN part p ON p.name='Front Door Window Frame Upper Protective Panel L/H' WHERE d.drawing_key='D374';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'8',2270.0,692.0 FROM diagram d JOIN part p ON p.name='Front Door Window Frame Upper Protective Panel R/H' WHERE d.drawing_key='D374';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'8',1441.0,837.0 FROM diagram d JOIN part p ON p.name='Front Door Electric Window Lift Module Assembly L/H' WHERE d.drawing_key='D375';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'8',1441.0,837.0 FROM diagram d JOIN part p ON p.name='Front Door Electric Window Lift Module Assembly R/H' WHERE d.drawing_key='D375';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'4',1275.0,260.0 FROM diagram d JOIN part p ON p.name='Front Door Electric Lock Assembly L/H' WHERE d.drawing_key='D378';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'4',1275.0,260.0 FROM diagram d JOIN part p ON p.name='Front Door Electric Lock Assembly R/H' WHERE d.drawing_key='D378';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'2',1059.0,1332.0 FROM diagram d JOIN part p ON p.name='Front Door Handle Assembly L/H' WHERE d.drawing_key='D378';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'2',1059.0,1332.0 FROM diagram d JOIN part p ON p.name='Front Door Handle Assembly R/H' WHERE d.drawing_key='D378';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'2',1376.0,1015.0 FROM diagram d JOIN part p ON p.name='Front Door Upper Hinge Assembly L/H' WHERE d.drawing_key='D379';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'2',1376.0,1015.0 FROM diagram d JOIN part p ON p.name='Front Door Upper Hinge Assembly R/H' WHERE d.drawing_key='D379';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'3',1200.0,1800.0 FROM diagram d JOIN part p ON p.name='Front Door Lower Hinge Assembly L/H' WHERE d.drawing_key='D379';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'3',1200.0,1800.0 FROM diagram d JOIN part p ON p.name='Front Door Lower Hinge Assembly R/H' WHERE d.drawing_key='D379';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'2',2274.0,773.0 FROM diagram d JOIN part p ON p.name='Front Door Limiter Assembly L/H' WHERE d.drawing_key='D381';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'2',736.0,1082.0 FROM diagram d JOIN part p ON p.name='Front Door Limiter Assembly L/H' WHERE d.drawing_key='D381';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'1',266.0,140.0 FROM diagram d JOIN part p ON p.name='Outer Rearview Mirror Assembly L/H — Electric' WHERE d.drawing_key='D394';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'1',2282.0,1400.0 FROM diagram d JOIN part p ON p.name='Outer Rearview Mirror Assembly L/H — Electric' WHERE d.drawing_key='D394';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'2',2278.0,1523.0 FROM diagram d JOIN part p ON p.name='Outer Rearview Mirror Assembly R/H — Electric' WHERE d.drawing_key='D394';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'1',1152.0,543.0 FROM diagram d JOIN part p ON p.name='Top View Mirror Assembly' WHERE d.drawing_key='D396';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'3',3092.0,294.0 FROM diagram d JOIN part p ON p.name='Front Lower View Mirror Assembly' WHERE d.drawing_key='D396';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'3',73.0,1885.0 FROM diagram d JOIN part p ON p.name='Front Lower View Mirror Assembly' WHERE d.drawing_key='D396';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'1',2957.0,566.0 FROM diagram d JOIN part p ON p.name='Primary Step' WHERE d.drawing_key='D397';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'2',1724.0,474.0 FROM diagram d JOIN part p ON p.name='Step Decorative Cover L/H' WHERE d.drawing_key='D397';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'4',2235.0,92.0 FROM diagram d JOIN part p ON p.name='Step Decorative Cover R/H' WHERE d.drawing_key='D398';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'4',1885.0,1213.0 FROM diagram d JOIN part p ON p.name='Step Decorative Cover R/H' WHERE d.drawing_key='D398';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'6',525.0,977.0 FROM diagram d JOIN part p ON p.name='Step Decorative Cover Small Door' WHERE d.drawing_key='D398';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'7',488.0,1676.0 FROM diagram d JOIN part p ON p.name='Step Decorative Cover Small Door Fixing Bracket' WHERE d.drawing_key='D398';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'7',684.0,1678.0 FROM diagram d JOIN part p ON p.name='Step Decorative Cover Small Door Fixing Bracket' WHERE d.drawing_key='D398';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'3',2223.0,1063.0 FROM diagram d JOIN part p ON p.name='Rear Mudguard Bracket Assembly' WHERE d.drawing_key='D400';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'4',2319.0,117.0 FROM diagram d JOIN part p ON p.name='L/H Rear Mudguard Bracket Fixing Seat' WHERE d.drawing_key='D400';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'6',1351.0,865.0 FROM diagram d JOIN part p ON p.name='Front Wheel Rear Mudguard Fixing Bracket Assembly' WHERE d.drawing_key='D400';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'1',638.0,1149.0 FROM diagram d JOIN part p ON p.name='Windscreen Wiper Assembly' WHERE d.drawing_key='D319';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'1',1589.0,1612.0 FROM diagram d JOIN part p ON p.name='Windscreen Washer Assembly' WHERE d.drawing_key='D322';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'1',480.0,125.0 FROM diagram d JOIN part p ON p.name='Front Wall Welding Assembly — Inner Board' WHERE d.drawing_key='D307';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'1',638.0,1149.0 FROM diagram d JOIN part p ON p.name='Windshield Upper Crossbeam Assembly' WHERE d.drawing_key='D319';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'3',1036.0,1595.0 FROM diagram d JOIN part p ON p.name='R/H Side Outer Panel Assembly' WHERE d.drawing_key='D392';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'3',1036.0,1595.0 FROM diagram d JOIN part p ON p.name='L/H Side Inner Panel Assembly' WHERE d.drawing_key='D392';
INSERT INTO hotspot(diagram_id,part_id,item_no,x,y) SELECT d.id,p.id,'2',88.0,1808.0 FROM diagram d JOIN part p ON p.name='R/H Side Inner Panel Assembly' WHERE d.drawing_key='D392';
