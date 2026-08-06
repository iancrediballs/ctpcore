# server/ — cloud Postgres migrations

Apply order for a fresh Supabase project:

    schema.postgres.sql  ->  seed.postgres.sql  ->  rls.sql
    -> 0014_powersync_b1_delta.sql
    -> 0015_data_api_grants.sql
    -> 0016_data_catchup.sql

## Current state (verified 2026-08-06 against project hkzmydowyiajkbakxfkj)

| file | status |
|---|---|
| schema / seed / rls | applied 2026-06-30 |
| `0014_powersync_b1_delta.sql` | **applied** 2026-08-05. Do not re-run — it fails on `price_natural_key already exists` and rolls back. Recovered here from `supabase_migrations.schema_migrations` so the repo has it. |
| `0015_data_api_grants.sql` | **NOT applied.** Ian must paste it into the Supabase SQL editor — the agent is refused role-privilege grants. |
| `0016_data_catchup.sql` | **NOT applied.** Run after 0015. |

## Why 0015 and 0016 matter

**0015** — Postgres checks table GRANTs before RLS. `authenticated` currently
holds SELECT on `app_user` and nothing else, so all 41 policies in `rls.sql`
are unreachable code and every Data API write fails before any policy is read.
Reads look fine only because PowerSync replicates as `powersync_role` and the
client reads its own local SQLite. 0015 also adds the three policies missing
from `part_alias` / `part_cost` / `price_tier` (RLS on, zero policies = deny
everything) and switches the three views to `security_invoker`.

**0016** — the cloud copy still holds the pre-0013 data, where all 334
`tier='list'` rows are landed COST wearing a list-price label. Anything
quoting off it sells at cost. 0016 replays the row changes from SQLite
migrations 0010, 0012 and 0013.

## Verification

Both files were applied to a local PostgreSQL 16 replica built from
`schema -> seed -> rls -> 0014`, which reproduced the live counts exactly
(part 173, price(list) 334, list_price_minor 102, sales_line 3).

After 0015 + 0016 on that replica:

- part 173 -> **161** (the 12 `FV-*` demo parts gone; none was on a sales line, so all hard-deleted)
- `diagram_ref` set on **122** parts
- `part_cost` **159** rows, `price(tier='list')` **115** rows, `price_tier` **3** rows
- **0** list prices at or below landed cost
- both files re-run clean (idempotent)

Behavioural checks under RLS on the replica:

| actor | result |
|---|---|
| staff (`admin`) | inserts a ledger movement, updates a part, writes `part_alias`, reads all 159 cost rows |
| customer | sees the 161-part catalogue, sees **0** cost rows and **0** price tiers, `part_alias` write refused by RLS |
| any authenticated | `UPDATE stock_movement` refused at the grant layer — the ledger stays append-only |
| anon | may INSERT a lead; cannot SELECT `part` or `lead` |

## Regenerating 0016

`0016_data_catchup.sql` is generated, not hand-written. Its source of truth is
the SQLite migrations, so it can be rebuilt and diffed:

    python server/gen_0016_data_catchup.py > server/0016_data_catchup.sql

The generator asserts the parsed counts (122 / 159 / 115 / 115 / 3) and exits
non-zero if the migrations no longer match.

## Still open after these two

- `part_alias`, `part_cost`, `price_tier` are missing from `sync-streams.yaml` (still lists 19 tables).
- `user_role` JWT claim via a Supabase custom-access-token hook — sync streams are not role-scoped yet.
- `AUTH_ENABLED` is still `false` in `app/src/sync/config.ts`.
- `PART_DETAIL_SQL` in `app/src/data/backend.web.ts` was written against the 0010 view; 0013 moved `price_zar_minor` to `part_cost`. Jefrey reads that field as cost, so mobile margins would be wrong until it is updated.
