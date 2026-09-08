-- ============================================================================
--  CTP Core — `rev` BECOMES ONE MECHANISM (migration 0018)
--
--  Until now `rev` was maintained by hand in ten written-out UPDATE statements
--  in main.rs, in some cloud RPCs and not others, and not at all in
--  fill_quote_from_list — which is why 21 of 58 cloud sales_line rows were
--  edited without ever being counted. The blueprint schema/core.sql had nine
--  `_touch` triggers expressing exactly this intent; they survived neither the
--  Postgres port nor the SQLite one. This restores them, widened to all 18
--  tables here that carry the column.
--
--  WHY THE DATABASE AND NOT THE APPLICATION
--  On the cloud the argument is decisive: PowerSync uploads execute NO
--  application code — a device's writes arrive as plain PostgREST calls running
--  as powersync_role, with no RPC and no Rust in the path. An application-level
--  scheme cannot cover the one write path `rev` exists to serve. A trigger can.
--  The desktop has no PowerSync writer today, so here the trigger buys
--  consistency rather than coverage: ONE mechanism across both databases, which
--  is the point. Cloud gets the same rule in its migration 0034.
--
--  WHAT THIS DOES NOT FIX — do not mistake the trigger for a repair
--  Rows whose rev is already wrong stay wrong, on purpose. Bumping them
--  recovers nothing and would make every row look freshly modified to the first
--  reconciliation. And a desktop row and a cloud row BOTH at rev = 1 with
--  different content is unresolvable by rev BY DEFINITION: the counter cannot
--  tell "never edited" from "edited without being counted". The one-time
--  desktop/cloud reconciliation must therefore be CONTENT-BASED, not rev-based.
--  rev is trustworthy only for changes made after this migration ran.
--
--  THE GUARD, AND WHY IT IS WRITTEN THIS WAY
--  SQLite cannot assign to NEW in a BEFORE trigger, so this is AFTER UPDATE
--  plus a second UPDATE. `WHEN NEW.rev = OLD.rev` makes that terminate: the
--  inner UPDATE changes rev, so on re-entry the guard is false and it stops.
--  Proven against a live schema with PRAGMA recursive_triggers set to BOTH 0
--  AND 1 — it terminates either way, so the pragma's default is NOT
--  load-bearing and a connection that flips it cannot cause a loop.
--  The guard has a second job: an UPDATE that sets rev explicitly is left
--  alone rather than double-counted, which is what a sync-applied row needs.
--
--  KNOWN COST, measured not assumed: `part` and `part_xref` carry FTS
--  maintenance triggers (part_au, xref_au). Those now fire TWICE per update —
--  once for the caller's write, once for the rev write. The rebuild is
--  idempotent so the result is identical; it is duplicated work, not a wrong
--  answer, and at 161 parts it is not measurable. Noted so nobody rediscovers
--  it as a mystery.
--
--  Paired with the removal of all ten hand-written `rev = rev + 1` sites from
--  main.rs IN THE SAME COMMIT. A window where both the trigger and the old code
--  fire would double-increment silently, which is worse than today's
--  inconsistency because it looks exactly like legitimate concurrent edits.
--
--  Idempotent: every trigger is dropped before being created.
-- ============================================================================

DROP TRIGGER IF EXISTS brand_touch_rev;
CREATE TRIGGER brand_touch_rev AFTER UPDATE ON brand WHEN NEW.rev = OLD.rev
BEGIN UPDATE brand SET rev = OLD.rev + 1, updated_at = datetime('now') WHERE rowid = NEW.rowid; END;

DROP TRIGGER IF EXISTS category_touch_rev;
CREATE TRIGGER category_touch_rev AFTER UPDATE ON category WHEN NEW.rev = OLD.rev
BEGIN UPDATE category SET rev = OLD.rev + 1, updated_at = datetime('now') WHERE rowid = NEW.rowid; END;

DROP TRIGGER IF EXISTS company_touch_rev;
CREATE TRIGGER company_touch_rev AFTER UPDATE ON company WHEN NEW.rev = OLD.rev
BEGIN UPDATE company SET rev = OLD.rev + 1, updated_at = datetime('now') WHERE rowid = NEW.rowid; END;

DROP TRIGGER IF EXISTS customer_touch_rev;
CREATE TRIGGER customer_touch_rev AFTER UPDATE ON customer WHEN NEW.rev = OLD.rev
BEGIN UPDATE customer SET rev = OLD.rev + 1, updated_at = datetime('now') WHERE rowid = NEW.rowid; END;

DROP TRIGGER IF EXISTS diagram_touch_rev;
CREATE TRIGGER diagram_touch_rev AFTER UPDATE ON diagram WHEN NEW.rev = OLD.rev
BEGIN UPDATE diagram SET rev = OLD.rev + 1, updated_at = datetime('now') WHERE rowid = NEW.rowid; END;

DROP TRIGGER IF EXISTS hotspot_touch_rev;
CREATE TRIGGER hotspot_touch_rev AFTER UPDATE ON hotspot WHEN NEW.rev = OLD.rev
BEGIN UPDATE hotspot SET rev = OLD.rev + 1, updated_at = datetime('now') WHERE rowid = NEW.rowid; END;

DROP TRIGGER IF EXISTS location_touch_rev;
CREATE TRIGGER location_touch_rev AFTER UPDATE ON location WHEN NEW.rev = OLD.rev
BEGIN UPDATE location SET rev = OLD.rev + 1, updated_at = datetime('now') WHERE rowid = NEW.rowid; END;

DROP TRIGGER IF EXISTS part_touch_rev;
CREATE TRIGGER part_touch_rev AFTER UPDATE ON part WHEN NEW.rev = OLD.rev
BEGIN UPDATE part SET rev = OLD.rev + 1, updated_at = datetime('now') WHERE rowid = NEW.rowid; END;

DROP TRIGGER IF EXISTS part_diagram_callout_touch_rev;
CREATE TRIGGER part_diagram_callout_touch_rev AFTER UPDATE ON part_diagram_callout WHEN NEW.rev = OLD.rev
BEGIN UPDATE part_diagram_callout SET rev = OLD.rev + 1, updated_at = datetime('now') WHERE rowid = NEW.rowid; END;

DROP TRIGGER IF EXISTS part_fitment_touch_rev;
CREATE TRIGGER part_fitment_touch_rev AFTER UPDATE ON part_fitment WHEN NEW.rev = OLD.rev
BEGIN UPDATE part_fitment SET rev = OLD.rev + 1, updated_at = datetime('now') WHERE rowid = NEW.rowid; END;

DROP TRIGGER IF EXISTS part_image_touch_rev;
CREATE TRIGGER part_image_touch_rev AFTER UPDATE ON part_image WHEN NEW.rev = OLD.rev
BEGIN UPDATE part_image SET rev = OLD.rev + 1, updated_at = datetime('now') WHERE rowid = NEW.rowid; END;

DROP TRIGGER IF EXISTS part_model_touch_rev;
CREATE TRIGGER part_model_touch_rev AFTER UPDATE ON part_model WHEN NEW.rev = OLD.rev
BEGIN UPDATE part_model SET rev = OLD.rev + 1, updated_at = datetime('now') WHERE rowid = NEW.rowid; END;

DROP TRIGGER IF EXISTS part_xref_touch_rev;
CREATE TRIGGER part_xref_touch_rev AFTER UPDATE ON part_xref WHEN NEW.rev = OLD.rev
BEGIN UPDATE part_xref SET rev = OLD.rev + 1, updated_at = datetime('now') WHERE rowid = NEW.rowid; END;

DROP TRIGGER IF EXISTS price_touch_rev;
CREATE TRIGGER price_touch_rev AFTER UPDATE ON price WHEN NEW.rev = OLD.rev
BEGIN UPDATE price SET rev = OLD.rev + 1, updated_at = datetime('now') WHERE rowid = NEW.rowid; END;

DROP TRIGGER IF EXISTS sales_line_touch_rev;
CREATE TRIGGER sales_line_touch_rev AFTER UPDATE ON sales_line WHEN NEW.rev = OLD.rev
BEGIN UPDATE sales_line SET rev = OLD.rev + 1, updated_at = datetime('now') WHERE rowid = NEW.rowid; END;

DROP TRIGGER IF EXISTS sales_order_touch_rev;
CREATE TRIGGER sales_order_touch_rev AFTER UPDATE ON sales_order WHEN NEW.rev = OLD.rev
BEGIN UPDATE sales_order SET rev = OLD.rev + 1, updated_at = datetime('now') WHERE rowid = NEW.rowid; END;

DROP TRIGGER IF EXISTS stock_policy_touch_rev;
CREATE TRIGGER stock_policy_touch_rev AFTER UPDATE ON stock_policy WHEN NEW.rev = OLD.rev
BEGIN UPDATE stock_policy SET rev = OLD.rev + 1, updated_at = datetime('now') WHERE rowid = NEW.rowid; END;

DROP TRIGGER IF EXISTS vehicle_model_touch_rev;
CREATE TRIGGER vehicle_model_touch_rev AFTER UPDATE ON vehicle_model WHEN NEW.rev = OLD.rev
BEGIN UPDATE vehicle_model SET rev = OLD.rev + 1, updated_at = datetime('now') WHERE rowid = NEW.rowid; END;
