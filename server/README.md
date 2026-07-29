# CTP Core — server/ (backend spine, Phase B0)

The Postgres source of truth + access control + offline-sync config that turns the
desktop ERP into a multi-surface platform. See `../BACKEND_ARCHITECTURE.md` for the
why; this folder is the how.

## Files
| file | what it is |
|------|------------|
| `schema.postgres.sql` | Canonical Postgres schema, ported from SQLite migrations 0001–0009 (consolidated). Includes the new `lead` table. |
| `rls.sql` | Roles (`app_user`) + Row-Level Security policies. Apply **after** the schema. |
| `sync-rules.yaml` | PowerSync starter: which data each role's devices sync. |
| `migrate_sqlite_to_pg.py` | One-time data move: reads the live `fleetview.db`, emits `seed.postgres.sql` (FK-ordered INSERTs + identity-sequence resets). |

## Apply order (in the Supabase SQL editor or `psql`)
1. `schema.postgres.sql`
2. `python migrate_sqlite_to_pg.py` → run the generated `seed.postgres.sql`
3. `rls.sql`  ← **after** the seed, so the data load is never blocked by a policy
4. Point PowerSync at the project, load `sync-rules.yaml`.

(Order matters: enabling RLS before loading data can block inserts unless the
caller bypasses RLS. Seeding first sidesteps that entirely.)

## Role claim into the JWT (required by RLS + sync rules)
RLS helpers read `app_user.role`; the sync rules read a `user_role` JWT claim.
In Supabase, add a **custom access token hook** that looks up `app_user.role` for
the user and injects it as `user_role`. Create one `app_user` row per staff login
(role = sales/warehouse/manager/admin); customers default to `customer`.

## Open decisions (flagged, not yet locked)
- **PK type.** We kept `BIGINT` ids 1:1 with the existing SQLite data so the
  migration preserves every foreign key. PowerSync's client SQLite uses text ids;
  confirm its id mapping when wiring. For heavy *offline creation* of new rows on
  multiple devices, consider switching write-heavy tables to UUID PKs in a later
  migration (the append-only ledger already sidesteps this via `client_uuid`).
- **Public catalogue (B2).** Do NOT grant anon access to raw tables. Add a curated
  view exposing only safe columns (no price/cost/locator/OEM/stock) and grant anon
  SELECT on that view.
- **Column-level price hiding.** If you ever expose `part` to anon, move price out
  of the public view (RLS is row-level, not column-level).

## B0 exit test
A part edited on a staff desktop appears in Supabase Postgres and syncs to a second
device — and a `warehouse` login cannot read `accounting_export` or `lead`.
