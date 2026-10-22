-- CTP Core 0059 — the Zoho sales order is read BACK, and fulfil waits for accounts (22 Oct 2026).
--
-- Ian: "once the sales order gets to michelle she changed the price on her side
-- ... that needs to reflect back ... the fulfil - take stock out button should
-- not be active until that process is complete on michelles side".
--
-- 1. FULFIL GATE. An order that has a Zoho sales order cannot be fulfilled until
--    accounts have finished with it in Zoho, read from real Zoho data:
--      * the SO is confirmed (open, or already partially invoiced/invoiced/closed),
--      * the SO has been EMAILED to the customer (Zoho `is_emailed`), and
--      * Michelle's latest version has been read back into CTP (lines/prices),
--        with nothing in it CTP could not map.
--    Enforced by a trigger on sales_order.status, so every path (phone, desktop
--    upload, SQL) obeys it; fulfil_order() itself is unchanged. Orders without a
--    Zoho SO (pre-go-live) are not affected. An ADMIN can override with a note
--    (override_fulfil_gate) — e.g. accounts confirmed by phone, customer collecting.
--
-- 2. READ-BACK. apply_zoho_salesorder() (server only, called by zoho-push with the
--    SO it just read) makes the CTP order match Zoho — Zoho wins:
--      * price (rate) and discount per line; quantity, added and removed lines
--        while the order is still only accepted (stock not yet out); after goods
--        out only prices/discounts follow and a quantity difference is flagged;
--      * every change is written into the order notes, old → new;
--      * stock holds follow a quantity change (released and re-held);
--      * the SO's status, emailed flag, last-modified time and payment terms.
--    Idempotent: the same Zoho version applied twice changes nothing.
--
-- 3. ACCOUNT TERMS. apply_zoho_contact_terms() stores the Zoho contact's payment
--    terms, outstanding receivables, unused credits and credit limit on the
--    customer row, for display. Nothing blocks on payment here.
begin;

alter table public.sales_order add column if not exists zoho_so_emailed boolean;
alter table public.sales_order add column if not exists zoho_so_modified_at timestamptz;
alter table public.sales_order add column if not exists zoho_so_synced_at timestamptz;
alter table public.sales_order add column if not exists zoho_so_terms_days int;
alter table public.sales_order add column if not exists zoho_so_terms_label text;
alter table public.sales_order add column if not exists zoho_so_readback_issue text;
alter table public.sales_order add column if not exists fulfil_override_by uuid;
alter table public.sales_order add column if not exists fulfil_override_note text;
alter table public.sales_order add column if not exists fulfil_override_at timestamptz;

alter table public.customer add column if not exists zoho_terms_days int;
alter table public.customer add column if not exists zoho_terms_label text;
alter table public.customer add column if not exists zoho_outstanding_minor bigint;
alter table public.customer add column if not exists zoho_unused_credit_minor bigint;
alter table public.customer add column if not exists zoho_credit_limit_minor bigint;
alter table public.customer add column if not exists zoho_terms_synced_at timestamptz;

-- ── why an order may not be fulfilled yet (null = it may) ────────────────────
-- Pure: reads only the row it is given, so the trigger can pass NEW.
create or replace function public.fulfil_block_reason(so public.sales_order)
returns text language sql stable set search_path = public, pg_temp as $$
  select case
    when so.zoho_salesorder_id is null then null                     -- no Zoho SO: not gated
    when so.fulfil_override_at is not null then null                 -- admin override, recorded
    when so.zoho_so_status in ('deleted', 'void') then
      format('The Zoho sales order %s was %s in Zoho — ask accounts before taking stock out.', coalesce(so.zoho_salesorder_number, ''), so.zoho_so_status)
    when coalesce(so.zoho_so_status, 'draft') not in ('open', 'partially_invoiced', 'invoiced', 'closed') then
      'Waiting for accounts (Zoho) to approve and send the sales order.'
    when so.zoho_so_synced_at is null then
      'Waiting for the sales order to be read back from Zoho — press Refresh.'
    when not coalesce(so.zoho_so_emailed, false) then
      'Waiting for accounts (Zoho) to approve and send the sales order.'
    when so.zoho_so_readback_issue is not null then
      'The Zoho sales order has a line CTP cannot match: ' || so.zoho_so_readback_issue
    else null end
$$;

create or replace function public.fulfil_block_reason(p_order_id bigint)
returns text language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v public.sales_order;
begin
  if auth.uid() is not null and not is_staff() then
    raise exception 'Staff only.' using errcode = '42501';
  end if;
  select * into v from sales_order where id = p_order_id and deleted_at is null;
  if v.id is null then return null; end if;
  return public.fulfil_block_reason(v);
end $$;
revoke all on function public.fulfil_block_reason(bigint) from public, anon;
grant execute on function public.fulfil_block_reason(bigint) to authenticated, service_role;

create or replace function public.sales_order_fulfil_gate()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare v_why text;
begin
  if new.status = 'fulfilled' and old.status is distinct from 'fulfilled' then
    v_why := public.fulfil_block_reason(new);
    if v_why is not null then
      raise exception 'Not yet: %', v_why using errcode = '22023';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists sales_order_fulfil_gate on public.sales_order;
create trigger sales_order_fulfil_gate before update of status on public.sales_order
  for each row execute function public.sales_order_fulfil_gate();

-- ── admin override, with a note ─────────────────────────────────────────────
create or replace function public.override_fulfil_gate(p_order_id bigint, p_note text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_o record; v_who text; v_note text := btrim(coalesce(p_note, ''));
begin
  select coalesce(nullif(btrim(a.display_name), ''), u.email, 'admin') into v_who
    from app_user a left join auth.users u on u.id = a.id
   where a.id = auth.uid() and a.role = 'admin';
  if v_who is null then
    raise exception 'Only an admin can release an order for fulfilment before accounts have sent it.' using errcode = '42501';
  end if;
  if length(v_note) < 5 then
    raise exception 'Say why it may go out before accounts have sent it.' using errcode = '22023';
  end if;
  select id, number, status into v_o from sales_order where id = p_order_id and deleted_at is null for update;
  if v_o.id is null then raise exception 'No such order.' using errcode = '42704'; end if;
  if v_o.status <> 'confirmed' then
    raise exception '% is %, so there is nothing to release.', v_o.number, v_o.status using errcode = '22023';
  end if;
  update sales_order
     set fulfil_override_by = auth.uid(), fulfil_override_note = v_note, fulfil_override_at = now(), updated_at = now(),
         notes = concat_ws(E'\n', nullif(notes, ''),
                   format('[%s] Released for fulfilment before accounts finished in Zoho, by %s: %s',
                          to_char(now() at time zone 'Africa/Johannesburg', 'YYYY-MM-DD HH24:MI'), v_who, v_note))
   where id = v_o.id;
  return jsonb_build_object('order_id', v_o.id, 'number', v_o.number, 'overridden_by', v_who);
end $$;
revoke all on function public.override_fulfil_gate(bigint, text) from public, anon;
grant execute on function public.override_fulfil_gate(bigint, text) to authenticated;

-- ── read-back: make the CTP order match the Zoho sales order ─────────────────
-- p_so: { salesorder_number, status, is_emailed, last_modified_time,
--         payment_terms, payment_terms_label,
--         line_items: [{ line_item_id, item_id, quantity, rate, discount, discount_amount }] }
create or replace function public.apply_zoho_salesorder(p_order_id bigint, p_so jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_o record; v_mod timestamptz; v_lines boolean; v_prices boolean;
  z record; c record; v_part bigint; v_pct numeric; v_price int;
  v_changes text[] := '{}'; v_warn text[] := '{}'; v_qty_changed boolean := false;
  v_used bigint[] := '{}'; v_new_id bigint; v_r numeric;
  fmt constant text := 'FM999,999,990.00';
begin
  if auth.uid() is not null then
    raise exception 'apply_zoho_salesorder is called by the server, not from a session.' using errcode = '42501';
  end if;
  select so.id, so.number, so.status, so.location_id, so.zoho_so_modified_at, so.zoho_so_synced_at
    into v_o from sales_order so where so.id = p_order_id and so.deleted_at is null for update;
  if v_o.id is null then return jsonb_build_object('skipped', 'no such order'); end if;
  v_mod := nullif(p_so->>'last_modified_time', '')::timestamptz;

  -- lines follow Zoho only before invoicing; quantities only before goods out
  v_prices := v_o.status in ('confirmed', 'fulfilled');
  v_lines  := v_o.status = 'confirmed';

  if (v_prices and (v_mod is null or v_o.zoho_so_modified_at is distinct from v_mod or v_o.zoho_so_synced_at is null))
     and jsonb_typeof(p_so->'line_items') = 'array' then
    -- Zoho lines in their order; each takes the first unused live CTP line for the same part
    for z in
      select (x->>'line_item_id') as lid, (x->>'item_id') as item_id, coalesce((x->>'quantity')::numeric, 0) as qty,
             coalesce((x->>'rate')::numeric, 0) as rate, coalesce(x->>'discount', '0') as disc,
             coalesce((x->>'discount_amount')::numeric, 0) as disc_amt, coalesce(x->>'sku', x->>'name', '?') as label, ord
        from jsonb_array_elements(p_so->'line_items') with ordinality as t(x, ord) order by ord
    loop
      select zi.part_id into v_part from zoho_item zi where zi.zoho_item_id = z.item_id and zi.part_id is not null limit 1;
      if v_part is null then
        v_warn := v_warn || format('%s is not a CTP part', z.label);
        continue;
      end if;
      v_price := round(z.rate * 100)::int;
      -- discount: "10%" or "10.00%" is a percentage; a plain number is an amount on the line
      v_pct := case when z.disc like '%\%%' then nullif(replace(z.disc, '%', ''), '')::numeric
                    when z.disc_amt > 0 and z.rate * z.qty > 0 then round(z.disc_amt / (z.rate * z.qty) * 100, 4)
                    when z.disc ~ '^[0-9.]+$' and z.disc::numeric > 0 and z.rate * z.qty > 0 then round(z.disc::numeric / (z.rate * z.qty) * 100, 4)
                    else 0 end;
      select sl.id, sl.qty, sl.unit_price_minor, coalesce(sl.rebate_pct, 0) as rebate_pct, p.sku
        into c from sales_line sl join part p on p.id = sl.part_id
       where sl.order_id = v_o.id and sl.deleted_at is null and sl.part_id = v_part and not (sl.id = any(v_used))
       order by sl.id limit 1;
      if c.id is null then
        if exists (select 1 from sales_line sl where sl.order_id = v_o.id and sl.part_id = v_part and sl.id = any(v_used)) then
          -- CTP holds one line per part per order (unique order_id, part_id)
          v_warn := v_warn || format('%s is on the Zoho sales order more than once', (select sku from part where id = v_part));
        elsif v_lines then
          -- one line per part per order, deleted rows included: a removed line comes back
          select sl.id into v_new_id from sales_line sl where sl.order_id = v_o.id and sl.part_id = v_part limit 1;
          if v_new_id is not null then
            update sales_line set deleted_at = null, qty = z.qty::int, unit_price_minor = v_price,
                   rebate_pct = 0, rebate_minor = 0, line_net_minor = null, updated_at = now() where id = v_new_id;
          else
            insert into sales_line (order_id, part_id, qty, unit_price_minor, tier_at_add, origin)
            values (v_o.id, v_part, z.qty::int, v_price, 'zoho', 'server') returning id into v_new_id;
          end if;
          v_used := v_used || v_new_id;
          if v_pct > 0 then
            update sales_line set rebate_pct = v_pct, rebate_minor = round(z.qty * v_price * v_pct / 100),
                   line_net_minor = (z.qty * v_price) - round(z.qty * v_price * v_pct / 100) where id = v_new_id;
          end if;
          v_qty_changed := true;
          v_changes := v_changes || format('added %s × %s at R%s', z.qty::int, (select sku from part where id = v_part), to_char(v_price / 100.0, fmt));
        else
          v_warn := v_warn || format('%s is on the Zoho sales order but not on this order (goods already out)', (select sku from part where id = v_part));
        end if;
        continue;
      end if;
      v_used := v_used || c.id;
      if c.unit_price_minor <> v_price then
        update sales_line set unit_price_minor = v_price, updated_at = now() where id = c.id;
        v_changes := v_changes || format('%s price R%s → R%s', c.sku, to_char(c.unit_price_minor / 100.0, fmt), to_char(v_price / 100.0, fmt));
      end if;
      if c.rebate_pct <> v_pct then
        update sales_line set rebate_pct = v_pct,
               rebate_minor = round(qty * unit_price_minor * v_pct / 100),
               line_net_minor = case when v_pct = 0 then null else (qty * unit_price_minor) - round(qty * unit_price_minor * v_pct / 100) end,
               updated_at = now() where id = c.id;
        v_changes := v_changes || format('%s discount %s%% → %s%%', c.sku, trim_scale(round(c.rebate_pct, 2))::text, trim_scale(round(v_pct, 2))::text);
      elsif v_pct > 0 and c.unit_price_minor <> v_price then
        update sales_line set rebate_minor = round(qty * unit_price_minor * v_pct / 100),
               line_net_minor = (qty * unit_price_minor) - round(qty * unit_price_minor * v_pct / 100) where id = c.id;
      end if;
      if c.qty <> z.qty::int then
        if v_lines then
          update sales_line set qty = z.qty::int, updated_at = now() where id = c.id;
          if v_pct > 0 then
            update sales_line set rebate_minor = round(qty * unit_price_minor * v_pct / 100),
                   line_net_minor = (qty * unit_price_minor) - round(qty * unit_price_minor * v_pct / 100) where id = c.id;
          end if;
          v_qty_changed := true;
          v_changes := v_changes || format('%s quantity %s → %s', c.sku, c.qty, z.qty::int);
        else
          v_warn := v_warn || format('%s: Zoho quantity %s, %s went out', c.sku, z.qty::int, c.qty);
        end if;
      end if;
    end loop;

    -- CTP lines Zoho no longer has
    for c in select sl.id, sl.qty, p.sku from sales_line sl join part p on p.id = sl.part_id
              where sl.order_id = v_o.id and sl.deleted_at is null and not (sl.id = any(v_used)) loop
      if v_lines then
        update sales_line set deleted_at = now(), updated_at = now() where id = c.id;
        v_qty_changed := true;
        v_changes := v_changes || format('removed %s × %s (not on the Zoho sales order)', c.qty, c.sku);
      else
        v_warn := v_warn || format('%s went out but is not on the Zoho sales order', c.sku);
      end if;
    end loop;

    -- stock holds follow the new quantities
    if v_qty_changed then
      perform public.release_order(v_o.id, 'Zoho sales order changed');
      insert into stock_movement (part_id, location_id, delta, reason, ref_type, ref_id, client_uuid, origin)
      select sl.part_id, v_o.location_id, -sl.qty, 'reserve', 'sales_order', v_o.id,
             'so-' || v_o.id || '-line-' || sl.id || '-reserve-zoho-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS'), 'server'
        from sales_line sl where sl.order_id = v_o.id and sl.deleted_at is null;
    end if;
  end if;

  update sales_order set
    zoho_so_status = coalesce(nullif(p_so->>'status', ''), zoho_so_status),
    zoho_salesorder_number = coalesce(nullif(p_so->>'salesorder_number', ''), zoho_salesorder_number),
    zoho_so_emailed = coalesce((p_so->>'is_emailed')::boolean, zoho_so_emailed),
    zoho_so_terms_days = coalesce(nullif(p_so->>'payment_terms', '')::int, zoho_so_terms_days),
    zoho_so_terms_label = coalesce(nullif(p_so->>'payment_terms_label', ''), zoho_so_terms_label),
    zoho_so_modified_at = coalesce(v_mod, zoho_so_modified_at),
    zoho_so_synced_at = now(), zoho_so_status_at = now(),
    zoho_so_readback_issue = case when v_prices and jsonb_typeof(p_so->'line_items') = 'array'
                                  then nullif(array_to_string(v_warn, '; '), '') else zoho_so_readback_issue end,
    notes = case when cardinality(v_changes) + cardinality(v_warn) = 0 then notes
                 else concat_ws(E'\n', nullif(notes, ''),
                        format('[%s] Zoho %s changed by accounts — %s', to_char(now() at time zone 'Africa/Johannesburg', 'YYYY-MM-DD HH24:MI'),
                               coalesce(nullif(p_so->>'salesorder_number', ''), 'sales order'),
                               array_to_string(v_changes || v_warn, '; '))) end,
    updated_at = now()
  where id = v_o.id;

  return jsonb_build_object('order_id', v_o.id, 'number', v_o.number, 'changes', to_jsonb(v_changes), 'warnings', to_jsonb(v_warn),
                            'lines_applied', v_prices and (v_mod is null or v_o.zoho_so_modified_at is distinct from v_mod or v_o.zoho_so_synced_at is null));
end $$;
revoke all on function public.apply_zoho_salesorder(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.apply_zoho_salesorder(bigint, jsonb) to service_role;

-- ── account terms from the Zoho contact ─────────────────────────────────────
create or replace function public.apply_zoho_contact_terms(p_customer_id bigint, p_c jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'apply_zoho_contact_terms is called by the server, not from a session.' using errcode = '42501';
  end if;
  update customer set
    zoho_terms_days = nullif(p_c->>'payment_terms', '')::int,
    zoho_terms_label = nullif(p_c->>'payment_terms_label', ''),
    zoho_outstanding_minor = round(coalesce(nullif(p_c->>'outstanding_receivable_amount', '')::numeric, 0) * 100),
    zoho_unused_credit_minor = round(coalesce(nullif(p_c->>'unused_credits_receivable_amount', '')::numeric, 0) * 100),
    zoho_credit_limit_minor = case when coalesce(nullif(p_c->>'credit_limit', '')::numeric, 0) > 0
                                   then round((p_c->>'credit_limit')::numeric * 100) end,
    zoho_terms_synced_at = now()
  where id = p_customer_id;
end $$;
revoke all on function public.apply_zoho_contact_terms(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.apply_zoho_contact_terms(bigint, jsonb) to service_role;

commit;
