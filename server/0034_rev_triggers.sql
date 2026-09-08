-- 0034 — make `rev` one mechanism, maintained by the database.
--
-- WHY A TRIGGER AND NOT APPLICATION CODE — this is the whole argument
--
-- PowerSync uploads execute NO application code. A device's local writes are
-- replayed into Postgres by SupabaseConnector.uploadData as plain PostgREST
-- calls, running as `powersync_role`. No RPC, no Rust, no TypeScript: just an
-- UPDATE arriving at the table. So an application-level scheme cannot cover the
-- one write path `rev` exists to serve. A trigger fires there; nothing else we
-- can write does.
--
-- That alone settles it, but the record so far says the same thing more
-- plainly. `rev` has been maintained by hand in about ten written-out
-- statements in main.rs, in some cloud RPCs and not others, and not at all in
-- fill_quote_from_list — with the result that 21 of 58 sales_line rows were
-- edited without being counted. Every new write path is another chance to
-- forget, and forgetting is silent. The blueprint schema/core.sql already had
-- nine `_touch` triggers expressing exactly this intent; they survived neither
-- the Postgres port nor the SQLite one. This restores them, widened to every
-- table that carries the column.
--
-- WHAT THIS DOES NOT FIX — read this before trusting `rev`
--
-- Rows whose `rev` is ALREADY wrong stay wrong, deliberately. Bumping them
-- recovers nothing (the uncounted edits are gone) and would make every row look
-- freshly modified to the first reconciliation, which is precisely the wrong
-- signal to send.
--
-- More importantly: a desktop row and a cloud row BOTH sitting at rev = 1 with
-- different content is unresolvable by `rev` by definition — the counter cannot
-- distinguish "never edited" from "edited without being counted". No trigger
-- fixes that, and this one does not. The one-time desktop/cloud reconciliation
-- must therefore be CONTENT-BASED, not rev-based. Do not read the existence of
-- this trigger as evidence that rev can be trusted for the initial merge; it
-- can only be trusted for changes made after it was installed.
--
-- APPLIED DYNAMICALLY, not to a hard-coded list: every table with both a `rev`
-- and an `updated_at` column gets the trigger. That states the rule instead of
-- a snapshot of today's 19 tables, and re-running this file picks up any table
-- added since. Idempotent — each trigger is dropped and recreated.
--
-- The guard `NEW.rev IS NOT DISTINCT FROM OLD.rev` means an UPDATE that sets
-- `rev` explicitly is respected rather than double-counted. That matters for
-- sync-applied rows, which arrive carrying the originating device's rev.
-- ============================================================================

create or replace function public.touch_rev()
returns trigger
language plpgsql
as $$
begin
  -- Only auto-increment when the writer did not set rev itself. A sync-applied
  -- row carries the rev it was given upstream and must keep it.
  if NEW.rev is not distinct from OLD.rev then
    NEW.rev := OLD.rev + 1;
  end if;
  NEW.updated_at := now();
  return NEW;
end $$;

comment on function public.touch_rev() is
  'BEFORE UPDATE trigger: maintains rev/updated_at for sync reconciliation. '
  'Lives in the database because PowerSync uploads run no application code.';

do $$
declare t text;
begin
  for t in
    select c.table_name
      from information_schema.columns c
      join information_schema.columns u
        on u.table_schema = c.table_schema
       and u.table_name   = c.table_name
       and u.column_name  = 'updated_at'
      join information_schema.tables tb
        on tb.table_schema = c.table_schema
       and tb.table_name   = c.table_name
       and tb.table_type   = 'BASE TABLE'
     where c.table_schema = 'public'
       and c.column_name  = 'rev'
     order by c.table_name
  loop
    execute format('drop trigger if exists %I on public.%I', t || '_touch_rev', t);
    execute format(
      'create trigger %I before update on public.%I '
      'for each row execute function public.touch_rev()',
      t || '_touch_rev', t);
    raise notice 'touch_rev installed on %', t;
  end loop;
end $$;

-- Verify by query, not by the editor's "Success" message — RAISE NOTICE is not
-- surfaced by the Supabase SQL editor. Expect one row per rev-bearing table
-- (19 at the time of writing: the 18 the desktop also has, plus `lead`).
--
--   select event_object_table, trigger_name
--     from information_schema.triggers
--    where trigger_name like '%_touch_rev'
--    order by event_object_table;
