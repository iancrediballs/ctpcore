-- 0073 (24 Oct 2026, docs/12 item 4): public / walk-in protection, enforced on the server.
--
-- The PowerSync customer stream already lists safe columns only. The Data API did not: a logged-in
-- customer could `select *` from part (list_price_minor, bins, Zoho stock figures, rebate caps),
-- their own customer row (staff notes, price tier) and their lines (rebate override details).
--   * Column grants: `authenticated` reads every column EXCEPT the internal ones below. Staff are
--     unaffected in practice — they read these through PowerSync (SELECT *) and SECURITY DEFINER
--     RPCs, and edge functions use the service role. Writes (UPDATE) are untouched.
--   * anon / authenticated lose TRUNCATE, TRIGGER and REFERENCES on every public table (never
--     needed; TRUNCATE ignores RLS).
--   * public_parts(q): what a logged-out visitor (future public site) may see — parts, OEM number,
--     make / model, section, in stock yes/no. No prices, no cost, no stock numbers.
--   * Walk-in / cash customers have no login: they are served from the staff screen only.
begin;

create or replace function pg_temp.grant_all_but(p_table text, p_hidden text[])
returns void language plpgsql as $$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = p_table and column_name <> all (p_hidden);
  execute format('revoke select on public.%I from authenticated, anon', p_table);
  execute format('grant select (%s) on public.%I to authenticated', cols, p_table);
end $$;

select pg_temp.grant_all_but('part', array['list_price_minor', 'locator', 'inventory_pn', 'notes', 'match_status',
  'max_rebate_pct', 'origin', 'zoho_item_id', 'zoho_stock_on_hand', 'zoho_available_for_sale', 'zoho_committed', 'zoho_stock_at']);
select pg_temp.grant_all_but('customer', array['notes', 'price_tier', 'rebate_pct', 'origin']);
select pg_temp.grant_all_but('sales_line', array['tier_at_add', 'rebate_ceiling_pct', 'rebate_override_by',
  'rebate_override_label', 'rebate_override_at', 'origin']);

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('revoke truncate, trigger, references on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- logged-out catalogue: no prices, ever
create or replace function public.public_parts(p_q text default null, p_limit int default 50)
returns table (id bigint, sku text, name text, catalogue_pn text, make text, model text, section text, in_stock boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  -- in stock yes/no from the ledger (0049's part.in_stock is not on live); never the number
  select p.id, p.sku, p.name, p.catalogue_pn, p.make, p.model, c.name,
         coalesce((select sum(m.delta) from stock_movement m where m.part_id = p.id), 0) > 0
    from part p left join category c on c.id = p.category_id
   where p.deleted_at is null and coalesce(p.status, 'active') = 'active'
     and (nullif(btrim(p_q), '') is null
          or p.name ilike '%' || p_q || '%' or p.sku ilike '%' || p_q || '%' or p.catalogue_pn ilike '%' || p_q || '%')
   order by p.name
   limit least(greatest(coalesce(p_limit, 50), 1), 200)
$$;
revoke all on function public.public_parts(text, int) from public;
grant execute on function public.public_parts(text, int) to anon, authenticated;

commit;
