-- 0037 — a fourth actor_source: `local_session`.
--
-- THE CASE IT NAMES
-- The desktop will queue work while offline. A signed-in operator posts a stock
-- movement at the counter with no connectivity; the row sits in an outbox; it
-- uploads later — possibly after that operator has gone home and somebody else
-- has signed in.
--
-- None of the three existing values tells the truth about that row:
--
--   server_session   would be a lie. The server never saw the acting session;
--                    auth.uid() at upload time belongs to whoever is signed in
--                    NOW, which may be a different person.
--   client_attested  understates it. That value means "a client asserted an
--                    identity" with no guarantee any authentication happened.
--                    Here a real session was verified on the device, at the
--                    moment of the action, against a real account.
--   import           is for scripts and migrations. No human acted.
--
-- So: `local_session` — the identity was established by a verified session ON
-- THE DEVICE at the time of the action, and the server took the device's word
-- for it at upload time.
--
-- The four values now form a plain ladder of how much the actor can be relied
-- on, which is the only question a future reader will ask:
--
--   server_session   the server checked, at the moment of the write.  STRONGEST
--   local_session    a verified device session checked, earlier; the
--                    server accepted it after the fact.
--   client_attested  a client said so. No offline-session guarantee.
--   import           no human actor at all.                           WEAKEST
--
-- NAMED TO OUTLIVE US. `local_session` is deliberately parallel to
-- `server_session` so the pair reads as "where was the session verified" rather
-- than as unrelated labels. Alternatives considered and rejected:
-- `offline_queued` describes the plumbing rather than the trust, and plumbing
-- changes; `deferred` says when, not what; `device_session` invites confusion
-- with device_identity, which is a numbering namespace and explicitly NOT an
-- identity.
--
-- Nothing writes any of these values yet. This is schema, added while
-- stock_movement.actor_source is NULL on every row and the change is free.
--
-- Idempotent: the constraint is dropped and recreated.
-- ============================================================================

alter table public.stock_movement
  drop constraint if exists stock_movement_actor_source_chk;

alter table public.stock_movement
  add constraint stock_movement_actor_source_chk
  check (actor_source is null
         or actor_source in ('server_session','local_session',
                             'client_attested','import'));

comment on column public.stock_movement.actor_source is
  'How the actor was established, strongest first: server_session (derived '
  'from auth.uid() server-side, uninfluenced by the caller); local_session (a '
  'verified session on the device at the time of the action, accepted by the '
  'server afterwards — the offline outbox case); client_attested (a client '
  'said so, no offline-session guarantee — PowerSync uploads run as '
  'powersync_role with no auth.uid() and can be no stronger); import (script '
  'or migration, no human actor).';

-- Verify:
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conname = 'stock_movement_actor_source_chk';
