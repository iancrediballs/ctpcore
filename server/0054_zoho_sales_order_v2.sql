-- ============================================================================
--  CTP Core — quote accepted -> Zoho SALES ORDER, on the 19 Oct Zoho link (0054)
--
--  Ian, 20 Oct 2026: "sales order as before". Accepting a quote raises a Zoho
--  Books sales order (draft); invoicing the order converts THAT sales order
--  into the Zoho invoice (draft). Bills unchanged.
--
--  What changes against the September version (final-sprint 0046/0047):
--   * ONE item link. Lines are checked against public.zoho_item (the 19 Oct
--     Multicat/Zoho link, 155 items) — not part.zoho_item_id, which had drifted
--     on 5 parts. part.zoho_item_id is re-synced from zoho_item here so
--     anything still reading it sees the same answer.
--   * The go-live switch. While Zoho sending is off, or before push_from, a
--     quote is accepted and reserved WITHOUT a sales order (history never goes
--     to Zoho) and Zoho readiness does not block the customer. From go-live on,
--     accept_quote() still requires the sales order id: both or neither.
--   * Contacts are matched or created by the edge function, so "customer not
--     set up in Zoho" is no longer a blocker.
--   * The sales order's own Zoho status is kept apart from the invoice's.
-- ============================================================================
begin;

-- 1. one item link
update public.part p
   set zoho_item_id = z.zoho_item_id, updated_at = now()
  from public.zoho_item z
 where z.part_id = p.id and z.status <> 'inactive' and p.zoho_item_id is distinct from z.zoho_item_id;
update public.part p
   set zoho_item_id = null, updated_at = now()
 where p.zoho_item_id is not null
   and not exists (select 1 from public.zoho_item z where z.part_id = p.id and z.status <> 'inactive');

-- 2. sales order status beside the invoice's
alter table public.sales_order add column if not exists zoho_so_status    text;
alter table public.sales_order add column if not exists zoho_so_status_at timestamptz;
alter table public.sales_order add column if not exists zoho_so_error     text;

alter table public.zoho_push_log drop constraint if exists zoho_push_log_doc_type_check;
alter table public.zoho_push_log add constraint zoho_push_log_doc_type_check
  check (doc_type in ('invoice','bill','contact','config','test','salesorder'));

-- 3. is Zoho sending live right now?
create or replace function public.zoho_live() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select push_enabled and push_from is not null and push_from <= now() from zoho_config where id = 1), false)
$$;
grant execute on function public.zoho_live() to authenticated, service_role;

-- 4. the blockers
create or replace function public.quote_accept_check(order_id bigint)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_o record; v_blockers jsonb := '[]'::jsonb; v_me bigint; v_live boolean := zoho_live();
begin
  select so.id, so.number, so.status, so.customer_id, c.name as customer_name
    into v_o from sales_order so join customer c on c.id = so.customer_id
   where so.id = quote_accept_check.order_id and so.deleted_at is null;
  if v_o.id is null then raise exception 'No such order.' using errcode = '42704'; end if;
  v_me := my_customer_id();
  if not is_staff() and (v_me is null or v_me <> v_o.customer_id) then
    raise exception 'That order belongs to a different customer.' using errcode = '42501';
  end if;
  if v_o.status <> 'quote' then
    v_blockers := v_blockers || jsonb_build_object('kind', 'status', 'message', format('This order is already %s.', v_o.status));
  end if;
  v_blockers := v_blockers || coalesce((
    select jsonb_agg(jsonb_build_object('kind', case when sl.unit_price_minor <= 0 then 'unpriced' else 'not_in_zoho' end,
                                        'part_id', p.id, 'sku', p.sku, 'name', p.name,
                                        'message', case when sl.unit_price_minor <= 0
                                          then format('%s (%s) has no price yet — we will finish it first.', p.name, p.sku)
                                          else format('%s (%s) is not set up for ordering yet — we will finish it first.', p.name, p.sku) end)
                     order by p.sku)
      from sales_line sl join part p on p.id = sl.part_id
     where sl.order_id = v_o.id and sl.deleted_at is null
       and (sl.unit_price_minor <= 0
            or (v_live and not exists (select 1 from zoho_item z where z.part_id = p.id and z.status <> 'inactive')))), '[]'::jsonb);
  return jsonb_build_object('order_id', v_o.id, 'number', v_o.number, 'ok', jsonb_array_length(v_blockers) = 0,
                            'blockers', v_blockers, 'zoho_live', v_live);
end $$;

-- 5. the one transaction
create or replace function public.accept_quote(order_id bigint, p_auth_user uuid, p_zoho_salesorder_id text, p_zoho_salesorder_number text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_o record; v_bad text; v_reserved int := 0; v_live boolean := zoho_live();
begin
  if auth.uid() is not null then
    raise exception 'accept_quote is called by the server, not from a session.' using errcode = '42501';
  end if;
  if v_live and coalesce(p_zoho_salesorder_id, '') = '' then
    raise exception 'accept_quote needs the Zoho sales order id (Zoho sending is on).' using errcode = '22023';
  end if;
  select so.id, so.number, so.status, so.customer_id, so.zoho_salesorder_id, c.auth_user_id
    into v_o from sales_order so join customer c on c.id = so.customer_id
   where so.id = accept_quote.order_id and so.deleted_at is null for update of so;
  if v_o.id is null then raise exception 'No such order.' using errcode = '42704'; end if;
  if v_o.auth_user_id is null or v_o.auth_user_id <> p_auth_user then
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
  update sales_order
     set status = 'confirmed', client_response = 'accepted', client_responded_at = now(),
         zoho_salesorder_id = nullif(p_zoho_salesorder_id, ''), zoho_salesorder_number = nullif(p_zoho_salesorder_number, ''),
         zoho_created_at = case when coalesce(p_zoho_salesorder_id, '') <> '' then now() end,
         zoho_so_status = case when coalesce(p_zoho_salesorder_id, '') <> '' then 'draft' end,
         zoho_so_status_at = case when coalesce(p_zoho_salesorder_id, '') <> '' then now() end,
         zoho_so_error = null,
         updated_at = now()
   where id = v_o.id;
  v_reserved := public.reserve_order(v_o.id);
  return jsonb_build_object('order_id', v_o.id, 'number', v_o.number, 'status', 'confirmed',
                            'zoho_salesorder_number', nullif(p_zoho_salesorder_number, ''), 'reserved_lines', v_reserved,
                            'already', false, 'zoho_live', v_live);
end $$;
revoke all on function public.accept_quote(bigint, uuid, text, text) from public, anon, authenticated;
grant execute on function public.accept_quote(bigint, uuid, text, text) to service_role;

commit;

-- VERIFY
select (select count(*) from part p join zoho_item z on z.part_id = p.id and z.status <> 'inactive'
         where p.deleted_at is null and p.zoho_item_id is distinct from z.zoho_item_id) as item_link_drift,
       zoho_live() as zoho_live_now,
       (select count(*) from information_schema.columns where table_name = 'sales_order' and column_name like 'zoho_so_%') as so_status_cols;
