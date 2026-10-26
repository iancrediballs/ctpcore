-- CTP Core 0089 (renumbered from 0087) (QA sweep "flow", 26 Oct 2026): cancel guard + timeline fixes. NOT applied yet — the lead applies it.
--
-- FLOW-1  cancel_order() refuses an order accounts have already invoiced in Zoho (the invoice needs a
--         credit note first; voiding the SO would not undo it). The cancel reason goes on the timeline
--         step. Voiding the open Zoho SO is the zoho-push "cancel" action, which the desk calls right
--         after this RPC — the CTP cancel never waits on Zoho.
-- FLOW-8  multi-line quotes logged "Priced" once per line (row trigger; every row saw the quote fully
--         priced). Skipped when the last step is already "priced" at the same total.
-- FLOW-9  with estimates off, pricing IS sending the quote: the step says so.
-- FLOW-10 a customer login whose display name already carries the company is not doubled
--         ("QA Book (Test Co 2) (Test Co 2)"); the SO step is CTP's (on acceptance), not the customer's.
-- FLOW-13 the release step names the step that was skipped (invoice / sending / payment).
begin;

-- ── FLOW-1: the cancel guard ─────────────────────────────────────────────────
create or replace function public.cancel_order(order_id bigint, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_o record; v_rel int; v_why text := coalesce(nullif(btrim(p_reason), ''), 'no reason given');
begin
  if not is_staff() then raise exception 'Only staff can cancel an order.' using errcode = '42501'; end if;
  select id, number, status, zoho_invoice_id, zoho_invoice_number, zoho_status into v_o
    from sales_order where id = cancel_order.order_id and deleted_at is null for update;
  if v_o.id is null then raise exception 'No such order.' using errcode = '42704'; end if;
  if v_o.status not in ('quote', 'confirmed') then
    raise exception '% is % — only a quote or an accepted order can be cancelled.', v_o.number, v_o.status using errcode = '22023';
  end if;
  if v_o.zoho_invoice_id is not null and coalesce(v_o.zoho_status, '') not in ('void', 'deleted') then
    raise exception '% is already invoiced in Zoho as % — accounts must credit-note that invoice first; then the order can be cancelled.',
      v_o.number, coalesce(v_o.zoho_invoice_number, 'an invoice') using errcode = '22023';
  end if;
  v_rel := public.release_order(v_o.id, 'cancelled: ' || v_why);
  update sales_order set status = 'cancelled', updated_at = now(),
         notes = concat_ws(E'\n', nullif(notes, ''), format('[%s] Cancelled by staff: %s', to_char(now() at time zone 'Africa/Johannesburg', 'YYYY-MM-DD HH24:MI'), v_why))
   where id = v_o.id;
  -- the reason on the "Cancelled" step the timeline trigger just wrote
  update sales_order set timeline = jsonb_set(timeline, array[(jsonb_array_length(timeline) - 1)::text, 'detail'],
           coalesce(timeline -> -1 -> 'detail', '{}'::jsonb) || jsonb_build_object('note', v_why))
   where id = v_o.id and timeline -> -1 ->> 'kind' = 'cancelled';
  return jsonb_build_object('order_id', v_o.id, 'number', v_o.number, 'status', 'cancelled', 'released', v_rel);
end $$;
revoke all on function public.cancel_order(bigint, text) from public, anon;
grant execute on function public.cancel_order(bigint, text) to authenticated;

-- ── FLOW-10: "Denver (Hermans)" — but not "QA Book (Test Co 2) (Test Co 2)" ──
create or replace function public.order_actor_name(p_uid uuid)
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select case when p_uid is null then null else coalesce(
    (select case when au.role = 'customer'
                 then case when cn.n is null or strpos(lower(coalesce(au.display_name, '')), lower(cn.n)) > 0
                           then coalesce(au.display_name, cn.n)
                           else concat_ws(' ', au.display_name, '(' || cn.n || ')') end
                 else au.display_name end
       from app_user au
       cross join lateral (select (select c.name from customer c where c.id = public.login_company(p_uid)) as n) cn
      where au.id = p_uid),
    (select name from customer where auth_user_id = p_uid limit 1),
    'user ' || left(p_uid::text, 8)) end
$$;
revoke all on function public.order_actor_name(uuid) from public, anon, authenticated;

-- ── FLOW-8 / FLOW-9: one "Priced" step; it says the quote went out when estimates are off ──
create or replace function public.sales_line_priced_event()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_total bigint;
begin
  if coalesce(old.unit_price_minor, 0) <= 0 and coalesce(new.unit_price_minor, 0) > 0 and new.deleted_at is null
     and not exists (select 1 from sales_line sl where sl.order_id = new.order_id and sl.deleted_at is null and sl.id <> new.id and coalesce(sl.unit_price_minor, 0) <= 0)
     and exists (select 1 from sales_order so where so.id = new.order_id and so.status = 'quote') then
    v_total := (select coalesce(sum(qty::bigint * unit_price_minor), 0) from sales_line where order_id = new.order_id and deleted_at is null);
    update sales_order set timeline = timeline || public.order_event('priced',
             case when coalesce((select estimates_enabled from zoho_config where id = 1), false) then 'Priced' else 'Priced — quote sent to the customer' end,
             auth.uid(), case when auth.uid() is null then 'CTP' end, jsonb_build_object('total_minor', v_total))
     where id = new.order_id
       -- several lines priced in one statement: each row sees the quote fully priced — log it once
       and not (timeline -> -1 ->> 'kind' = 'priced' and (timeline -> -1 -> 'detail' ->> 'total_minor') = v_total::text);
  end if;
  return new;
end $$;
revoke execute on function public.sales_line_priced_event() from public, anon, authenticated;

-- ── the timeline trigger (0070's, with FLOW-10 / FLOW-13) ───────────────────
create or replace function public.sales_order_timeline()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me uuid := coalesce(auth.uid(), new.event_actor);
  ev jsonb := '[]'::jsonb;
  cust_login uuid;
  so_by uuid;
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
        case when new.accepted_via = 'zoho' then 'Accepted in Zoho'
             when new.accepted_by is not null then 'Accepted on the customer''s behalf' else 'Accepted by the customer' end,
        case when new.accepted_via = 'zoho' then null else coalesce(new.accepted_by, me, cust_login) end,
        case when new.accepted_via = 'zoho' then 'Zoho (accounts)' end,
        jsonb_strip_nulls(jsonb_build_object('note', new.accepted_note, 'salesorder', new.zoho_salesorder_number, 'po', new.po_number)));
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
    -- FLOW-10: raised by CTP when the quote was accepted — by the admin on the customer's behalf, never "by the customer"
    so_by := coalesce(new.accepted_by, case when me is distinct from cust_login then me end);
    ev := ev || public.order_event('salesorder', format('Sales order %s raised in Zoho', coalesce(new.zoho_salesorder_number, '')),
      so_by, case when so_by is null then case when new.accepted_via = 'zoho' then 'Zoho (accounts)' else 'CTP (on acceptance)' end end);
  end if;
  if old.zoho_invoice_id is null and new.zoho_invoice_id is not null then
    ev := ev || public.order_event('invoiced', format('Invoiced in Zoho as %s', coalesce(new.zoho_invoice_number, '')), null, 'Zoho (accounts)');
  end if;
  if new.zoho_status = 'paid' and old.zoho_status is distinct from 'paid' and new.zoho_invoice_id is not null then
    ev := ev || public.order_event('paid', format('%s paid', coalesce(new.zoho_invoice_number, 'Invoice')), null, 'Zoho (accounts)');
  end if;
  if old.fulfil_override_at is null and new.fulfil_override_at is not null then
    -- FLOW-13: name the step that was skipped
    ev := ev || public.order_event('released',
      case when new.zoho_invoice_id is null or coalesce(new.zoho_status, '') in ('void', 'deleted') then 'Released for fulfilment before the invoice'
           when coalesce(new.zoho_status, 'draft') in ('draft', 'pending_approval', 'approved') then 'Released for fulfilment before the invoice was sent'
           when new.zoho_status <> 'paid' and not coalesce((select c.on_account from customer c where c.id = new.customer_id), false) then 'Released for fulfilment before payment'
           else 'Released for fulfilment' end,
      coalesce(new.fulfil_override_by, me), null,
      jsonb_strip_nulls(jsonb_build_object('note', new.fulfil_override_note)));
  end if;

  if jsonb_array_length(ev) > 0 then new.timeline := coalesce(new.timeline, '[]'::jsonb) || ev; end if;
  new.event_actor := null;
  return new;
end $$;
revoke execute on function public.sales_order_timeline() from public, anon, authenticated;

commit;
