-- ============================================================================
--  CTP Core — ONE BUILDING, ONE WAREHOUSE (migration 0023)
--
--  Ian confirmed 2026-09-09: China Truck Parts operates from a single building
--  with a single warehouse. Three locations exist because the FleetView seed
--  (0002_seed.sql) shipped MAIN + SHOP as demo data and the real JH6 shipment
--  landed into a third, WH. Nobody chose to have three; they accumulated.
--
--  Cloud counterpart: server/0038_single_location.sql. Same rule, same
--  survivor, same order of operations.
--
--  ⚠ NO STOCK IS WRITTEN OFF BY THIS MIGRATION. NOT ONE UNIT.
--    It repoints rows from one location to another and retires the two empty
--    locations. The sum of stock_movement.delta is asserted to be identical
--    before and after, and the migration ABORTS if it is not (see part 5).
--
--  ON IAN'S MACHINE this is a no-op for data: all 160 movements and all 161
--  bin policies already point at WH, and there are no sales orders. Only the
--  two retirements happen. The repointing statements exist because the CLOUD
--  has rows at MAIN and SHOP, and because a fresh install runs 0002 and
--  creates MAIN and SHOP again — this file must be correct on any machine, not
--  just on the one it was written against.
--
--  ⚠ WHY THIS FILE IS MANDATORY AND NOT MERELY TIDY.
--    stock_movement has no `rev` and no `updated_at` — it is the append-only
--    ledger, and Stage B's pull watermark for it is `created_at`. Repointing a
--    movement's location_id in the cloud does not change created_at, so a
--    desktop that has already pulled those rows will never see the change; and
--    apply_rows() upserts the ledger with INSERT OR IGNORE on client_uuid, so
--    even a full replay would not update it either.
--
--    SYNC CANNOT CARRY THIS CORRECTION FOR THE LEDGER. The desktop reaches the
--    same state only by applying the same rule locally. That is what this file
--    is. The two migrations are one change written twice, not a change and a
--    copy of it.
--
--  WHY WH SURVIVES rather than MAIN: it holds every unit and every bin policy.
--  The survivor is chosen by where the data already is.
--
--  NEVER HARD-DELETE A LOCATION. stock_movement references it and the ledger
--  is history; deleting one would turn every past movement into a row that
--  cannot say where it happened. Retirement is `deleted_at`, and every picker
--  filters on it (list_locations, part_detail). The ledger and order displays
--  deliberately do NOT filter on it, so history keeps rendering.
--
--  rev IS NOT SET BY HAND. Migration 0018 installed the rev triggers, whose
--  guard is `WHEN NEW.rev = OLD.rev` — setting rev here would look like a
--  deliberate writer-supplied version and suppress the increment.
--
--  Idempotent: safe to re-run, every statement is a no-op the second time.
-- ============================================================================
PRAGMA foreign_keys = ON;

BEGIN;

-- ── 1. capture the invariant BEFORE anything moves ─────────────────────────
-- A temp table, because SQLite has no variables. Dropped at the end.
DROP TABLE IF EXISTS _loc_before;
CREATE TEMP TABLE _loc_before AS
  SELECT COALESCE(SUM(delta), 0) AS total FROM stock_movement;

-- ── 2. sales orders ────────────────────────────────────────────────────────
-- Resolved by CODE, never by id. Two locations are both NAMED 'Main Warehouse'
-- and only the codes tell them apart; codes are also the natural key the
-- desktop syncs on (Stage B rule 1), which is what lets this file mean the
-- same thing in a database whose id sequence is independent of the cloud's.
UPDATE sales_order
   SET location_id = (SELECT id FROM location WHERE code = 'WH')
 WHERE location_id IN (SELECT id FROM location WHERE code IN ('MAIN','SHOP'));

-- ── 3. the ledger ──────────────────────────────────────────────────────────
-- Same part, same delta, same reason, same created_at, same client_uuid. Only
-- the location the movement is attributed to changes. This is the step that
-- resolves a negative balance at a location that never received anything.
UPDATE stock_movement
   SET location_id = (SELECT id FROM location WHERE code = 'WH')
 WHERE location_id IN (SELECT id FROM location WHERE code IN ('MAIN','SHOP'));

-- ── 4. bin policies ────────────────────────────────────────────────────────
-- stock_policy's PRIMARY KEY is (part_id, location_id), so a blind UPDATE
-- would fail on a collision rather than doing something sensible. A policy at
-- a retired location that duplicates one at WH is dropped, not merged: WH's is
-- authoritative because WH is where the stock physically is, and choosing a
-- winner by arithmetic would silently move somebody's bin number.
UPDATE stock_policy
   SET location_id = (SELECT id FROM location WHERE code = 'WH')
 WHERE location_id IN (SELECT id FROM location WHERE code IN ('MAIN','SHOP'))
   AND NOT EXISTS (
     SELECT 1 FROM stock_policy w
      WHERE w.part_id = stock_policy.part_id
        AND w.location_id = (SELECT id FROM location WHERE code = 'WH'));

DELETE FROM stock_policy
 WHERE location_id IN (SELECT id FROM location WHERE code IN ('MAIN','SHOP'));

-- ── 5. retire the two survivors of the seed ────────────────────────────────
UPDATE location
   SET deleted_at = datetime('now')
 WHERE code IN ('MAIN','SHOP')
   AND deleted_at IS NULL;

-- ── 6. assert, and abort the migration if anything is off ──────────────────
-- SQLite has no RAISE outside a trigger, so the assertion is a CHECK
-- constraint on a throwaway table: inserting a 0 violates it, the statement
-- errors, execute_batch stops, and PRAGMA user_version is never advanced
-- (see run_migrations in main.rs) — so a failed run is retried next launch
-- rather than being silently half-applied.
DROP TABLE IF EXISTS _loc_assert;
CREATE TEMP TABLE _loc_assert (
  ok INTEGER NOT NULL CHECK (ok = 1)   -- 0 here means: DO NOT COMMIT
);

-- 6a. total stock must be byte-for-byte identical.
INSERT INTO _loc_assert(ok)
SELECT CASE WHEN (SELECT COALESCE(SUM(delta),0) FROM stock_movement)
              = (SELECT total FROM _loc_before)
            THEN 1 ELSE 0 END;

-- 6b. nothing may still point at a retired location.
INSERT INTO _loc_assert(ok)
SELECT CASE WHEN NOT EXISTS (
         SELECT 1 FROM location l
          WHERE l.deleted_at IS NOT NULL
            AND (EXISTS (SELECT 1 FROM stock_movement m WHERE m.location_id = l.id)
              OR EXISTS (SELECT 1 FROM sales_order    o WHERE o.location_id = l.id)
              OR EXISTS (SELECT 1 FROM stock_policy   p WHERE p.location_id = l.id)))
            THEN 1 ELSE 0 END;

-- 6c. exactly one live location must remain.
INSERT INTO _loc_assert(ok)
SELECT CASE WHEN (SELECT COUNT(*) FROM location WHERE deleted_at IS NULL) = 1
            THEN 1 ELSE 0 END;

DROP TABLE _loc_assert;
DROP TABLE _loc_before;

COMMIT;

-- ============================================================================
--  VERIFY, on a COPY of the database (with its -wal and -shm files):
--
--    SELECT l.id, l.code, l.name, l.deleted_at,
--           (SELECT COUNT(*) FROM stock_movement m WHERE m.location_id=l.id) mv,
--           (SELECT COALESCE(SUM(delta),0) FROM stock_movement m WHERE m.location_id=l.id) units,
--           (SELECT COUNT(*) FROM stock_policy p WHERE p.location_id=l.id) pol
--      FROM location l ORDER BY l.id;
--
--  On Ian's machine, before the first cloud pull:
--     1 MAIN  Main Warehouse        <ts>    0    0    0
--     2 SHOP  Counter / Shop Floor  <ts>    0    0    0
--    10 WH    Main Warehouse                160  834  161
--
--  The 834 is the desktop's own figure and is expected to differ from the
--  cloud's 805 until the reseed pull runs — the two databases have not yet
--  been reconciled. What matters is that this migration does not change it:
--  834 before, 834 after.
-- ============================================================================
