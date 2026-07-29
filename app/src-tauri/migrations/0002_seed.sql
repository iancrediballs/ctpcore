-- ============================================================================
--  FleetView ERP — sample data (realistic Chinese commercial-truck parts)
--  Heavy-duty trucks: Sinotruk HOWO, Shacman, FAW, Dongfeng; Weichai engines.
--  Enough cross-references + fitment + stock to make the Phase-0 search demo
--  feel like a real parts counter.
-- ============================================================================

INSERT INTO category (id, code, name, path) VALUES
 (1,'FILT','Filtration','filtration'),
 (2,'FUEL','Fuel System','fuel-system'),
 (3,'BRAKE','Braking','braking'),
 (4,'ENG','Engine','engine'),
 (5,'DRV','Driveline','driveline'),
 (6,'ELEC','Electrical','electrical'),
 (7,'COOL','Cooling','cooling');

INSERT INTO brand (id, code, name, is_oem) VALUES
 (1,'BOSCH','Bosch',0),
 (2,'MANN','Mann-Filter',0),
 (3,'FLG','Fleetguard',0),
 (4,'KNORR','Knorr-Bremse',0),
 (5,'SACHS','Sachs',0),
 (6,'HOLSET','Holset',0),
 (7,'SINO','Sinotruk',1),
 (8,'WEICHAI','Weichai',1);

INSERT INTO location (id, code, name) VALUES
 (1,'MAIN','Main Warehouse'),
 (2,'SHOP','Counter / Shop Floor');

INSERT INTO vehicle_model (id, make, model, variant) VALUES
 (1,'Sinotruk','HOWO A7',''),
 (2,'Sinotruk','HOWO T7H',''),
 (3,'Shacman','X3000',''),
 (4,'FAW','J6',''),
 (5,'Dongfeng','KL','');

-- ---------------------------------------------------------------- parts -----
INSERT INTO part (id, sku, mpn, brand_id, category_id, name, description, weight_g) VALUES
 (1 ,'FV-FUEL-0445120','VG1560080276',1,2,'Common Rail Fuel Injector','Bosch common-rail injector for Weichai WD615 EFI',1850),
 (2 ,'FV-FILT-VG1540','VG1540070007',3,1,'Oil Filter, Spin-on','Full-flow lube spin-on filter',1100),
 (3 ,'FV-FILT-K2841','WG9725190102',2,1,'Air Filter Element','Primary air filter element, radial seal',900),
 (4 ,'FV-FILT-FS19732','FS19732',3,2,'Fuel / Water Separator','Spin-on fuel/water separator with bowl',1300),
 (5 ,'FV-BRK-T2430','WG9000360523',4,3,'Brake Chamber T24/30','Spring brake chamber, rear axle',5400),
 (6 ,'FV-BRK-PAD7H','WG9100440010',4,3,'Disc Brake Pad Set, Front','Front axle disc pad set, WVA 29202',6800),
 (7 ,'FV-DRV-CL430','WG9725160100',5,5,'Clutch Disc 430mm','Organic clutch driven disc, 430mm',7200),
 (8 ,'FV-ENG-HX40W','4051092',6,4,'Turbocharger HX40W','Holset HX40W turbo for WD615',9100),
 (9 ,'FV-COOL-WP307','612600060307',8,7,'Water Pump Assembly','Coolant pump assembly, Weichai',3200),
 (10,'FV-ELEC-ST24','VG1560090001',1,6,'Starter Motor 24V','24V 7.5kW reduction starter',9800),
 (11,'FV-ELEC-ALT28','VG1560090002',1,6,'Alternator 28V 55A','28V 55A brushless alternator',6100),
 (12,'FV-DRV-SHK','WG9725680020',5,5,'Shock Absorber, Rear','Rear suspension gas shock',2400);

-- --------------------------------------------------- cross-references -------
-- xref_type: oem | aftermarket | competitor | supersession
INSERT INTO part_xref (part_id, xref_number, xref_brand, xref_type, confidence) VALUES
 (1,'VG1560080276','Sinotruk','oem',100),
 (1,'0445120123','Bosch','aftermarket',100),
 (1,'0445120224','Generic','competitor',90),
 (1,'VG1560080179','Sinotruk','supersession',100),
 (2,'VG1540070007','Sinotruk','oem',100),
 (2,'W11102/36','Mann-Filter','aftermarket',100),
 (2,'LF3349','Fleetguard','aftermarket',100),
 (2,'JX0810','Generic','competitor',85),
 (3,'WG9725190102','Sinotruk','oem',100),
 (3,'C331840','Mann-Filter','aftermarket',100),
 (3,'AF26393','Fleetguard','competitor',90),
 (4,'FS19732','Fleetguard','aftermarket',100),
 (4,'R90T','Parker','oem',95),
 (4,'PS7079','Generic','competitor',80),
 (5,'WG9000360523','Sinotruk','oem',100),
 (5,'II37156','Knorr-Bremse','aftermarket',100),
 (6,'WG9100440010','Sinotruk','oem',100),
 (6,'29202','Knorr-Bremse','aftermarket',100),
 (7,'WG9725160100','Sinotruk','oem',100),
 (7,'1878634567','Sachs','aftermarket',100),
 (8,'612600118895','Weichai','oem',100),
 (8,'4051092','Holset','aftermarket',100),
 (8,'3787794','Generic','competitor',80),
 (9,'612600060307','Weichai','oem',100),
 (9,'VG1500060051','Sinotruk','aftermarket',95),
 (10,'VG1560090001','Sinotruk','oem',100),
 (10,'0001241014','Bosch','aftermarket',100),
 (11,'VG1560090002','Sinotruk','oem',100),
 (11,'0124655009','Bosch','aftermarket',100),
 (12,'WG9725680020','Sinotruk','oem',100),
 (12,'313875','Sachs','aftermarket',100);

-- ----------------------------------------------------------- fitment --------
INSERT INTO part_fitment (part_id, vehicle_id, engine, year_from, year_to) VALUES
 (1,1,'WD615',2007,2018),(1,2,'WP10',2015,2024),
 (2,1,'WD615',2007,2018),(2,2,'WP10',2015,2024),(2,3,'WP12',2014,2024),
 (3,1,'',2007,2018),(3,2,'',2015,2024),
 (4,1,'',2007,2018),(4,2,'',2015,2024),(4,3,'',2014,2024),
 (5,1,'',2007,2018),(5,2,'',2015,2024),(5,3,'',2014,2024),(5,4,'',2012,2022),
 (6,2,'',2015,2024),(6,3,'',2014,2024),
 (7,1,'',2007,2018),(7,2,'',2015,2024),
 (8,1,'WD615',2007,2018),
 (9,1,'WD615',2007,2018),(9,2,'WP10',2015,2024),
 (10,1,'',2007,2018),(10,2,'',2015,2024),
 (11,1,'',2007,2018),(11,2,'',2015,2024),
 (12,1,'',2007,2018),(12,2,'',2015,2024);

-- ------------------------------------------- stock ledger (append-only) -----
-- on-hand is SUM(delta); two parts intentionally low/empty for the demo.
INSERT INTO stock_movement (part_id, location_id, delta, reason, client_uuid) VALUES
 (1,1, 24,'receipt','seed-0001'),(1,1,-3,'sale','seed-0002'),(1,1,-1,'sale','seed-0003'),
 (2,1,120,'receipt','seed-0004'),(2,1,-15,'sale','seed-0005'),
 (3,1, 40,'receipt','seed-0006'),(3,1,-8,'sale','seed-0007'),
 (4,1, 60,'receipt','seed-0008'),(4,1,-55,'sale','seed-0009'),
 (5,1, 16,'receipt','seed-0010'),(5,1,-4,'sale','seed-0011'),
 (6,1, 30,'receipt','seed-0012'),(6,1,-30,'sale','seed-0013'),
 (7,1, 10,'receipt','seed-0014'),(7,1,-2,'sale','seed-0015'),
 (8,1,  6,'receipt','seed-0016'),(8,1,-1,'sale','seed-0017'),
 (9,1, 14,'receipt','seed-0018'),(9,1,-2,'sale','seed-0019'),
 (10,1, 8,'receipt','seed-0020'),(10,1,-1,'sale','seed-0021'),
 (11,1, 9,'receipt','seed-0022'),
 (12,1,50,'receipt','seed-0023'),(12,1,-6,'sale','seed-0024');

INSERT INTO stock_policy (part_id, location_id, bin, reorder_point, reorder_qty) VALUES
 (4,1,'A-12-3',10,50),
 (6,1,'C-04-1', 5,30),
 (1,1,'A-01-2', 6,24);

-- ------------------------------------------------- pricing (cents) ----------
INSERT INTO price (part_id, tier, amount_minor) VALUES
 (1,'list',18500),(2,'list',1200),(3,'list',3400),(4,'list',2800),
 (5,'list',4500),(6,'list',6900),(7,'list',12500),(8,'list',89000),
 (9,'list',7600),(10,'list',21000),(11,'list',19500),(12,'list',4200);
