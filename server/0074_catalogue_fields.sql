-- 0074 (24 Oct 2026, docs/12 item 2): catalogue fields for scale, Zoho native fields first.
--   make     = Zoho item Manufacturer (FAW)          → part.make   (exists)
--   model    = Zoho item Brand (JH6)                 → part.model  (exists)
--   type     = OEM / Aftermarket                     → part.part_type (new; Zoho custom field
--              "Part type" if Anton adds one — read as cf_part_type — else 'OEM', since every
--              item today is an FAW original)
--   supplier = Zoho item preferred vendor            → part.supplier (new; STAFF ONLY)
-- Filled from the Inventory item list zoho-push already reads every 15 minutes (stock_sync);
-- a part row is touched only when a value changed. Customers see make / model / type, never the
-- supplier (column not granted over the Data API; not in their PowerSync stream).
begin;

alter table public.part add column if not exists part_type text;
alter table public.part add column if not exists supplier text;
do $$ begin
  alter table public.part add constraint part_type_check check (part_type is null or part_type in ('OEM', 'Aftermarket'));
exception when duplicate_object then null; end $$;

-- column grants (0073): part_type readable, supplier not
grant select (part_type) on public.part to authenticated;

-- p_items: [{ item_id, manufacturer, brand, vendor_name, part_type }]
create or replace function public.apply_zoho_catalogue(p_items jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare n int := 0;
begin
  if auth.uid() is not null then
    raise exception 'apply_zoho_catalogue is called by the server, not from a session.' using errcode = '42501';
  end if;
  with x as (
    select e->>'item_id' as item_id, nullif(btrim(e->>'manufacturer'), '') as make, nullif(btrim(e->>'brand'), '') as model,
           nullif(btrim(e->>'vendor_name'), '') as supplier,
           case when lower(btrim(coalesce(e->>'part_type', ''))) like 'after%' then 'Aftermarket'
                when lower(btrim(coalesce(e->>'part_type', ''))) = 'oem' then 'OEM' end as part_type
      from jsonb_array_elements(p_items) e
  ), v as (
    select z.part_id, coalesce(x.make, p.make) as make, coalesce(x.model, p.model) as model, x.supplier,
           coalesce(x.part_type, p.part_type, 'OEM') as part_type
      from x join zoho_item z on z.zoho_item_id = x.item_id and z.status = 'active'
      join part p on p.id = z.part_id
  )
  update part p set make = v.make, model = v.model, supplier = v.supplier, part_type = v.part_type, updated_at = now()
    from v
   where p.id = v.part_id
     and (p.make is distinct from v.make or p.model is distinct from v.model
          or p.supplier is distinct from v.supplier or p.part_type is distinct from v.part_type);
  get diagnostics n = row_count;
  return jsonb_build_object('parts_changed', n);
end $$;
revoke all on function public.apply_zoho_catalogue(jsonb) from public, anon, authenticated;
grant execute on function public.apply_zoho_catalogue(jsonb) to service_role;

commit;
