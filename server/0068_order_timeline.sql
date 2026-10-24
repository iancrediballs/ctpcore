-- CTP Core 0068 — full audit trail: who did each step of an order, and when (24 Oct 2026).
--
-- Ian + Anton: "every step in CTP records who and when: created, priced, quoted, accepted (with
-- PO), invoiced/linked, fulfilled, closed — shown as a timeline on the order."
--
-- sales_order.timeline: jsonb array of {at, kind, label, by, by_id, detail}. STAFF ONLY:
--   * not in the customers' PowerSync stream (explicit column list);
--   * not selectable over the Data API (0067 column grants; a new column is not granted);
--   * staff phones receive it through their SELECT * stream.
-- Written by a trigger on every state change, so every path is covered (phone, RPCs, edge
-- functions, Zoho read-backs).
-- Who:
--   1. the session user (auth.uid());
--   2. else the step's own column (accepted_by, fulfil_override_by, raised_by);
--   3. else the customer's login when the customer accepted/declined;
--   4. else event_actor, which an edge function sets in the same UPDATE (then cleared);
--   5. else "Zoho (accounts)" for read-back changes.
-- append_order_event() (server only) adds a step an edge function performed (quote sent to Zoho,
-- shipped in Zoho). Existing orders are back-filled from their dates, marked "reconstructed".
begin;

alter table public.sales_order add column if not exists timeline jsonb not null default '[]'::jsonb;
alter table public.sales_order add column if not exists event_actor uuid;
alter table public.sales_order add column if not exists raised_by uuid;   -- live has it (0053); declared for a fresh database

-- staff: their name; a customer login: "Denver (Hermans Panel Beaters)"
create or replace function public.order_actor_name(p_uid uuid)
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select case when p_uid is null then null else coalesce(
    (select case when au.role = 'customer'
                 then concat_ws(' ', au.display_name, '(' || (select c.name from customer c where c.id = public.login_company(p_uid)) || ')')
                 else au.display_name end
       from app_user au where au.id = p_uid),
    (select name from customer where auth_user_id = p_uid limit 1),
    'user ' || left(p_uid::text, 8)) end
$$;

create or replace function public.order_event(p_kind text, p_label text, p_by uuid, p_by_name text, p_detail jsonb default '{}'::jsonb)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'kind', p_kind, 'label', p_label,
         'by', coalesce(p_by_name, case when p_by is null then 'Zoho (accounts)' else public.order_actor_name(p_by) end),
         'by_id', p_by, 'detail', coalesce(p_detail, '{}'::jsonb))
$$;

create or replace function public.sales_order_timeline()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me uuid := coalesce(auth.uid(), new.event_actor);
  ev jsonb := '[]'::jsonb;
  cust_login uuid;
begin
  if tg_op = 'INSERT' then
    ev := ev || public.order_event('created', case when new.raised_by is not null then 'Raised at the counter' else 'Request sent' end,
                                   coalesce(me, new.raised_by), null, jsonb_build_object('number', new.number));
    new.timeline := coalesce(new.timeline, '[]'::jsonb) || ev;
    new.event_actor := null;
    return new;
  end if;
  select auth_user_id into cust_login from customer where id = new.customer_id;

  if new.status is distinct from old.status then
    if new.status = 'confirmed' and old.status = 'quote' then
      ev := ev || public.order_event('accepted',
        case when new.accepted_by is not null then 'Accepted on the customer''s behalf' else 'Accepted by the customer' end,
        coalesce(new.accepted_by, me, cust_login), null,
        jsonb_strip_nulls(jsonb_build_object('note', new.accepted_note, 'salesorder', new.zoho_salesorder_number)));
    elsif new.status = 'fulfilled' then
      ev := ev || public.order_event('fulfilled', case when new.zoho_shipment_number is not null then 'Goods out (shipped in Zoho)' else 'Goods out (fulfilled)' end,
        me, case when me is null then 'CTP' end, jsonb_strip_nulls(jsonb_build_object('shipment', new.zoho_shipment_number)));
    elsif new.status = 'invoiced' then
      ev := ev || public.order_event('closed', 'Order closed', me, case when me is null then 'CTP' end,
        jsonb_strip_nulls(jsonb_build_object('invoice', coalesce(new.zoho_invoice_number, new.invoice_no))));
    elsif new.status = 'cancelled' then
      ev := ev || public.order_event(case when new.client_response = 'declined' then 'declined' else 'cancelled' end,
        case when new.client_response = 'declined' then 'Declined by the customer' else 'Cancelled' end,
        coalesce(me, case when new.client_response = 'declined' then cust_login end), case when me is null and new.client_response is distinct from 'declined' then 'CTP' end);
    end if;
  end if;

  if new.zoho_estimate_status is distinct from old.zoho_estimate_status and new.zoho_estimate_status in ('sent', 'accepted', 'declined', 'expired', 'deleted', 'void') then
    ev := ev || public.order_event('estimate_' || new.zoho_estimate_status, format('Zoho estimate %s %s', coalesce(new.zoho_estimate_number, ''), new.zoho_estimate_status),
      case when new.zoho_estimate_status = 'sent' then null else me end, case when new.zoho_estimate_status = 'sent' or me is null then 'Zoho (accounts)' end);
  end if;
  if old.zoho_salesorder_id is null and new.zoho_salesorder_id is not null then
    ev := ev || public.order_event('salesorder', format('Sales order %s raised in Zoho', coalesce(new.zoho_salesorder_number, '')),
      coalesce(new.accepted_by, me, cust_login), null);
  end if;
  if old.zoho_invoice_id is null and new.zoho_invoice_id is not null then
    ev := ev || public.order_event('invoiced', format('Invoiced in Zoho as %s', coalesce(new.zoho_invoice_number, '')), null, 'Zoho (accounts)');
  end if;
  if new.zoho_status = 'paid' and old.zoho_status is distinct from 'paid' and new.zoho_invoice_id is not null then
    ev := ev || public.order_event('paid', format('%s paid', coalesce(new.zoho_invoice_number, 'Invoice')), null, 'Zoho (accounts)');
  end if;
  if old.fulfil_override_at is null and new.fulfil_override_at is not null then
    ev := ev || public.order_event('released', 'Released for fulfilment before the invoice', coalesce(new.fulfil_override_by, me), null,
      jsonb_strip_nulls(jsonb_build_object('note', new.fulfil_override_note)));
  end if;

  if jsonb_array_length(ev) > 0 then new.timeline := coalesce(new.timeline, '[]'::jsonb) || ev; end if;
  new.event_actor := null;
  return new;
end $$;
drop trigger if exists sales_order_timeline on public.sales_order;
create trigger sales_order_timeline before insert or update on public.sales_order
  for each row execute function public.sales_order_timeline();

-- priced: the moment the last unpriced line gets a price (quote fully priced)
create or replace function public.sales_line_priced_event()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if coalesce(old.unit_price_minor, 0) <= 0 and coalesce(new.unit_price_minor, 0) > 0 and new.deleted_at is null
     and not exists (select 1 from sales_line sl where sl.order_id = new.order_id and sl.deleted_at is null and sl.id <> new.id and coalesce(sl.unit_price_minor, 0) <= 0)
     and exists (select 1 from sales_order so where so.id = new.order_id and so.status = 'quote') then
    update sales_order set timeline = timeline || public.order_event('priced', 'Priced', auth.uid(), case when auth.uid() is null then 'CTP' end,
             jsonb_build_object('total_minor', (select coalesce(sum(qty::bigint * unit_price_minor), 0) from sales_line where order_id = new.order_id and deleted_at is null)))
     where id = new.order_id;
  end if;
  return new;
end $$;
drop trigger if exists sales_line_priced_event on public.sales_line;
create trigger sales_line_priced_event after update of unit_price_minor on public.sales_line
  for each row execute function public.sales_line_priced_event();

-- an edge function's own step, with its staff user (quote sent to Zoho, shipped in Zoho, …)
create or replace function public.append_order_event(p_order_id bigint, p_kind text, p_label text, p_actor uuid, p_detail jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'append_order_event is called by the server, not from a session.' using errcode = '42501';
  end if;
  update sales_order set timeline = timeline || public.order_event(p_kind, p_label, p_actor, case when p_actor is null then 'CTP' end, p_detail)
   where id = p_order_id;
end $$;
revoke all on function public.append_order_event(bigint, text, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.append_order_event(bigint, text, text, uuid, jsonb) to service_role;
revoke all on function public.order_event(text, text, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.order_actor_name(uuid) from public, anon, authenticated;

-- 0065's record_goods_out, now naming who shipped (event_actor → timeline)
create or replace function public.record_goods_out(p_order_id bigint, p_actor uuid, p_ship jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_o record;
begin
  if auth.uid() is not null then
    raise exception 'record_goods_out is called by the server, not from a session.' using errcode = '42501';
  end if;
  select id, number, status, fulfilled_at into v_o from sales_order where id = p_order_id and deleted_at is null for update;
  if v_o.id is null then raise exception 'No such order.' using errcode = '42704'; end if;
  update sales_order set
    zoho_package_id = coalesce(p_ship->>'package_id', zoho_package_id),
    zoho_package_number = coalesce(p_ship->>'package_number', zoho_package_number),
    zoho_shipment_id = coalesce(p_ship->>'shipment_id', zoho_shipment_id),
    zoho_shipment_number = coalesce(p_ship->>'shipment_number', zoho_shipment_number),
    zoho_shipment_status = coalesce(p_ship->>'shipment_status', zoho_shipment_status),
    updated_at = now()
  where id = v_o.id;
  if v_o.status in ('fulfilled', 'invoiced') then
    return jsonb_build_object('order_id', v_o.id, 'number', v_o.number, 'status', v_o.status, 'already', true);
  end if;
  if v_o.status <> 'confirmed' then
    raise exception '% is %, not accepted — only an accepted order can go out.', v_o.number, v_o.status using errcode = '22023';
  end if;
  perform public.release_order(v_o.id, 'shipped in Zoho');
  update sales_order set status = 'fulfilled', fulfilled_at = now(), updated_at = now(), event_actor = p_actor,   -- 0068: the timeline names who shipped
         notes = concat_ws(E'\n', nullif(notes, ''), format('[%s] Goods out — Zoho package %s, shipment %s%s',
                   to_char(now() at time zone 'Africa/Johannesburg', 'YYYY-MM-DD HH24:MI'),
                   coalesce(p_ship->>'package_number', '?'), coalesce(p_ship->>'shipment_number', '?'),
                   case when p_actor is null then '' else ' (by ' || coalesce((select display_name from app_user where id = p_actor), 'staff') || ')' end))
   where id = v_o.id;
  return jsonb_build_object('order_id', v_o.id, 'number', v_o.number, 'status', 'fulfilled', 'already', false);
end $$;
revoke all on function public.record_goods_out(bigint, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.record_goods_out(bigint, uuid, jsonb) to service_role;

-- back-fill existing orders from their dates (no trigger noise: built directly)
update sales_order so set timeline = (
  select coalesce(jsonb_agg(e order by e->>'at'), '[]'::jsonb) from (
    select jsonb_build_object('at', to_char(so.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'kind', 'created',
                              'label', 'Created (reconstructed)', 'by', coalesce(public.order_actor_name(so.raised_by), (select name from customer where id = so.customer_id)), 'detail', '{}'::jsonb) e
    union all select jsonb_build_object('at', to_char(so.client_responded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'kind',
                              case when so.client_response = 'declined' then 'declined' else 'accepted' end,
                              'label', case when so.client_response = 'declined' then 'Declined (reconstructed)' when so.accepted_by is not null then 'Accepted on the customer''s behalf (reconstructed)' else 'Accepted (reconstructed)' end,
                              'by', coalesce(public.order_actor_name(so.accepted_by), (select name from customer where id = so.customer_id)),
                              'detail', jsonb_strip_nulls(jsonb_build_object('note', so.accepted_note, 'salesorder', so.zoho_salesorder_number)))
      where so.client_responded_at is not null
    union all select jsonb_build_object('at', to_char(so.fulfilled_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'kind', 'fulfilled',
                              'label', 'Goods out (reconstructed)', 'by', 'CTP', 'detail', jsonb_strip_nulls(jsonb_build_object('shipment', so.zoho_shipment_number)))
      where so.fulfilled_at is not null
    union all select jsonb_build_object('at', to_char(coalesce(so.zoho_invoice_linked_at, so.invoiced_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'kind', 'invoiced',
                              'label', format('Invoiced %s (reconstructed)', coalesce(so.zoho_invoice_number, so.invoice_no, '')), 'by', 'Zoho (accounts)', 'detail', '{}'::jsonb)
      where coalesce(so.zoho_invoice_linked_at, so.invoiced_at) is not null) x)
where so.timeline = '[]'::jsonb;

commit;
