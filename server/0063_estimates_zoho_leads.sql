-- CTP Core 0063 — quotes as Zoho estimates: ZOHO LEADS, accept only after accounts SEND (23 Oct 2026).
--
-- Ian, 23 Oct: "switch quotes to Zoho estimates immediately", with two rules:
--   * The app NEVER marks an estimate sent. The customer (and the admin "accept
--     on customer's behalf") can accept only once accounts have SENT the
--     estimate from Zoho. Declined / expired / invoiced estimates are refused.
--   * Zoho leads the estimate's content. "Send quote" creates the draft estimate
--     ONCE as a proposal; after that CTP never pushes to it. The quote lines are
--     LOCKED in CTP ("Edit prices in Zoho (QT-…)") and follow Zoho through the
--     read-back (10-min cron, opening the order, Refresh): lines, prices,
--     discounts, total, expiry and status — old → new in the order notes.
--     The sales order is raised FROM the estimate's lines on acceptance.
begin;

alter table public.sales_order add column if not exists zoho_estimate_total_minor bigint;
alter table public.sales_order add column if not exists zoho_estimate_expiry date;
alter table public.sales_order add column if not exists zoho_estimate_emailed boolean;
alter table public.sales_order add column if not exists zoho_estimate_synced_at timestamptz;

-- ── the quote's lines are Zoho's once the estimate exists ────────────────────
-- Only the read-back (apply_zoho_estimate, which sets ctp.zoho_apply) may change
-- them while the order is a quote. Bookkeeping updates that leave qty, price,
-- part, discount and deleted_at alone (rev bumps, customer_id denormalisation)
-- pass. A deleted / declined / expired estimate releases the lock.
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
     and coalesce(v.zoho_estimate_status, '') not in ('deleted', 'declined', 'expired') then
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
drop trigger if exists sales_line_estimate_lock on public.sales_line;
create trigger sales_line_estimate_lock before insert or update or delete on public.sales_line
  for each row execute function public.sales_line_estimate_lock();

-- ── read-back: Zoho's estimate → the CTP quote (Zoho wins) ───────────────────
-- p_est: { estimate_id, estimate_number, status, last_modified_time, total,
--          expiry_date, is_emailed, line_items: [{item_id, quantity, rate,
--          discount, discount_amount, sku, name}], error? }
-- While the order is a QUOTE its lines follow the estimate exactly (price,
-- discount, quantity, added and removed lines). Afterwards only the estimate's
-- status/number are recorded. Every change goes into the notes once.
drop function if exists public.apply_zoho_estimate(bigint, jsonb);
create function public.apply_zoho_estimate(p_order_id bigint, p_est jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  o sales_order;
  st text := nullif(p_est->>'status', '');
  num text;
  z record; c record; v_part bigint; v_pct numeric; v_price int; v_new_id bigint;
  v_used bigint[] := '{}'; v_changes text[] := '{}'; v_warn text[] := '{}';
  stamp text := to_char(now() at time zone 'Africa/Johannesburg', 'YYYY-MM-DD HH24:MI');
  fmt constant text := 'FM999,999,990.00';
begin
  select * into o from sales_order where id = p_order_id for update;
  if not found then raise exception 'order % not found', p_order_id; end if;
  if o.zoho_estimate_id is not null and p_est ? 'estimate_id'
     and o.zoho_estimate_id <> (p_est->>'estimate_id') then
    raise exception 'order % is linked to Zoho estimate %, not %', o.number, o.zoho_estimate_id, p_est->>'estimate_id';
  end if;
  num := coalesce(nullif(p_est->>'estimate_number', ''), o.zoho_estimate_number, 'estimate');

  if o.status = 'quote' and o.deleted_at is null and jsonb_typeof(p_est->'line_items') = 'array'
     and coalesce(st, '') not in ('deleted', 'declined', 'expired') then
    perform set_config('ctp.zoho_apply', 'on', true);
    for z in
      select (x->>'item_id') as item_id, coalesce((x->>'quantity')::numeric, 0) as qty,
             coalesce((x->>'rate')::numeric, 0) as rate, coalesce(x->>'discount', '0') as disc,
             coalesce((x->>'discount_amount')::numeric, 0) as disc_amt, coalesce(x->>'sku', x->>'name', '?') as label, ord
        from jsonb_array_elements(p_est->'line_items') with ordinality as t(x, ord) order by ord
    loop
      v_part := null;
      select zi.part_id into v_part from zoho_item zi where zi.zoho_item_id = z.item_id and zi.part_id is not null limit 1;
      if v_part is null then v_warn := v_warn || format('%s is not a CTP part', z.label); continue; end if;
      v_price := round(z.rate * 100)::int;
      v_pct := case when z.disc like '%\%%' then coalesce(nullif(replace(z.disc, '%', ''), '')::numeric, 0)
                    when z.disc_amt > 0 and z.rate * z.qty > 0 then round(z.disc_amt / (z.rate * z.qty) * 100, 4)
                    when z.disc ~ '^[0-9.]+$' and z.disc::numeric > 0 and z.rate * z.qty > 0 then round(z.disc::numeric / (z.rate * z.qty) * 100, 4)
                    else 0 end;
      c := null;
      select sl.id, sl.qty, sl.unit_price_minor, coalesce(sl.rebate_pct, 0) as rebate_pct, sl.deleted_at, p.sku
        into c from sales_line sl join part p on p.id = sl.part_id
       where sl.order_id = o.id and sl.part_id = v_part and not (sl.id = any(v_used))
       order by (sl.deleted_at is null) desc, sl.id limit 1;
      if c.id is null then
        if exists (select 1 from sales_line sl where sl.order_id = o.id and sl.part_id = v_part) then
          v_warn := v_warn || format('%s is on the estimate more than once', (select sku from part where id = v_part));
          continue;
        end if;
        insert into sales_line (order_id, part_id, qty, unit_price_minor, tier_at_add, origin)
        values (o.id, v_part, z.qty::int, v_price, 'zoho', 'server') returning id into v_new_id;
        v_used := v_used || v_new_id;
        v_changes := v_changes || format('added %s × %s at R%s', z.qty::int, (select sku from part where id = v_part), to_char(v_price / 100.0, fmt));
        c := null;
        select sl.id, sl.qty, sl.unit_price_minor, 0::numeric as rebate_pct, sl.deleted_at, p.sku
          into c from sales_line sl join part p on p.id = sl.part_id where sl.id = v_new_id;
      else
        v_used := v_used || c.id;
        if c.deleted_at is not null then
          update sales_line set deleted_at = null, updated_at = now() where id = c.id;
          v_changes := v_changes || format('added back %s × %s', z.qty::int, c.sku);
        end if;
        if c.unit_price_minor <> v_price then
          update sales_line set unit_price_minor = v_price, updated_at = now() where id = c.id;
          v_changes := v_changes || format('%s price R%s → R%s', c.sku, to_char(c.unit_price_minor / 100.0, fmt), to_char(v_price / 100.0, fmt));
        end if;
        if c.qty <> z.qty::int then
          update sales_line set qty = z.qty::int, updated_at = now() where id = c.id;
          v_changes := v_changes || format('%s quantity %s → %s', c.sku, c.qty, z.qty::int);
        end if;
      end if;
      if c.rebate_pct <> v_pct then
        v_changes := v_changes || format('%s discount %s%% → %s%%', c.sku, trim_scale(round(c.rebate_pct, 2))::text, trim_scale(round(v_pct, 2))::text);
      end if;
      update sales_line set rebate_pct = v_pct,
             rebate_minor = round(qty * unit_price_minor * v_pct / 100),
             line_net_minor = case when v_pct = 0 then null else (qty * unit_price_minor) - round(qty * unit_price_minor * v_pct / 100) end
       where id = c.id and (coalesce(rebate_pct, 0) <> v_pct or v_pct > 0);
    end loop;
    for c in select sl.id, sl.qty, p.sku from sales_line sl join part p on p.id = sl.part_id
              where sl.order_id = o.id and sl.deleted_at is null and not (sl.id = any(v_used)) loop
      update sales_line set deleted_at = now(), updated_at = now() where id = c.id;
      v_changes := v_changes || format('removed %s × %s (not on the estimate)', c.qty, c.sku);
    end loop;
    perform set_config('ctp.zoho_apply', '', true);
  end if;

  if st is not null and o.zoho_estimate_status is not null and st is distinct from o.zoho_estimate_status then
    v_changes := v_changes || format('status %s → %s', o.zoho_estimate_status, st);
  end if;

  update sales_order set
    zoho_estimate_id          = coalesce(p_est->>'estimate_id', zoho_estimate_id),
    zoho_estimate_number      = coalesce(nullif(p_est->>'estimate_number', ''), zoho_estimate_number),
    zoho_estimate_status      = coalesce(st, zoho_estimate_status),
    zoho_estimate_status_at   = now(),
    zoho_estimate_synced_at   = now(),
    zoho_estimate_modified_at = coalesce(nullif(p_est->>'last_modified_time', '')::timestamptz, zoho_estimate_modified_at),
    zoho_estimate_total_minor = coalesce(round(nullif(p_est->>'total', '')::numeric * 100)::bigint, zoho_estimate_total_minor),
    zoho_estimate_expiry      = coalesce(nullif(p_est->>'expiry_date', '')::date, zoho_estimate_expiry),
    zoho_estimate_emailed     = coalesce((p_est->>'is_emailed')::boolean, zoho_estimate_emailed),
    zoho_estimate_error       = case
      when st = 'deleted' then 'This estimate was DELETED in Zoho. It will not be re-created automatically — ask the accountant.'
      when cardinality(v_warn) > 0 then 'Differs from Zoho: ' || array_to_string(v_warn, '; ')
      when nullif(p_est->>'error', '') is not null then p_est->>'error'
      else null end,
    notes = case when cardinality(v_changes) + cardinality(v_warn) = 0 then notes
                 else concat_ws(E'\n', nullif(notes, ''), format('[%s] Zoho estimate %s — %s', stamp, num,
                        array_to_string(v_changes || v_warn, '; '))) end,
    updated_at = case when cardinality(v_changes) > 0 or o.zoho_estimate_id is null then now() else updated_at end
  where id = p_order_id;
  return jsonb_build_object('order_id', p_order_id, 'status', coalesce(st, o.zoho_estimate_status),
                            'changes', to_jsonb(v_changes), 'warnings', to_jsonb(v_warn));
end $$;
revoke all on function public.apply_zoho_estimate(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.apply_zoho_estimate(bigint, jsonb) to service_role;

-- ── accept only after accounts SEND the estimate ─────────────────────────────
-- 0054's check plus the estimate blockers (only while estimates are on and Zoho
-- is live). The customer reads `message`; the desk reads `staff_message`.
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
    if v_o.zoho_estimate_id is null or coalesce(v_o.zoho_estimate_status, 'draft') in ('draft', 'deleted') then
      v_blockers := v_blockers || jsonb_build_object('kind', 'estimate',
        'message', 'Your quote is being finalised by our accounts team.',
        'staff_message', case when v_o.zoho_estimate_id is null then 'No Zoho estimate yet — tap Send quote (creates the draft estimate in Zoho).'
                              when v_o.zoho_estimate_status = 'deleted' then format('Zoho estimate %s was deleted in Zoho — ask accounts.', v_o.zoho_estimate_number)
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

commit;
