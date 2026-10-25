-- 0087 (QA sweep, 26 Oct): server/0048_stock_guard.sql (approved by Ian 2026-09-20) was never
-- applied on live, so negative stock was only blocked on the phone. Applied verbatim as 0087.

-- 0048_stock_guard.sql — the shelf cannot go below zero.
--
-- A BEFORE INSERT trigger on the ledger refuses any movement that would take
-- a part's ON-HAND at that location below zero. Approved by Ian 2026-09-20.
--
-- What it guards, precisely: on_hand as stock_position (0047) defines it —
-- the sum of every movement EXCEPT 'reserve' and 'release'. Reservations are
-- a different quantity (they reduce AVAILABLE, not the shelf) and are never
-- blocked here: a customer may accept a quote for more than is on the shelf
-- and the desk sees a backorder; it is fulfil_order that refuses to hand
-- over what is not there, and this trigger is the backstop under it.
--
-- Only NEGATIVE deltas are tested, so a row that is already below zero can
-- always be corrected UPWARD: +1 brings it to 0 and passes; a further −1 would
-- be refused. (The Radiator Grille was at −1 while this was designed; Ian's
-- test-order reversal of 2026-09-20 cleared it, so the case is no longer
-- live — the rule stays because it is the right one.) Nothing is rewritten.
--
-- Concurrency: two counter people issuing the same part at once are
-- serialised on an advisory lock per (part, location) for the length of the
-- transaction, so both cannot pass the check on the same stale sum.
--
-- The message is written for the counter, not for a DBA, and carries a
-- fixed SQLSTATE ('CT001') so the sync layer can tell "refused on purpose"
-- from "the network dropped" and stop retrying it.
--
-- REVERSE: drop trigger stock_movement_guard on stock_movement;
--          drop function stock_movement_guard();

begin;

create or replace function public.stock_movement_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_on_hand bigint; v_part text; v_loc text;
begin
  -- Stock coming in, and holds either way, are never refused.
  if new.delta >= 0 or new.reason in ('reserve', 'release') then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('stock:' || new.part_id || ':' || new.location_id));
  select coalesce(sum(m.delta), 0) into v_on_hand
    from stock_movement m
   where m.part_id = new.part_id and m.location_id = new.location_id
     and m.reason not in ('reserve', 'release');
  if v_on_hand + new.delta < 0 then
    select coalesce(nullif(p.name, ''), p.sku) into v_part from part p where p.id = new.part_id;
    select coalesce(nullif(l.name, ''), l.code) into v_loc from location l where l.id = new.location_id;
    raise exception 'Cannot take % × % out of %: only % on the shelf. Count the shelf and book what you find first (a receipt or an adjustment), then try again.',
      -new.delta, coalesce(v_part, 'part ' || new.part_id), coalesce(v_loc, 'location ' || new.location_id), greatest(v_on_hand, 0)
      using errcode = 'CT001', hint = 'The stock ledger is never allowed below zero.';
  end if;
  return new;
end $$;
revoke all on function public.stock_movement_guard() from public;

drop trigger if exists stock_movement_guard on public.stock_movement;
create trigger stock_movement_guard
  before insert on public.stock_movement
  for each row execute function public.stock_movement_guard();

comment on trigger stock_movement_guard on public.stock_movement is
  'Refuses a negative movement that would take on_hand (shelf, excluding reserve/release) below zero at that location. Positive movements always pass, so an already-negative row can be corrected upward. SQLSTATE CT001 (0048).';

commit;

-- VERIFY:
--   select part_id, location_id, on_hand from stock_position where on_hand < 0;   -- the Grille, until corrected
--   insert into stock_movement (part_id, location_id, delta, reason, client_uuid)
--     values (1072, 1, -1, 'sale', 'verify-should-fail');   -- expect: Cannot take 1 × Radiator Grille out of ...
