// 0046 + 0047 on PGlite: the Zoho accept path and the reservations under it.
//   - quote_accept_check names the blockers in the customer's words (unpriced / not in Zoho / status)
//   - a direct respond_to_quote(accept) is refused; decline still works
//   - accept_quote (service role only) stamps the Zoho refs, reserves, is idempotent, refuses a customer session
//   - reservations: on_hand untouched, available down, backorder visible, cancel releases, fulfil = release + sale
//   - the seed mapped parts by SKU and customers by code; integration_issue is staff-readable
const { PGlite } = require("@electric-sql/pglite"); const { pg_trgm } = require("@electric-sql/pglite/contrib/pg_trgm");
const fs = require("fs"); const path = require("path"); const SRV = __dirname;
const res = []; const check = (n, ok, d) => { res.push(ok); console.log((ok ? "PASS " : "FAIL ") + n + (d !== undefined ? "  — " + d : "")); };
(async () => {
  const db = new PGlite({ extensions: { pg_trgm } }); const q = async (s, p) => (await db.query(s, p)).rows; const exec = (s) => db.exec(s);
  const fails = async (s, p) => { try { await db.query(s, p); return null; } catch (e) { return e.message; } };
  await exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin; create schema auth; create schema extensions;
    create table auth.users (id uuid primary key, email text); create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('ctp.uid', true), '')::uuid $$;`);
  for (const f of ["schema.postgres.sql","rls.sql","0014_powersync_b1_delta.sql","0015_data_api_grants.sql","0020_client_requests.sql","0021_client_quote_response.sql","0022_staff_quoting.sql","0028_settings_backbone.sql","0031_company_app_url.sql","0033_company_profile_no_silent_blanking.sql","0034_rev_triggers.sql","0035_actor_identity_columns.sql","0036_client_uuid_idempotency.sql","0037_actor_source_local_session.sql","0039_purchasing.sql","0041_pricing_guard.sql","0042_fulfil_invoice.sql","0043_prefix_settings.sql","0045_invoice_guard.sql"]) {
    try { await exec(fs.readFileSync(path.join(SRV, f), "utf8")); } catch (e) { console.log("LOAD ERROR " + f + ": " + e.message); process.exit(2); } }
  const STAFF = "11111111-1111-1111-1111-111111111111", CUST = "22222222-2222-2222-2222-222222222222", CUST2 = "33333333-3333-3333-3333-333333333333";
  // parts and customers exist BEFORE 0047 runs (as live), with real SKUs / codes so the seed lands
  await exec(`insert into company (id,name,currency,invoice_prefix,quote_prefix,default_tax_bps) values (1,'T','ZAR','','QT-',1500) on conflict (id) do update set invoice_prefix='';
    insert into location (id,code,name) values (10,'WH','Warehouse'); insert into category (id,code,name,path) values (1,'X','X','X');
    insert into part (id,sku,name,category_id) values (1,'CTP-FWL-013-C','Radiator Grille',1),(2,'CTP-BMP-009-C','Front Bumper Centre Assembly',1),(3,'CTP-DOR-001-L','Front Door Assembly L/H',1);
    insert into price (part_id,tier,currency,amount_minor) values (1,'list','ZAR',82504),(2,'list','ZAR',464252);
    insert into app_user (id,role,display_name) values ('${STAFF}','admin','Ian'),('${CUST}','customer','Denver'),('${CUST2}','customer','Other'); insert into auth.users (id,email) values ('${STAFF}','ian@x');
    insert into customer (id,code,name,auth_user_id) values (6,'HERMANS','Hermans Panel Beaters','${CUST}'),(7,'NEWCO','New Co (not in Zoho)','${CUST2}');
    insert into stock_movement (part_id,location_id,delta,reason,client_uuid) values (1,10,5,'receipt','r1'),(2,10,1,'receipt','r2');`);
  for (const f of ["0046_reservations.sql", "0047_zoho_sales_order.sql"]) { try { await exec(fs.readFileSync(path.join(SRV, f), "utf8")); } catch (e) { console.log("LOAD ERROR " + f + ": " + e.message); process.exit(2); } }
  const as = (u) => exec(`select set_config('ctp.uid','${u}',false)`);
  const pos = async (pid) => (await q("select on_hand, reserved, available from stock_position where part_id=$1 and location_id=10", [pid]))[0] ?? { on_hand: 0, reserved: 0, available: 0 };
  // seed
  const m = await q("select id, zoho_item_id from part order by id");
  check("seed: Grille and Bumper mapped by SKU, Front Door (no list price, not in Zoho) unmapped", m[0].zoho_item_id === "1429405000000117019" && m[1].zoho_item_id === "1429405000000115001" && m[2].zoho_item_id === null, JSON.stringify(m));
  const c = await q("select code, zoho_contact_id from customer order by id");
  check("seed: Hermans mapped by code; a customer not in Zoho stays unmapped", c[0].zoho_contact_id === "1429405000000131019" && c[1].zoho_contact_id === null);
  // a quote with an unorderable line
  await as(CUST); const o1 = (await q(`select request_parts('[{"part_id":1,"qty":2},{"part_id":3,"qty":1}]'::jsonb, null) r`))[0].r.order_id;
  await as(STAFF); await exec(`select fill_quote_from_list(${o1})`);
  await as(CUST); let chk = (await q("select quote_accept_check($1) r", [o1]))[0].r;
  check("check: not ok; the blocker names the Front Door as unpriced", chk.ok === false && chk.blockers.length === 1 && chk.blockers[0].kind === "unpriced" && /Front Door Assembly L\/H \(CTP-DOR-001-L\) has no price yet/.test(chk.blockers[0].message), JSON.stringify(chk.blockers));
  await as(STAFF); await exec(`select price_quote(${o1}, '[{"part_id":3,"unit_price_minor":100000}]'::jsonb)`).catch(() => {});
  await exec(`update sales_line set unit_price_minor = 100000 where order_id = ${o1} and part_id = 3`);
  await as(CUST); chk = (await q("select quote_accept_check($1) r", [o1]))[0].r;
  check("check: priced by hand but still not in Zoho -> 'not set up for ordering yet'", chk.ok === false && chk.blockers[0].kind === "not_in_zoho" && /not set up for ordering yet/.test(chk.blockers[0].message), JSON.stringify(chk.blockers));
  await as(""); let e = await fails("select accept_quote($1, $2, 'SO-X', 'SO-00001')", [o1, CUST]);
  check("accept_quote refuses the same quote even from the server: names the part", /cannot be ordered yet: Front Door Assembly L\/H \(CTP-DOR-001-L\)/.test(e || ""), e);
  let g = await pos(1); check("…and reserved nothing", g.reserved === 0);
  await as(CUST2); e = await fails("select quote_accept_check($1)", [o1]); check("another customer cannot even read the check", /different customer/.test(e || ""), e);
  // a clean quote
  await as(CUST); const o2 = (await q(`select request_parts('[{"part_id":1,"qty":2},{"part_id":2,"qty":2}]'::jsonb, null) r`))[0].r.order_id;
  await as(STAFF); await exec(`select fill_quote_from_list(${o2})`);
  await as(CUST); chk = (await q("select quote_accept_check($1) r", [o2]))[0].r; check("clean quote: ok, no blockers", chk.ok === true && chk.blockers.length === 0);
  e = await fails("select respond_to_quote($1, true)", [o2]); check("a direct accept from the phone is refused: goes through the sales-order step", /sales-order step/.test(e || ""), e);
  e = await fails("select accept_quote($1, $2, 'Z1', 'SO-00001')", [o2, CUST]); check("accept_quote from a customer session is refused (server only)", /called by the server/.test(e || ""), e);
  await as(""); e = await fails("select accept_quote($1, $2, 'Z1', 'SO-00001')", [o2, CUST2]); check("server accept for the wrong customer login is refused", /different customer/.test(e || ""), e);
  e = await fails("select accept_quote($1, $2, '', 'SO-00001')", [o2, CUST]); check("server accept without a Zoho id is refused", /needs the Zoho sales order id/.test(e || ""), e);
  const acc = (await q("select accept_quote($1, $2, 'Z1', 'SO-00001') r", [o2, CUST]))[0].r;
  const so = (await q("select status, client_response, zoho_salesorder_id, zoho_salesorder_number, zoho_created_at from sales_order where id=$1", [o2]))[0];
  check("accept: confirmed, Zoho refs stamped, 2 lines reserved", acc.status === "confirmed" && acc.reserved_lines === 2 && so.status === "confirmed" && so.client_response === "accepted" && so.zoho_salesorder_id === "Z1" && so.zoho_salesorder_number === "SO-00001" && so.zoho_created_at !== null, JSON.stringify(so));
  g = await pos(1); const b = await pos(2);
  check("Grille: on_hand 5, reserved 2, available 3; Bumper: on_hand 1, reserved 2, available -1 (backorder visible)", g.on_hand === 5 && g.reserved === 2 && g.available === 3 && b.on_hand === 1 && b.reserved === 2 && b.available === -1, JSON.stringify({ g, b }));
  const again = (await q("select accept_quote($1, $2, 'Z1', 'SO-00001') r", [o2, CUST]))[0].r; check("the same call again (retry after a dropped response) is a no-op: already", again.already === true && (await pos(1)).reserved === 2);
  e = await fails("select accept_quote($1, $2, 'Z2', 'SO-00002')", [o2, CUST]); check("a DIFFERENT Zoho id for an accepted order is refused", /already confirmed/.test(e || ""), e);
  // decline still works directly
  await as(CUST); const o3 = (await q(`select request_parts('[{"part_id":1,"qty":1}]'::jsonb, null) r`))[0].r.order_id;
  await as(STAFF); await exec(`select fill_quote_from_list(${o3})`); await as(CUST); const dec = (await q("select respond_to_quote($1, false) r", [o3]))[0].r;
  check("decline from the phone still works and reserves nothing", dec.status === "cancelled" && (await pos(1)).reserved === 2);
  // fulfil: shelf check, then release + sale; no payment concept in CTP
  await as(STAFF); e = await fails(`select fulfil_order(${o2})`); check("fulfil refused: Bumper need 2, on hand 1 (the shelf)", /CTP-BMP-009-C: need 2, on hand 1/.test(e || ""), e);
  await as(""); await exec("insert into stock_movement (part_id,location_id,delta,reason,client_uuid) values (2,10,1,'receipt','r3')"); await as(STAFF);
  const ful = (await q(`select fulfil_order(${o2}) r`))[0].r; g = await pos(1); const b2 = await pos(2);
  check("fulfil: 2 sale rows; Grille on_hand 3 reserved 0; Bumper on_hand 0 reserved 0 — no paid gate", ful.movements === 2 && g.on_hand === 3 && g.reserved === 0 && b2.on_hand === 0 && b2.reserved === 0, JSON.stringify({ g, b2 }));
  const led = await q("select reason, sum(delta)::int s from stock_movement where ref_type='sales_order' and ref_id=$1 group by reason order by reason", [o2]);
  check("ledger: reserve -4, release +4, sale -4 — nothing deleted", JSON.stringify(led) === JSON.stringify([{ reason: "release", s: 4 }, { reason: "reserve", s: -4 }, { reason: "sale", s: -4 }]), JSON.stringify(led));
  // cancel releases; the compensation log is server-only and staff-readable
  await as(CUST); const o4 = (await q(`select request_parts('[{"part_id":1,"qty":1}]'::jsonb, null) r`))[0].r.order_id;
  await as(STAFF); await exec(`select fill_quote_from_list(${o4})`); await as(""); await exec(`select accept_quote(${o4}, '${CUST}', 'Z4', 'SO-00004')`);
  await as(STAFF); const can = (await q(`select cancel_order(${o4}, 'changed mind') r`))[0].r; check("cancel releases the hold", can.released === 1 && (await pos(1)).reserved === 0);
  // PGlite runs as superuser, so the grant is read from the catalogue rather than tripped
  const priv = (await q("select has_function_privilege('authenticated', 'public.log_integration_issue(text,text,bigint,text,text)', 'execute') a, has_function_privilege('authenticated', 'public.accept_quote(bigint,uuid,text,text)', 'execute') b, has_function_privilege('service_role', 'public.accept_quote(bigint,uuid,text,text)', 'execute') c"))[0];
  check("grants: authenticated can execute neither accept_quote nor log_integration_issue; service_role can", priv.a === false && priv.b === false && priv.c === true, JSON.stringify(priv));
  await as(""); const iid = (await q("select log_integration_issue('zoho','orphan_salesorder',$1,'Z9','delete failed: 500') r", [o4]))[0].r; check("the server logs an orphan sales order", iid > 0);
  const n = res.filter(Boolean).length; console.log(`\n${n}/${res.length} passed`); process.exit(n === res.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(3); });
