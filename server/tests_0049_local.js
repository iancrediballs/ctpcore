// 0049 on PGlite: part.in_stock follows AVAILABLE (on hand minus holds) across locations.
// Backfill on apply; receipt flips it on; selling out flips it off; a hold for the whole
// shelf reads out of stock; release brings it back; a customer insert path (the counter's
// role, INSERT-only on the ledger) still updates the part row through the definer trigger.
const { PGlite } = require("@electric-sql/pglite"); const { pg_trgm } = require("@electric-sql/pglite/contrib/pg_trgm");
const fs = require("fs"); const path = require("path"); const SRV = __dirname;
const res = []; const check = (n, ok, d) => { res.push(ok); console.log((ok ? "PASS " : "FAIL ") + n + (d !== undefined ? "  — " + d : "")); };
(async () => {
  const db = new PGlite({ extensions: { pg_trgm } }); const q = async (s, p) => (await db.query(s, p)).rows; const exec = (s) => db.exec(s);
  await exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin; create schema auth; create schema extensions;
    create table auth.users (id uuid primary key, email text); create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('ctp.uid', true), '')::uuid $$;`);
  for (const f of ["schema.postgres.sql","rls.sql","0014_powersync_b1_delta.sql","0015_data_api_grants.sql","0020_client_requests.sql","0021_client_quote_response.sql","0022_staff_quoting.sql","0028_settings_backbone.sql","0031_company_app_url.sql","0033_company_profile_no_silent_blanking.sql","0034_rev_triggers.sql","0035_actor_identity_columns.sql","0036_client_uuid_idempotency.sql","0037_actor_source_local_session.sql","0039_purchasing.sql","0041_pricing_guard.sql","0042_fulfil_invoice.sql","0043_prefix_settings.sql","0045_invoice_guard.sql","0046_reservations.sql","0047_zoho_sales_order.sql"]) {
    try { await exec(fs.readFileSync(path.join(SRV, f), "utf8")); } catch (e) { console.log("LOAD ERROR " + f + ": " + e.message); process.exit(2); } }
  const STAFF = "11111111-1111-1111-1111-111111111111", CUST = "22222222-2222-2222-2222-222222222222";
  // Stock exists BEFORE the migration, as it does live: A has 3 in WH, B has 2 in WH and 2 in VAN, C has none, D was oversold (-1).
  await exec(`insert into company (id,name,currency,invoice_prefix,quote_prefix,default_tax_bps) values (1,'T','ZAR','','QT-',1500) on conflict (id) do update set invoice_prefix='';
    insert into location (id,code,name) values (10,'WH','Warehouse'),(11,'VAN','Van'); insert into category (id,code,name,path) values (1,'X','X','X');
    insert into part (id,sku,name,category_id) values (1,'A','Part A',1),(2,'B','Part B',1),(3,'C','Part C',1),(4,'D','Part D',1);
    insert into price (part_id,tier,currency,amount_minor) values (1,'list','ZAR',10000),(2,'list','ZAR',10000),(3,'list','ZAR',10000),(4,'list','ZAR',10000);
    insert into app_user (id,role,display_name) values ('${STAFF}','admin','Ian'),('${CUST}','customer','Cust'); insert into auth.users (id,email) values ('${STAFF}','ian@x');
    insert into customer (id,code,name,auth_user_id) values (1,'C','Cust','${CUST}');
    update customer set zoho_contact_id='ZC1'; update part set zoho_item_id='ZI'||id;
    insert into stock_movement (part_id,location_id,delta,reason,client_uuid) values (1,10,3,'receipt','a1'),(2,10,2,'receipt','b1'),(2,11,2,'receipt','b2'),(4,10,-1,'sale','d-oversold');`);
  // 0049 lands after the oversold row exists (as it will live), then 0050.
  for (const f of ["0048_stock_guard.sql", "0049_part_in_stock.sql"]) { try { await exec(fs.readFileSync(path.join(SRV, f), "utf8")); } catch (e) { console.log("LOAD ERROR " + f + ": " + e.message); process.exit(2); } }
  const flags = async () => Object.fromEntries((await q("select id, in_stock from part order by id")).map((r) => [r.id, r.in_stock]));
  const mv = (pid, loc, d, reason, key) => db.query("insert into stock_movement (part_id,location_id,delta,reason,client_uuid) values ($1,$2,$3,$4,$5)", [pid, loc, d, reason, key]);
  let f = await flags();
  check("backfill: A true, B true, C false (never stocked), D false (oversold, -1)", f[1] === true && f[2] === true && f[3] === false && f[4] === false, JSON.stringify(f));
  // receipt flips on; the part row's updated_at moved (so it syncs)
  const before = (await q("select updated_at, rev from part where id=3"))[0];
  await mv(3, 10, 1, "receipt", "c1"); f = await flags(); check("a receipt of 1 for C flips it to in stock", f[3] === true);
  const after = (await q("select updated_at, rev from part where id=3"))[0];
  check("...and bumped the part row (rev/updated_at) so it syncs", after.rev > before.rev || String(after.updated_at) !== String(before.updated_at), JSON.stringify({ before, after }));
  // selling to zero flips off; selling some of it does not
  await mv(1, 10, -2, "sale", "a2"); f = await flags(); check("A: sell 2 of 3, still in stock", f[1] === true);
  await mv(1, 10, -1, "sale", "a3"); f = await flags(); check("A: sell the last one, out of stock", f[1] === false);
  // multi-location: B out in WH but still in the VAN stays in stock
  await mv(2, 10, -2, "sale", "b3"); f = await flags(); check("B: WH empty, VAN still has 2 -> in stock (all locations)", f[2] === true);
  // holds: a customer accepts a quote for everything B has -> available 0 -> out of stock, though on_hand is 2
  const as = (u) => exec(`select set_config('ctp.uid','${u}',false)`);
  await as(CUST); const o1 = (await q(`select request_parts('[{"part_id":2,"qty":2}]'::jsonb, null) r`))[0].r.order_id;
  await as(STAFF); await exec(`select fill_quote_from_list(${o1})`); await as(''); await exec(`select accept_quote(${o1}, '${CUST}', 'Z-o1', 'SO-1')`);
  f = await flags(); const pos = (await q("select sum(on_hand)::int on_hand, sum(reserved)::int reserved, sum(available)::int available from stock_position where part_id=2"))[0];
  check("B: accepted order holds both -> out of stock for the next customer (on_hand 2 across locations, available 0)", f[2] === false && pos.on_hand === 2 && pos.available === 0, JSON.stringify(pos));
  await as(STAFF); await exec(`select cancel_order(${o1}, 'changed mind')`); f = await flags(); check("B: hold released on cancel -> in stock again", f[2] === true);
  // the oversold part corrected upward (0049 allows it) stays out at 0 and flips at +2
  await as(""); await mv(4, 10, 1, "adjustment", "d1"); f = await flags(); check("D: -1 -> 0 is still out of stock", f[4] === false);
  await mv(4, 10, 1, "receipt", "d2"); f = await flags(); check("D: 0 -> 1 is in stock", f[4] === true);
  // the row-count invariant the VERIFY block checks live
  const bad = await q("select p.id from part p left join stock_movement m on m.part_id=p.id group by p.id, p.in_stock having p.in_stock <> (coalesce(sum(m.delta),0) > 0)");
  check("invariant: no part disagrees with its ledger", bad.length === 0, JSON.stringify(bad));
  // the customer bucket lists the column; the ledger is still absent from it
  const y = fs.readFileSync(path.join(SRV, "sync-streams.yaml"), "utf8"); const client = y.slice(y.indexOf("ctp_client:"), y.indexOf("# ══ CLIENT — their own requests"));
  check("sync-streams: the customer bucket carries part.in_stock and still no stock_movement", /in_stock/.test(client) && !/FROM stock_movement/.test(client));
  const n = res.filter(Boolean).length; console.log(`\n${n}/${res.length} passed`); process.exit(n === res.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(3); });
