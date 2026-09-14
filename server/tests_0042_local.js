// Local proof of 0042 on a throwaway WASM Postgres (PGlite 17.5): the repo's
// own schema files, Supabase's auth/roles stubbed, seed data made for the
// purpose. Nothing here touches the live project.
const { PGlite } = require("@electric-sql/pglite");
const { pg_trgm } = require("@electric-sql/pglite/contrib/pg_trgm");
const fs = require("fs");
const path = require("path");
const SRV = __dirname; // run from the repo: node server/tests_0042_local.js (needs: npm i @electric-sql/pglite)

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log((ok ? "PASS " : "FAIL ") + name + (detail ? "  — " + detail : "")); };

(async () => {
  const db = new PGlite({ extensions: { pg_trgm } });
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const exec = (sql) => db.exec(sql);
  const fails = async (sql, params) => { try { await db.query(sql, params); return null; } catch (e) { return e.message; } };

  // ── Supabase stand-ins ────────────────────────────────────────────────────
  await exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create schema auth; create schema extensions;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('ctp.uid', true), '')::uuid $$;
  `);

  // ── the repo's schema, in order ───────────────────────────────────────────
  const files = ["schema.postgres.sql", "rls.sql", "0014_powersync_b1_delta.sql", "0015_data_api_grants.sql", "0020_client_requests.sql",
    "0021_client_quote_response.sql", "0022_staff_quoting.sql", "0028_settings_backbone.sql", "0031_company_app_url.sql", "0033_company_profile_no_silent_blanking.sql",
    "0034_rev_triggers.sql", "0035_actor_identity_columns.sql", "0036_client_uuid_idempotency.sql",
    "0037_actor_source_local_session.sql", "0042_fulfil_invoice.sql", "0043_prefix_settings.sql"];
  for (const f of files) {
    const sql = fs.readFileSync(path.join(SRV, f), "utf8");
    try { await exec(sql); console.log("loaded " + f); }
    catch (e) { console.log("LOAD ERROR in " + f + ": " + e.message); process.exit(2); }
  }

  // ── seed ──────────────────────────────────────────────────────────────────
  const STAFF = "11111111-1111-1111-1111-111111111111";
  const CUST = "22222222-2222-2222-2222-222222222222";
  const NOBODY = "33333333-3333-3333-3333-333333333333";
  const ADMIN = "44444444-4444-4444-4444-444444444444";
  await exec(`
    insert into company (id, name, currency, invoice_prefix, quote_prefix, default_tax_bps) values (1, 'Test Co', 'ZAR', '', 'QT-', 1500)
      on conflict (id) do update set invoice_prefix = '', default_tax_bps = 1500;
    insert into location (id, code, name) values (10, 'WH', 'Main Warehouse');
    insert into category (id, code, name, path) values (1, 'TST', 'Test', 'Test');
    insert into part (id, sku, name, category_id) values (1, 'T-A', 'Part A', 1), (2, 'T-B', 'Part B', 1);
    insert into stock_movement (part_id, location_id, delta, reason, client_uuid) values
      (1, 10, 5, 'receipt', 'seed-a'), (2, 10, 1, 'receipt', 'seed-b');
    insert into app_user (id, role, display_name) values ('${STAFF}', 'warehouse', 'Staff'), ('${NOBODY}', 'customer', 'Nobody'), ('${ADMIN}', 'admin', 'Admin');
    insert into customer (id, code, name, auth_user_id) values (1, 'TESTC', 'Test Customer', '${CUST}');
    insert into app_user (id, role, display_name) values ('${CUST}', 'customer', 'Cust');
    -- orders in each state. O1: fulfil + invoice happy path. O2: short. O3/O4: mutual reservation. O5: quote. O6: empty.
    -- accepted in the order O1, O3, O4, O2 (O2 is the oversold one, last in the queue)
    insert into sales_order (id, number, customer_id, location_id, status, currency, tax_rate_bps, client_responded_at) values
      (1, 'RQ-1', 1, 10, 'confirmed', 'ZAR', 1500, now() - interval '4 min'),
      (2, 'RQ-2', 1, 10, 'confirmed', 'ZAR', 1500, now() - interval '1 min'),
      (3, 'RQ-3', 1, 10, 'confirmed', 'ZAR', 1500, now() - interval '3 min'),
      (4, 'RQ-4', 1, 10, 'confirmed', 'ZAR', 1500, now() - interval '2 min'),
      (5, 'RQ-5', 1, 10, 'quote', 'ZAR', 1500, null),
      (6, 'RQ-6', 1, 10, 'confirmed', 'ZAR', 1500, now());
    insert into sales_line (order_id, part_id, qty, unit_price_minor) values
      (1, 1, 2, 1000), (1, 2, 1, 2000),
      (2, 1, 10, 1000),
      (3, 1, 3, 1000),
      (4, 1, 2, 1000),
      (5, 1, 1, 1000);
    select setval(pg_get_serial_sequence('sales_order','id'), 100);
    select setval(pg_get_serial_sequence('sales_line','id'), 100);
  `);
  const onhand = async (p) => (await q("select coalesce(sum(delta),0)::int n from stock_movement where part_id=$1 and location_id=10", [p]))[0].n;
  const moves = async () => (await q("select count(*)::int n from stock_movement where reason='sale'"))[0].n;
  const order = async (id) => (await q("select status, fulfilled_at, invoice_no, invoiced_at from sales_order where id=$1", [id]))[0];
  const asUser = (uid) => exec(`select set_config('ctp.uid', '${uid}', false)`);

  // ── 1. anon and non-staff are blocked ─────────────────────────────────────
  await exec("set role anon");
  let err = await fails("select fulfil_order(1)");
  check("anon cannot call fulfil_order", /permission denied/i.test(err || ""), err);
  err = await fails("select invoice_order(1)");
  check("anon cannot call invoice_order", /permission denied/i.test(err || ""), err);
  await exec("reset role");
  await asUser(NOBODY);
  err = await fails("select fulfil_order(1)");
  check("a signed-in non-staff user is refused", /Only staff/i.test(err || ""), err);
  await asUser(STAFF);

  // ── 2. shortfall refuses and writes nothing ──────────────────────────────
  const before = await moves();
  err = await fails("select fulfil_order(2)");
  check("short order refused with the shortfall named (5 on hand, 7 promised ahead of it → 0)", /Not enough stock.*T-A: need 10, available 0$/.test(err || ""), err);
  check("…and nothing was written", (await moves()) === before && (await order(2)).status === "confirmed");

  // ── 3. happy path, then the double tap ───────────────────────────────────
  let r = (await q("select fulfil_order(1) r"))[0].r;
  check("fulfil writes one sale movement per line", r.movements === 2 && r.already === false && (await order(1)).status === "fulfilled", JSON.stringify(r));
  check("on hand fell by the line quantities", (await onhand(1)) === 3 && (await onhand(2)) === 0);
  const after = await moves();
  r = (await q("select fulfil_order(1) r"))[0].r;
  check("double tap: already=true, zero movements", r.already === true && r.movements === 0 && (await moves()) === after, JSON.stringify(r));
  const uuids = await q("select client_uuid from stock_movement where reason='sale' order by 1");
  check("movement client_uuids follow so-<order>-line-<line>", uuids.every((u) => /^so-1-line-\d+$/.test(u.client_uuid)), JSON.stringify(uuids));
  const actor = await q("select actor_id, actor_source, origin, ref_type, ref_id from stock_movement where reason='sale' limit 1");
  check("movement carries actor_id/server_session/ref", actor[0].actor_id === STAFF && actor[0].actor_source === "server_session" && actor[0].ref_type === "sales_order" && Number(actor[0].ref_id) === 1, JSON.stringify(actor[0]));

  // ── 4. reservations: two accepted orders promising the same units ────────
  err = await fails("select fulfil_order(4)");
  check("O4 (accepted later, needs 2) refused: 3 on hand minus 3 promised to O3", /T-A: need 2, available 0/.test(err || ""), err);
  r = (await q("select fulfil_order(3) r"))[0].r;
  check("O3 (accepted first, needs 3) fulfils against the 3 on hand", r.movements === 1 && (await onhand(1)) === 0, JSON.stringify(r));
  err = await fails("select fulfil_order(4)");
  check("O4 still refused afterwards: need 2, available 0", /T-A: need 2, available 0/.test(err || ""), err);

  // ── 5. invoice: once, and only for fulfilled ─────────────────────────────
  err = await fails("select invoice_order(5)");
  check("quote cannot be invoiced", /fulfil it first/.test(err || ""), err);
  err = await fails("select fulfil_order(5)");
  check("quote cannot be fulfilled", /not accepted/.test(err || ""), err);
  err = await fails("select fulfil_order(6)");
  check("empty order cannot be fulfilled", /no lines/.test(err || ""), err);
  const today = (await q("select to_char((now() at time zone 'Africa/Johannesburg')::date, 'YYMMDD') d"))[0].d;
  r = (await q("select invoice_order(1) r"))[0].r;
  check("invoice number is bare YYMMDD01 with empty prefix", r.invoice_no === today + "01" && r.already === false, JSON.stringify(r));
  const r2 = (await q("select invoice_order(1) r"))[0].r;
  check("invoicing again returns the same number", r2.invoice_no === r.invoice_no && r2.already === true, JSON.stringify(r2));
  const o1 = await order(1);
  check("order row: invoiced, number and time stamped", o1.status === "invoiced" && o1.invoice_no === today + "01" && o1.invoiced_at, JSON.stringify(o1));
  const cnt = await q("select day::text, last from invoice_counter");
  check("counter holds one row for today at 1", cnt.length === 1 && cnt[0].last === 1, JSON.stringify(cnt));

  // ── 6. the counter: second of the day, prefix honoured, the 100th ────────
  r = (await q("select invoice_order(3) r"))[0].r;
  check("second invoice today is YYMMDD02", r.invoice_no === today + "02", JSON.stringify(r));
  await exec("update company set invoice_prefix = 'INV-' where id = 1");
  let n = (await q("select next_invoice_no() n"))[0].n;
  check("a prefix, when set, is honoured", n === "INV-" + today + "03", n);
  await exec("update company set invoice_prefix = '' where id = 1");
  await exec("update invoice_counter set last = 99");
  const c99 = await q("select last from invoice_counter");
  n = (await q("select next_invoice_no() n"))[0].n;
  check("the 100th invoice of a day is three digits, no collision", n === today + "100", n + " (counter before: " + JSON.stringify(c99) + ")");
  await exec("update invoice_counter set day = day - 1"); // pretend that was yesterday
  n = (await q("select next_invoice_no() n"))[0].n;
  const days = await q("select day::text, last from invoice_counter order by day");
  check("a new day starts again at 01; yesterday's row untouched", n === today + "01" && days.length === 2 && days[1].last === 1 && days[0].last === 100, n + " " + JSON.stringify(days));
  err = await fails("update sales_order set invoice_no = $1 where id = 2", [today + "01"]);
  check("unique index refuses a duplicate invoice number", /duplicate key|unique/i.test(err || ""), err);

  // ── 7. VAT inherited on a customer request ───────────────────────────────
  await asUser(CUST);
  r = (await q("select request_parts('[{\"part_id\":1,\"qty\":1}]'::jsonb, null) r"))[0].r;
  const tax = (await q("select tax_rate_bps from sales_order where id=$1", [r.order_id]))[0].tax_rate_bps;
  check("a new customer request inherits company.default_tax_bps (1500)", tax === 1500, "tax_rate_bps=" + tax);

  // ── 8. the ledger is append-only for authenticated ───────────────────────
  await exec("set role authenticated");
  err = await fails("update stock_movement set delta = 0 where reason='sale'");
  check("authenticated cannot UPDATE stock_movement", /permission denied/i.test(err || ""), err);
  err = await fails("delete from stock_movement where reason='sale'");
  check("authenticated cannot DELETE stock_movement", /permission denied/i.test(err || ""), err);
  err = await fails("select next_invoice_no()");
  check("authenticated cannot mint a number directly", /permission denied/i.test(err || ""), err);
  await exec("reset role");

  // ── 9. 0043: the prefix settings can be set, cleared and left alone ──────
  await asUser(ADMIN);
  const setp = async (payload) => (await q("select invoice_prefix, quote_prefix from set_company_profile($1::jsonb)", [JSON.stringify(payload)]))[0];
  let sp = await setp({ invoice_prefix: "INV-" });
  check("invoice prefix can be set", sp.invoice_prefix === "INV-", JSON.stringify(sp));
  sp = await setp({ invoice_prefix: "" });
  check("invoice prefix can be CLEARED to '' (was impossible before 0043)", sp.invoice_prefix === "", JSON.stringify(sp));
  sp = await setp({ name: "Test Co" });
  check("a save that does not mention the prefix leaves it alone", sp.invoice_prefix === "" && sp.quote_prefix === "QT-", JSON.stringify(sp));
  sp = await setp({ quote_prefix: "  " });
  check("quote prefix cannot be blanked", sp.quote_prefix === "QT-", JSON.stringify(sp));
  sp = await setp({ quote_prefix: "Q-" });
  check("quote prefix can be changed", sp.quote_prefix === "Q-", JSON.stringify(sp));
  n = (await q("select next_invoice_no() n"))[0].n;
  check("minting after the round trip still yields a bare number", /^\d{8}$/.test(n), n);
  await asUser(STAFF);
  err = await fails("select set_company_profile('{}'::jsonb)");
  check("warehouse staff cannot change company details", /manager or administrator/i.test(err || ""), err);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  fs.writeFileSync(path.join(__dirname, "results.json"), JSON.stringify(results, null, 1));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(3); });
