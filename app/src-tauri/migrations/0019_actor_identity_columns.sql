-- ============================================================================
--  CTP Core — ACTOR IDENTITY COLUMNS (migration 0019)
--
--  SCHEMA ONLY. Nothing writes these columns yet, and that is deliberate:
--  actor_id is NULL on all 160 movements here, so reshaping it costs nothing
--  today. After a year of trading it is a data migration. The system is not in
--  daily use yet, which makes this the cheapest this change will ever be.
--
--  THE DEFECT
--  `actor_id` was declared INTEGER. The only staff-identity table in the system
--  is the cloud's app_user, whose id is a UUID. So the audit column could not
--  hold the identity it exists to record — not an oversight in populating it,
--  but a value that could never have fitted. 160 movements carry no actor here;
--  199 do in the cloud, for the same reason.
--
--  THE THREE COLUMNS, matching the cloud's migration 0035 exactly:
--
--    actor_id      the app_user UUID, stored as TEXT. NO FOREIGN KEY: app_user
--                  does not exist in this schema at all — identity lives in the
--                  cloud — so there is nothing local to reference. The value is
--                  the same UUID the cloud stores; only the constraint differs.
--
--    actor_label   who acted, in words, when there is no account to point at.
--                  This desktop has no authentication today (AUTH_ENABLED is
--                  false), and a shared counter machine may never have one
--                  account per person. A truthful "Thabo, counter" is a better
--                  record than a fabricated user id.
--
--    actor_source  which path stamped the row, because the paths do not carry
--                  equal weight:
--                    'server_session'  derived from a verified session
--                    'client_attested' taken on an authenticated client's word
--                    'import'          loaded by a script or migration
--                  An audit field the caller can set is a claim, not a record.
--                  Keeping both is fine; conflating them is not.
--
--  WHY DROP AND RE-ADD RATHER THAN REBUILD THE TABLE
--  SQLite cannot change a column's declared type. The usual answer is a 12-step
--  table rebuild — but stock_movement is the append-only ledger whose integrity
--  is the product's headline claim, and rebuilding it to fix a type on an
--  all-NULL column is a poor trade. DROP COLUMN + ADD COLUMN is available
--  (SQLite 3.35+; rusqlite bundles well past that), loses nothing because every
--  value is NULL, and leaves the ledger's rows untouched. Verified first that
--  actor_id is not indexed, not in any constraint, and not referenced by any
--  view or trigger — DROP COLUMN refuses in those cases, and would have told us.
--
--  Not done here: no identity code, no UI, no AUTH_ENABLED change. Desktop
--  authentication is designed after Phase 3 because it interacts with the sync
--  write path, and designing it first means designing it twice.
-- ============================================================================

-- All 160 rows are NULL here, so nothing is lost. Confirm if ever in doubt:
--   SELECT count(*) FROM stock_movement WHERE actor_id IS NOT NULL;  -- expect 0
ALTER TABLE stock_movement DROP COLUMN actor_id;

ALTER TABLE stock_movement ADD COLUMN actor_id     TEXT;
ALTER TABLE stock_movement ADD COLUMN actor_label  TEXT;
ALTER TABLE stock_movement ADD COLUMN actor_source TEXT
  CHECK (actor_source IS NULL
         OR actor_source IN ('server_session','client_attested','import'));
