-- 0070 (24 Oct 2026, docs/12 item 5): quote → customer PO → confirmed SO, Zoho estimate step skipped.
--
--   * Quotes are no longer Zoho estimates (estimates_enabled OFF; the switch and code stay).
--     Quotes already sent as estimates finish the estimate way.
--   * Accepting needs the customer's PO number, and a PO file (PDF/photo) unless the setting says
--     otherwise: customers by default yes (po_file_required), on behalf by default no
--     (po_file_required_behalf). The file goes to the private bucket po-docs/<customer id>/<order id>/…
--     (a customer writes and reads only their own folder; staff read all; nobody updates or deletes).
--   * The Zoho SO carries reference_number = the PO, the CTP order no. in its notes, and the PO file
--     as its attachment (accept-quote).
--   * Credit limit: the accept compares Zoho outstanding + this order with the Zoho credit limit and
--     WARNS (never blocks); the warning is kept on the order for staff (credit_warning).
--   * Zoho-side acceptance (Anton's test): an estimate accepted / converted in Zoho is followed by
--     CTP — accept_quote_from_zoho() — logged "Accepted in Zoho" on the timeline.
begin;

alter table public.sales_order add column if not exists po_number text;
alter table public.sales_order add column if not exists po_file_path text;
alter table public.sales_order add column if not exists po_file_name text;
alter table public.sales_order add column if not exists credit_warning text;
alter table public.sales_order add column if not exists accepted_via text;   -- null (customer / behalf) | 'zoho'

alter table public.zoho_config add column if not exists po_file_required boolean not null default true;
alter table public.zoho_config add column if not exists po_file_required_behalf boolean not null default false;

-- quotes are not Zoho estimates any more (docs/12 §5)
update public.zoho_config set estimates_enabled = false, updated_at = now() where id = 1;

-- the new columns readable like the rest (0067/0068: staff_log and timeline stay hidden)
do $$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
    from information_schema.columns where table_schema = 'public' and table_name = 'sales_order'
     and column_name not in ('staff_log', 'timeline');
  execute 'revoke select on public.sales_order from authenticated, anon';
  execute format('grant select (%s) on public.sales_order to authenticated', cols);
end $$;

-- ── PO files ─────────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('po-docs', 'po-docs', false, 10485760,
        array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists po_docs_insert on storage.objects;
create policy po_docs_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'po-docs' and (public.is_staff() or (storage.foldername(name))[1] = public.my_customer_id()::text));
drop policy if exists po_docs_select on storage.objects;
create policy po_docs_select on storage.objects for select to authenticated
  using (bucket_id = 'po-docs' and (public.is_staff() or (storage.foldername(name))[1] = public.my_customer_id()::text));

-- ── accepted in Zoho → CTP follows ───────────────────────────────────────────
create or replace function public.accept_quote_from_zoho(order_id bigint, p_zoho_salesorder_id text, p_zoho_salesorder_number text, p_how text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_o record; v_reserved int := 0;
begin
  if auth.uid() is not null then
    raise exception 'accept_quote_from_zoho is called by the server, not from a session.' using errcode = '42501';
  end if;
  select so.id, so.number, so.status, so.zoho_salesorder_id into v_o from sales_order so
   where so.id = accept_quote_from_zoho.order_id and so.deleted_at is null for update of so;
  if v_o.id is null then raise exception 'No such order.' using errcode = '42704'; end if;
  if v_o.status <> 'quote' then
    return jsonb_build_object('order_id', v_o.id, 'number', v_o.number, 'status', v_o.status, 'already', true, 'reserved_lines', 0);
  end if;
  update sales_order
     set status = 'confirmed', client_response = 'accepted', client_responded_at = now(),
         accepted_via = 'zoho', accepted_note = nullif(btrim(coalesce(p_how, '')), ''),
         zoho_salesorder_id = coalesce(nullif(p_zoho_salesorder_id, ''), zoho_salesorder_id),
         zoho_salesorder_number = coalesce(nullif(p_zoho_salesorder_number, ''), zoho_salesorder_number),
         zoho_created_at = case when coalesce(p_zoho_salesorder_id, '') <> '' then now() else zoho_created_at end,
         zoho_so_status = case when coalesce(p_zoho_salesorder_id, '') <> '' then 'open' else zoho_so_status end,
         zoho_so_status_at = case when coalesce(p_zoho_salesorder_id, '') <> '' then now() else zoho_so_status_at end,
         zoho_so_error = null, updated_at = now()
   where id = v_o.id;
  v_reserved := public.reserve_order(v_o.id);
  return jsonb_build_object('order_id', v_o.id, 'number', v_o.number, 'status', 'confirmed', 'already', false, 'reserved_lines', v_reserved);
end $$;
revoke all on function public.accept_quote_from_zoho(bigint, text, text, text) from public, anon, authenticated;
grant execute on function public.accept_quote_from_zoho(bigint, text, text, text) to service_role;

-- ── timeline: "Accepted in Zoho", and the PO on the accepted step ─────────────
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
      -- 0070: accepted in Zoho (accounts accepted / converted the estimate there); the customer's PO
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
commit;
