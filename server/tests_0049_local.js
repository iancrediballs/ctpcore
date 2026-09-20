// 0049 on PGlite: the shelf cannot go below zero. Over-issue refused with a counter-person message;
// a legitimate issue passes; an already-negative row (the Grille) can be corrected upward but not
// pushed further down; reservations past zero still pass (they are AVAILABLE, not the shelf);
// fulfil_order's own shelf check still fires first; the whole 0046-0048 flow still runs.
const { PGlite } = require("@electric-sql/pglite"); const { pg_trgm } = require("@electric-sql/pglite/contrib/pg_trgm");
const fs = require("fs"); const path = require("path"); const SRV = __dirname;
const res = []; const check = (n, ok, d) => { res.push(ok); console.log((ok ? "PASS " : "FAIL ") + n + (d !== undefined ? "  — " + d : "")); };
(async () => {
  const db = new PGlite({ extensions: { pg_trgm } }); const q = async (s, p) => (await db.query(s, p)).rows; const exec = (s) => db.exec(s);
  const fails = async (s, p) => { try { await db.query(s, p); return null; } catch (e) { return e; } };
  await exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin; create schema auth; create schema extensions;
    create table auth.users (id uuid primary key, email text); create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('ctp.uid', true), '')::uuid $$;`);
  for (const f of ["schema.postgres.sql","rls.sql","0014_powersync_b1_delta.sql","0015_data_api_grants.sql","0020_client_requests.sql","0021_client_quote_response.sql","0022_staff_quoting.sql","0028_settings_backbone.sql","0031_company_app_url.sql","0033_company_profile_no_silent_blanking.sql","0034_rev_triggers.sql","0035_actor_identity_columns.sql","0036_client_uuid_idempotency.sql","0037_actor_source_local_session.sql","0039_purchasing.sql","0041_pricing_guard.sql","0042_fulfil_invoice.sql","0043_prefix_settings.sql","0045_invoice_guard.sql","0046_proforma_payment.sql","0047_reservations.sql","0048_hold_clocks.sql"]) {
    try { await exec(fs.readFileSync(path.join(SRV, f), "utf8")); } catch (e) { console.log("LOAD ERROR " + f + ": " + e.message); process.exit(2); } }
  const STAFF = "11111111-1111-1111-1111-111111111111", CUST = "22222222-2222-2222-2222-222222222222";
  // The Grille is at -1 BEFORE the guard lands, as it is live.
  await exec(`insert into company (id,name,currency,invoice_prefix,quote_prefix,default_tax_bps) values (1,'T','ZAR','','QT-',1500) on conflict (id) do update set invoice_prefix='';
    insert into location (id,code,name) values (10,'WH','Warehouse'),(11,'VAN','Van'); insert into category (id,code,name,path) values (1,'X','X','X');
    insert into part (id,sku,name,category_id) values (1,'A','Part A',1),(1072,'CTP-FWL-013-C','Radiator Grille',1);
    insert into price (part_id,tier,currency,amount_minor) values (1,'list','ZAR',10000),(1072,'list','ZAR',5000);
    insert into app_user (id,role,display_name) values ('${STAFF}','admin','Ian'),('${CUST}','customer','Cust'); insert into auth.users (id,email) values ('${STAFF}','ian@x');
    insert into customer (id,code,name,auth_user_id) values (1,'C','Cust','${CUST}');
    insert into stock_movement (part_id,location_id,delta,reason,client_uuid) values (1,10,5,'receipt','r1'),(1072,10,-1,'sale','grille-oversold');`);
  try { await exec(fs.readFileSync(path.join(SRV, "0049_stock_guard.sql"), "utf8")); } catch (e) { console.log("LOAD ERROR 0049: " + e.message); process.exit(2); }
  const pos = async (pid, loc = 10) => (await q("select on_hand, reserved, available from stock_position where part_id=$1 and location_id=$2", [pid, loc]))[0] ?? { on_hand: 0, reserved: 0, available: 0 };
  const mv = (pid, loc, d, reason, key) => fails("insert into stock_movement (part_id,location_id,delta,reason,client_uuid) values ($1,$2,$3,$4,$5)", [pid, loc, d, reason, key]);
  // 1. over-issue refused, message for the counter, SQLSTATE CT001
  let e = await mv(1, 10, -6, "sale", "k1");
  check("issuing 6 of A with 5 on the shelf is refused", !!e);
  check("...with a message a counter person reads: Cannot take 6 x Part A out of Warehouse: only 5 on the shelf", /Cannot take 6 × Part A out of Warehouse: only 5 on the shelf/.test(e?.message || ""), e?.message);
  check("...and SQLSTATE CT001 so the sync layer can stop retrying it", e?.code === "CT001", e?.code);
  check("nothing was written", (await pos(1)).on_hand === 5);
  // 2. legitimate issue passes; exactly to zero passes
  e = await mv(1, 10, -3, "sale", "k2"); check("issuing 3 of 5 passes", e === null && (await pos(1)).on_hand === 2, e?.message);
  e = await mv(1, 10, -2, "sale", "k3"); check("issuing the last 2 (to exactly zero) passes", e === null && (await pos(1)).on_hand === 0, e?.message);
  e = await mv(1, 10, -1, "sale", "k4"); check("one more is refused: only 0 on the shelf", /only 0 on the shelf/.test(e?.message || ""), e?.message);
  // 3. the Grille: already -1; upward correction passes; further downward refused; history untouched
  check("the Grille starts at -1 (pre-existing, untouched by the migration)", (await pos(1072)).on_hand === -1);
  e = await mv(1072, 10, -1, "sale", "g1"); check("selling another Grille is refused (would be -2)", /Cannot take 1 × Radiator Grille out of Warehouse/.test(e?.message || ""), e?.message);
  e = await mv(1072, 10, 1, "adjustment", "g2"); check("a +1 adjustment brings the Grille to 0 and passes", e === null && (await pos(1072)).on_hand === 0, e?.message);
  e = await mv(1072, 10, 3, "receipt", "g3"); check("a receipt of 3 passes: on hand 3", e === null && (await pos(1072)).on_hand === 3);
  const hist = await q("select count(*)::int n from stock_movement where client_uuid='grille-oversold'"); check("the original oversold row is still in the ledger", hist[0].n === 1);
  // 4. a transfer out of a location that does not have it is refused; a transfer of what is there passes
  e = await mv(1072, 11, -1, "transfer", "t1"); check("transfer out of the Van (has none) refused: out of Van: only 0", /out of Van: only 0 on the shelf/.test(e?.message || ""), e?.message);
  e = await mv(1072, 10, -2, "transfer", "t2"); const e2 = await mv(1072, 11, 2, "transfer", "t3");
  check("transfer 2 WH -> Van passes both legs: WH 1, Van 2", e === null && e2 === null && (await pos(1072)).on_hand === 1 && (await pos(1072, 11)).on_hand === 2);
  // 5. reservations are not the shelf: accepting a quote for MORE than is on the shelf still reserves (backorder visible)
  const as = (u) => exec(`select set_config('ctp.uid','${u}',false)`);
  await as(CUST); const o1 = (await q(`select request_parts('[{"part_id":1072,"qty":5}]'::jsonb, null) r`))[0].r.order_id;
  await as(STAFF); await exec(`select fill_quote_from_list(${o1})`); await as(CUST); const acc = (await q(`select respond_to_quote(${o1}, true) r`))[0].r;
  let g = await pos(1072); check("accepting 5 Grilles with 1 on the shelf reserves 5: on_hand 1, reserved 5, available -4 - not refused", acc.reserved_lines === 1 && g.on_hand === 1 && g.reserved === 5 && g.available === -4, JSON.stringify(g));
  // 6. fulfil: its own shelf check fires first (the message it always had); after a receipt the sale passes the guard
  await as(STAFF); await exec(`select record_payment(${o1}, 'P1')`);
  e = await fails(`select fulfil_order(${o1})`); check("fulfil refused by fulfil_order's own check: need 5, on hand 1", /need 5, on hand 1/.test(e?.message || ""), e?.message);
  await as(""); await mv(1072, 10, 4, "receipt", "g4"); await as(STAFF);
  const ful = (await q(`select fulfil_order(${o1}) r`))[0].r; g = await pos(1072);
  check("after a receipt of 4, fulfil passes the guard: release + sale; on_hand 0, reserved 0", ful.movements === 1 && g.on_hand === 0 && g.reserved === 0 && g.available === 0, JSON.stringify(g));
  // 7. the sweeper's release on an expired unpaid order is a positive movement - never blocked
  await as(CUST); const o2 = (await q(`select request_parts('[{"part_id":1,"qty":1}]'::jsonb, null) r`))[0].r.order_id;
  await as(STAFF); await exec(`select fill_quote_from_list(${o2})`); await as(CUST); await exec(`select respond_to_quote(${o2}, true)`);
  await exec(`update sales_order set proforma_issued_at = now() - interval '8 days' where id=${o2}`); await as(STAFF);
  const run = (await q("select run_hold_clocks() r"))[0].r; check("the sweeper released the expired hold through the guard", run.expired === 1 && (await pos(1)).reserved === 0);
  const n = res.filter(Boolean).length; console.log(`\n${n}/${res.length} passed`); process.exit(n === res.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(3); });
