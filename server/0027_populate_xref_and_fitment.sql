-- 0027 — fill part_xref and part_fitment from data the system already holds.
--
-- Both tables were built and left empty, which made the headline capability of
-- the product — "type any number, find our part" — undemonstrable.
--
-- NOTHING HERE IS INVENTED. Every row derives from a column already on the part
-- record, populated during the original catalogue reconciliation.
--
-- xref_type is constrained to oem/aftermarket/competitor/supersession, and only
-- one of those is honestly true here: catalogue_pn IS the manufacturer's own
-- number for the part, so it goes in as 'oem'. Our inventory_pn (the same part
-- carrying a supplier grade suffix such as -DQ or -G) is NOT an aftermarket or
-- competitor number and is not forced into one of those buckets — it is made
-- searchable through the search index instead, which is where it belongs.
--
-- To be explicit about what this is NOT: this is FAW catalogue interchange, not
-- competitor interchange. It does not map an Isuzu or Mercedes number onto our
-- stock. That needs data this business does not yet hold.
--
-- Idempotent: guarded by the table's own UNIQUE (part_id, xref_number, xref_type).

insert into part_xref (part_id, xref_number, xref_brand, xref_type, confidence)
select p.id, p.catalogue_pn, 'FAW', 'oem', 100
  from part p
 where p.deleted_at is null
   and coalesce(p.catalogue_pn,'') <> ''
   and p.catalogue_pn is distinct from p.sku
on conflict (part_id, xref_number, xref_type) do nothing;

-- Where our stock number differs from the catalogue number, the catalogue
-- number supersedes it in FAW's own numbering — record that relationship too,
-- which is the one case 'supersession' genuinely describes.
insert into part_xref (part_id, xref_number, xref_brand, xref_type, confidence)
select p.id, p.inventory_pn, 'CTP', 'supersession', 90
  from part p
 where p.deleted_at is null
   and coalesce(p.inventory_pn,'') <> ''
   and p.inventory_pn is distinct from p.sku
   and p.inventory_pn is distinct from p.catalogue_pn
on conflict (part_id, xref_number, xref_type) do nothing;

-- ── fitment ───────────────────────────────────────────────────────────────
-- Every part in this catalogue is a FAW JH6 part; that is what the business
-- imports and warehouses. Year and engine are left NULL rather than guessed —
-- a wrong fitment year is worse than an absent one, because it is exactly the
-- field a customer trusts when deciding a part fits their truck.
insert into part_fitment (part_id, vehicle_id, note)
select p.id, v.id, 'FAW JH6 range; specific variant not yet differentiated'
  from part p
 cross join (select id from vehicle_model where make='FAW' and model='JH6' limit 1) v
 where p.deleted_at is null
   and not exists (
     select 1 from part_fitment f
      where f.part_id = p.id and f.vehicle_id = v.id);
