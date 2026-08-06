-- ============================================================================
--  CTP Core - migration 0015: Data API grants (and the three missing policies)
--
--  THE PROBLEM
--  rls.sql created 41 row-level policies, 23 of which govern writes. Not one of
--  them has ever been consulted. Postgres checks table GRANTs *before* RLS, and
--  the grant list on this database is:
--
--      authenticated  -> SELECT on app_user. That is the entire list.
--      anon           -> nothing
--      service_role   -> nothing
--      powersync_role -> SELECT on all 25 tables  (correct, leave alone)
--
--  So every policy below the grant layer is unreachable code. Reads still look
--  fine because PowerSync replicates as powersync_role and serves the client
--  from its local SQLite - it never goes through PostgREST. Only WRITES cross
--  the Data API, which is why nothing has failed yet: nothing has written yet.
--  The first queued mobile write would have failed with a bare permission
--  denied, nowhere near the policy that appears to allow it.
--
--  ALSO FIXED HERE
--  * part_alias, part_cost and price_tier (created by 0014) have RLS ENABLED
--    and ZERO policies. RLS with no policy denies everything, so these three
--    are unreadable and unwritable by any user no matter what is granted.
--    Policies added below.
--  * The three views (part_detail, stock_on_hand, order_total) run as their
--    owner, which means they would bypass RLS entirely for whoever can select
--    from them. Switched to security_invoker so the caller's policies apply.
--
--  DELIBERATE OMISSIONS
--  * No UPDATE or DELETE on stock_movement. The stock ledger is append-only -
--    that is the architectural decision the whole offline-sync story rests on.
--    A correction is a new compensating movement, never an edited row.
--  * No UPDATE or DELETE on accounting_export. Same reasoning: it is an outbox,
--    and its UNIQUE(order_id,target) is what makes export idempotent.
--  * anon gets INSERT on lead and nothing else. The public catalogue for anon
--    is B2 work: a curated view over safe columns only, never a raw table.
--  * part_cost and price_tier are staff-only, including reads. Landed cost and
--    the margin floor are not customer-visible facts.
--
--  Run this BEFORE 0016_data_catchup.sql.
--  Must be run by Ian in the Supabase SQL editor: role-privilege grants are
--  refused to the agent, correctly.
--  Idempotent: safe to re-run.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Schema usage. Without this the grants below are unusable.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. service_role bypasses RLS and is the identity for server-side jobs.
--    It needs everything; it is never handed to a browser.
-- ---------------------------------------------------------------------------
GRANT ALL ON ALL TABLES    IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- ---------------------------------------------------------------------------
-- 3. authenticated: SELECT everywhere, RLS decides which rows.
--    Every table here has policies; the grant only opens the door.
-- ---------------------------------------------------------------------------
GRANT SELECT ON
  app_user, category, brand, part, part_xref, vehicle_model, part_fitment,
  diagram, part_diagram_callout, part_image, part_model, hotspot,
  price, part_cost, price_tier, part_alias,
  location, stock_movement, stock_policy,
  customer, sales_order, sales_line,
  accounting_export, company, lead
TO authenticated;

-- views (see the security_invoker switch in section 6)
GRANT SELECT ON part_detail, stock_on_hand, order_total TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. authenticated: writes. RLS narrows each of these to staff, manager or
--    the customer's own rows - see rls.sql and section 5 below.
-- ---------------------------------------------------------------------------

-- catalogue and media: staff maintain the parts data
GRANT INSERT, UPDATE, DELETE ON
  category, brand, part, part_xref, vehicle_model, part_fitment,
  diagram, part_diagram_callout, part_image, part_model, hotspot,
  price, part_cost, price_tier, part_alias
TO authenticated;

-- inventory: staff post stock. The ledger takes inserts only.
GRANT INSERT                 ON stock_movement TO authenticated;
GRANT INSERT, UPDATE, DELETE ON stock_policy   TO authenticated;
GRANT INSERT, UPDATE, DELETE ON location       TO authenticated;

-- sales and CRM
GRANT INSERT, UPDATE, DELETE ON customer, sales_order, sales_line TO authenticated;

-- accounting outbox: append only
GRANT INSERT ON accounting_export TO authenticated;

-- letterhead: one row, admin edits it
GRANT UPDATE ON company TO authenticated;

-- leads: staff work them after capture
GRANT INSERT, UPDATE ON lead TO authenticated;

-- app_user: admins manage roles (policy app_user_admin gates this to managers)
GRANT INSERT, UPDATE, DELETE ON app_user TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. anon: the public lead form and nothing else.
--    Policy lead_insert_any already permits it; the grant was missing.
--
--    GOTCHA, verified against a local replica: anon has INSERT but NOT SELECT
--    on lead, and Postgres needs SELECT to evaluate a RETURNING clause. So the
--    public form must insert WITHOUT reading the row back:
--        supabase.from('lead').insert(row)              -- works
--        supabase.from('lead').insert(row).select()     -- permission denied
--    Do not "fix" that by granting anon SELECT on lead; that would publish
--    every captured lead to the internet.
-- ---------------------------------------------------------------------------
GRANT INSERT ON lead TO anon;

-- ---------------------------------------------------------------------------
-- 6. The three tables 0014 created have RLS on and no policies, which denies
--    everything. Give them the same shape as their neighbours.
--
--    part_alias  - Jefrey's learned phrase -> part mappings. Staff read and
--                  write; a customer has no business seeing internal search
--                  training data.
--    part_cost   - landed cost. Staff only, both directions.
--    price_tier  - discount and margin-floor config. Staff read, manager write.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS part_alias_staff ON part_alias;
CREATE POLICY part_alias_staff ON part_alias FOR ALL TO authenticated
  USING (is_staff()) WITH CHECK (is_staff());

DROP POLICY IF EXISTS part_cost_staff ON part_cost;
CREATE POLICY part_cost_staff ON part_cost FOR ALL TO authenticated
  USING (is_staff()) WITH CHECK (is_staff());

DROP POLICY IF EXISTS price_tier_read ON price_tier;
CREATE POLICY price_tier_read ON price_tier FOR SELECT TO authenticated
  USING (is_staff());

DROP POLICY IF EXISTS price_tier_write ON price_tier;
CREATE POLICY price_tier_write ON price_tier FOR ALL TO authenticated
  USING (is_manager()) WITH CHECK (is_manager());

-- ---------------------------------------------------------------------------
-- 7. Views must run as the caller, not as their owner, or selecting from
--    part_detail would hand out every row regardless of policy.
-- ---------------------------------------------------------------------------
ALTER VIEW part_detail   SET (security_invoker = on);
ALTER VIEW stock_on_hand SET (security_invoker = on);
ALTER VIEW order_total   SET (security_invoker = on);

-- ---------------------------------------------------------------------------
-- 8. Anything created later inherits the same shape, so this does not have to
--    be remembered again.
-- ---------------------------------------------------------------------------
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON SEQUENCES TO service_role;

-- ---------------------------------------------------------------------------
-- 9. Verify. Aborts rather than reporting a success that is not one.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  n_sel      INT;
  n_write    INT;
  n_nopolicy INT;
  n_ledger   INT;
BEGIN
  SELECT count(DISTINCT table_name) INTO n_sel
    FROM information_schema.role_table_grants
   WHERE table_schema='public' AND grantee='authenticated' AND privilege_type='SELECT';

  SELECT count(DISTINCT table_name) INTO n_write
    FROM information_schema.role_table_grants
   WHERE table_schema='public' AND grantee='authenticated'
     AND privilege_type IN ('INSERT','UPDATE','DELETE');

  -- RLS on with no policy = a table nobody can touch. There must be none left.
  SELECT count(*) INTO n_nopolicy
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity
     AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid);

  -- the append-only ledger must not be editable through the Data API
  SELECT count(*) INTO n_ledger
    FROM information_schema.role_table_grants
   WHERE table_schema='public' AND grantee='authenticated'
     AND table_name='stock_movement' AND privilege_type IN ('UPDATE','DELETE');

  IF n_sel < 28 THEN
    RAISE EXCEPTION 'authenticated has SELECT on only % relations, expected 28', n_sel;
  END IF;
  IF n_nopolicy > 0 THEN
    RAISE EXCEPTION '% table(s) still have RLS enabled with no policy', n_nopolicy;
  END IF;
  IF n_ledger > 0 THEN
    RAISE EXCEPTION 'stock_movement is editable by authenticated - the ledger must be append-only';
  END IF;

  RAISE NOTICE '0015 OK - authenticated: SELECT on %, writes on %; no policy-less tables; ledger append-only',
               n_sel, n_write;
END $$;

COMMIT;
