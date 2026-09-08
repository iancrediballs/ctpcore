-- ============================================================================
--  CTP Core — SYNC FOUNDATIONS (migration 0021)
--
--  Three changes, all schema-only, all made now because the tables are empty
--  or the columns are NULL and the cost is therefore nothing. After trading
--  history accumulates each of them is a data migration.
--
--  Cloud counterparts: server/0036 (idempotency keys) and server/0037
--  (actor_source). The watermark is desktop-only and has no cloud counterpart
--  by design — see part 3.
-- ============================================================================


-- ── 1. IDEMPOTENCY KEYS ────────────────────────────────────────────────────
--
-- The desktop will create rows offline and upload them later. An upload can
-- fail AFTER the server committed but before the client hears back; the client
-- retries; without a key the server cannot tell a retry from a second real row.
--
-- stock_movement already survives this because it carries client_uuid UNIQUE,
-- generated on the device before the first attempt. That single column is why
-- the two ledgers merge by union with no judgement at all. This applies the
-- same idea where it is missing.
--
-- Checked, not assumed. Already protected by a natural key: part (sku),
-- diagram (drawing_key), customer (code), part_xref, part_alias, and sales_line
-- (order_id, part_id — an immutable composite, so a retry collides with
-- itself). Genuinely unprotected: hotspot, part_image, part_diagram_callout,
-- part_fitment — none of them has a UNIQUE constraint of any kind.
--
-- hotspot is the urgent one: nothing distinguishes two markers at the same spot
-- on the same drawing, so a retried upload silently doubles them, and hotspot
-- placement is hours of careful manual work.
--
-- sales_order is included although `number` is UNIQUE and now genuinely unique
-- across installs thanks to the device namespace. That is idempotency by side
-- effect. `number` is user-facing and might one day be edited or reformatted;
-- an idempotency key must be immutable and machine-owned. One column now beats
-- discovering the coupling later.
--
-- Nullable on purpose: existing rows need no key — they exist on both sides and
-- match by natural key. SQLite permits many NULLs in a UNIQUE column, so
-- nothing is backfilled and no existing row is touched.

ALTER TABLE sales_order          ADD COLUMN client_uuid TEXT;
ALTER TABLE hotspot              ADD COLUMN client_uuid TEXT;
ALTER TABLE part_image           ADD COLUMN client_uuid TEXT;
ALTER TABLE part_diagram_callout ADD COLUMN client_uuid TEXT;
ALTER TABLE part_fitment         ADD COLUMN client_uuid TEXT;

-- UNIQUE cannot be added by ALTER TABLE in SQLite, but a unique INDEX is the
-- same guarantee and does permit multiple NULLs.
CREATE UNIQUE INDEX IF NOT EXISTS sales_order_client_uuid_idx          ON sales_order(client_uuid);
CREATE UNIQUE INDEX IF NOT EXISTS hotspot_client_uuid_idx              ON hotspot(client_uuid);
CREATE UNIQUE INDEX IF NOT EXISTS part_image_client_uuid_idx           ON part_image(client_uuid);
CREATE UNIQUE INDEX IF NOT EXISTS part_diagram_callout_client_uuid_idx ON part_diagram_callout(client_uuid);
CREATE UNIQUE INDEX IF NOT EXISTS part_fitment_client_uuid_idx         ON part_fitment(client_uuid);


-- ── 2. actor_source GAINS `local_session` ──────────────────────────────────
--
-- The offline outbox creates a case none of the three existing values describes
-- honestly: a signed-in operator acts at the counter with no connectivity, and
-- the row uploads later — possibly after somebody else has signed in.
--
--   server_session  would be a lie: the server never saw the acting session.
--   client_attested understates it: a real session WAS verified on the device.
--   import          is for scripts. No human acted.
--
-- The four values are a ladder of how far the actor can be relied upon:
--   server_session  > local_session > client_attested > import
--
-- SQLite cannot alter a CHECK constraint, so the column is dropped and re-added.
-- Safe because actor_source is NULL on every row — nothing writes it yet.

ALTER TABLE stock_movement DROP COLUMN actor_source;
ALTER TABLE stock_movement ADD COLUMN actor_source TEXT
  CHECK (actor_source IS NULL
         OR actor_source IN ('server_session','local_session',
                             'client_attested','import'));


-- ── 3. THE SYNC WATERMARK LIVES ON device_identity ─────────────────────────
--
-- Sync needs to remember how far it got, per table, so an interrupted pull
-- resumes instead of restarting. That state belongs to THIS MACHINE and must
-- never be shared with any other.
--
-- It goes here rather than in a new table for one reason: device_identity
-- already exists to hold exactly that kind of fact, and it already carries the
-- warning that it must never join the sync set. One table with one reason to
-- exist is easier to protect than two — a second local-only table is a second
-- chance for somebody to "tidy" it into sync-rules.yaml, and the numbering
-- collision that would cause is the bug device_identity exists to prevent.
--
--  ⚠ device_identity IS LOCAL-ONLY AND MUST STAY OUT OF sync-rules.yaml,
--    sync-streams.yaml AND AppSchema.ts. Syncing it would put every machine in
--    the same numbering namespace AND give them each other's sync progress.
--
-- sync_watermarks is a JSON object of table name -> last-seen updated_at, so a
-- new table needs no schema change. last_sync_at / last_sync_status exist so
-- the app can TELL THE OPERATOR how stale the machine is, rather than failing
-- silently — the same principle as the authentication warning window.

ALTER TABLE device_identity ADD COLUMN sync_watermarks  TEXT NOT NULL DEFAULT '{}';
ALTER TABLE device_identity ADD COLUMN last_sync_at     TEXT;
ALTER TABLE device_identity ADD COLUMN last_sync_status TEXT;
