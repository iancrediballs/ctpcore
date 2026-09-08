-- 0035 — give the audit trail a column shape that can actually hold an identity.
--
-- SCHEMA ONLY. Nothing populates these columns yet, and that is the point:
-- stock_movement.actor_id is NULL on all 199 rows today, so changing its type
-- costs nothing. On a year of trading history it is a data migration with
-- downtime. The system is not in daily use yet, which makes this the cheapest
-- it will ever be — the same argument applies to every foundation in Phase 2.
--
-- THE DEFECT THIS FIXES
-- `actor_id` was declared BIGINT. The only staff-identity table in the system
-- is app_user, whose id is a UUID (= auth.users.id). So the audit column could
-- not reference the identity table EVEN IN PRINCIPLE — not "we forgot to
-- populate it", but "the value could never have fitted". That is why 199
-- movements carry no actor and why no amount of application work would have
-- fixed it.
--
-- WHY THREE COLUMNS AND NOT ONE
--
--   actor_id      uuid, FK to app_user. A real account. Nullable, because
--                 movements exist that predate any identity.
--
--   actor_label   text. Who acted, in words, when there is no account to point
--                 at — the desktop has no authentication today, and a shared
--                 counter machine may never have one account per person. A
--                 truthful "Thabo, counter" beats a fabricated user id.
--
--   actor_source  text. WHICH PATH stamped the row, because the paths do not
--                 carry equal weight and the difference must live in the
--                 schema rather than in someone's memory:
--
--     'server_session'  derived server-side from auth.uid() inside a SECURITY
--                       DEFINER function. The caller cannot influence it.
--                       This is a RECORD.
--     'client_attested' supplied by an authenticated client and uploaded.
--                       PowerSync replicates as powersync_role with BYPASSRLS
--                       and NO auth.uid(), so a synced row's actor cannot be
--                       server-derived — it can only be taken on the device's
--                       word. This is a CLAIM.
--     'import'          loaded by a migration or script. No human actor.
--
-- An audit field the caller can set is a claim, not a record. Both are worth
-- keeping; conflating them is not. A future reader asking "can I rely on this
-- actor?" gets the answer from the row instead of from tribal knowledge.
--
-- NOT DONE HERE, deliberately: no identity code, no UI, no AUTH_ENABLED
-- change. Desktop authentication is designed after Phase 3, because it
-- interacts with the sync write path and designing it before that path is
-- settled means designing it twice.
--
-- The desktop gets the same three columns in its migration 0019, WITHOUT the
-- foreign key: app_user does not exist in the local SQLite schema at all, so
-- there is nothing to reference. The desktop stores the same UUID as text.
-- ============================================================================

-- Safe because every row is NULL. Verify first if that is ever in doubt:
--   select count(*) from stock_movement where actor_id is not null;   -- expect 0
alter table public.stock_movement
  alter column actor_id type uuid using null::uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'stock_movement_actor_id_fkey'
  ) then
    alter table public.stock_movement
      add constraint stock_movement_actor_id_fkey
      foreign key (actor_id) references public.app_user(id);
  end if;
end $$;

alter table public.stock_movement add column if not exists actor_label  text;
alter table public.stock_movement add column if not exists actor_source text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'stock_movement_actor_source_chk'
  ) then
    alter table public.stock_movement
      add constraint stock_movement_actor_source_chk
      check (actor_source is null
             or actor_source in ('server_session','client_attested','import'));
  end if;
end $$;

comment on column public.stock_movement.actor_id is
  'The app_user who posted this movement, when there is a real account. Null '
  'for movements with no identity behind them.';
comment on column public.stock_movement.actor_label is
  'Who acted, in words, when no account can be pointed at (shared counter '
  'machine, pre-authentication desktop). Never a substitute for actor_id when '
  'an account exists.';
comment on column public.stock_movement.actor_source is
  'How the actor was established. server_session = derived from auth.uid(), a '
  'record the caller could not influence. client_attested = supplied by an '
  'authenticated client (PowerSync uploads run as powersync_role with no '
  'auth.uid(), so they can only be attested). import = script or migration.';

-- Verify by query, not by the editor's success message:
--   select column_name, data_type from information_schema.columns
--    where table_name = 'stock_movement' and column_name like 'actor%';
--   -- expect actor_id uuid, actor_label text, actor_source text
