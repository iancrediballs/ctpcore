-- 0072 (24 Oct 2026, docs/12 items 1 + 3): price-book-aware pricing.
--
--   * price_book / price_book_item: a STAFF-ONLY cache of the Zoho price books customers are on
--     (zoho-push pricebook_sync; refreshed after a book is built or assigned, and hourly with the
--     status read-back). Zoho stays the price source: CTP never invents a rebate.
--   * order_prices(order): per line, the list price and the customer's book rate. Staff also get
--     cost, the 0041 margin floor and the tier — a customer gets only list + their own book rate,
--     only for their own order (never cost, floor or anyone else's book).
--   * my_prices(part_ids): a logged-in customer ON A PRICE BOOK sees, for those parts, the list
--     price (struck through in the app) and their rebate price. Customers without a book get
--     nothing (they are quoted, as today).
begin;

create table if not exists public.price_book (
  pricebook_id text primary key,
  name text not null,
  synced_at timestamptz not null default now()
);
create table if not exists public.price_book_item (
  pricebook_id text not null references public.price_book (pricebook_id) on delete cascade,
  zoho_item_id text not null,
  part_id bigint references public.part (id),
  rate_minor bigint not null,
  synced_at timestamptz not null default now(),
  primary key (pricebook_id, zoho_item_id)
);
create index if not exists price_book_item_part on public.price_book_item (pricebook_id, part_id);

alter table public.price_book enable row level security;
alter table public.price_book_item enable row level security;
revoke all on public.price_book, public.price_book_item from anon, authenticated;
grant select on public.price_book, public.price_book_item to authenticated;
drop policy if exists price_book_staff on public.price_book;
create policy price_book_staff on public.price_book for select to authenticated using (public.is_staff());
drop policy if exists price_book_item_staff on public.price_book_item;
create policy price_book_item_staff on public.price_book_item for select to authenticated using (public.is_staff());

-- one book from Zoho: { pricebook_id, name, pricebook_items: [{ item_id, pricebook_rate }] }
create or replace function public.apply_price_book(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id text := nullif(p->>'pricebook_id', ''); v_n int; v_gone int;
begin
  if auth.uid() is not null then
    raise exception 'apply_price_book is called by the server, not from a session.' using errcode = '42501';
  end if;
  if v_id is null then raise exception 'pricebook_id is required' using errcode = '22023'; end if;
  insert into price_book (pricebook_id, name, synced_at) values (v_id, coalesce(p->>'name', v_id), now())
  on conflict (pricebook_id) do update set name = excluded.name, synced_at = now();
  with src as (
    select x->>'item_id' as item_id, round((x->>'pricebook_rate')::numeric * 100)::bigint as rate
      from jsonb_array_elements(coalesce(p->'pricebook_items', '[]'::jsonb)) x
     where coalesce(x->>'item_id', '') <> '' and coalesce(x->>'pricebook_rate', '') <> ''
  ), up as (
    insert into price_book_item (pricebook_id, zoho_item_id, part_id, rate_minor, synced_at)
    select v_id, s.item_id, (select z.part_id from zoho_item z where z.zoho_item_id = s.item_id limit 1), s.rate, now() from src s
    on conflict (pricebook_id, zoho_item_id) do update set part_id = excluded.part_id, rate_minor = excluded.rate_minor, synced_at = now()
    returning 1
  ) select count(*) into v_n from up;
  delete from price_book_item i where i.pricebook_id = v_id
     and not exists (select 1 from jsonb_array_elements(coalesce(p->'pricebook_items', '[]'::jsonb)) x where x->>'item_id' = i.zoho_item_id);
  get diagnostics v_gone = row_count;
  return jsonb_build_object('pricebook_id', v_id, 'items', v_n, 'removed', v_gone);
end $$;
revoke all on function public.apply_price_book(jsonb) from public, anon, authenticated;
grant execute on function public.apply_price_book(jsonb) to service_role;

-- per line of one order: list + book (everyone allowed to see the order); cost, floor (staff only)
create or replace function public.order_prices(p_order_id bigint)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_o record; v_staff boolean := public.is_staff(); v_tier text;
begin
  select so.id, so.customer_id, c.zoho_pricebook_id as book, c.zoho_pricebook_name as book_name, coalesce(c.price_tier, 'list') as tier
    into v_o from sales_order so join customer c on c.id = so.customer_id
   where so.id = p_order_id and so.deleted_at is null;
  if v_o.id is null then raise exception 'No such order.' using errcode = '42704'; end if;
  if not v_staff and public.my_customer_id() is distinct from v_o.customer_id then
    raise exception 'That order belongs to a different customer.' using errcode = '42501';
  end if;
  return jsonb_build_object('order_id', v_o.id, 'pricebook', v_o.book_name, 'lines', coalesce((
    select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'line_id', sl.id, 'part_id', sl.part_id,
             'list_minor', (select pr.amount_minor from price pr where pr.part_id = sl.part_id and pr.tier = 'list' and pr.deleted_at is null
                             order by pr.valid_from desc limit 1),
             'book_minor', (select i.rate_minor from price_book_item i where i.pricebook_id = v_o.book and i.part_id = sl.part_id limit 1),
             'cost_minor', case when v_staff then (select cc.cost_invoiced_minor from part_current_cost cc where cc.part_id = sl.part_id) end,
             'floor_minor', case when v_staff then public.price_floor_minor(sl.part_id, coalesce(sl.tier_at_add, v_o.tier)) end))
           order by sl.id)
      from sales_line sl where sl.order_id = v_o.id and sl.deleted_at is null), '[]'::jsonb));
end $$;
revoke all on function public.order_prices(bigint) from public, anon;
grant execute on function public.order_prices(bigint) to authenticated;

-- a logged-in customer on a price book: list + their rebate price for these parts (book parts only)
create or replace function public.my_prices(p_part_ids bigint[])
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_object_agg(i.part_id::text, jsonb_build_object('book_minor', i.rate_minor,
           'list_minor', (select pr.amount_minor from price pr where pr.part_id = i.part_id and pr.tier = 'list' and pr.deleted_at is null
                           order by pr.valid_from desc limit 1))), '{}'::jsonb)
    from customer c
    join price_book_item i on i.pricebook_id = c.zoho_pricebook_id
   where c.id = public.my_customer_id() and c.deleted_at is null
     and i.part_id = any (p_part_ids)
$$;
revoke all on function public.my_prices(bigint[]) from public, anon;
grant execute on function public.my_prices(bigint[]) to authenticated;

commit;
