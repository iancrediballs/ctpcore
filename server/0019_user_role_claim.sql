-- 0019_user_role_claim.sql — put the user's role INSIDE their login token.
--
-- WHY THIS EXISTS
--   PowerSync replicates as `powersync_role`, which is BYPASSRLS. Every rule in
--   rls.sql and every grant in 0015 governs the Data API only — none of it
--   touches the sync stream. What a device receives is decided solely by which
--   sync stream its token matches. Sync streams can only see JWT claims, not
--   tables. So until the role is a CLAIM, "role-based access" does not exist on
--   any phone, and one customer login would sync landed cost, margin floors and
--   every customer's orders to that customer's device.
--
--   This migration is therefore step 1 of the client portal, and nothing else
--   about client access may ship before it.
--
-- WHAT IT DOES
--   Registers a Supabase Custom Access Token hook: every time a token is
--   issued, Auth calls this function, which looks up public.app_user.role and
--   writes it into the token as the `user_role` claim. server/sync-streams.yaml
--   then gates each stream on auth.parameter('user_role').
--
-- ORDER OF OPERATIONS — READ THIS
--   1. Run this file in the SQL editor.
--   2. Dashboard → Authentication → Hooks → "Customize Access Token (JWT)
--      Claims" → select public.custom_access_token_hook → save/enable.
--   3. Sign out and back in on every device. A token issued BEFORE the hook was
--      enabled has no user_role claim and will keep working off the old token
--      until it expires.
--   4. Confirm the claim is really there (the phone's Info tab prints it), and
--      only THEN deploy the new sync-streams.yaml in PowerSync.
--
--   Do it in that order. The streams fail CLOSED: with no user_role claim they
--   match nothing, so deploying them first would silently stop syncing for
--   everyone, including staff, and it would look like a broken app rather than
--   a missing claim.
--
-- ROLES: is_staff() = sales | warehouse | manager | admin. A customer login
-- gets role 'customer'. A user with no app_user row gets user_role = null and
-- syncs nothing — deliberate: unknown identity, no data.

BEGIN;

CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  claims jsonb;
  v_role text;
BEGIN
  SELECT au.role INTO v_role
    FROM public.app_user au
   WHERE au.id = (event->>'user_id')::uuid;

  claims := event->'claims';

  IF v_role IS NOT NULL THEN
    claims := jsonb_set(claims, '{user_role}', to_jsonb(v_role));
  ELSE
    -- Explicit null rather than an absent key: a stream comparing against a
    -- missing claim and a stream comparing against null behave the same here,
    -- but the token then SHOWS that the user has no role, which is far easier
    -- to diagnose than a claim that quietly isn't there.
    claims := jsonb_set(claims, '{user_role}', 'null');
  END IF;

  event := jsonb_set(event, '{claims}', claims);
  RETURN event;
END;
$$;

-- Auth runs the hook as `supabase_auth_admin`, a role that by default cannot
-- see the public schema at all.
GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) TO supabase_auth_admin;

-- Nobody else may run it: the function reads roles, and an anon-callable
-- endpoint that reports "what role does this user id have?" is an enumeration
-- oracle. (Same class of mistake 0017 fixes for the RLS helpers.)
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) FROM authenticated, anon, public;

-- The hook needs to READ app_user. SELECT only — the documented example grants
-- ALL, which would let the auth admin rewrite roles; it never needs to.
GRANT SELECT ON TABLE public.app_user TO supabase_auth_admin;

-- app_user has RLS on (policies app_user_self, app_user_admin), so a grant
-- alone still returns zero rows to the hook. This policy is SELECT-only and
-- scoped to that one role.
--
-- NOTE what is deliberately NOT here: the documented example also revokes
-- app_user from `authenticated`. Do not — AuthProvider.tsx reads its own row
-- through the Data API to show the signed-in user's role, and revoking would
-- break the app while looking like an auth bug.
DROP POLICY IF EXISTS app_user_auth_admin_read ON public.app_user;
CREATE POLICY app_user_auth_admin_read ON public.app_user
  AS PERMISSIVE FOR SELECT
  TO supabase_auth_admin
  USING (true);

COMMIT;

-- ── verify (run separately; both should return a row) ───────────────────────
--
-- 1. the hook can see the roles it is supposed to see:
--      SELECT id, role FROM public.app_user;
--
-- 2. the function exists and only the auth admin may execute it:
--      SELECT p.proname,
--             has_function_privilege('supabase_auth_admin', p.oid, 'EXECUTE') AS auth_admin,
--             has_function_privilege('authenticated',       p.oid, 'EXECUTE') AS authenticated,
--             has_function_privilege('anon',                p.oid, 'EXECUTE') AS anon
--        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--       WHERE n.nspname = 'public' AND p.proname = 'custom_access_token_hook';
--    Expect auth_admin = true, authenticated = false, anon = false.
--
-- 3. after enabling the hook in the dashboard AND signing out/in, the phone's
--    Info tab shows "Access level: admin". If it shows "not in your token",
--    the hook is not enabled or the session predates it.
