-- 0046_reservations.sql — stock reserved on acceptance, on the ledger.
--
-- THE MODEL. Two new reasons on the append-only stock_movement ledger:
--   reserve   delta = −qty   written when the customer accepts (0047 accept_quote,
--                            after the Zoho sales order exists)
--   release   delta = +qty   written when the hold ends: cancelled, or the
--                            goods leave (fulfil_order)
-- Nothing is ever deleted or updated. From these:
--   on_hand   = SUM(delta) over every reason EXCEPT reserve/release
--   reserved  = −SUM(delta) over reserve/release        (0 when all released)
--   available = on_hand − reserved = SUM(delta) over EVERYTHING
-- So a reservation lowers what can be promised without lowering what is on
-- the shelf, and the whole history is on the ledger like every other move.
-- Collection writes release +qty (the hold ends) and sale −qty (the goods
-- go) — two rows, both visible, both idempotent on client_uuid.
--
-- READERS. public.stock_position is the one place the three figures are
-- defined; every server function reads it. The web app's local SQL (which
-- summed all rows as "on hand") now excludes the two reasons — see
-- backend.web.ts. The desktop is a separate database and unaffected.
--
-- ACCEPTANCE ALWAYS RESERVES, even past zero. A customer's acceptance is a
-- promise we made; if the shelf cannot cover it, available goes negative and
-- the desk shows the shortfall as a backorder rather than refusing the
-- customer. fulfil_order still refuses to take goods that are not there.
--
-- Payment is Zoho Books' business now (Ian, 2026-09-20): nothing here reads
-- or gates on a payment. The accept path itself is in 0047.
--
-- REVERSE: drop the view and the functions; re-run 0021 for respond_to_quote
-- and 0042 for fulfil_order; leave the reason CHECK widened (rows may exist)
-- or release them first.

begin;

alter table public.stock_movement drop constraint if exists stock_movement_reason_check;
alter table public.stock_movement add constraint stock_movement_reason_check
  check (reason in ('receipt','sale','adjustment','transfer','return','count','reserve','release'));

create or replace view public.stock_position as
  select m.part_id, m.location_id,
         coalesce(sum(m.delta) filter (where m.reason not in ('reserve','release')), 0)::int as on_hand,
         coalesce(-sum(m.delta) filter (where m.reason in ('reserve','release')), 0)::int   as reserved,
         coalesce(sum(m.delta), 0)::int                                                     as available
    from public.stock_movement m
   group by m.part_id, m.location_id;
grant select on public.stock_position to authenticated;
comment on view public.stock_position is 'on_hand = shelf; reserved = active holds (reserve − release); available = on_hand − reserved. The single definition (0047).';

-- What THIS order still holds, per part (reserve − release for its ref).
create or replace function public.order_reserved(p_order_id bigint)
returns table (part_id bigint, qty int)
language sql stable security definer set search_path = public, pg_temp as $$
  select m.part_id, (-sum(m.delta))::int
    from stock_movement m
   where m.ref_type = 'sales_order' and m.ref_id = p_order_id and m.reason in ('reserve','release')
   group by m.part_id
  having -sum(m.delta) > 0;
$$;

-- Reserve every line of an order at its location. Idempotent per line.
create or replace function public.reserve_order(p_order_id bigint)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare v_o record; v_n int; v_actor uuid;
begin
  select id, location_id into v_o from sales_order where id = p_order_id and deleted_at is null;
  if v_o.id is null then return 0; end if;
  select au.id into v_actor from app_user au where au.id = auth.uid();
  insert into stock_movement (part_id, location_id, delta, reason, ref_type, ref_id, actor_id, actor_source, client_uuid, origin)
  select sl.part_id, v_o.location_id, -sl.qty, 'reserve', 'sales_order', v_o.id,
         v_actor, case when v_actor is null then null else 'server_session' end,
         'so-' || v_o.id || '-line-' || sl.id || '-reserve', 'server'
    from sales_line sl where sl.order_id = v_o.id and sl.deleted_at is null
  on conflict (client_uuid) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Release whatever the order still holds, tagged with why. Idempotent: a
-- second call finds nothing held and writes nothing.
create or replace function public.release_order(p_order_id bigint, p_why text)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare v_o record; v_n int; v_actor uuid;
begin
  select id, location_id into v_o from sales_order where id = p_order_id;
  if v_o.id is null then return 0; end if;
  select au.id into v_actor from app_user au where au.id = auth.uid();
  insert into stock_movement (part_id, location_id, delta, reason, ref_type, ref_id, actor_id, actor_source, client_uuid, origin)
  select r.part_id, v_o.location_id, r.qty, 'release', 'sales_order', v_o.id,
         v_actor, case when v_actor is null then null else 'server_session' end,
         'so-' || v_o.id || '-part-' || r.part_id || '-release-' || p_why || '-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS'), 'server'
    from public.order_reserved(v_o.id) r;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    update sales_order set notes = concat_ws(E'\n', nullif(notes, ''),
      format('[%s] Stock hold released: %s', to_char(now() at time zone 'Africa/Johannesburg', 'YYYY-MM-DD HH24:MI'), p_why)), updated_at = now()
     where id = v_o.id;
  end if;
  return v_n;
end $$;

-- ── staff cancel a quote or an accepted order: the hold is released ──
create or replace function public.cancel_order(order_id bigint, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_o record; v_rel int;
begin
  if not is_staff() then raise exception 'Only staff can cancel an order.' using errcode = '42501'; end if;
  select id, number, status into v_o from sales_order where id = cancel_order.order_id and deleted_at is null for update;
  if v_o.id is null then raise exception 'No such order.' using errcode = '42704'; end if;
  if v_o.status not in ('quote', 'confirmed') then
    raise exception '% is % — only a quote or an accepted order can be cancelled.', v_o.number, v_o.status using errcode = '22023';
  end if;
  v_rel := public.release_order(v_o.id, 'cancelled: ' || coalesce(nullif(btrim(p_reason), ''), 'no reason given'));
  update sales_order set status = 'cancelled', updated_at = now(),
         notes = concat_ws(E'\n', nullif(notes, ''), format('[%s] Cancelled by staff: %s', to_char(now() at time zone 'Africa/Johannesburg', 'YYYY-MM-DD HH24:MI'), coalesce(nullif(btrim(p_reason), ''), 'no reason given')))
   where id = v_o.id;
  return jsonb_build_object('order_id', v_o.id, 'number', v_o.number, 'status', 'cancelled', 'released', v_rel);
end $$;
revoke all on function public.cancel_order(bigint, text) from public, anon;
grant execute on function public.cancel_order(bigint, text) to authenticated;

-- ── fulfil: release the hold and take the goods; the check is against the SHELF ──
create or replace function public.fulfil_order(order_id bigint)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_o        record;
  v_short    text;
  v_written  int;
  v_actor    uuid;
begin
  if not is_staff() then
    raise exception 'Only staff can fulfil an order.' using errcode = '42501';
  end if;
  select so.id, so.number, so.status, so.location_id, so.fulfilled_at, l.deleted_at as loc_deleted
    into v_o
    from sales_order so left join location l on l.id = so.location_id
   where so.id = fulfil_order.order_id and so.deleted_at is null
     for update of so;
  if v_o.id is null then raise exception 'No such order.' using errcode = '42704'; end if;
  if v_o.status = 'fulfilled' or v_o.status = 'invoiced' then
    return jsonb_build_object('order_id', v_o.id, 'number', v_o.number, 'status', v_o.status,
                              'fulfilled_at', v_o.fulfilled_at, 'movements', 0, 'already', true);
  end if;
  if v_o.status <> 'confirmed' then
    raise exception '% is %, not accepted — only an accepted order can be fulfilled.', v_o.number, v_o.status using errcode = '22023';
  end if;
  -- Whether it is PAID is read in Zoho Books by the person handing the goods
  -- over; CTP Core does not hold the payment (Ian, 2026-09-20).
  if v_o.loc_deleted is not null then
    raise exception '% points at a retired location; move it first.', v_o.number using errcode = '22023';
  end if;
  if not exists (select 1 from sales_line sl where sl.order_id = v_o.id and sl.deleted_at is null) then
    raise exception '% has no lines — nothing to fulfil.', v_o.number using errcode = '22023';
  end if;

  -- The goods must be ON THE SHELF. Our own hold does not count against us;
  -- other orders' holds do not matter here either — they are promises, and
  -- the first to be collected takes the stock.
  select string_agg(format('%s: need %s, on hand %s', p.sku, n.qty, coalesce(sp.on_hand, 0)), '; ' order by p.sku)
    into v_short
    from (select sl.part_id, sum(sl.qty)::int as qty from sales_line sl where sl.order_id = v_o.id and sl.deleted_at is null group by sl.part_id) n
    join part p on p.id = n.part_id
    left join public.stock_position sp on sp.part_id = n.part_id and sp.location_id = v_o.location_id
   where n.qty > coalesce(sp.on_hand, 0);
  if v_short is not null then
    raise exception 'Not enough stock to fulfil %. %', v_o.number, v_short using errcode = '22023';
  end if;

  -- the hold ends (release +qty) …
  perform public.release_order(v_o.id, 'collected');
  -- … and the goods leave (sale −qty)
  select au.id into v_actor from app_user au where au.id = auth.uid();
  insert into stock_movement (part_id, location_id, delta, reason, ref_type, ref_id, actor_id, actor_source, client_uuid, origin)
  select sl.part_id, v_o.location_id, -sl.qty, 'sale', 'sales_order', v_o.id,
         v_actor, case when v_actor is null then null else 'server_session' end,
         'so-' || v_o.id || '-line-' || sl.id, 'server'
    from sales_line sl where sl.order_id = v_o.id and sl.deleted_at is null
  on conflict (client_uuid) do nothing;
  get diagnostics v_written = row_count;

  update sales_order set status = 'fulfilled', fulfilled_at = now(), updated_at = now() where id = v_o.id;
  return jsonb_build_object('order_id', v_o.id, 'number', v_o.number, 'status', 'fulfilled',
                            'fulfilled_at', now(), 'movements', v_written, 'already', false);
end;
$$;

commit;

-- VERIFY:
--   select * from stock_position where reserved <> 0;                           -- the active holds
--   select reason, count(*) from stock_movement group by 1;                     -- reserve/release appear
--   select part_id, location_id, on_hand, reserved, available from stock_position where part_id=1136;
