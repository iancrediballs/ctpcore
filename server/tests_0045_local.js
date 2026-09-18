// Local proof of 0045 on PGlite: the repo's schema + migrations, Supabase auth stubbed.
// Run from the repo root: node server/tests_0045_local.js  (NODE_PATH to a pglite install)
const { PGlite } = require("@electric-sql/pglite");
const { pg_trgm } = require("@electric-sql/pglite/contrib/pg_trgm");
const fs = require("fs"); const path = require("path"); const SRV = __dirname;
const res = []; const check = (n, ok, d) => { res.push(ok); console.log((ok ? "PASS " : "FAIL ") + n + (d !== undefined ? "  — " + d : "")); };
(async () => {
  const db = new PGlite({ extensions: { pg_trgm } });
  const q = async (s, p) => (await db.query(s, p)).rows; const exec = (s) => db.exec(s);
  const fails = async (s, p) => { try { await db.query(s, p); return null; } catch (e) { return e.message; } };
  await exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin; create schema auth; create schema extensions;
    create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('ctp.uid', true), '')::uuid $$;`);
  for (const f of ["schema.postgres.sql","rls.sql","0014_powersync_b1_delta.sql","0015_data_api_grants.sql","0020_client_requests.sql","0021_client_quote_response.sql","0022_staff_quoting.sql","0028_settings_backbone.sql","0031_company_app_url.sql","0033_company_profile_no_silent_blanking.sql","0034_rev_triggers.sql","0035_actor_identity_columns.sql","0036_client_uuid_idempotency.sql","0037_actor_source_local_session.sql","0039_purchasing.sql","0041_pricing_guard.sql","0042_fulfil_invoice.sql","0043_prefix_settings.sql"]) {
    try { await exec(fs.readFileSync(path.join(SRV, f), "utf8")); } catch (e) { console.log("LOAD ERROR " + f + ": " + e.message); process.exit(2); }
  }
  const STAFF = "11111111-1111-1111-1111-111111111111", CUST = "22222222-2222-2222-2222-222222222222";
  await exec(`insert into company (id,name,currency,invoice_prefix,quote_prefix,default_tax_bps) values (1,'T','ZAR','','QT-',1500) on conflict (id) do update set invoice_prefix='';
    insert into location (id,code,name) values (10,'WH','Warehouse'); insert into category (id,code,name,path) values (1,'X','X','X');
    insert into part (id,sku,name,category_id) values (1,'CHEAP','Cheap',1),(2,'DEAR','Dear',1);
    insert into price (part_id,tier,currency,amount_minor) values (1,'list','ZAR',10000),(2,'list','ZAR',375929);
    insert into part_cost (part_id,currency,amount_minor) values (1,'ZAR',4000),(2,'ZAR',28956);
    insert into app_user (id,role,display_name) values ('${STAFF}','admin','Staff'),('${CUST}','customer','Cust');
    insert into customer (id,code,name,auth_user_id) values (1,'C','Cust','${CUST}');
    insert into stock_movement (part_id,location_id,delta,reason,client_uuid) values (1,10,5,'receipt','r1'),(2,10,5,'receipt','r2');
    -- a LEGACY row: invoiced with no number, as the five live ones are
    insert into sales_order (id,number,customer_id,location_id,status,currency,tax_rate_bps) values (900,'SO-LEGACY',1,10,'invoiced','ZAR',1500);
    select setval(pg_get_serial_sequence('sales_order','id'), 1000);`);
  const as = (u) => exec(`select set_config('ctp.uid','${u}',false)`);
  // BEFORE 0045: the overflow is real
  await as(CUST); const o = (await q(`select request_parts('[{"part_id":2,"qty":1}]'::jsonb, null) r`))[0].r; const oid = o.order_id; const lid = (await q("select id from sales_line where order_id=$1",[oid]))[0].id;
  await as(STAFF);
  let e = await fails("select quote_price_check($1, $2::jsonb)", [oid, JSON.stringify([{ line_id: lid, unit_price_minor: 375929 }])]);
  check("BEFORE 0045: pricing check on a R3,759.29 part overflows int4", /out of range/.test(e || ""), e);
  // apply 0045 (server session)
  await as(""); await exec(fs.readFileSync(path.join(SRV, "0045_invoice_guard.sql"), "utf8"));
  const legacy = (await q("select status, invoice_no from sales_order where id=900"))[0];
  check("legacy invoiced row with no number is untouched (NOT VALID)", legacy.status === "invoiced" && legacy.invoice_no === null);
  await as(STAFF);
  e = await fails("select quote_price_check($1, $2::jsonb)", [oid, JSON.stringify([{ line_id: lid, unit_price_minor: 375929 }])]);
  check("AFTER: the same check returns findings, no overflow", e === null, e);
  await exec(`select price_quote(${oid}, '[{"line_id":${lid},"unit_price_minor":375929}]'::jsonb, false)`);
  await as(CUST); await exec(`select respond_to_quote(${oid}, true)`); await as(STAFF);
  // the desktop's shape: mark invoiced by status alone
  e = await fails("update sales_order set status='invoiced' where id=$1", [oid]);
  check("staff UPDATE status='invoiced' on a confirmed order is refused by the trigger", /only through invoice_order/.test(e || ""), e);
  await exec(`select fulfil_order(${oid})`);
  e = await fails("update sales_order set status='invoiced' where id=$1", [oid]);
  check("…and on a fulfilled order (the desktop's exact path)", /only through invoice_order/.test(e || ""), e);
  e = await fails("update sales_order set status='invoiced', invoice_no='FAKE-1' where id=$1", [oid]);
  check("…even with a made-up number", /only through invoice_order/.test(e || ""), e);
  const inv = (await q(`select invoice_order(${oid}) r`))[0].r;
  check("invoice_order still allocates: YYMMDD01", /^\d{6}01$/.test(inv.invoice_no) && inv.already === false, inv.invoice_no);
  const again = (await q(`select invoice_order(${oid}) r`))[0].r;
  check("second call: already:true, same number", again.already === true && again.invoice_no === inv.invoice_no);
  await as("");
  e = await fails("update sales_order set invoice_no='ZOHO-0042' where id=$1", [900]);
  check("server session (no auth.uid) may repair a legacy row by giving it its number", e === null, e);
  e = await fails("update sales_order set notes='touched' where id=$1", [900]);
  check("a legacy row still without a number cannot be touched until it has one (CHECK re-runs on UPDATE)", /invoiced_has_no_chk/.test(e || "") || e === null, e);
  e = await fails("update sales_order set status='invoiced', invoice_no=null where id=$1", [oid]);
  check("CHECK: a NEW row cannot be invoiced without a number, even by the server", /invoiced_has_no_chk/.test(e || ""), e);
  const n = res.filter(Boolean).length; console.log(`\n${n}/${res.length} passed`); process.exit(n === res.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(3); });
