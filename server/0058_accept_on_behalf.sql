-- CTP Core 0058 — an admin accepts a quote on the customer's behalf (22 Oct 2026).
--
-- For orders the customer confirms by phone or email (Ian: Hermans demo). Same
-- path as the customer's own accept: the accept-quote edge function raises the
-- CONFIRMED Zoho sales order first, then this function does the database side
-- in one transaction (status, Zoho refs, stock holds via reserve_order), and
-- the function deletes the Zoho SO again if this fails.
--
-- What differs from accept_quote(): no "is it your company" check (the caller
-- is staff), instead the caller must be an ADMIN, a note is required, and who
-- did it is recorded on the order (accepted_by, accepted_note) and in its notes.
-- accept_quote() itself is unchanged.
begin;

alter table public.sales_order add column if not exists accepted_by uuid;
alter table public.sales_order add column if not exists accepted_note text;

create or replace function public.accept_quote_on_behalf(order_id bigint, p_staff uuid, p_note text,
                                                         p_zoho_salesorder_id text, p_zoho_salesorder_number text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_o record; v_bad text; v_reserved int := 0; v_live boolean := zoho_live(); v_who text; v_note text := btrim(coalesce(p_note, ''));
begin
  if auth.uid() is not null then
    raise exception 'accept_quote_on_behalf is called by the server, not from a session.' using errcode = '42501';
  end if;
  select coalesce(nullif(btrim(a.display_name), ''), u.email, 'admin') into v_who
    from app_user a left join auth.users u on u.id = a.id
   where a.id = p_staff and a.role = 'admin';
  if v_who is null then
    raise exception 'Only an admin can accept a quote on the customer''s behalf.' using errcode = '42501';
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
                            'already', false, 'zoho_live', v_live, 'accepted_by', v_who);
end $$;
revoke all on function public.accept_quote_on_behalf(bigint, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.accept_quote_on_behalf(bigint, uuid, text, text, text) to service_role;

commit;
