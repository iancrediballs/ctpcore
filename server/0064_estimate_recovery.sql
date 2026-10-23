-- CTP Core 0064 — Phase 2 close-out (23 Oct 2026).
--
-- 1. A VOIDED estimate is treated like a deleted one: the quote's lines unlock,
--    the customer still sees "being finalised", and the desk is told an admin
--    can create a new estimate.
-- 2. reset_zoho_estimate() (server only, called by zoho-push
--    {action:"estimate_recreate"} for an ADMIN): when the quote's Zoho estimate
--    was deleted or voided in Zoho, the old link is retired — its number kept in
--    the notes — so a fresh draft can be created from the current CTP lines.
--    Refuses anything else, so it can never be used to make a duplicate.
begin;

create or replace function public.sales_line_estimate_lock()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v record; n jsonb; o jsonb;
begin
  if coalesce(current_setting('ctp.zoho_apply', true), '') = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  select so.status, so.zoho_estimate_id, so.zoho_estimate_number, so.zoho_estimate_status into v
    from sales_order so where so.id = case when tg_op = 'DELETE' then old.order_id else new.order_id end;
  if v.status = 'quote' and v.zoho_estimate_id is not null
     and coalesce(v.zoho_estimate_status, '') not in ('deleted', 'void', 'declined', 'expired') then
    if tg_op = 'UPDATE' then
      n := to_jsonb(new); o := to_jsonb(old);
      if n->'qty' = o->'qty' and n->'unit_price_minor' = o->'unit_price_minor' and n->'part_id' = o->'part_id'
         and n->'deleted_at' is not distinct from o->'deleted_at' and n->'rebate_pct' is not distinct from o->'rebate_pct' then
        return new;
      end if;
    end if;
    raise exception 'Edit prices in Zoho (%): this quote is a Zoho estimate, and Zoho leads its lines.',
      coalesce(v.zoho_estimate_number, 'the estimate') using errcode = '22023';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

create or replace function public.quote_accept_check(order_id bigint)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_o record; v_blockers jsonb := '[]'::jsonb; v_me bigint; v_live boolean := zoho_live();
        v_est boolean := v_live and coalesce((select estimates_enabled from zoho_config where id = 1), false);
begin
  select so.id, so.number, so.status, so.customer_id, so.zoho_estimate_id, so.zoho_estimate_number, so.zoho_estimate_status,
         so.zoho_estimate_total_minor, so.zoho_estimate_expiry, c.name as customer_name
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
  if v_est and v_o.status = 'quote' then
    if v_o.zoho_estimate_id is null or coalesce(v_o.zoho_estimate_status, 'draft') in ('draft', 'deleted', 'void') then
      v_blockers := v_blockers || jsonb_build_object('kind', 'estimate',
        'message', 'Your quote is being finalised by our accounts team.',
        'staff_message', case when v_o.zoho_estimate_id is null then 'No Zoho estimate yet — tap Send quote (creates the draft estimate in Zoho).'
                              when v_o.zoho_estimate_status in ('deleted', 'void') then format('Zoho estimate %s was %s in Zoho — an admin can tap "Create new estimate".', v_o.zoho_estimate_number, v_o.zoho_estimate_status)
                              else format('Waiting for accounts to send estimate %s from Zoho.', coalesce(v_o.zoho_estimate_number, '')) end);
    elsif v_o.zoho_estimate_status in ('declined', 'expired', 'invoiced') then
      v_blockers := v_blockers || jsonb_build_object('kind', 'estimate',
        'message', format('This quote is %s in our accounts system — please ask us for a new one.', v_o.zoho_estimate_status),
        'staff_message', format('Zoho estimate %s is %s — it cannot be accepted.', v_o.zoho_estimate_number, v_o.zoho_estimate_status));
    end if;
  end if;
  -- Zoho's figures for the customer (their stream carries no discounts or totals)
  return jsonb_build_object('order_id', v_o.id, 'number', v_o.number, 'ok', jsonb_array_length(v_blockers) = 0,
                            'blockers', v_blockers, 'zoho_live', v_live, 'estimates', v_est,
                            'estimate', case when v_o.zoho_estimate_id is null then null else jsonb_build_object(
                              'number', v_o.zoho_estimate_number, 'status', v_o.zoho_estimate_status,
                              'total_minor', v_o.zoho_estimate_total_minor, 'expiry', v_o.zoho_estimate_expiry,
                              'lines', coalesce((select jsonb_agg(jsonb_build_object('part_id', sl.part_id, 'discount_pct', sl.rebate_pct,
                                                   'net_minor', coalesce(sl.line_net_minor, sl.qty::bigint * sl.unit_price_minor)))
                                                   from sales_line sl where sl.order_id = v_o.id and sl.deleted_at is null), '[]'::jsonb)) end);
end $$;

create or replace function public.reset_zoho_estimate(p_order_id bigint, p_actor uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare o sales_order; who text;
begin
  if auth.uid() is not null then
    raise exception 'reset_zoho_estimate is called by the server, not from a session.' using errcode = '42501';
  end if;
  select * into o from sales_order where id = p_order_id and deleted_at is null for update;
  if not found then raise exception 'No such order.' using errcode = '42704'; end if;
  if o.status <> 'quote' then
    raise exception '% is %, not a quote — no new estimate.', o.number, o.status using errcode = '22023';
  end if;
  if o.zoho_estimate_id is null then
    raise exception '% has no Zoho estimate to replace.', o.number using errcode = '22023';
  end if;
  if coalesce(o.zoho_estimate_status, '') not in ('deleted', 'void') then
    raise exception 'Zoho estimate % is %, not deleted or voided — no second estimate.', o.zoho_estimate_number, coalesce(o.zoho_estimate_status, 'unknown')
      using errcode = '22023';
  end if;
  select coalesce(display_name, p_actor::text) into who from app_user where id = p_actor;
  update sales_order set
    zoho_estimate_id = null, zoho_estimate_number = null, zoho_estimate_status = null, zoho_estimate_error = null,
    zoho_estimate_total_minor = null, zoho_estimate_expiry = null, zoho_estimate_emailed = null,
    zoho_estimate_modified_at = null, zoho_estimate_synced_at = null, zoho_estimate_status_at = now(),
    notes = concat_ws(E'\n', nullif(notes, ''), format('[%s] Zoho estimate %s was %s in Zoho — new draft requested by %s%s',
              to_char(now() at time zone 'Africa/Johannesburg', 'YYYY-MM-DD HH24:MI'), coalesce(o.zoho_estimate_number, o.zoho_estimate_id),
              o.zoho_estimate_status, coalesce(who, 'an admin'), case when nullif(p_reason, '') is null then '' else ': ' || p_reason end)),
    updated_at = now()
  where id = o.id;
  return jsonb_build_object('order_id', o.id, 'number', o.number, 'replaced', o.zoho_estimate_number, 'was', o.zoho_estimate_status);
end $$;
revoke all on function public.reset_zoho_estimate(bigint, uuid, text) from public, anon, authenticated;
grant execute on function public.reset_zoho_estimate(bigint, uuid, text) to service_role;

commit;
