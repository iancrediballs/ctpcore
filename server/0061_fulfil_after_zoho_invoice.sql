-- CTP Core 0061 — fulfil only after accounts INVOICE the sales order in Zoho (22 Oct 2026).
--
-- Ian: "the fulfill stock button should only become available once michelle
-- converts a sales order into tax invoice" and "michelle has a button in zoho
-- 'i have received payment' and she converts to tax invoice".
--
-- Replaces 0059's gate definition ("SO confirmed + emailed"):
--   * an order with a Zoho sales order may be fulfilled only when Zoho shows an
--     INVOICE raised from that sales order (read back and linked onto the order);
--   * a CASH customer's invoice must also be PAID (Zoho status 'paid');
--     an ACCOUNT customer needs only the invoice;
--   * account vs cash is customer.on_account, set by an admin in CTP. Zoho's
--     payment terms are not used: on 22 Oct the Hermans contact said "Due on
--     Receipt", SO-00011 "Net 30" and INV-000005 "Custom (39 days)" — three
--     answers for one customer. Default is cash (the safe side); Hermans is
--     set to account here;
--   * admin override with a note (0059 override_fulfil_gate) stays.
-- CTP never creates a Zoho invoice for an order that has a sales order — accounts
-- raise it in Zoho and CTP links it (zoho-push). The trigger also refuses CTP's
-- own "invoiced" status for such an order until a Zoho invoice is linked.
begin;

alter table public.customer add column if not exists on_account boolean not null default false;
update public.customer set on_account = true where code = 'HERMANS' and not on_account;

alter table public.sales_order add column if not exists zoho_invoice_total_minor bigint;
alter table public.sales_order add column if not exists zoho_invoice_balance_minor bigint;
alter table public.sales_order add column if not exists zoho_invoice_paid_minor bigint;
alter table public.sales_order add column if not exists zoho_invoice_payments text;
alter table public.sales_order add column if not exists zoho_invoice_count int;
alter table public.sales_order add column if not exists zoho_invoice_linked_at timestamptz;

-- ── the gate, redefined ──────────────────────────────────────────────────────
create or replace function public.fulfil_block_reason(so public.sales_order)
returns text language plpgsql stable set search_path = public, pg_temp as $$
declare v_account boolean;
begin
  if so.zoho_salesorder_id is null then return null; end if;          -- no Zoho SO: not gated
  if so.fulfil_override_at is not null then return null; end if;      -- admin override, recorded
  if so.zoho_so_status in ('deleted', 'void') then
    return format('The Zoho sales order %s was %s in Zoho — ask accounts before taking stock out.', coalesce(so.zoho_salesorder_number, ''), so.zoho_so_status);
  end if;
  if so.zoho_invoice_id is null or coalesce(so.zoho_status, '') in ('void', 'deleted') then
    return 'Waiting for accounts to invoice this sales order in Zoho.';
  end if;
  if so.zoho_so_readback_issue is not null then
    return 'The Zoho invoice has a line CTP cannot match: ' || so.zoho_so_readback_issue;
  end if;
  select c.on_account into v_account from customer c where c.id = so.customer_id;
  if not coalesce(v_account, false) and coalesce(so.zoho_status, '') <> 'paid' then
    return format('Waiting for payment: %s is %s%s (cash customer — accounts record the payment in Zoho).',
                  coalesce(so.zoho_invoice_number, 'the invoice'), replace(coalesce(so.zoho_status, 'unpaid'), '_', ' '),
                  case when coalesce(so.zoho_invoice_balance_minor, 0) > 0
                       then ', R' || to_char(so.zoho_invoice_balance_minor / 100.0, 'FM999,999,990.00') || ' due' else '' end);
  end if;
  return null;
end $$;

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
  -- CTP's own "invoiced" for an order with a Zoho SO only once accounts' invoice is linked
  if new.status = 'invoiced' and old.status is distinct from 'invoiced'
     and new.zoho_salesorder_id is not null and new.zoho_invoice_id is null and not coalesce(new.zoho_do_not_push, false) then
    raise exception 'Accounts invoice this order in Zoho and CTP links that invoice — there is none yet for %.', coalesce(new.zoho_salesorder_number, new.number)
      using errcode = '22023';
  end if;
  return new;
end $$;

-- ── link accounts' invoice (and its payments) onto the order ─────────────────
-- p_inv: { invoice_id, invoice_number, status, total, balance, payment_made,
--          payments: [text], count }   — totals summed over the SO's live invoices
create or replace function public.apply_zoho_invoice_link(p_order_id bigint, p_inv jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_o record; v_note text; fmt constant text := 'FM999,999,990.00';
  v_total bigint := round(coalesce(nullif(p_inv->>'total', '')::numeric, 0) * 100);
  v_bal bigint := round(coalesce(nullif(p_inv->>'balance', '')::numeric, 0) * 100);
  v_paid bigint := round(coalesce(nullif(p_inv->>'payment_made', '')::numeric, 0) * 100);
  v_st text := nullif(p_inv->>'status', '');
begin
  if auth.uid() is not null then
    raise exception 'apply_zoho_invoice_link is called by the server, not from a session.' using errcode = '42501';
  end if;
  select id, number, zoho_invoice_id, zoho_invoice_number, zoho_status into v_o
    from sales_order where id = p_order_id and deleted_at is null for update;
  if v_o.id is null or coalesce(p_inv->>'invoice_id', '') = '' then return jsonb_build_object('skipped', true); end if;
  if v_o.zoho_invoice_id is null then
    v_note := format('Zoho invoice %s raised by accounts — R%s, %s — linked', p_inv->>'invoice_number', to_char(v_total / 100.0, fmt), coalesce(v_st, '?'));
  elsif v_o.zoho_status is distinct from v_st then
    v_note := format('Zoho invoice %s: %s → %s%s', coalesce(p_inv->>'invoice_number', v_o.zoho_invoice_number), coalesce(v_o.zoho_status, '?'), coalesce(v_st, '?'),
                     case when v_paid > 0 then format(' (paid R%s, balance R%s)', to_char(v_paid / 100.0, fmt), to_char(v_bal / 100.0, fmt)) else '' end);
  end if;
  update sales_order set
    zoho_invoice_id = p_inv->>'invoice_id',
    zoho_invoice_number = coalesce(nullif(p_inv->>'invoice_number', ''), zoho_invoice_number),
    zoho_status = coalesce(v_st, zoho_status), zoho_status_at = now(), zoho_error = null,
    zoho_invoice_total_minor = v_total, zoho_invoice_balance_minor = v_bal, zoho_invoice_paid_minor = v_paid,
    zoho_invoice_payments = nullif(array_to_string(array(select jsonb_array_elements_text(coalesce(p_inv->'payments', '[]'::jsonb))), '; '), ''),
    zoho_invoice_count = coalesce(nullif(p_inv->>'count', '')::int, 1),
    zoho_invoice_linked_at = coalesce(zoho_invoice_linked_at, now()),
    zoho_pushed_at = coalesce(zoho_pushed_at, now()),
    notes = case when v_note is null then notes
                 else concat_ws(E'\n', nullif(notes, ''), format('[%s] %s', to_char(now() at time zone 'Africa/Johannesburg', 'YYYY-MM-DD HH24:MI'), v_note)) end,
    updated_at = now()
  where id = v_o.id;
  return jsonb_build_object('order_id', v_o.id, 'linked', v_o.zoho_invoice_id is null, 'note', v_note);
end $$;
revoke all on function public.apply_zoho_invoice_link(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.apply_zoho_invoice_link(bigint, jsonb) to service_role;

-- ── admin: account or cash ───────────────────────────────────────────────────
create or replace function public.set_customer_on_account(p_customer_id bigint, p_on_account boolean)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_who text; v_c record;
begin
  select coalesce(nullif(btrim(a.display_name), ''), 'admin') into v_who from app_user a where a.id = auth.uid() and a.role = 'admin';
  if v_who is null then raise exception 'Only an admin can change whether a customer is on account.' using errcode = '42501'; end if;
  update customer set on_account = p_on_account, updated_at = now(),
         notes = concat_ws(E'\n', nullif(notes, ''), format('[%s] %s by %s', to_char(now() at time zone 'Africa/Johannesburg', 'YYYY-MM-DD HH24:MI'),
                 case when p_on_account then 'Set to ACCOUNT (fulfil after invoice)' else 'Set to CASH (fulfil after invoice is paid)' end, v_who))
   where id = p_customer_id and deleted_at is null returning id, name, on_account into v_c;
  if v_c.id is null then raise exception 'No such customer.' using errcode = '42704'; end if;
  return jsonb_build_object('customer_id', v_c.id, 'name', v_c.name, 'on_account', v_c.on_account);
end $$;
revoke all on function public.set_customer_on_account(bigint, boolean) from public, anon;
grant execute on function public.set_customer_on_account(bigint, boolean) to authenticated;

commit;
