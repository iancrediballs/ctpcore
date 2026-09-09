-- ============================================================================
--  CTP Core — ONE BUILDING, ONE WAREHOUSE (server migration 0038)
--
--  Ian confirmed 2026-09-09: China Truck Parts operates from a single building
--  with a single warehouse. Three locations exist because the FleetView seed
--  (0002_seed.sql) shipped MAIN + SHOP as demo data and the real JH6 shipment
--  landed into a third, WH. Nobody chose to have three; they accumulated.
--
--  ⚠ NO STOCK IS WRITTEN OFF BY THIS MIGRATION. NOT ONE UNIT.
--    Read that again before reading the numbers, because a migration that
--    moves a negative balance looks exactly like one that adjusts stock away,
--    and it is not.
--
--    BEFORE                                    AFTER
--    id  code  name                   units    id  code  units
--     1  MAIN  Main Warehouse             0     1  MAIN  (retired)
--     2  SHOP  Counter / Shop Floor     -11     2  SHOP  (retired)
--    10  WH    Main Warehouse           816    10  WH      805
--                              total = 805                total = 805
--
--    805 before, 805 after. The total is IDENTICAL. Only the attribution
--    changes. The eleven units genuinely left the building — they were sold —
--    they were merely booked out of a location that had never received
--    anything, which is why SHOP reads -11 and WH reads 11 too many.
--
--  WHY THE NEGATIVE EXISTED, since it is worth recording and it is not a bug
--  anyone introduced: stock was received into one location and sold from
--  another. That is simply what happens when locations exist without a reason
--  to exist. Ian having one warehouse does not fix the number — it removes the
--  entire class of problem, which is a better outcome than a correction.
--
--  WHY WH SURVIVES rather than MAIN: it holds all 816 units and all 161 bin
--  policies point at it. Retiring it would mean repointing 196 movements and
--  161 policies instead of 3 movements and 0 policies. The survivor is chosen
--  by where the data already is, not by which code reads better.
--
--  NEVER HARD-DELETE A LOCATION. stock_movement references it and the ledger
--  is history: a deleted location turns every past movement into a row that
--  cannot say where it happened. Retirement is `deleted_at`, and every picker
--  in the app already filters on it. The ledger display deliberately does NOT
--  filter on it (see list_orders / part_detail), so history keeps rendering.
--
--  EVERY REFERENCE TO location_id, CHECKED — not just the two obvious ones:
--    1. sales_order.location_id      — 10 rows repointed here
--    2. stock_movement.location_id   —  3 rows repointed here
--    3. stock_policy.location_id     —  0 rows expected; handled defensively
--    4. stock_on_hand (view)         — derived from stock_movement, no action
--    5. request_to_quote() (0020)    — picks a location by
--                                      `WHERE deleted_at IS NULL ORDER BY id
--                                      LIMIT 1`, which today returns MAIN.
--                                      THAT IS WHY MAIN HAS 9 ORDERS AND ZERO
--                                      MOVEMENTS: customer requests became
--                                      quotes fulfilled from an empty
--                                      warehouse. After this migration the
--                                      same query returns WH and the function
--                                      is correct with no code change. It
--                                      self-heals; do not edit it.
--    6. retire_location() (0028)     — NOT called by this migration, for two
--                                      reasons. It runs is_manager(), and a
--                                      migration in the SQL editor has no
--                                      auth.uid(), so the check would fail.
--                                      And its guard refuses to retire a
--                                      location whose per-part sum(delta) is
--                                      non-zero — true of SHOP until step 2
--                                      runs. Order matters: repoint first,
--                                      retire second. This file does the
--                                      retirement with a plain UPDATE.
--
--  rev / updated_at ARE NOT SET BY HAND. Migration 0034 installed touch_rev()
--  on every rev-bearing table, location included. Setting rev here would tell
--  the trigger a writer had chosen a value and suppress its increment.
--
--  ⚠ SYNC CONSEQUENCE, and it is the reason a matching SQLite migration is
--    MANDATORY rather than tidy: stock_movement has no `rev` and no
--    `updated_at` — it is the append-only ledger, and Stage B's pull watermark
--    for it is `created_at`. Repointing a movement's location_id does not
--    change created_at, so a desktop that has already pulled those rows will
--    NEVER see this correction; and apply_rows() upserts the ledger with
--    INSERT OR IGNORE on client_uuid, so even a full replay would not update
--    it. SYNC CANNOT CARRY THIS CHANGE FOR THE LEDGER. The desktop reaches the
--    same state only by running app/src-tauri/migrations/0023, independently,
--    under the same rule. The two files are one change in two dialects.
--
--  Idempotent: safe to re-run. Every statement is a no-op the second time.
-- ============================================================================

begin;

do $$
declare
  v_wh    bigint;
  v_total_before bigint;
  v_total_after  bigint;
  v_moved_orders int;
  v_moved_moves  int;
  v_moved_pol    int;
  v_dropped_pol  int;
  v_retired      int;
  v_orphans      int;
begin
  -- ── 0. resolve the survivor by CODE, never by id ────────────────────────
  -- Two locations are both NAMED 'Main Warehouse'; only the codes tell them
  -- apart. Codes are also the natural key the desktop syncs on (Stage B rule
  -- 1), so keying on code is what makes this file mean the same thing in both
  -- databases even though their id sequences are independent.
  select id into v_wh from location where code = 'WH';
  if v_wh is null then
    raise exception 'Location WH not found. This migration assumes WH is the '
                    'surviving warehouse; check the location table before '
                    'proceeding.';
  end if;

  -- The invariant, measured before anything moves.
  select coalesce(sum(delta), 0) into v_total_before from stock_movement;

  -- ── 1. sales orders ─────────────────────────────────────────────────────
  update sales_order
     set location_id = v_wh
   where location_id in (select id from location where code in ('MAIN','SHOP'));
  get diagnostics v_moved_orders = row_count;

  -- ── 2. the ledger ───────────────────────────────────────────────────────
  -- This is the step that resolves the -11. The rows are not edited in
  -- substance: same part, same delta, same reason, same created_at, same
  -- client_uuid. Only the location they are attributed to changes.
  update stock_movement
     set location_id = v_wh
   where location_id in (select id from location where code in ('MAIN','SHOP'));
  get diagnostics v_moved_moves = row_count;

  -- ── 3. bin policies ─────────────────────────────────────────────────────
  -- Expected: zero rows. Handled anyway, because stock_policy carries
  -- UNIQUE (part_id, location_id) and a blind UPDATE would fail on a collision
  -- rather than doing something sensible. A policy at a retired location that
  -- duplicates one at WH is dropped, not merged: WH's is authoritative because
  -- WH is where the stock physically is, and picking a winner by arithmetic
  -- would silently move somebody's bin number.
  update stock_policy sp
     set location_id = v_wh
   where sp.location_id in (select id from location where code in ('MAIN','SHOP'))
     and not exists (select 1 from stock_policy w
                      where w.part_id = sp.part_id and w.location_id = v_wh);
  get diagnostics v_moved_pol = row_count;

  delete from stock_policy
   where location_id in (select id from location where code in ('MAIN','SHOP'));
  get diagnostics v_dropped_pol = row_count;

  -- ── 4. retire the two survivors of the seed ─────────────────────────────
  update location
     set deleted_at = now()
   where code in ('MAIN','SHOP')
     and deleted_at is null;
  get diagnostics v_retired = row_count;

  -- ── 5. verify, and refuse to commit if anything is off ──────────────────
  select coalesce(sum(delta), 0) into v_total_after from stock_movement;
  if v_total_after <> v_total_before then
    raise exception 'ABORTING: total stock changed from % to %. This migration '
                    'must never alter the quantity of anything — it only '
                    'changes which location a movement is attributed to.',
                    v_total_before, v_total_after;
  end if;

  select count(*) into v_orphans
    from (select location_id from stock_movement
          union all select location_id from sales_order
          union all select location_id from stock_policy) r
    join location l on l.id = r.location_id
   where l.deleted_at is not null;
  if v_orphans > 0 then
    raise exception 'ABORTING: % row(s) still reference a retired location.',
                    v_orphans;
  end if;

  raise notice 'single-location consolidation: % order(s), % movement(s), '
               '% policy row(s) repointed, % duplicate policy row(s) dropped, '
               '% location(s) retired. Total stock unchanged at %.',
               v_moved_orders, v_moved_moves, v_moved_pol, v_dropped_pol,
               v_retired, v_total_after;
end $$;

commit;

-- ============================================================================
--  VERIFY BY QUERY, not by the editor's "Success" message — RAISE NOTICE is
--  not surfaced by the Supabase SQL editor.
--
--  Expect exactly one live location, holding 805 units:
--
--    select l.id, l.code, l.name, l.deleted_at,
--           (select count(*) from stock_movement m where m.location_id = l.id) as movements,
--           (select coalesce(sum(delta),0) from stock_movement m where m.location_id = l.id) as units,
--           (select count(*) from stock_policy  p where p.location_id = l.id) as policies,
--           (select count(*) from sales_order   o where o.location_id = l.id) as orders
--      from location l order by l.id;
--
--    id | code |         name         | deleted_at | movements | units | policies | orders
--     1 | MAIN | Main Warehouse       | <ts>       |         0 |     0 |        0 |      0
--     2 | SHOP | Counter / Shop Floor | <ts>       |         0 |     0 |        0 |      0
--    10 | WH   | Main Warehouse       |            |       199 |   805 |      161 |     14
--
--  And the total, which is the number that must not have moved:
--
--    select coalesce(sum(delta),0) from stock_movement;   -- 805
-- ============================================================================
