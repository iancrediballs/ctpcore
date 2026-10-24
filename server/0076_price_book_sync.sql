-- 0076 (24 Oct 2026, Ian: "no rebate and no strikethrough"): price books on the device.
--
-- Until now the rebate was read online, one order or one part at a time (0072 order_prices /
-- my_prices), so search, browse and the cart never showed it. This puts the book rows in the
-- PowerSync streams:
--   * staff (ctp_staff) get every book, so search shows "Hermans rebate" even with no customer
--     picked;
--   * a customer on a book (ctp_client_book) gets ONLY their own book's rows — the bucket is
--     parameterised on customer.auth_user_id, exactly like their orders.
-- A customer has no `price` table, so each book row carries the part's current list price
-- (list_minor) for the strikethrough. Triggers keep it current when a list price changes.
--
-- PowerSync needs a single text `id` per row. These are ordinary columns filled by trigger, not
-- GENERATED columns: logical replication before Postgres 18 does not publish generated columns.
-- Zoho prices are not touched: this only reshapes what CTP already caches.
begin;

alter table public.price_book add column if not exists id text;
alter table public.price_book_item add column if not exists id text;
alter table public.price_book_item add column if not exists list_minor bigint;

create or replace function public.list_price_minor(p_part_id bigint)
returns bigint language sql stable security definer set search_path = public, pg_temp as $$
  select pr.amount_minor from price pr
   where pr.part_id = p_part_id and pr.tier = 'list' and pr.deleted_at is null
   order by pr.valid_from desc limit 1
$$;
revoke all on function public.list_price_minor(bigint) from public, anon, authenticated;

create or replace function public.price_book_ids() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_table_name = 'price_book' then
    new.id := new.pricebook_id;
  else
    new.id := new.pricebook_id || ':' || new.zoho_item_id;
    new.list_minor := case when new.part_id is null then null else public.list_price_minor(new.part_id) end;
  end if;
  return new;
end $$;
drop trigger if exists price_book_ids on public.price_book;
create trigger price_book_ids before insert or update on public.price_book
  for each row execute function public.price_book_ids();
drop trigger if exists price_book_item_ids on public.price_book_item;
create trigger price_book_item_ids before insert or update on public.price_book_item
  for each row execute function public.price_book_ids();

-- a list price changed → the book rows for that part follow (touches only rows that differ)
create or replace function public.price_book_list_follow() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_part bigint := coalesce(new.part_id, old.part_id);
begin
  update price_book_item i set list_minor = public.list_price_minor(v_part)
   where i.part_id = v_part and i.list_minor is distinct from public.list_price_minor(v_part);
  return null;
end $$;
drop trigger if exists price_book_list_follow on public.price;
create trigger price_book_list_follow after insert or update or delete on public.price
  for each row execute function public.price_book_list_follow();

-- backfill (fires the trigger: id + list_minor)
update public.price_book set name = name;
update public.price_book_item set rate_minor = rate_minor;
alter table public.price_book alter column id set not null;
alter table public.price_book_item alter column id set not null;
create unique index if not exists price_book_id_key on public.price_book (id);
create unique index if not exists price_book_item_id_key on public.price_book_item (id);

-- Online fallback for a customer (before the sync rules are deployed, or a slow first sync):
-- their own book only, resolved from their login. Customers without a book get [].
create or replace function public.my_price_book()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('pricebook_id', i.pricebook_id, 'name', b.name, 'part_id', i.part_id,
           'book_minor', i.rate_minor, 'list_minor', i.list_minor)), '[]'::jsonb)
    from customer c
    join price_book b on b.pricebook_id = c.zoho_pricebook_id
    join price_book_item i on i.pricebook_id = b.pricebook_id
   where c.id = public.my_customer_id() and c.deleted_at is null and i.part_id is not null
$$;
revoke all on function public.my_price_book() from public, anon;
grant execute on function public.my_price_book() to authenticated;

commit;
