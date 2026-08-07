# server/ — cloud Postgres migrations

Apply order for a fresh Supabase project:

    schema.postgres.sql  ->  seed.postgres.sql  ->  rls.sql
    -> 0014_powersync_b1_delta.sql
    -> 0015_data_api_grants.sql
    -> 0016_data_catchup.sql
    -> 0017_security_hardening.sql
    -> 0018_photo_catchup.sql

## Status (project `hkzmydowyiajkbakxfkj`, checked 2026-08-06)

| file | status |
|---|---|
| schema / seed / rls | applied 2026-06-30 |
| `0014_powersync_b1_delta.sql` | **applied** 2026-08-05. Do not re-run — fails on `price_natural_key already exists`. Recovered here from `supabase_migrations.schema_migrations`. |
| `0015_data_api_grants.sql` | **applied** 2026-08-06 |
| `0016_data_catchup.sql` | **applied** 2026-08-06 |
| `0017_security_hardening.sql` | **NOT applied** — paste into the SQL editor |
| `0018_photo_catchup.sql` | **NOT applied** — paste, then run `sync_assets.py` |

The SQL editor reports "Success. No rows returned" for all of these. That is
correct — none ends in a SELECT, and their self-checks report via `RAISE
NOTICE`, which that editor does not surface. **Verify by query, not by the
editor's message.**

## What each one is for

**0015 — Data API grants.** Postgres checks table GRANTs *before* RLS.
`authenticated` held SELECT on `app_user` and nothing else, so all 41 policies
in `rls.sql` were unreachable code and every Data API write would have failed
before any policy was read. Reads looked fine only because PowerSync replicates
as `powersync_role` and the client reads its own local SQLite. Also adds the
three policies missing from `part_alias` / `part_cost` / `price_tier` (RLS on
with no policy denies everything) and switches the three views to
`security_invoker`. `stock_movement` gets INSERT only — the ledger is
append-only.

**0016 — data catch-up.** The cloud copy held pre-0013 data, where all 334
`tier='list'` rows were landed cost wearing a list-price label. Replays the row
changes from SQLite 0010, 0012 and 0013. Generated, not transcribed —
regenerate with `python server/gen_0016_data_catchup.py > server/0016_data_catchup.sql`.

**0017 — helper hardening.** Pins `search_path` on `is_staff()` / `is_manager()`,
which sit in the call path of every policy, and stops publishing the five RLS
helpers as anonymous RPC endpoints. Pre-existing advisor warnings from
`rls.sql`, not caused by 0015. Leaves `pg_trgm` in `public` (moving it needs the
`gin_trgm_ops` index rebuilt — see the commented block at the end of the file).

**0018 — white cutouts.** The 2026-07-02 cutout import went into the local
SQLite only, so Postgres still points at `raw_*.jpg`. Replays it: 151 parts get
a white-background cutout as primary, raws are demoted (never deleted). Uses
`png_import.py`'s matching rule verbatim. **Run `python server/sync_assets.py`
afterwards** or the new paths 404 on web.

## Verification

Every file here was applied to a local PostgreSQL 16 replica built from
`schema -> seed -> rls -> 0014` before going anywhere near production. The
replica reproduced the live counts exactly (part 173, price(list) 334,
list_price_minor 102, sales_line 3) and predicted every post-apply number.

After 0015 + 0016, live:

- part 173 → **161** (the 12 `FV-*` demo parts gone; none was on a sales line)
- `diagram_ref` on **122** parts, `part_cost` **159**, `price(tier='list')` **115**, `price_tier` **3**
- **0** list prices at or below landed cost
- `authenticated`: SELECT on 28 relations, writes on 25; **0** UPDATE/DELETE on `stock_movement`
- `anon`: 1 grant (INSERT on `lead`); 0 tables with RLS and no policy; 3 views on `security_invoker`

0017 and 0018 on the replica:

| check | result |
|---|---|
| staff (`admin`) | posts a movement, updates a part, writes `part_alias`, reads all 159 cost rows |
| customer | sees the 161-part catalogue, **0** cost rows, **0** price tiers; `part_alias` write refused |
| any authenticated | `UPDATE stock_movement` refused at the grant layer |
| anon | may INSERT a lead; cannot SELECT `part` or `lead`; cannot execute the RLS helpers |
| 0018 | parts with a photo 125 → **152**; 151 cutouts, all primary; one primary per part; all 124 raw rows kept |

All files re-run clean.

## Gotchas worth keeping

- **`list_tables.rows` is `reltuples`** — an estimate that reads 0 until ANALYZE
  runs. It is what produced the false "the database is empty" note. Use `count(*)`.
- **No `TEMP ... ON COMMIT DROP`** in anything meant to be pasted. If the editor
  does not wrap the script in one transaction the table dies at the CREATE and
  every following statement silently matches nothing — a migration that reports
  success and changed not one row. 0016 and 0018 use real tables and drop them.
- **anon has INSERT but not SELECT on `lead`**, and Postgres needs SELECT to
  evaluate `RETURNING`. The public form must call `.insert(row)` **without**
  `.select()`. Do not grant anon SELECT to fix it — that publishes every lead.
- **PowerSync bypasses RLS.** It replicates as `powersync_role` (BYPASSRLS), so
  0015's lock on `part_cost` / `price_tier` only covers the Data API. What keeps
  cost off a device is which sync stream it subscribes to — see `ctp_staff` in
  `sync-streams.yaml`. Gate it on the `user_role` claim before any non-staff
  login exists.
- **Recover an applied migration's SQL** from
  `supabase_migrations.schema_migrations` — that is how `0014` got back into the
  repo after the session that wrote it was reclaimed.

## Still open

- Run 0017, then 0018, then `sync_assets.py`.
- `user_role` JWT claim via a Supabase custom-access-token hook, then role-scope `ctp_staff`.
- `AUTH_ENABLED` is still `false` in `app/src/sync/config.ts`.
- `migrate_sqlite_to_pg.py`'s `ORDER` list predates 0011/0013 (add `part_alias`,
  `part_cost`, `price_tier`) — only matters if a full reseed is ever wanted.
