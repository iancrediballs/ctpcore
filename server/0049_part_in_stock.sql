-- 0049_part_in_stock.sql — customers see in stock / out of stock, never a number.
--
-- Approved by Ian 2026-09-20. A customer's device never syncs stock_movement
-- (the ledger reveals sales volumes), so the answer is derived HERE, once,
-- into one boolean on the part row: part.in_stock. The customer bucket in
-- sync-streams.yaml lists it explicitly next to the other part columns; the
-- number itself still never leaves the server.
--
-- Definition: in_stock = AVAILABLE across every location > 0, where
-- available is stock_position's (0046): on_hand minus what is held for
-- accepted orders. A part that is on the shelf but entirely spoken for reads
-- "out of stock" to the next customer — which is what the counter would say.
-- (Assumption made here; flip the reason filter below if Ian wants shelf.)
--
-- Kept current by a row trigger on the ledger (the ledger is append-only, so
-- INSERT is the only event), and backfilled once below. The trigger is
-- SECURITY DEFINER because the counter's role holds INSERT on stock_movement
-- but no UPDATE on part.
--
-- REVERSE: drop trigger part_in_stock_refresh on stock_movement;
--          drop function part_in_stock_refresh(); alter table part drop column in_stock;
--          and take the column out of the customer bucket in sync-streams.yaml.

begin;

alter table public.part add column if not exists in_stock boolean not null default false;
comment on column public.part.in_stock is
  'Derived: available stock (on hand minus holds) across all locations > 0. Maintained by trigger on stock_movement (0049). The only stock fact a customer device receives.';

create or replace function public.part_in_stock_refresh()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_now boolean;
begin
  select coalesce(sum(m.delta), 0) > 0 into v_now
    from stock_movement m where m.part_id = new.part_id;
  update part p
     set in_stock = v_now, updated_at = now()
   where p.id = new.part_id and p.in_stock is distinct from v_now;
  return null;
end $$;
revoke all on function public.part_in_stock_refresh() from public;

drop trigger if exists part_in_stock_refresh on public.stock_movement;
create trigger part_in_stock_refresh
  after insert on public.stock_movement
  for each row execute function public.part_in_stock_refresh();

-- Backfill: every part, once.
update public.part p
   set in_stock = coalesce(s.avail, 0) > 0
  from (select part_id, sum(delta) as avail from public.stock_movement group by part_id) s
 where s.part_id = p.id and p.in_stock is distinct from (coalesce(s.avail, 0) > 0);

commit;

-- VERIFY:
--   select count(*) filter (where in_stock) as in_stock, count(*) as parts from part where deleted_at is null;
--   select p.id, p.sku, p.in_stock, coalesce(sum(m.delta),0) avail from part p left join stock_movement m on m.part_id=p.id
--    group by p.id having p.in_stock <> (coalesce(sum(m.delta),0) > 0);   -- expect no rows
