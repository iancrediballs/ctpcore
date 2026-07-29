-- ============================================================================
--  CTP Core — Roles + Row-Level Security (apply AFTER schema.postgres.sql)
--  Defence-in-depth: even a leaked token only reads/writes what its role allows.
--  Built for Supabase (auth.uid() = logged-in user; JWT role = anon|authenticated).
--
--  Read model (B0):
--   * catalogue/reference tables → readable by ANY logged-in user, writable by STAFF
--   * truly-anonymous public catalogue is exposed in B2 via a CURATED view that
--     selects only safe columns (no price / cost / locator / OEM PN) — we do NOT
--     expose raw tables to anon, so nothing leaks by default.
--   * customers see only THEIR OWN customer row + orders.
--   * inventory/accounting are staff-only.
--   * leads can be INSERTed by anyone (public form); only staff read them.
-- ============================================================================

-- ── who is this user? ───────────────────────────────────────────────────────
-- Maps a Supabase auth user to an app role (+ optional customer link for staff
-- creating customer logins is handled in B3).
CREATE TABLE app_user (
  id          UUID PRIMARY KEY,              -- = auth.users.id
  role        TEXT NOT NULL DEFAULT 'customer'
                CHECK (role IN ('customer','sales','warehouse','manager','admin')),
  display_name TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- helpers (SECURITY DEFINER so policies can read app_user without recursion)
CREATE OR REPLACE FUNCTION auth_role() RETURNS TEXT
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT role FROM app_user WHERE id = auth.uid() $$;

CREATE OR REPLACE FUNCTION is_staff() RETURNS BOOLEAN
  LANGUAGE sql STABLE AS
$$ SELECT auth_role() IN ('sales','warehouse','manager','admin') $$;

CREATE OR REPLACE FUNCTION is_manager() RETURNS BOOLEAN
  LANGUAGE sql STABLE AS
$$ SELECT auth_role() IN ('manager','admin') $$;

CREATE OR REPLACE FUNCTION my_customer_id() RETURNS BIGINT
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT id FROM customer WHERE auth_user_id = auth.uid() $$;

-- app_user: a user sees only their own row; admins manage all
ALTER TABLE app_user ENABLE ROW LEVEL SECURITY;
CREATE POLICY app_user_self ON app_user FOR SELECT TO authenticated USING (id = auth.uid() OR is_manager());
CREATE POLICY app_user_admin ON app_user FOR ALL TO authenticated USING (is_manager()) WITH CHECK (is_manager());

-- ── catalogue / reference group: logged-in read, staff write ────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'category','brand','part','part_xref','vehicle_model','part_fitment',
    'diagram','part_diagram_callout','part_image','part_model','hotspot'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format($f$CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (true);$f$,
                   t||'_read', t);
    EXECUTE format($f$CREATE POLICY %I ON %I FOR ALL TO authenticated USING (is_staff()) WITH CHECK (is_staff());$f$,
                   t||'_staff_write', t);
  END LOOP;
END $$;

-- ── price: logged-in read, staff write ──────────────────────────────────────
ALTER TABLE price ENABLE ROW LEVEL SECURITY;
CREATE POLICY price_read ON price FOR SELECT TO authenticated USING (true);
CREATE POLICY price_write ON price FOR ALL TO authenticated USING (is_staff()) WITH CHECK (is_staff());

-- ── inventory: staff only (read + write) ────────────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['location','stock_movement','stock_policy'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format($f$CREATE POLICY %I ON %I FOR ALL TO authenticated USING (is_staff()) WITH CHECK (is_staff());$f$,
                   t||'_staff', t);
  END LOOP;
END $$;

-- ── customers: staff full; a customer sees only their own row ────────────────
ALTER TABLE customer ENABLE ROW LEVEL SECURITY;
CREATE POLICY customer_staff ON customer FOR ALL TO authenticated USING (is_staff()) WITH CHECK (is_staff());
CREATE POLICY customer_self  ON customer FOR SELECT TO authenticated USING (auth_user_id = auth.uid());

-- ── sales: staff full; a customer reads only their own orders/lines ──────────
ALTER TABLE sales_order ENABLE ROW LEVEL SECURITY;
CREATE POLICY so_staff ON sales_order FOR ALL TO authenticated USING (is_staff()) WITH CHECK (is_staff());
CREATE POLICY so_self  ON sales_order FOR SELECT TO authenticated USING (customer_id = my_customer_id());

ALTER TABLE sales_line ENABLE ROW LEVEL SECURITY;
CREATE POLICY sl_staff ON sales_line FOR ALL TO authenticated USING (is_staff()) WITH CHECK (is_staff());
CREATE POLICY sl_self  ON sales_line FOR SELECT TO authenticated
  USING (order_id IN (SELECT id FROM sales_order WHERE customer_id = my_customer_id()));

-- ── accounting outbox: managers/admin only ──────────────────────────────────
ALTER TABLE accounting_export ENABLE ROW LEVEL SECURITY;
CREATE POLICY acct_mgr ON accounting_export FOR ALL TO authenticated USING (is_manager()) WITH CHECK (is_manager());

-- ── company letterhead: logged-in read, admin write ─────────────────────────
ALTER TABLE company ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_read  ON company FOR SELECT TO authenticated USING (true);
CREATE POLICY company_admin ON company FOR ALL TO authenticated USING (is_manager()) WITH CHECK (is_manager());

-- ── leads: ANYONE may submit (public form, incl. anon); only staff may read ──
ALTER TABLE lead ENABLE ROW LEVEL SECURITY;
CREATE POLICY lead_insert_any ON lead FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY lead_staff_read ON lead FOR SELECT TO authenticated USING (is_staff());
CREATE POLICY lead_staff_edit ON lead FOR UPDATE TO authenticated USING (is_staff()) WITH CHECK (is_staff());

-- NOTE (B2): expose a curated PUBLIC catalogue to anon via a view that selects
-- only safe columns (sku, name, category, image, diagram, 3D) — never price,
-- cost, locator, OEM PN, stock. Grant SELECT on that view to anon; keep raw
-- tables authenticated-only as above.
