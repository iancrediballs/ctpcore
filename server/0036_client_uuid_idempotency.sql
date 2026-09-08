-- 0036 — give every offline-creatable row a client-generated idempotency key.
--
-- WHY THIS EXISTS
-- The desktop will soon create rows while offline and upload them later. Any
-- upload can fail after the server committed but before the client heard back —
-- a dropped connection, a timeout, a closed laptop. The client retries, and
-- without a key the server cannot tell a retry from a second genuine row.
--
-- `stock_movement` already survives this, and it is worth being precise about
-- why: it carries `client_uuid TEXT NOT NULL UNIQUE`, generated on the device
-- before the first attempt. A retry collides with itself and is rejected. That
-- one column is the entire reason the desktop and cloud ledgers can be merged
-- by union with no judgement — 160 rows replayed against 199 added exactly 39
-- and changed sum(delta) by exactly the new rows. It was designed in, and
-- everything else in this migration is that idea applied where it is missing.
--
-- WHICH TABLES, AND WHY THESE
-- Checked rather than assumed. Tables the desktop can create rows in, and what
-- protects them today:
--
--   part                 sku UNIQUE                      already safe
--   diagram              drawing_key UNIQUE              already safe
--   customer             code UNIQUE                     already safe
--   part_xref            (part_id, xref_number, type)    already safe
--   part_alias           (phrase_norm, part_id, polarity) already safe
--   sales_line           (order_id, part_id)             already safe — an
--                        immutable composite; a retry collides with itself
--
--   hotspot              *** NO UNIQUE CONSTRAINT AT ALL ***
--   part_image           *** NO UNIQUE CONSTRAINT AT ALL ***
--   part_diagram_callout *** NO UNIQUE CONSTRAINT AT ALL ***
--   part_fitment         *** NO UNIQUE CONSTRAINT AT ALL ***
--
-- `hotspot` is the urgent one. Nothing distinguishes two markers at the same
-- spot on the same drawing, so a retried upload silently doubles them — and
-- hotspot placement is hours of careful manual work being done right now.
--
-- `sales_order` is added too, though `number` is UNIQUE and, since the device
-- namespace landed, genuinely unique across installs. That is idempotency by
-- side effect, and the two concerns should not share a column: `number` is
-- user-facing and could be edited or reformatted one day, while an idempotency
-- key must be immutable and machine-owned. Separating them now costs one
-- column; discovering the coupling later costs an incident.
--
-- NULLABLE ON PURPOSE. Existing rows have no key and need none — they already
-- exist on both sides and are matched by natural key. A NULLable UNIQUE column
-- permits many NULLs in both PostgreSQL and SQLite, so no backfill is required
-- and no existing row is touched. New rows created by a sync-aware client will
-- carry one; rows created by anything older simply will not.
--
-- The desktop gets the same columns in its migration 0021.
-- ============================================================================

alter table public.sales_order          add column if not exists client_uuid text;
alter table public.hotspot              add column if not exists client_uuid text;
alter table public.part_image           add column if not exists client_uuid text;
alter table public.part_diagram_callout add column if not exists client_uuid text;
alter table public.part_fitment         add column if not exists client_uuid text;

do $$
declare t text;
begin
  foreach t in array array['sales_order','hotspot','part_image',
                           'part_diagram_callout','part_fitment']
  loop
    if not exists (
      select 1 from pg_constraint where conname = t || '_client_uuid_key'
    ) then
      execute format('alter table public.%I add constraint %I unique (client_uuid)',
                     t, t || '_client_uuid_key');
    end if;
  end loop;
end $$;

comment on column public.hotspot.client_uuid is
  'Idempotency key generated on the device before the first upload attempt. '
  'Null for rows that predate sync. A retried upload collides with itself '
  'rather than creating a duplicate — see stock_movement.client_uuid, the '
  'pattern this follows.';

-- Verify:
--   select table_name from information_schema.columns
--    where column_name = 'client_uuid' and table_schema = 'public'
--    order by table_name;
--   -- expect: hotspot, part_diagram_callout, part_fitment, part_image,
--   --         sales_order, stock_movement
