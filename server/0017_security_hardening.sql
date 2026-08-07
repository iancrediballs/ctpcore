-- ============================================================================
--  CTP Core - migration 0017: close the advisor warnings on the RLS helpers
--
--  None of these is caused by 0015. They have been there since rls.sql went in
--  on 2026-06-30; the advisor only started reporting some of them once the
--  Data API roles actually had grants to speak of. `get_advisors(security)`
--  reports no ERRORs - these are all WARN.
--
--  WHAT IS ACTUALLY WRONG
--
--  1. Every RLS policy on this database routes through is_staff() or
--     is_manager(), which call auth_role(), which is SECURITY DEFINER (it must
--     be - it reads app_user, which is itself RLS-protected). auth_role() pins
--     its search_path. is_staff() and is_manager() do not. A function with a
--     mutable search_path that sits in the call path of every policy is the
--     textbook shape of a privilege-escalation bug: whoever can influence
--     search_path chooses which `auth_role` gets called.
--
--  2. auth_role(), my_customer_id(), is_staff(), is_manager() and
--     rls_auto_enable() are all reachable as anonymous RPC endpoints
--     (/rest/v1/rpc/<name>) because Postgres grants EXECUTE to PUBLIC by
--     default. auth_role() and my_customer_id() return NULL for anon, so
--     nothing leaks today - but they are SECURITY DEFINER functions on the
--     public internet, and rls_auto_enable() is an event-trigger body that has
--     no business being callable at all.
--
--  NOT DONE HERE, ON PURPOSE
--  * pg_trgm lives in `public`. Moving it means rebuilding the gin_trgm_ops
--    index on part, and the win is cosmetic. See the commented block at the end
--    - do it during a quiet window, not as part of a security patch.
--  * Leaked-password protection (HaveIBeenPwned) is a dashboard toggle, not
--    SQL: Authentication -> Providers -> Email -> "Prevent use of leaked
--    passwords". Worth turning on before real staff accounts exist.
--
--  Idempotent: safe to re-run.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Pin search_path on the two helpers every policy depends on.
--    STABLE + SECURITY INVOKER is already correct; only the path was loose.
-- ---------------------------------------------------------------------------
ALTER FUNCTION public.is_staff()   SET search_path = public, pg_temp;
ALTER FUNCTION public.is_manager() SET search_path = public, pg_temp;

-- ---------------------------------------------------------------------------
-- 2. Stop publishing the helpers as anonymous RPC endpoints.
--
--    REVOKE FROM PUBLIC removes the default grant that every role inherits,
--    then EXECUTE is handed back only to the roles that genuinely evaluate
--    policies. `authenticated` is the one that matters: RLS on every table
--    calls is_staff()/is_manager() as that role, so revoking it would lock the
--    whole database out. service_role and postgres bypass RLS but are granted
--    anyway so server-side code and the dashboard keep working.
--
--    powersync_role is deliberately NOT granted: it is BYPASSRLS, so it never
--    evaluates a policy and never calls these.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.auth_role()      FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.my_customer_id() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_staff()       FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_manager()     FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.auth_role()      TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.my_customer_id() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_staff()       TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_manager()     TO authenticated, service_role;

-- rls_auto_enable() is the body of an event trigger (Supabase's "automatic RLS"
-- setting). Event triggers fire in their own privileged context; nothing should
-- ever call this over HTTP.
DO $$
BEGIN
  IF to_regprocedure('public.rls_auto_enable()') IS NOT NULL THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Verify. The critical check is that authenticated can STILL execute the
--    helpers - if this migration broke that, every policy on every table would
--    start denying and the app would look like a total outage.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  anon_can  INT;
  auth_can  INT;
  unpinned  INT;
BEGIN
  SELECT count(*) INTO anon_can
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('auth_role','my_customer_id','is_staff','is_manager','rls_auto_enable')
     AND has_function_privilege('anon', p.oid, 'EXECUTE');

  SELECT count(*) INTO auth_can
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('auth_role','my_customer_id','is_staff','is_manager')
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE');

  SELECT count(*) INTO unpinned
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('auth_role','my_customer_id','is_staff','is_manager')
     AND (p.proconfig IS NULL
          OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg
                          WHERE cfg LIKE 'search\_path=%'));

  IF anon_can > 0 THEN
    RAISE EXCEPTION 'anon can still execute % helper function(s)', anon_can;
  END IF;
  IF auth_can <> 4 THEN
    RAISE EXCEPTION 'authenticated can execute only % of 4 helpers - RLS would deny everywhere', auth_can;
  END IF;
  IF unpinned > 0 THEN
    RAISE EXCEPTION '% helper(s) still have a mutable search_path', unpinned;
  END IF;

  RAISE NOTICE '0017 OK - helpers pinned, anon locked out, authenticated intact';
END $$;

COMMIT;

-- ============================================================================
--  OPTIONAL, NOT RUN ABOVE: move pg_trgm out of the public schema.
--
--  The lint is real but low value here, and the move is not free: the trigram
--  index on part references gin_trgm_ops, so the operator class has to stay
--  resolvable. Test on a copy before running this against production, and
--  expect the index rebuild to take a moment.
--
--    CREATE SCHEMA IF NOT EXISTS extensions;
--    GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
--    ALTER EXTENSION pg_trgm SET SCHEMA extensions;
--    -- then confirm the index still exists and is used:
--    --   \d+ part
--    --   EXPLAIN SELECT 1 FROM part WHERE name ILIKE '%bumper%';
-- ============================================================================
