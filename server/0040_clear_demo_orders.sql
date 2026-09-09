-- ============================================================================
--  CTP Core — CLEAR THE DEMO SALES ORDERS (server migration 0040)
--
--  ⚠ THIS IS OPTIONAL AND DISCRETIONARY. It is not a schema change and nothing
--    else depends on it. It exists so that "clear the demo orders" is one
--    reviewed step Ian can say yes or no to, rather than something that happens
--    while his attention is elsewhere. If he says no, skip it forever; every
--    later migration works either way.
--
--  WHAT IT DOES: soft-deletes the 14 sales orders currently in the cloud, and
--  their lines. Ian said these are few and can be re-entered later.
--
--  ⚠ NO STOCK MOVES. NOT ONE UNIT. The ledger is not touched, and the migration
--    ABORTS if sum(delta) changes. Read the next paragraph before running it,
--    because the reason is not obvious.
--
--  WHY THE LEDGER IS LEFT ALONE, which is the whole judgement in this file:
--  some of those orders have stock_movement rows behind them (ref_type =
--  'sales_order'). Those movements are why the cloud reads 805 units and not
--  816 — the goods physically left the building. Deleting the order does not
--  bring them back, and reversing them would invent a return that never
--  happened. So the document is cleared and the stock history stays.
--
--  The consequence, stated rather than discovered: after this runs, a few
--  ledger rows point at a document flagged deleted. That is FINE for a soft
--  delete — the row still exists, so the reference still resolves and the
--  ledger still explains itself. It would NOT be fine for a hard delete, which
--  is one of the two reasons this is a soft delete.
--
--  THE OTHER REASON IS THAT IT IS REVERSIBLE. Undo is one statement:
--      update sales_order set deleted_at = null where deleted_at = <the stamp>;
--      update sales_line  set deleted_at = null where deleted_at = <the stamp>;
--  A hard delete cannot be undone, and `accounting_export` references
--  sales_order without ON DELETE CASCADE, so a hard delete would be REFUSED by
--  the foreign key anyway the moment anything had been exported.
--
--  NO EMAILS ARE SENT. Worth stating because this database fires notifications
--  on order events. Both triggers are narrow:
--      order_request_notify   AFTER INSERT
--      order_response_notify  AFTER UPDATE OF client_response
--  This migration does neither — it updates deleted_at — so neither fires.
--  sales_order_customer_cascade is AFTER UPDATE OF customer_id and also stays
--  quiet. touch_rev does fire, which is correct: these rows genuinely changed.
--
--  IT REFUSES TO RUN if any order being cleared has already been pushed to
--  QuickBooks or Xero. An exported order exists in someone else's books, and
--  clearing it here creates a silent mismatch between two systems. That is a
--  decision for Ian and his accountant, not for a migration, so the migration
--  stops and names the orders instead of guessing.
--
--  Idempotent: re-running clears nothing further, because already-cleared rows
--  are excluded.
-- ============================================================================

begin;

do $$
declare
  v_stamp       timestamptz := now();
  v_before      bigint;
  v_after       bigint;
  v_orders      int;
  v_lines       int;
  v_exported    int;
  v_exported_ns text;
  v_ledger      int;
begin
  -- The invariant, measured before anything changes.
  select coalesce(sum(delta), 0) into v_before from public.stock_movement;

  -- ── refuse on anything already in the accounts ──────────────────────────
  select count(*), string_agg(distinct o.number, ', ' order by o.number)
    into v_exported, v_exported_ns
    from public.sales_order o
    join public.accounting_export e on e.order_id = o.id
   where o.deleted_at is null;

  if v_exported > 0 then
    raise exception
      'ABORTING: % order(s) have been exported to accounting (%). Clearing an '
      'order that already exists in QuickBooks or Xero puts the two systems out '
      'of step. Decide what to do about the export first, then re-run.',
      v_exported, v_exported_ns;
  end if;

  -- ── how much ledger history will point at a cleared document ────────────
  -- Reported, not prevented. It is expected and harmless under a soft delete,
  -- but it should be a number somebody saw rather than a surprise later.
  select count(*) into v_ledger
    from public.stock_movement m
   where m.ref_type = 'sales_order'
     and m.ref_id in (select id from public.sales_order where deleted_at is null);

  -- ── clear the lines, then the orders ────────────────────────────────────
  update public.sales_line
     set deleted_at = v_stamp
   where deleted_at is null
     and order_id in (select id from public.sales_order where deleted_at is null);
  get diagnostics v_lines = row_count;

  update public.sales_order
     set deleted_at = v_stamp
   where deleted_at is null;
  get diagnostics v_orders = row_count;

  -- ── verify, and refuse to commit if the ledger moved ────────────────────
  select coalesce(sum(delta), 0) into v_after from public.stock_movement;
  if v_after <> v_before then
    raise exception
      'ABORTING: total stock changed from % to %. This migration clears '
      'documents only and must never alter the quantity of anything.',
      v_before, v_after;
  end if;

  raise notice
    'cleared % order(s) and % line(s) at %. Stock unchanged at %. % ledger '
    'row(s) now reference a cleared document, which is expected under a soft '
    'delete. To undo: update sales_order set deleted_at = null where '
    'deleted_at = ''%''; and the same for sales_line.',
    v_orders, v_lines, v_stamp, v_after, v_ledger, v_stamp;
end $$;

commit;

-- ============================================================================
--  NO DESKTOP COUNTERPART, deliberately.
--
--  The desktop has ZERO sales orders — it has never been used to sell — so
--  there is nothing there to clear. When the reseed pull runs it will bring the
--  cleared rows down as ordinary updates: sales_order carries updated_at and a
--  rev trigger, so unlike the location repoint in 0038, sync CAN carry this
--  one. No second migration is needed and writing one would be noise.
--
--  VERIFY BY QUERY — RAISE NOTICE is not surfaced by the Supabase SQL editor.
--
--    select count(*) filter (where deleted_at is null) as live,
--           count(*) filter (where deleted_at is not null) as cleared
--      from sales_order;                        -- expect live 0, cleared 14
--
--    select coalesce(sum(delta),0) from stock_movement;   -- expect 805
--
--    select count(*) from location where deleted_at is null;  -- expect 1
-- ============================================================================
