-- 0099 - In-stock and on-order lines on one quote (26 Nov 2026, Ian).
--
-- Ian: "the ones that are on order coming in will have their own price and go to a new line item."
-- When a quote asks for more than Zoho has available, staff split the line: the in-stock quantity
-- stays at its price; the shortfall becomes an ON-ORDER line, marked with the supplier PO and ETA
-- (earliest open Zoho PO line for the part, 0097/0098), whose price staff type by hand (Ian chose
-- this on a card: the landed cost changes every shipment, so there is no automatic price).
--
-- On accept, the on-order lines leave the quote and become their own back-order order
-- (BO-<quote no.>, sales_order.back_order_of = the quote), with its own Zoho sales order, so the
-- in-stock order can be invoiced and fulfilled now (fulfil is all-or-nothing, 0042/0046).
--
--   sales_line.on_order / po_number / po_eta    the on-order marking (po_* informational)
--   sales_order.back_order_of                    the quote a back order was split from
--   UNIQUE (order_id, part_id) -> UNIQUE (order_id, part_id, on_order)
--       a quote may carry one in-stock and one on-order line per part; a confirmed order still has
--       one line per part (the split moves every on-order line off a mixed quote), which is what
--       the Zoho read-back (apply_zoho_salesorder, 0059) relies on.
--   split_quote_line(line)       staff: split a short line by Zoho's available-for-sale
--   unsplit_quote_line(line)     staff: put an on-order line back (undo)
--   fill_quote_from_list         no longer touches on-order lines (their price is typed)
--   split_back_order(order)      internal: move a mixed quote's on-order lines to its back order
--   accept_quote / accept_quote_on_behalf   split first (same transaction), return the back order
--   accept_back_order(...)       server: confirm the back order with its own Zoho sales order
--
-- Runs once; re-running is safe (IF NOT EXISTS / CREATE OR REPLACE / constraint guarded).

begin;

alter table public.sales_line  add column if not exists on_order  boolean not null default false;
alter table public.sales_line  add column if not exists po_number text;
alter table public.sales_line  add column if not exists po_eta    date;
alter table public.sales_order add column if not exists back_order_of bigint references public.sales_order(id);
create index if not exists so_back_order_of_idx on public.sales_order(back_order_of) where back_order_of is not null;

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'sales_line_order_id_part_id_key' and conrelid = 'public.sales_line'::regclass) then
    alter table public.sales_line drop constraint sales_line_order_id_part_id_key;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sales_line_order_part_on_order_key' and conrelid = 'public.sales_line'::regclass) then
    alter table public.sales_line add constraint sales_line_order_part_on_order_key unique (order_id, part_id, on_order);
  end if;
end $$;

-- ── staff: split a short quote line ─────────────────────────────────────────
create or replace function public.split_quote_line(p_line_id bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  l record; v_avail int; v_short int; v_po text; v_eta date; v_bo bigint; v_over bigint[];
begin
  if not is_staff() then
    raise exception 'Only staff can split a quote line.' using errcode = '42501';
  end if;
  select sl.id, sl.order_id, sl.part_id, sl.qty, sl.on_order, so.status, so.number,
         so.zoho_estimate_id, so.zoho_estimate_status, p.sku, p.zoho_available_for_sale as avail
    into l
    from sales_line sl join sales_order so on so.id = sl.order_id join part p on p.id = sl.part_id
   where sl.id = p_line_id and sl.deleted_at is null and so.deleted_at is null
     for update of sl, so;
  if l.id is null then raise exception 'No such line.' using errcode = '42704'; end if;
  if l.status <> 'quote' then
    raise exception '% is %, so its lines are settled.', l.number, l.status using errcode = '22023';
  end if;
  if l.zoho_estimate_id is not null and coalesce(l.zoho_estimate_status, '') not in ('deleted', 'void', 'declined', 'expired') then
    raise exception '% is a Zoho estimate; change its lines in Zoho.', l.number using errcode = '22023';
  end if;
  if l.on_order then
    raise exception '% is already the on-order line.', l.sku using errcode = '22023';
  end if;
  v_avail := greatest(floor(coalesce(l.avail, 0))::int, 0);
  if l.qty <= v_avail then
    raise exception '% has % available in Zoho, enough for all %; nothing to split.', l.sku, v_avail, l.qty using errcode = '22023';
  end if;
  v_short := l.qty - v_avail;

  -- the supplier PO it comes in on: the earliest open Zoho PO line for this part
  select b.purchaseorder_number, b.eta into v_po, v_eta
    from zoho_back_order_line b
   where b.part_id = l.part_id and b.qty_outstanding > 0
   order by b.eta nulls last, b.po_date nulls last, b.purchaseorder_number
   limit 1;

  -- a removed (soft-deleted) on-order row would block the unique key; it carries nothing live
  delete from sales_line where order_id = l.order_id and part_id = l.part_id and on_order and deleted_at is not null;
  select id into v_bo from sales_line where order_id = l.order_id and part_id = l.part_id and on_order;

  if v_avail = 0 then
    if v_bo is not null then
      update sales_line set qty = qty + l.qty, po_number = v_po, po_eta = v_eta, updated_at = now() where id = v_bo;
      delete from sales_line where id = l.id;
    else
      -- nothing in stock: the whole line is on order, priced by hand
      update sales_line set on_order = true, po_number = v_po, po_eta = v_eta, unit_price_minor = 0, updated_at = now()
       where id = l.id;
      v_bo := l.id;
    end if;
  else
    update sales_line set qty = v_avail, updated_at = now() where id = l.id;
    if v_bo is not null then
      update sales_line set qty = qty + v_short, po_number = v_po, po_eta = v_eta, updated_at = now() where id = v_bo;
    else
      insert into sales_line (order_id, part_id, qty, unit_price_minor, tier_at_add, on_order, po_number, po_eta, origin)
      values (l.order_id, l.part_id, v_short, 0, 'on_order', true, v_po, v_eta, 'server')
      returning id into v_bo;
    end if;
  end if;

  select coalesce(array_agg(id), '{}') into v_over from sales_line
   where order_id = l.order_id and deleted_at is null and rebate_override_at is not null;
  perform public.rebate_apply(l.order_id, v_over);

  return jsonb_build_object('order_id', l.order_id, 'number', l.number, 'sku', l.sku,
                            'in_stock_line_id', case when v_avail > 0 then l.id end, 'in_stock_qty', v_avail,
                            'on_order_line_id', v_bo, 'on_order_qty', v_short, 'po_number', v_po, 'po_eta', v_eta);
end $$;
revoke all on function public.split_quote_line(bigint) from public, anon;
grant execute on function public.split_quote_line(bigint) to authenticated;

-- ── staff: undo a split ─────────────────────────────────────────────────────
create or replace function public.unsplit_quote_line(p_line_id bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare l record; v_sib bigint; v_over bigint[];
begin
  if not is_staff() then
    raise exception 'Only staff can change a quote line.' using errcode = '42501';
  end if;
  select sl.id, sl.order_id, sl.part_id, sl.qty, sl.on_order, so.status, so.number, p.sku
    into l
    from sales_line sl join sales_order so on so.id = sl.order_id join part p on p.id = sl.part_id
   where sl.id = p_line_id and sl.deleted_at is null and so.deleted_at is null
     for update of sl, so;
  if l.id is null then raise exception 'No such line.' using errcode = '42704'; end if;
  if l.status <> 'quote' then
    raise exception '% is %, so its lines are settled.', l.number, l.status using errcode = '22023';
  end if;
  if not l.on_order then
    raise exception '% is not an on-order line.', l.sku using errcode = '22023';
  end if;
  delete from sales_line where order_id = l.order_id and part_id = l.part_id and not on_order and deleted_at is not null;
  select id into v_sib from sales_line where order_id = l.order_id and part_id = l.part_id and not on_order;
  if v_sib is not null then
    update sales_line set qty = qty + l.qty, updated_at = now() where id = v_sib;
    delete from sales_line where id = l.id;
  else
    update sales_line set on_order = false, po_number = null, po_eta = null, tier_at_add = 'list', updated_at = now()
     where id = l.id;
    v_sib := l.id;
  end if;
  select coalesce(array_agg(id), '{}') into v_over from sales_line
   where order_id = l.order_id and deleted_at is null and rebate_override_at is not null;
  perform public.rebate_apply(l.order_id, v_over);
  return jsonb_build_object('order_id', l.order_id, 'number', l.number, 'sku', l.sku, 'line_id', v_sib);
end $$;
revoke all on function public.unsplit_quote_line(bigint) from public, anon;
grant execute on function public.unsplit_quote_line(bigint) to authenticated;

-- ── fill from list: on-order lines keep the price staff typed ───────────────
create or replace function public.fill_quote_from_list(order_id bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_status text;
  v_filled int;
begin
  if not is_staff() then
    raise exception 'Only staff can price a quote.' using errcode = '42501';
  end if;
  select so.status into v_status
    from sales_order so where so.id = fill_quote_from_list.order_id and so.deleted_at is null;
  if v_status is null then
    raise exception 'No such order.' using errcode = '42704';
  end if;
  if v_status <> 'quote' then
    raise exception 'Order is %, so its prices are settled.', v_status using errcode = '22023';
  end if;
  update sales_line sl
     set unit_price_minor = coalesce((
           select pr.amount_minor from price pr
            where pr.part_id = sl.part_id and pr.tier = 'list' and pr.deleted_at is null
            order by pr.valid_from desc limit 1), sl.unit_price_minor),
         tier_at_add = 'list',
         updated_at = now()
   where sl.order_id = fill_quote_from_list.order_id and sl.deleted_at is null
     and not sl.on_order;   -- 0099
  get diagnostics v_filled = row_count;
  perform public.rebate_apply(fill_quote_from_list.order_id, '{}'::bigint[]);
  return (
    select jsonb_build_object(
      'order_id', fill_quote_from_list.order_id,
      'lines', v_filled,
      'unpriced_left', count(*) filter (where sl.unit_price_minor <= 0),
      'unpriced_skus', coalesce(jsonb_agg(p.sku) filter (where sl.unit_price_minor <= 0), '[]'::jsonb),
      'gross_minor',  coalesce(sum(sl.qty::bigint * sl.unit_price_minor), 0),
      'rebate_minor', coalesce(sum(sl.rebate_minor), 0),
      'net_minor',    coalesce(sum(coalesce(sl.line_net_minor, sl.qty::bigint * sl.unit_price_minor)), 0),
      'total_minor',  coalesce(sum(coalesce(sl.line_net_minor, sl.qty::bigint * sl.unit_price_minor)), 0))
      from sales_line sl join part p on p.id = sl.part_id
     where sl.order_id = fill_quote_from_list.order_id and sl.deleted_at is null
  );
end $$;

-- ── internal: a mixed quote's on-order lines become its back order ──────────
-- Called inside accept_quote / accept_quote_on_behalf, so the move and the acceptance are one
-- transaction. Only a MIXED quote splits: a quote of on-order lines only (or a back order being
-- accepted on its own) is accepted whole. Re-uses a back order still open as a quote.
create or replace function public.split_back_order(p_order_id bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare o record; v_child bigint; v_number text; v_moved int;
begin
  if auth.uid() is not null then
    raise exception 'split_back_order is called by the server, not from a session.' using errcode = '42501';
  end if;
  select so.* into o from sales_order so where so.id = p_order_id and so.deleted_at is null;
  if o.id is null then raise exception 'No such order.' using errcode = '42704'; end if;
  if not exists (select 1 from sales_line where order_id = o.id and deleted_at is null and on_order)
     or not exists (select 1 from sales_line where order_id = o.id and deleted_at is null and not on_order) then
    return null;
  end if;
  select id, number into v_child, v_number from sales_order
   where back_order_of = o.id and status = 'quote' and deleted_at is null order by id limit 1;
  if v_child is null then
    v_number := 'BO-' || o.number;
    if exists (select 1 from sales_order where number = v_number) then
      v_number := v_number || '-' || (select count(*) + 1 from sales_order where back_order_of = o.id);
    end if;
    insert into sales_order (number, customer_id, location_id, status, currency, tax_rate_bps, notes, origin,
                             raised_by, po_number, po_file_path, po_file_name, back_order_of)
    values (v_number, o.customer_id, o.location_id, 'quote', o.currency, o.tax_rate_bps,
            format('Back order for %s: parts on order from our supplier.', o.number), 'server',
            o.raised_by, o.po_number, o.po_file_path, o.po_file_name, o.id)
    returning id into v_child;
  end if;
  update sales_line set order_id = v_child, updated_at = now()
   where order_id = o.id and deleted_at is null and on_order;
  get diagnostics v_moved = row_count;
  return jsonb_build_object('order_id', v_child, 'number', v_number, 'lines', v_moved);
end $$;
revoke all on function public.split_back_order(bigint) from public, anon, authenticated;

-- ── accept: split first, in the same transaction ────────────────────────────
-- Live bodies (read 26 Nov) with one change each: split_back_order() before the status update,
-- and the back order in the result.
create or replace function public.accept_quote(order_id bigint, p_auth_user uuid, p_zoho_salesorder_id text, p_zoho_salesorder_number text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $function$
declare v_o record; v_bad text; v_reserved int := 0; v_live boolean := zoho_live(); v_bo jsonb;
begin
  if auth.uid() is not null then
    raise exception 'accept_quote is called by the server, not from a session.' using errcode = '42501';
  end if;
  if v_live and coalesce(p_zoho_salesorder_id, '') = '' then
    raise exception 'accept_quote needs the Zoho sales order id (Zoho sending is on).' using errcode = '22023';
  end if;
  select so.id, so.number, so.status, so.customer_id, so.zoho_salesorder_id
    into v_o from sales_order so
   where so.id = accept_quote.order_id and so.deleted_at is null for update of so;
  if v_o.id is null then raise exception 'No such order.' using errcode = '42704'; end if;
  if login_company(p_auth_user) is distinct from v_o.customer_id then
    raise exception 'That order belongs to a different customer.' using errcode = '42501';
  end if;
  if v_o.status = 'confirmed' and v_o.zoho_salesorder_id is not distinct from nullif(p_zoho_salesorder_id, '') then
    return jsonb_build_object('order_id', v_o.id, 'number', v_o.number, 'status', 'confirmed',
                              'zoho_salesorder_number', p_zoho_salesorder_number, 'reserved_lines', 0, 'already', true);
  end if;
  if v_o.status <> 'quote' then
    raise exception '% is already %, so it cannot be accepted.', v_o.number, v_o.status using errcode = '22023';
  end if;
  select string_agg(p.name || ' (' || p.sku || ')', ', ') into v_bad
    from sales_line sl join part p on p.id = sl.part_id
   where sl.order_id = v_o.id and sl.deleted_at is null
     and (sl.unit_price_minor <= 0
          or (v_live and not exists (select 1 from zoho_item z where z.part_id = p.id and z.status <> 'inactive')));
  if v_bad is not null then
    raise exception 'This quote has a line that cannot be ordered yet: %', v_bad using errcode = '22023';
  end if;
  v_bo := public.split_back_order(v_o.id);   -- 0099
  update sales_order
     set status = 'confirmed', client_response = 'accepted', client_responded_at = now(),
         zoho_salesorder_id = nullif(p_zoho_salesorder_id, ''), zoho_salesorder_number = nullif(p_zoho_salesorder_number, ''),
         zoho_created_at = case when coalesce(p_zoho_salesorder_id, '') <> '' then now() end,
         zoho_so_status = case when coalesce(p_zoho_salesorder_id, '') <> '' then 'draft' end,
         zoho_so_status_at = case when coalesce(p_zoho_salesorder_id, '') <> '' then now() end,
         zoho_so_error = null, event_actor = p_auth_user, updated_at = now()
   where id = v_o.id;
  v_reserved := public.reserve_order(v_o.id);
  return jsonb_build_object('order_id', v_o.id, 'number', v_o.number, 'status', 'confirmed',
                            'zoho_salesorder_number', nullif(p_zoho_salesorder_number, ''), 'reserved_lines', v_reserved,
                            'already', false, 'zoho_live', v_live, 'back_order', v_bo);
end $function$;

create or replace function public.accept_quote_on_behalf(order_id bigint, p_staff uuid, p_note text, p_zoho_salesorder_id text, p_zoho_salesorder_number text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $function$
declare v_o record; v_bad text; v_reserved int := 0; v_live boolean := zoho_live(); v_who text; v_note text := btrim(coalesce(p_note, '')); v_bo jsonb;
begin
  if auth.uid() is not null then
    raise exception 'accept_quote_on_behalf is called by the server, not from a session.' using errcode = '42501';
  end if;
  select coalesce(nullif(btrim(a.display_name), ''), u.email, 'admin') into v_who
    from app_user a left join auth.users u on u.id = a.id
   where a.id = p_staff and a.role in ('sales', 'manager', 'admin');
  if v_who is null then
    raise exception 'Only CTP sales staff can accept a quote on the customer''s behalf.' using errcode = '42501';
  end if;
  if length(v_note) < 3 then
    raise exception 'Say how the customer confirmed it, e.g. "Confirmed by Denver via phone".' using errcode = '22023';
  end if;
  if v_live and coalesce(p_zoho_salesorder_id, '') = '' then
    raise exception 'accept_quote_on_behalf needs the Zoho sales order id (Zoho sending is on).' using errcode = '22023';
  end if;
  select so.id, so.number, so.status, so.customer_id, so.zoho_salesorder_id
    into v_o from sales_order so
   where so.id = accept_quote_on_behalf.order_id and so.deleted_at is null for update of so;
  if v_o.id is null then raise exception 'No such order.' using errcode = '42704'; end if;
  if v_o.status = 'confirmed' and v_o.zoho_salesorder_id is not distinct from nullif(p_zoho_salesorder_id, '') then
    return jsonb_build_object('order_id', v_o.id, 'number', v_o.number, 'status', 'confirmed',
                              'zoho_salesorder_number', p_zoho_salesorder_number, 'reserved_lines', 0, 'already', true);
  end if;
  if v_o.status <> 'quote' then
    raise exception '% is already %, so it cannot be accepted.', v_o.number, v_o.status using errcode = '22023';
  end if;
  select string_agg(p.name || ' (' || p.sku || ')', ', ') into v_bad
    from sales_line sl join part p on p.id = sl.part_id
   where sl.order_id = v_o.id and sl.deleted_at is null
     and (sl.unit_price_minor <= 0
          or (v_live and not exists (select 1 from zoho_item z where z.part_id = p.id and z.status <> 'inactive')));
  if v_bad is not null then
    raise exception 'This quote has a line that cannot be ordered yet: %', v_bad using errcode = '22023';
  end if;
  if not exists (select 1 from sales_line sl where sl.order_id = v_o.id and sl.deleted_at is null) then
    raise exception '% has no lines.', v_o.number using errcode = '22023';
  end if;
  v_bo := public.split_back_order(v_o.id);   -- 0099
  update sales_order
     set status = 'confirmed', client_response = 'accepted', client_responded_at = now(),
         accepted_by = p_staff, accepted_note = v_note,
         notes = concat_ws(E'\n', nullif(notes, ''),
                   format('[%s] Accepted on the customer''s behalf by %s: %s', to_char(now() at time zone 'Africa/Johannesburg', 'YYYY-MM-DD HH24:MI'), v_who, v_note)),
         zoho_salesorder_id = nullif(p_zoho_salesorder_id, ''), zoho_salesorder_number = nullif(p_zoho_salesorder_number, ''),
         zoho_created_at = case when coalesce(p_zoho_salesorder_id, '') <> '' then now() end,
         zoho_so_status = case when coalesce(p_zoho_salesorder_id, '') <> '' then 'draft' end,
         zoho_so_status_at = case when coalesce(p_zoho_salesorder_id, '') <> '' then now() end,
         zoho_so_error = null, updated_at = now()
   where id = v_o.id;
  v_reserved := public.reserve_order(v_o.id);
  return jsonb_build_object('order_id', v_o.id, 'number', v_o.number, 'status', 'confirmed',
                            'zoho_salesorder_number', nullif(p_zoho_salesorder_number, ''), 'reserved_lines', v_reserved,
                            'already', false, 'zoho_live', v_live, 'accepted_by', v_who, 'back_order', v_bo);
end $function$;

-- ── server: confirm a back order with its own Zoho sales order ──────────────
-- The acceptance is the parent quote's: who accepted, how, and the PO come from it.
create or replace function public.accept_back_order(p_order_id bigint, p_zoho_salesorder_id text, p_zoho_salesorder_number text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_o record; v_p record; v_bad text; v_reserved int; v_live boolean := zoho_live();
begin
  if auth.uid() is not null then
    raise exception 'accept_back_order is called by the server, not from a session.' using errcode = '42501';
  end if;
  if v_live and coalesce(p_zoho_salesorder_id, '') = '' then
    raise exception 'accept_back_order needs the Zoho sales order id (Zoho sending is on).' using errcode = '22023';
  end if;
  select so.id, so.number, so.status, so.back_order_of, so.zoho_salesorder_id
    into v_o from sales_order so where so.id = p_order_id and so.deleted_at is null for update of so;
  if v_o.id is null then raise exception 'No such order.' using errcode = '42704'; end if;
  if v_o.status = 'confirmed' and v_o.zoho_salesorder_id is not distinct from nullif(p_zoho_salesorder_id, '') then
    return jsonb_build_object('order_id', v_o.id, 'number', v_o.number, 'status', 'confirmed', 'already', true);
  end if;
  if v_o.status <> 'quote' or v_o.back_order_of is null then
    raise exception '% is not an open back order.', v_o.number using errcode = '22023';
  end if;
  select so.status, so.client_response, so.accepted_by, so.accepted_note, so.accepted_via, so.event_actor
    into v_p from sales_order so where so.id = v_o.back_order_of;
  if v_p.status is null or v_p.status not in ('confirmed', 'fulfilled', 'invoiced') then
    raise exception 'The quote % came from is not accepted.', v_o.number using errcode = '22023';
  end if;
  select string_agg(p.sku, ', ') into v_bad
    from sales_line sl join part p on p.id = sl.part_id
   where sl.order_id = v_o.id and sl.deleted_at is null and sl.unit_price_minor <= 0;
  if v_bad is not null then raise exception '% has unpriced lines: %', v_o.number, v_bad using errcode = '22023'; end if;
  update sales_order
     set status = 'confirmed', client_response = 'accepted', client_responded_at = now(),
         accepted_by = v_p.accepted_by, accepted_note = v_p.accepted_note, accepted_via = v_p.accepted_via,
         zoho_salesorder_id = nullif(p_zoho_salesorder_id, ''), zoho_salesorder_number = nullif(p_zoho_salesorder_number, ''),
         zoho_created_at = case when coalesce(p_zoho_salesorder_id, '') <> '' then now() end,
         zoho_so_status = case when coalesce(p_zoho_salesorder_id, '') <> '' then 'draft' end,
         zoho_so_status_at = case when coalesce(p_zoho_salesorder_id, '') <> '' then now() end,
         zoho_so_error = null, event_actor = v_p.event_actor, updated_at = now()
   where id = v_o.id;
  v_reserved := public.reserve_order(v_o.id);
  return jsonb_build_object('order_id', v_o.id, 'number', v_o.number, 'status', 'confirmed',
                            'zoho_salesorder_number', nullif(p_zoho_salesorder_number, ''), 'reserved_lines', v_reserved, 'already', false);
end $$;
revoke all on function public.accept_back_order(bigint, text, text) from public, anon, authenticated;
grant execute on function public.accept_back_order(bigint, text, text) to service_role;

commit;
