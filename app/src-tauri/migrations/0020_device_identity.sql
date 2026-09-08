-- ============================================================================
--  CTP Core — DEVICE NUMBERING NAMESPACE (migration 0020)
--
--  THE COLLISION THIS PREVENTS, which is not hypothetical
--  create_order minted `SO-{1000 + local rowid}`, against a column declared
--  `number TEXT NOT NULL UNIQUE`. Every fresh install starts at rowid 1 and so
--  mints SO-1001 — and the cloud ALREADY HOLDS SO-1001 and SO-1002, seeded from
--  an early desktop database. Two machines trading independently produce the
--  same numbers for different orders, and the collision only announces itself
--  when sync turns on and one of them fails to upload, or worse, overwrites.
--
--  THE FIX: uniqueness comes from a NAMESPACE, not from coordination.
--
--      {company.quote_prefix}{device code}-{1000 + local id}      QT-A7K2-1001
--
--  Each install owns its own code, so local sequences can never meet. A
--  server-issued block would need connectivity at the moment an order is
--  created, and offline operation at the counter is a headline feature — an
--  order desk that cannot write an order without signal is a worse defect than
--  the one being fixed. A ULID or UUID component would be collision-free and
--  unreadable; these numbers get read down a telephone to customers.
--
--  ── WHY THIS TABLE IS LOCAL AND MUST STAY LOCAL ───────────────────────────
--  device_identity is deliberately absent from server/sync-rules.yaml,
--  server/sync-streams.yaml and app/src/sync/AppSchema.ts, and it must remain
--  absent from all three.
--
--  If this table is ever added to the sync set, every machine converges on one
--  code and the numbering collision returns — silently, and looking exactly
--  like the bug it replaced. The whole mechanism depends on this row being
--  different on every install, which is the opposite of what syncing a table
--  is for. It is not an oversight that it does not sync. Do not "tidy" it into
--  the synced schema.
--
--  The code is a NAMESPACE, not an identity. It says which machine minted a
--  number; it says nothing about who was using that machine. Who did what is
--  recorded by stock_movement.actor_id / actor_label / actor_source (0019),
--  and identity follows the person rather than the hardware. Those two ideas
--  were conflated in an earlier draft of this work; they are separate concerns
--  and this table only serves the first.
--
--  The code is generated on first run rather than here, because SQLite's RNG
--  is reachable from Rust and a migration cannot ask the operator. It is shown
--  and editable in Settings so Ian can replace A7K2 with something meaningful
--  like FRONT or WH.
--
--  Existing orders are untouched and need no backfill: the desktop currently
--  holds ZERO sales_order rows, and the cloud's existing numbers (SO-1001,
--  RQ-260908-…) are disjoint from this format, so the UNIQUE constraint is
--  satisfied by construction rather than by luck.
-- ============================================================================

CREATE TABLE IF NOT EXISTS device_identity (
  id         INTEGER PRIMARY KEY CHECK (id = 1),   -- singleton
  code       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The prefix half of the number. The cloud has carried quote_prefix since its
-- migration 0028 and SettingsView has always been able to edit it, but nothing
-- ever read it — it was a setting wired to nothing. The desktop now has the
-- column too, and the numbering below is its first actual consumer.
ALTER TABLE company ADD COLUMN quote_prefix TEXT NOT NULL DEFAULT 'QT-';
