-- 0042_fulfil_invoice.sql — close the loop from the web: fulfil, then invoice.
--
-- WHY THIS EXISTS
--   An accepted quote could only be turned into stock-out and a tax invoice on
--   the desktop. The desktop writes its own SQLite; the phone and the customer
--   never hear about it. Anything that changes the books has to be written
--   server-side, once, inside one transaction, with the rules in the function
--   and not in the UI — the doctrine of 0020–0022 and 0041.
--
-- TWO ACTS, NOT ONE (Ian, 2026-09-14)
--   Fulfilment moves physical stock and can be got wrong by a person in a
--   warehouse. Invoicing issues a numbered tax document that must not exist for
--   goods that never left. Payment sits between them. So there are two
--   functions and two buttons, and there is no function that does both.
--
-- THE RULES, in the order the code applies them
--   * The ledger is append-only. fulfil_order INSERTs movements; nothing here
--     updates or deletes one. A mistake is undone with a compensating movement
--     posted through the counter, never a correction.
--   * Idempotent. Each movement's client_uuid is 'so-<order>-line-<line>' —
--     the desktop's own convention (main.rs fulfill_order) — and the insert is
--     ON CONFLICT DO NOTHING, so a double tap, a retry after a dropped
--     connection, or a re-run never issues stock twice. The order row is
--     locked FOR UPDATE for the duration, and fulfilments are serialised on an
--     advisory lock so two orders cannot both pass the stock check against
--     the same units.
--   * No overselling. Available = on hand at the order's location minus the
--     lines of every other accepted-but-unfulfilled order at that location
--     that was accepted EARLIER (first accepted, first served — without the
--     ordering, two orders promising the same units would each block the
--     other and neither could ever be fulfilled). A single short line refuses
--     the whole order with the shortfalls named; nothing is written.
--   * An invoice number, once allocated, is spent. It is minted by
--     next_invoice_no() at the moment invoice_order commits and is never
--     reused — a cancelled or credited invoice keeps its number as a record.
--     Nothing allocates one speculatively: fulfil_order never mints.
--
-- THE NUMBER (Ian, 2026-09-14, from his own July invoice 26072403)
--   company.invoice_prefix || YYMMDD || NN — the day in Johannesburg time and
--   a per-day counter: 26072403 was the third invoice on 24 July 2026. His
--   prefix is '' (bare), matching the invoices already in the world; the
--   column is honoured so it can change without a migration.
--     * invoice_counter holds one row per day. Minting locks that row, so two
--       invoices in the same second get 01 and 02, never the same number.
--     * Midnight: a new day row starts at 01. The date leads, so numbers never
--       go backwards.
--     * The 100th invoice in a day becomes 260724100 — three digits rather
--       than a collision or a refusal. Unlikely; decided rather than left.
--     * Uniqueness is enforced by the unique index on sales_order.invoice_no,
--       not by trusting the counter; the counter never decrements.
--   * VAT. request_parts (0020) inserted orders with the column default,
--     tax_rate_bps = 0, so every customer request would have invoiced at 0%.
--     New orders now inherit company.default_tax_bps (0028) at creation.
--     EXISTING rows are business records and are NOT retro-edited here.
--
-- DECIDED: only a 'confirmed' (customer-accepted) order can be fulfilled. The
-- desktop allowed 'quote' too; a walk-in sale is a separate job and can widen
-- this deliberately.

BEGIN;

-- ── invoice identity on the order ────────────────────────────────────────────
alter table public.sales_order add column if not exists invoice_no  text;
alter table public.sales_order add column if not exists invoiced_at timestamptz;
create unique index if not exists sales_order_invoice_no_uniq
  on public.sales_order (invoice_no) where invoice_no is not null;

comment on column public.sales_order.invoice_no is
  'Tax invoice number, minted by next_invoice_no() inside invoice_order() at '
  'the moment of issue. company.invoice_prefix || YYMMDD || per-day count. '
  'Unique, never reused, never set by a client.';

-- ── the per-day counter ──────────────────────────────────────────────────────
create table if not exists public.invoice_counter (
  day  date    primary key,
  last integer not null check (last >= 0)
);
revoke all on table public.invoice_counter from public, anon, authenticated;

-- Mint the next number. Only invoice_order() calls this; it is not granted to
-- any role. The UPSERT locks today's row for the rest of the transaction, so
-- concurrent issues serialise on it and each gets its own count.
create or replace function public.next_invoice_no()
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_day    date := (now() at time zone 'Africa/Johannesburg')::date;
  v_n      integer;
  v_prefix text;
begin
  insert into invoice_counter (day, last) values (v_day, 1)
  on conflict (day) do update set last = invoice_counter.last + 1
  returning last into v_n;
  select coalesce(c.invoice_prefix, '') into v_prefix from company c where c.id = 1;
  -- Not lpad(n, 2): lpad TRUNCATES to the width, so the 100th would print as
  -- '10' and collide with the tenth. Pad below 100, print in full above.
  return coalesce(v_prefix, '') || to_char(v_day, 'YYMMDD')
         || case when v_n < 100 then lpad(v_n::text, 2, '0') else v_n::text end;
end;
$$;
revoke all on function public.next_invoice_no() from public, anon, authenticated;

-- ── fulfil: stock out, order → fulfilled ─────────────────────────────────────
create or replace function public.fulfil_order(order_id bigint)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_o        record;
  v_lines    int;
  v_short    text;
  v_written  int;
  v_actor    uuid;
begin
  if not is_staff() then
    raise exception 'Only staff can fulfil an order.' using errcode = '42501';
  end if;

  -- One fulfilment at a time. The stock check below reads on-hand minus other
  -- orders' reservations; two orders checked concurrently could both pass
  -- against the same units. Volume here is a few orders a day; serialising is
  -- free and removes the race entirely.
  perform pg_advisory_xact_lock(hashtext('ctp:fulfil_order'));

  select so.id, so.number, so.status, so.location_id, so.fulfilled_at,
         coalesce(so.client_responded_at, so.created_at) as accepted_at
    into v_o
    from sales_order so
   where so.id = fulfil_order.order_id and so.deleted_at is null
     for update;
  if v_o.id is null then
    raise exception 'No such order.' using errcode = '42704';
  end if;

  -- Already done: a double tap or a retry. Say so, write nothing.
  if v_o.status in ('fulfilled', 'invoiced') then
    return jsonb_build_object('order_id', v_o.id, 'number', v_o.number,
                              'status', v_o.status, 'fulfilled_at', v_o.fulfilled_at,
                              'movements', 0, 'already', true);
  end if;
  if v_o.status <> 'confirmed' then
    raise exception '% is %, not accepted — only an accepted order can be fulfilled.',
      v_o.number, v_o.status using errcode = '22023';
  end if;
  if not exists (select 1 from location l where l.id = v_o.location_id and l.deleted_at is null) then
    raise exception '% points at a retired location; move it first.', v_o.number
      using errcode = '22023';
  end if;

  select count(*) into v_lines
    from sales_line sl where sl.order_id = v_o.id and sl.deleted_at is null;
  if v_lines = 0 then
    raise exception '% has no lines — nothing to fulfil.', v_o.number using errcode = '22023';
  end if;

  -- ── the stock check ────────────────────────────────────────────────────
  -- on_hand: the ledger at this location. reserved: lines on OTHER orders at
  -- the same location that are accepted, not yet fulfilled, and were accepted
  -- before this one — stock promised to someone ahead in the queue. An order
  -- accepted later does not hold stock against this one. available = on_hand
  -- - reserved. Every short line is named.
  with need as (
    select sl.part_id, sum(sl.qty)::int as qty
      from sales_line sl
     where sl.order_id = v_o.id and sl.deleted_at is null
     group by sl.part_id
  ), onhand as (
    select sm.part_id, coalesce(sum(sm.delta), 0)::int as qty
      from stock_movement sm
     where sm.location_id = v_o.location_id
       and sm.part_id in (select part_id from need)
     group by sm.part_id
  ), reserved as (
    select sl.part_id, coalesce(sum(sl.qty), 0)::int as qty
      from sales_line sl
      join sales_order so on so.id = sl.order_id
     where so.status = 'confirmed' and so.deleted_at is null and sl.deleted_at is null
       and so.id <> v_o.id and so.location_id = v_o.location_id
       and (coalesce(so.client_responded_at, so.created_at), so.id) < (v_o.accepted_at, v_o.id)
       and sl.part_id in (select part_id from need)
     group by sl.part_id
  )
  select string_agg(
           format('%s: need %s, available %s', p.sku, n.qty,
                  greatest(0, coalesce(o.qty, 0) - coalesce(r.qty, 0))),
           '; ' order by p.sku)
    into v_short
    from need n
    join part p on p.id = n.part_id
    left join onhand o on o.part_id = n.part_id
    left join reserved r on r.part_id = n.part_id
   where n.qty > coalesce(o.qty, 0) - coalesce(r.qty, 0);
  if v_short is not null then
    raise exception 'Not enough stock to fulfil %. %', v_o.number, v_short
      using errcode = '22023';
  end if;

  -- ── write the ledger ───────────────────────────────────────────────────
  -- actor_id only when the caller is a real app_user row (it always is, for
  -- staff — but the FK must never be the thing that fails a sale).
  select au.id into v_actor from app_user au where au.id = auth.uid();

  insert into stock_movement
        (part_id, location_id, delta, reason, ref_type, ref_id,
         actor_id, actor_source, client_uuid, origin)
  select sl.part_id, v_o.location_id, -sl.qty, 'sale', 'sales_order', v_o.id,
         v_actor, case when v_actor is null then null else 'server_session' end,
         'so-' || v_o.id || '-line-' || sl.id, 'server'
    from sales_line sl
   where sl.order_id = v_o.id and sl.deleted_at is null
  on conflict (client_uuid) do nothing;
  get diagnostics v_written = row_count;

  update sales_order
     set status = 'fulfilled', fulfilled_at = now(), updated_at = now()
   where id = v_o.id;

  return jsonb_build_object('order_id', v_o.id, 'number', v_o.number,
                            'status', 'fulfilled', 'fulfilled_at', now(),
                            'movements', v_written, 'already', false);
end;
$$;

-- ── invoice: allocate the number, order → invoiced ───────────────────────────
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

  update sales_order
     set status = 'invoiced', invoice_no = v_no, invoiced_at = now(), updated_at = now()
   where id = v_o.id;

  return jsonb_build_object('order_id', v_o.id, 'number', v_o.number,
                            'invoice_no', v_no, 'invoiced_at', now(), 'already', false);
end;
$$;

revoke all on function public.fulfil_order(bigint)  from public, anon;
revoke all on function public.invoice_order(bigint) from public, anon;
grant execute on function public.fulfil_order(bigint)  to authenticated;
grant execute on function public.invoice_order(bigint) to authenticated;

-- ── VAT on new customer requests ─────────────────────────────────────────────
-- Same body as 0020 (as deployed), with one addition: tax_rate_bps is taken
-- from company.default_tax_bps at creation instead of the column default 0.
CREATE OR REPLACE FUNCTION public.request_parts(items jsonb, note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_customer bigint;
  v_location bigint;
  v_order    bigint;
  v_number   text;
  v_lines    jsonb;
  v_bad      int;
  v_tax      int;
BEGIN
  v_customer := my_customer_id();
  IF v_customer IS NULL THEN
    RAISE EXCEPTION 'This login is not linked to a customer account.' USING ERRCODE = '42501';
  END IF;

  IF items IS NULL OR jsonb_typeof(items) <> 'array' OR jsonb_array_length(items) = 0 THEN
    RAISE EXCEPTION 'Nothing to request.' USING ERRCODE = '22023';
  END IF;

  SELECT jsonb_agg(jsonb_build_object('part_id', t.part_id, 'qty', t.qty))
    INTO v_lines
    FROM (
      SELECT (i->>'part_id')::bigint AS part_id,
             SUM(GREATEST(1, LEAST(999, COALESCE((i->>'qty')::int, 1))))::int AS qty
        FROM jsonb_array_elements(items) AS i
       GROUP BY (i->>'part_id')::bigint
    ) t;

  IF jsonb_array_length(v_lines) > 50 THEN
    RAISE EXCEPTION 'A single request is limited to 50 different parts.' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_bad
    FROM jsonb_array_elements(v_lines) AS l
   WHERE NOT EXISTS (SELECT 1 FROM part p
                      WHERE p.id = (l->>'part_id')::bigint AND p.deleted_at IS NULL);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Request contains % part(s) that do not exist.', v_bad USING ERRCODE = '23503';
  END IF;

  SELECT id INTO v_location FROM location WHERE deleted_at IS NULL ORDER BY id LIMIT 1;

  -- The VAT the business charges, as set in Settings → Company. Falls back to
  -- the column default (0) only if the company row is somehow missing.
  SELECT coalesce(c.default_tax_bps, 0) INTO v_tax FROM company c WHERE c.id = 1;

  v_order  := nextval(pg_get_serial_sequence('sales_order', 'id'));
  v_number := 'RQ-' || to_char(now() AT TIME ZONE 'Africa/Johannesburg', 'YYMMDD') || '-' || v_order::text;

  INSERT INTO sales_order (id, number, customer_id, location_id, status, currency, notes, tax_rate_bps)
  VALUES (v_order, v_number, v_customer, v_location, 'quote', 'ZAR',
          NULLIF(btrim(COALESCE(note, '')), ''), coalesce(v_tax, 0));

  INSERT INTO sales_line (order_id, part_id, qty, unit_price_minor, tier_at_add)
  SELECT v_order, (l->>'part_id')::bigint, (l->>'qty')::int, 0, 'list'
    FROM jsonb_array_elements(v_lines) AS l;

  RETURN jsonb_build_object('order_id', v_order, 'number', v_number,
                            'lines', jsonb_array_length(v_lines));
END;
$function$;

COMMIT;

-- ── verify ──────────────────────────────────────────────────────────────────
-- select has_function_privilege('anon','public.fulfil_order(bigint)','EXECUTE');  -- false
-- select * from public.invoice_counter;                                           -- empty until the first issue
-- select column_name from information_schema.columns
--  where table_name='sales_order' and column_name in ('invoice_no','invoiced_at');
