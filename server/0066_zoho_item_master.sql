-- CTP Core 0066 — Zoho Inventory is the item / parts master (23 Oct 2026).
--
-- Ian: "Zoho is now the item master". New parts are added in Zoho; CTP's "Pull & apply"
-- (zoho-sync, apply) creates them here. Existing codes are unchanged: the part no. is the
-- Zoho SKU, as before.
--   * One category, "New from Zoho" (code NEW), holds parts that arrive this way until the desk
--     files them into a section (Zoho has no CTP section/diagram data).
--   * zoho_new_part() (server only): allocates the part id, inserts part + list price + landed
--     cost, and links the Zoho item, all in one transaction. Idempotent on SKU: a part that
--     already exists is only linked.
begin;

insert into public.category (id, code, name, path)
select coalesce((select max(id) from public.category), 100) + 1, 'NEW', 'New from Zoho', 'NEW'
 where not exists (select 1 from public.category where code = 'NEW');

-- p: { item_id, sku, name, rate_minor, purchase_rate_minor, description? }
create or replace function public.zoho_new_part(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_sku text := btrim(p->>'sku'); v_id bigint; v_cat bigint; v_existing bigint;
        v_rate bigint := nullif(p->>'rate_minor', '')::bigint; v_cost bigint := nullif(p->>'purchase_rate_minor', '')::bigint;
begin
  if auth.uid() is not null then
    raise exception 'zoho_new_part is called by the server, not from a session.' using errcode = '42501';
  end if;
  if coalesce(v_sku, '') = '' then raise exception 'a Zoho item needs a SKU (part no.) to become a CTP part'; end if;
  select id into v_existing from part where upper(btrim(sku)) = upper(v_sku) and deleted_at is null limit 1;
  if v_existing is not null then
    update zoho_item set part_id = v_existing where zoho_item_id = p->>'item_id' and part_id is null;
    return jsonb_build_object('part_id', v_existing, 'sku', v_sku, 'created', false);
  end if;
  select id into v_cat from category where code = 'NEW';
  lock table part in share row exclusive mode;   -- the id is max+1: no two syncs take the same one
  select coalesce(max(id), 1000) + 1 into v_id from part;
  insert into part (id, sku, name, category_id, description, status, list_price_minor, origin)
  values (v_id, v_sku, coalesce(nullif(btrim(p->>'name'), ''), v_sku), v_cat, nullif(p->>'description', ''), 'active',
          case when v_rate > 0 then v_rate end, 'zoho-sync');
  if v_rate > 0 then
    insert into price (part_id, tier, currency, amount_minor, valid_from, origin) values (v_id, 'list', 'ZAR', v_rate, now(), 'zoho-sync');
  end if;
  if v_cost > 0 then
    insert into part_cost (part_id, currency, amount_minor, valid_from, source, basis, origin)
    values (v_id, 'ZAR', v_cost, now(), 'Zoho Purchase Rate (new item)', 'landed', 'zoho-sync');
  end if;
  update zoho_item set part_id = v_id where zoho_item_id = p->>'item_id';
  return jsonb_build_object('part_id', v_id, 'sku', v_sku, 'created', true);
end $$;
revoke all on function public.zoho_new_part(jsonb) from public, anon, authenticated;
grant execute on function public.zoho_new_part(jsonb) to service_role;

commit;
