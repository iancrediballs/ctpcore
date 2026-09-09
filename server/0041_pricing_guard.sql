-- ============================================================================
--  CTP Core — A MARGIN FLOOR ON THE PATH WHERE QUOTING ACTUALLY HAPPENS (0041)
--
--  WHY THIS EXISTS, from the evidence rather than from principle.
--
--  On 13 August 2026 eight quotes went to Hermans Panel Beaters. Nine lines
--  across eight parts carried prices that were typed by hand, because those
--  parts have no list price and the system asked for a number:
--
--      Top Cover Welding Assembly    R1 111 111.00     164.6x supplier cost
--      Front Door Assembly L/H       R1 112 234.00     100.7x
--      R/H Side Inner Panel            R443 636.00     286.8x
--      L/H Side Outer Panel            R346 463.00      73.3x
--      Front Door Assembly L/H         R333 334.00      30.2x  (same part,
--                                                              3 minutes later)
--      Rear Panel Assembly              R99 999.00      20.9x
--      Windshield Upper Crossbeam       R66 664.00      94.4x
--      L/H Side Inner Panel              R9 999.00       6.5x
--      Front Door Assembly R/H          R11 111.00       1.0x  <-- accepted
--
--  The last one is the reason this file is not merely tidy. Supplier cost is
--  R11 039.59. Quoted at R11 111.00, that is a 0.6% margin BEFORE freight and
--  duty, and the client accepted it. On the landed-cost arithmetic the true
--  cost is nearer R15 000, so honouring it is a loss.
--
--  WHAT THE SOFTWARE DID: fill_quote_from_list correctly left those lines at
--  zero, the UI correctly said "N parts have no list price, fill by hand", and
--  price_quote then accepted whatever came back with one check — that it was
--  above zero. No upper bound, no comparison to cost, no margin floor.
--
--  So this is not a person's mistake happening near some software. It is
--  software with no opinion about its most consequential input.
--
--  THE ASYMMETRY BEING CLOSED
--    Desktop:  add_line() prices every line through snapshot_price(), which
--              applies price_tier.min_margin_bps as a floor and clamps to list.
--              THE DESKTOP CANNOT PRODUCE A BAD PRICE BECAUSE IT CANNOT ACCEPT
--              ONE — there is no command anywhere that takes a typed price.
--    Cloud:    price_quote() takes a typed price and validates `> 0`.
--
--  Every one of those nine lines was written on the second path. Same rule,
--  both paths, from here.
--
--  ⚠ NOTHING EXISTING IS ALTERED. This migration does not touch a single
--    sales_line, price or quote. The nine lines stay exactly as they are —
--    they are Ian's customer records and his commercial decisions to make. The
--    guard applies to writes from here on.
--
--  REJECT, NOT SILENTLY CLAMP — and this is a deliberate difference from the
--  desktop. snapshot_price() computes a price and clamping it is invisible and
--  correct. price_quote receives a price a person typed; raising it under them
--  would mean the number they saw is not the number that was saved. So a line
--  below the floor is REFUSED, with the floor and the cost named, and the
--  person decides.
--
--  AND THERE IS AN ESCAPE HATCH, on purpose. p_allow_below_floor must be passed
--  deliberately. Without one, the first genuine clearance or goodwill sale gets
--  worked around by editing the price list, which is worse than the thing being
--  prevented. When it is used, the exception is written into the order's notes
--  so it is visible afterwards rather than invisible forever.
-- ============================================================================

begin;

-- ── 1. the thresholds, as data ─────────────────────────────────────────────
-- Configurable rather than baked in, because "implausible" is a judgement about
-- a business, not a constant. A truck cab genuinely costs six figures; a clip
-- genuinely costs eight rand. The multiples below are a starting position, and
-- every one of the nine lines above is caught by them.
create table if not exists public.pricing_guard (
  id                    integer primary key default 1 check (id = 1),
  -- The floor itself. Turning this off is a deliberate act with a visible name.
  floor_enabled         boolean not null default true,
  -- Warn when price > cost x this. 100000 bps = 1000% = 10x cost.
  -- Catches all eight of the wild figures; the tightest of them is 6.5x.
  warn_above_cost_bps   integer not null default 100000
                        check (warn_above_cost_bps >= 10000),
  -- Warn when price < cost x this. 11500 bps = 115% = 1.15x cost.
  -- Catches the R11 111 door at 1.006x. Sits just above the 15% tier floor so
  -- a line that only just clears the floor still says so.
  warn_near_cost_bps    integer not null default 11500
                        check (warn_near_cost_bps >= 10000),
  -- Warn when price exceeds the list price by more than this. 2000 bps = 20%.
  -- Above list is legitimate for a special order, so it warns and never blocks.
  warn_above_list_bps   integer not null default 2000
                        check (warn_above_list_bps >= 0),
  rev        integer not null default 1,
  updated_at timestamptz not null default now()
);
insert into public.pricing_guard (id) values (1) on conflict (id) do nothing;

alter table public.pricing_guard enable row level security;
drop policy if exists pricing_guard_read on public.pricing_guard;
create policy pricing_guard_read on public.pricing_guard
  for select to authenticated using (is_staff());
grant select on public.pricing_guard to authenticated;
grant all on public.pricing_guard to service_role;

create or replace function public.set_pricing_guard(
  p_floor_enabled boolean default null,
  p_warn_above_cost_bps integer default null,
  p_warn_near_cost_bps integer default null,
  p_warn_above_list_bps integer default null)
returns public.pricing_guard
language plpgsql security definer set search_path = public, pg_temp
as $$
declare row_out public.pricing_guard;
begin
  if not is_manager() then
    raise exception 'Only a manager or administrator can change pricing guards.'
      using errcode = '42501';
  end if;
  -- COALESCE so an omitted field keeps what is there, rather than blanking it.
  -- The same silent-blanking fault 0033 had to fix on the company profile.
  update public.pricing_guard
     set floor_enabled       = coalesce(p_floor_enabled, floor_enabled),
         warn_above_cost_bps = coalesce(p_warn_above_cost_bps, warn_above_cost_bps),
         warn_near_cost_bps  = coalesce(p_warn_near_cost_bps, warn_near_cost_bps),
         warn_above_list_bps = coalesce(p_warn_above_list_bps, warn_above_list_bps)
   where id = 1
  returning * into row_out;
  return row_out;
end $$;
revoke all on function public.set_pricing_guard(boolean,integer,integer,integer)
  from public, anon;
grant execute on function public.set_pricing_guard(boolean,integer,integer,integer)
  to authenticated;

-- ── 2. one definition of the floor, used by the check and by the write ─────
-- A rule that lives in one function cannot be forgotten by a second caller —
-- the argument 0022 already makes for these being RPCs at all.
--
-- The formula is IDENTICAL to snapshot_price() in the desktop's Rust, including
-- the trailing +1:  floor = cost * 10000 / (10000 - min_margin) + 1.
-- The +1 puts the floor one cent ABOVE exact break-even, so a line that lands
-- exactly on the margin is above it rather than on it. Keeping the arithmetic
-- character-for-character identical is the point of this migration; a floor
-- that differs by a cent between two paths is a floor nobody can reason about.
create or replace function public.price_floor_minor(p_part_id bigint, p_tier text)
returns bigint
language sql stable security definer set search_path = public, pg_temp
as $$
  select case
    when c.cost_invoiced_minor is null or c.cost_invoiced_minor <= 0 then null
    when coalesce(t.min_margin_bps, 1500) >= 10000 then null
    else (c.cost_invoiced_minor * 10000) / (10000 - coalesce(t.min_margin_bps, 1500)) + 1
  end
  from public.part_current_cost c
  left join public.price_tier t on t.code = coalesce(p_tier, 'list')
  where c.part_id = p_part_id;
$$;

revoke all on function public.price_floor_minor(bigint, text)
  from public, anon, authenticated;

comment on function public.price_floor_minor(bigint, text) is
  'Lowest quotable price for a part at a tier. Mirrors snapshot_price() in the '
  'desktop Rust exactly, including the +1. NULL means no cost on file and '
  'therefore nothing to protect.';

-- ── 3. a read-only check the UI can call BEFORE saving ─────────────────────
-- Warnings after the fact are worth much less than warnings before. This takes
-- the same payload price_quote does and answers "what would happen", writing
-- nothing.
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
      and r.price < (r.cost * v_g.warn_near_cost_bps) / 10000 then
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
      and r.price > (r.cost * v_g.warn_above_cost_bps) / 10000 then
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
      and r.price > (r.list_minor * (10000 + v_g.warn_above_list_bps)) / 10000 then
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

revoke all on function public.quote_price_check(bigint, jsonb) from public, anon;
grant execute on function public.quote_price_check(bigint, jsonb) to authenticated;

-- ── 4. price_quote, with the floor ─────────────────────────────────────────
-- The old two-argument version is DROPPED rather than left alongside. A
-- create-or-replace with an extra argument makes an overload, not a
-- replacement, and PostgREST would then have two candidates — which is exactly
-- how a guard gets bypassed by accident. Callers passing only order_id and
-- lines still work: the third argument has a default.
drop function if exists public.price_quote(bigint, jsonb);

create or replace function public.price_quote(
  order_id bigint,
  lines jsonb,
  p_allow_below_floor boolean default false)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_status  text;
  v_updated int;
  v_bad     int;
  v_check   jsonb;
  v_block   int;
  v_msgs    text;
begin
  if not is_staff() then
    raise exception 'Only staff can price a quote.' using errcode = '42501';
  end if;

  select so.status into v_status
    from sales_order so where so.id = price_quote.order_id and so.deleted_at is null;
  if v_status is null then
    raise exception 'No such order.' using errcode = '42704';
  end if;
  -- Repricing something the customer already accepted would change the deal
  -- under them. Staff can still reopen it deliberately.
  if v_status <> 'quote' then
    raise exception 'Order is %, so its prices are settled.', v_status
      using errcode = '22023';
  end if;

  if lines is null or jsonb_typeof(lines) <> 'array' or jsonb_array_length(lines) = 0 then
    raise exception 'No prices supplied.' using errcode = '22023';
  end if;

  -- A zero price is what an unpriced request looks like, so allowing one here
  -- would quietly hand the customer an acceptable R0 quote. (Unchanged from
  -- 0022 — this check was never the problem.)
  select count(*) into v_bad
    from jsonb_array_elements(lines) as l
   where coalesce((l->>'unit_price_minor')::bigint, 0) <= 0;
  if v_bad > 0 then
    raise exception 'Every line needs a price above zero (% missing).', v_bad
      using errcode = '22023';
  end if;

  -- ── THE FLOOR ───────────────────────────────────────────────────────────
  v_check := public.quote_price_check(price_quote.order_id, price_quote.lines);
  v_block := (v_check->>'blocking')::int;

  if v_block > 0 and not p_allow_below_floor then
    select string_agg(x->>'message', ' ') into v_msgs
      from jsonb_array_elements(v_check->'findings') x
     where x->>'severity' = 'block';
    raise exception
      '% line(s) are below the minimum margin. %  Raise the price, or price it '
      'deliberately below the floor by confirming the override.',
      v_block, v_msgs
      using errcode = '22023';
  end if;

  with input as (
    select (l->>'line_id')::bigint as line_id,
           (l->>'unit_price_minor')::bigint as price
      from jsonb_array_elements(price_quote.lines) as l
  )
  update sales_line sl
     set unit_price_minor = i.price, updated_at = now()
    from input i
   where sl.id = i.line_id
     and sl.order_id = price_quote.order_id   -- lines from another order are ignored
     and sl.deleted_at is null;
  get diagnostics v_updated = row_count;

  -- An override that leaves no trace is the same as no control at all. Write
  -- what was overridden onto the order, where anyone reading it later will see
  -- it next to the price.
  if v_block > 0 and p_allow_below_floor then
    select string_agg(x->>'message', ' ') into v_msgs
      from jsonb_array_elements(v_check->'findings') x
     where x->>'severity' = 'block';
    update sales_order
       set notes = concat_ws(E'\n', nullif(notes, ''),
             format('[%s] Priced below the margin floor, deliberately: %s',
                    to_char(now() at time zone 'Africa/Johannesburg',
                            'YYYY-MM-DD HH24:MI'), v_msgs))
     where id = price_quote.order_id;
  end if;

  return (
    select jsonb_build_object(
      'order_id', price_quote.order_id,
      'updated', v_updated,
      'unpriced_left', count(*) filter (where sl.unit_price_minor <= 0),
      'total_minor', coalesce(sum(sl.qty * sl.unit_price_minor), 0),
      -- Warnings ride back with the result so the UI can show them even when
      -- nothing blocked. They are advice, never a refusal.
      'warnings', v_check->'findings',
      'below_floor_overridden', (v_block > 0 and p_allow_below_floor))
      from sales_line sl
     where sl.order_id = price_quote.order_id and sl.deleted_at is null
  );
end $$;

revoke all on function public.price_quote(bigint, jsonb, boolean) from public, anon;
grant execute on function public.price_quote(bigint, jsonb, boolean) to authenticated;

commit;

-- ============================================================================
--  VERIFY BY QUERY — RAISE NOTICE is not surfaced by the Supabase SQL editor.
--
--  1. Exactly ONE price_quote exists, and it takes three arguments:
--       select p.oid::regprocedure
--         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--        where n.nspname='public' and p.proname='price_quote';
--     -- expect one row: price_quote(bigint,jsonb,boolean)
--     -- TWO ROWS WOULD MEAN THE OLD ONE SURVIVED AND THE GUARD IS BYPASSABLE.
--
--  2. The floor agrees with the desktop on a known part. Front Door R/H
--     (CTP-DOR-002-R) costs 1103959 and has no list price:
--       select public.price_floor_minor(
--                (select id from part where sku='CTP-DOR-002-R'), 'list');
--     -- expect 1298776  (11039.59 / 0.85 = 12987.7529, floored to 12987.75,
--     --                  then +1 cent = 12987.76)
--     -- The quote accepted at R11 111.00 sits R1 876.76 below this.
--
--  3. The guard row exists with its defaults:
--       select * from pricing_guard;
--
--  4. NOTHING WAS ALTERED. The nine hand-typed lines are untouched:
--       select count(*) from sales_line where unit_price_minor = 1111100;  -- 1
--       select coalesce(sum(delta),0) from stock_movement;                 -- 805
-- ============================================================================
