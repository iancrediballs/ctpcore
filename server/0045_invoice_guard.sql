-- 0045_invoice_guard.sql — an invoice number is not optional, and the pricing
-- check must not overflow.
--
-- FOUND 2026-09-18, live database: five sales_order rows carry status
-- 'invoiced' with invoice_no NULL and invoice_counter was EMPTY. Not a failure
-- of invoice_order() (0042) — it had never been called. All five rows predate
-- 0042 and were set to 'invoiced' by the desktop's "Mark invoiced" button
-- (SalesView.tsx), which writes the status and nothing else. Driven through
-- invoice_order() for the first time today, the path works: 26091801 was
-- allocated for test order 22, the counter row appeared, a second call
-- returned already:true, and the unique index refused a duplicate number.
--
-- So the hole is structural, not functional: nothing stopped a row from
-- BECOMING invoiced without a number. This closes it at the database:
--   1. CHECK: status = 'invoiced' implies invoice_no is set — for any order
--      created since 0042 went live (2026-09-14). The five legacy rows (whose
--      real numbers live in Zoho — one has its Zoho number as its ORDER
--      number, INV-26072403) are exempt by date rather than by NOT VALID, so
--      they stay editable (notes, etc.) until Ian gives them their numbers.
--      They remain a reporting item.
--   2. TRIGGER: the transition INTO 'invoiced' is allowed only inside
--      invoice_order() — a raw UPDATE from the Data API, a desktop sync or a
--      script cannot mark an order invoiced, with or without a number it made
--      up. Server sessions with no auth.uid() are exempt (this file, repairs).
--
-- ALSO: quote_price_check (0041) multiplies the INTEGER list price by 12000,
-- which overflows int4 for any list price above R1,789.56 — pricing a quote
-- with such a part raises "integer out of range" on the live database today
-- (proved: 375929 * 12000 → SQLSTATE 22003). 0044 (rebates) also fixes this in
-- its own body; this file fixes it independently so it does not wait on the
-- rebate decision. Whichever is applied later wins; both are correct. The
-- body below is 0041's verbatim except three ::bigint casts.
--
-- REVERSE: see the foot.

begin;

alter table public.sales_order drop constraint if exists sales_order_invoiced_has_no_chk;
alter table public.sales_order
  add constraint sales_order_invoiced_has_no_chk
  check (status <> 'invoiced' or invoice_no is not null or created_at < '2026-09-14');
comment on constraint sales_order_invoiced_has_no_chk on public.sales_order is
  'A tax invoice carries a number. Orders created before 0042 (2026-09-14) are exempt: their numbers are in Zoho.';

create or replace function public.sales_order_invoice_guard()
returns trigger language plpgsql as $$
begin
  if new.status = 'invoiced' and old.status is distinct from 'invoiced'
     and auth.uid() is not null
     and coalesce(current_setting('ctp.invoicing', true), '') <> '1' then
    raise exception 'An order becomes invoiced only through invoice_order(), which allocates its number.'
      using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists sales_order_invoice_guard on public.sales_order;
create trigger sales_order_invoice_guard
  before update of status on public.sales_order
  for each row execute function public.sales_order_invoice_guard();

-- invoice_order: 0042's body plus the flag the trigger looks for.
create or replace function public.invoice_order(order_id bigint)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_o   record;
  v_no  text;
begin
  if not is_staff() then
    raise exception 'Only staff can issue an invoice.' using errcode = '42501';
  end if;

  select so.id, so.number, so.status, so.invoice_no, so.invoiced_at
    into v_o
    from sales_order so
   where so.id = invoice_order.order_id and so.deleted_at is null
     for update;
  if v_o.id is null then
    raise exception 'No such order.' using errcode = '42704';
  end if;

  -- Already issued: hand back the same number. Never a second one.
  if v_o.status = 'invoiced' then
    return jsonb_build_object('order_id', v_o.id, 'number', v_o.number,
                              'invoice_no', v_o.invoice_no, 'invoiced_at', v_o.invoiced_at,
                              'already', true);
  end if;
  if v_o.status <> 'fulfilled' then
    raise exception '% is % — an invoice is issued only for goods that have left (fulfil it first).',
      v_o.number, v_o.status using errcode = '22023';
  end if;

  -- The number is spent the moment this commits, and only now.
  v_no := public.next_invoice_no();
  -- the guard trigger lets the transition happen only under this flag
  perform set_config('ctp.invoicing', '1', true);

  update sales_order
     set status = 'invoiced', invoice_no = v_no, invoiced_at = now(), updated_at = now()
   where id = v_o.id;

  return jsonb_build_object('order_id', v_o.id, 'number', v_o.number,
                            'invoice_no', v_no, 'invoiced_at', now(), 'already', false);
end;
$$;

-- quote_price_check: 0041 verbatim, three ::bigint casts.
create or replace function public.quote_price_check(order_id bigint, lines jsonb)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_tier text;
  v_out  jsonb := '[]'::jsonb;
  v_g    public.pricing_guard;
  r      record;
begin
  if not is_staff() then
    raise exception 'Only staff can price a quote.' using errcode = '42501';
  end if;
  select * into v_g from public.pricing_guard where id = 1;

  -- The customer's tier decides the floor, exactly as it does on the desktop.
  select coalesce(c.price_tier, 'list') into v_tier
    from public.sales_order so
    join public.customer c on c.id = so.customer_id
   where so.id = quote_price_check.order_id;

  for r in
    select sl.id                                as line_id,
           p.sku, p.name,
           coalesce(sl.tier_at_add, v_tier)     as tier,
           (l->>'unit_price_minor')::bigint     as price,
           cc.cost_invoiced_minor               as cost,
           public.price_floor_minor(sl.part_id, coalesce(sl.tier_at_add, v_tier)) as floor_minor,
           (select pr.amount_minor from public.price pr
             where pr.part_id = sl.part_id and pr.tier = 'list'
               and pr.deleted_at is null
             order by pr.valid_from desc limit 1) as list_minor
      from jsonb_array_elements(quote_price_check.lines) as l
      join public.sales_line sl on sl.id = (l->>'line_id')::bigint
      join public.part p on p.id = sl.part_id
      left join public.part_current_cost cc on cc.part_id = sl.part_id
     where sl.order_id = quote_price_check.order_id and sl.deleted_at is null
  loop
    -- below the floor: blocking, unless explicitly overridden on the write
    if v_g.floor_enabled and r.floor_minor is not null and r.price < r.floor_minor then
      v_out := v_out || jsonb_build_object(
        'line_id', r.line_id, 'sku', r.sku, 'severity', 'block',
        'code', 'below_floor',
        'price_minor', r.price, 'floor_minor', r.floor_minor, 'cost_minor', r.cost,
        'tier', r.tier,
        'message', format(
          '%s at R%s is below the %s floor of R%s (supplier cost R%s).',
          r.sku, to_char(r.price/100.0, 'FM999G999G990D00'),
          r.tier, to_char(r.floor_minor/100.0, 'FM999G999G990D00'),
          to_char(r.cost/100.0, 'FM999G999G990D00')));

    -- barely above cost: allowed, but it should be said out loud
    elsif r.cost is not null and r.cost > 0
      and r.price < (r.cost::bigint * v_g.warn_near_cost_bps) / 10000 then
      v_out := v_out || jsonb_build_object(
        'line_id', r.line_id, 'sku', r.sku, 'severity', 'warn',
        'code', 'near_cost',
        'price_minor', r.price, 'cost_minor', r.cost,
        'message', format('%s at R%s is barely above cost (R%s).',
          r.sku, to_char(r.price/100.0, 'FM999G999G990D00'),
          to_char(r.cost/100.0, 'FM999G999G990D00')));
    end if;

    -- far above cost: a genuine high-value part must stay quotable, so this
    -- never blocks. It is the check that would have caught R1 111 111.00.
    if r.cost is not null and r.cost > 0
      and r.price > (r.cost::bigint * v_g.warn_above_cost_bps) / 10000 then
      v_out := v_out || jsonb_build_object(
        'line_id', r.line_id, 'sku', r.sku, 'severity', 'warn',
        'code', 'far_above_cost',
        'price_minor', r.price, 'cost_minor', r.cost,
        'multiple_x10', (r.price * 10) / nullif(r.cost, 0),
        'message', format('%s at R%s is %sx supplier cost (R%s). Check it.',
          r.sku, to_char(r.price/100.0, 'FM999G999G990D00'),
          round((r.price::numeric / r.cost), 1)::text,
          to_char(r.cost/100.0, 'FM999G999G990D00')));
    end if;

    if r.list_minor is not null and r.list_minor > 0
      and r.price > (r.list_minor::bigint * (10000 + v_g.warn_above_list_bps)) / 10000 then
      v_out := v_out || jsonb_build_object(
        'line_id', r.line_id, 'sku', r.sku, 'severity', 'warn',
        'code', 'above_list',
        'price_minor', r.price, 'list_minor', r.list_minor,
        'message', format('%s at R%s is above its list price of R%s.',
          r.sku, to_char(r.price/100.0, 'FM999G999G990D00'),
          to_char(r.list_minor/100.0, 'FM999G999G990D00')));
    end if;
  end loop;

  return jsonb_build_object(
    'order_id', quote_price_check.order_id,
    'blocking', (select count(*) from jsonb_array_elements(v_out) x
                  where x->>'severity' = 'block'),
    'warnings', (select count(*) from jsonb_array_elements(v_out) x
                  where x->>'severity' = 'warn'),
    'findings', v_out);
end $$;

commit;

-- VERIFY (SQL editor):
--   select count(*) from sales_order where status='invoiced' and invoice_no is null;          -- 5 legacy, unchanged, all created before 2026-09-14
--   as a staff login:  update sales_order set status='invoiced' where id=<a fulfilled order>;  -- refused 42501
-- REVERSE:
--   drop trigger if exists sales_order_invoice_guard on public.sales_order;
--   drop function if exists public.sales_order_invoice_guard();
--   alter table public.sales_order drop constraint if exists sales_order_invoiced_has_no_chk;
--   then re-run 0042 (invoice_order) and 0041 (quote_price_check).
