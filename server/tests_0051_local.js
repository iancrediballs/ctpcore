// 0051 on PGlite: the customer takes a line off their own quote.
//
// The point being proved is not just "the line goes away". It is that the line
// going away is the ONLY fact that changes, and that every downstream number —
// the total, the Zoho line items the edge function would build, the
// reservations reserve_order() makes — follows from it without anybody having
// to keep them in step. So the proof accepts a trimmed quote for real and then
// reads the ledger.
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
  await exec(`insert into company (id,name,currency,invoice_prefix,quote_prefix,default_tax_bps) values (1,'T','ZAR','','QT-',1500) on conflict (id) do update set invoice_prefix='';
    insert into location (id,code,name) values (10,'WH','Warehouse'); insert into category (id,code,name,path) values (1,'X','X','X');
    insert into part (id,sku,name,category_id) values (1,'CTP-FWL-013-C','Radiator Grille',1),(2,'CTP-BMP-009-C','Front Bumper Centre Assembly',1),(3,'CTP-MRR-001-L','Main Mirror Assembly L/H',1);
    insert into price (part_id,tier,currency,amount_minor) values (1,'list','ZAR',82504),(2,'list','ZAR',464252),(3,'list','ZAR',120000);
    insert into app_user (id,role,display_name) values ('${STAFF}','admin','Ian'),('${CUST}','customer','Denver'),('${CUST2}','customer','Other'); insert into auth.users (id,email) values ('${STAFF}','ian@x');
    insert into customer (id,code,name,auth_user_id) values (6,'HERMANS','Hermans Panel Beaters','${CUST}'),(7,'GSLOGI','GS Logistics','${CUST2}');
    insert into stock_movement (part_id,location_id,delta,reason,client_uuid) values (1,10,5,'receipt','r1'),(2,10,5,'receipt','r2'),(3,10,5,'receipt','r3');`);
  for (const f of ["0046_reservations.sql", "0047_zoho_sales_order.sql", "0051_customer_drops_quote_line.sql"]) {
    try { await exec(fs.readFileSync(path.join(SRV, f), "utf8")); } catch (e) { console.log("LOAD ERROR " + f + ": " + e.message); process.exit(2); } }
  const as = (u) => exec(`select set_config('ctp.uid','${u}',false)`);
  const pos = async (pid) => (await q("select on_hand, reserved, available from stock_position where part_id=$1 and location_id=10", [pid]))[0] ?? { on_hand: 0, reserved: 0, available: 0 };
  const live = async (o) => (await q("select id, part_id, qty, unit_price_minor from sales_line where order_id=$1 and deleted_at is null order by id", [o]));
  const total = async (o) => Number((await q("select coalesce(sum(qty::bigint*unit_price_minor),0) t from sales_line where order_id=$1 and deleted_at is null", [o]))[0].t);

  // ── a three-line quote, priced ──────────────────────────────────────────
  await as(CUST);
  const o1 = (await q(`select request_parts('[{"part_id":1,"qty":2},{"part_id":2,"qty":1},{"part_id":3,"qty":3}]'::jsonb, null) r`))[0].r.order_id;
  await as(STAFF); await exec(`select fill_quote_from_list(${o1})`);
  await as(CUST);
  // Addressed by PART, never by position: request_parts does not promise to
  // insert in the order it was given, and the first run of this proof quietly
  // removed the Mirror while claiming to remove the Bumper.
  const L = await live(o1);
  const lineOf = (partId) => L.find((x) => Number(x.part_id) === partId).id;
  const GRILLE = lineOf(1), BUMPER = lineOf(2), MIRROR = lineOf(3);
  const before = await total(o1);
  check("a three-line quote prices to 2×825.04 + 1×4642.52 + 3×1200.00", before === 2 * 82504 + 464252 + 3 * 120000, String(before));

  // ── who may not ─────────────────────────────────────────────────────────
  await as(CUST2);
  let e = await fails("select quote_drop_line($1)", [GRILLE]);
  check("another customer cannot drop a line off someone else's quote", /different customer/.test(e || ""), e);
  await as(STAFF);
  e = await fails("select quote_drop_line($1)", [GRILLE]);
  check("staff cannot call it either — the note it writes says 'customer removed'", /not linked to a customer account/.test(e || ""), e);
  await as(CUST);
  check("…and nothing was removed by either attempt", (await live(o1)).length === 3);

  // ── the removal itself ──────────────────────────────────────────────────
  const r = (await q("select quote_drop_line($1) r", [BUMPER]))[0].r;   // the Bumper, 1 × 4642.52
  check("drop returns the part it removed and the new total", r.removed_sku === "CTP-BMP-009-C" && r.remaining_lines === 2 && Number(r.total_minor) === before - 464252, JSON.stringify(r));
  check("the quote reprices: the removed line is gone from the total", (await total(o1)) === before - 464252);
  const gone = (await q("select deleted_at from sales_line where id=$1", [BUMPER]))[0];
  check("the line is soft-deleted, not destroyed — the quote as sent is still on record", gone.deleted_at !== null);
  const note = (await q("select notes from sales_order where id=$1", [o1]))[0].notes;
  check("the desk can read what happened, in words", /customer removed 1 × Front Bumper Centre Assembly \(CTP-BMP-009-C\)/.test(note || ""), JSON.stringify(note));

  // ── it cannot be done twice ─────────────────────────────────────────────
  e = await fails("select quote_drop_line($1)", [BUMPER]);
  check("dropping the same line again says so rather than silently succeeding", /already been removed/.test(e || ""), e);
  check("…and the total did not move again", (await total(o1)) === before - 464252);

  // ── the last line is refused ────────────────────────────────────────────
  await q("select quote_drop_line($1) r", [MIRROR]);
  check("down to one line", (await live(o1)).length === 1);
  e = await fails("select quote_drop_line($1)", [GRILLE]);
  check("the LAST line is refused, and points at Decline", /at least one item/.test(e || "") && /Decline/.test(e || ""), e);
  check("so a quote can never be emptied this way", (await live(o1)).length === 1);

  // ── accepting a TRIMMED quote: Zoho lines, total and holds all follow ───
  const rest = await live(o1);
  check("what is left is the Grille, 2 off — the line the customer kept", rest.length === 1 && rest[0].part_id === 1 && rest[0].qty === 2);
  let chk = (await q("select quote_accept_check($1) r", [o1]))[0].r;
  check("the trimmed quote is acceptable", chk.ok === true && chk.blockers.length === 0, JSON.stringify(chk.blockers));
  await as("");
  const acc = (await q("select accept_quote($1, $2, 'Z1', 'SO-00042') r", [o1, CUST]))[0].r;
  check("accept: ONE line reserved, not three — the order is what was accepted, not what was sent", acc.reserved_lines === 1 && acc.status === "confirmed", JSON.stringify(acc));
  const g = await pos(1), b = await pos(2), m = await pos(3);
  check("the ledger holds only the kept line: Grille reserved 2; Bumper and Mirror reserved 0", g.reserved === 2 && b.reserved === 0 && m.reserved === 0, JSON.stringify({ g, b, m }));

  // ── an order that is no longer a quote is closed to edits ───────────────
  await as(CUST);
  e = await fails("select quote_drop_line($1)", [rest[0].id]);
  check("once accepted, items can no longer be removed", /already confirmed/.test(e || ""), e);

  // ── the empty-quote guards, reached the other way ───────────────────────
  // quote_drop_line cannot empty a quote, but staff editing on the desk can.
  // Both guards must hold regardless of how the order got here.
  await as(CUST);
  const o2 = (await q(`select request_parts('[{"part_id":1,"qty":1}]'::jsonb, null) r`))[0].r.order_id;
  await as(STAFF); await exec(`select fill_quote_from_list(${o2})`);
  await as(""); await exec(`update sales_line set deleted_at = now() where order_id = ${o2}`);
  await as(CUST);
  chk = (await q("select quote_accept_check($1) r", [o2]))[0].r;
  check("an empty quote is NOT acceptable, and says why (0047 returned ok=true here)", chk.ok === false && chk.blockers.some((b) => b.kind === "no_lines"), JSON.stringify(chk.blockers));
  await as("");
  e = await fails("select accept_quote($1, $2, 'Z9', 'SO-00099')", [o2, CUST]);
  check("and the transaction itself refuses it, next to the UPDATE that would confirm it", /no items left on it/.test(e || ""), e);
  const st = (await q("select status, zoho_salesorder_id from sales_order where id=$1", [o2]))[0];
  check("nothing was confirmed and no Zoho ref was stamped", st.status === "quote" && st.zoho_salesorder_id === null, JSON.stringify(st));

  // ── 0047's own behaviour is otherwise untouched ─────────────────────────
  await as(CUST);
  const o3 = (await q(`select request_parts('[{"part_id":1,"qty":1},{"part_id":2,"qty":1}]'::jsonb, null) r`))[0].r.order_id;
  await as(STAFF); await exec(`select fill_quote_from_list(${o3})`);
  await as(CUST);
  e = await fails("select respond_to_quote($1, true)", [o3]);
  check("a direct accept from the phone is still refused (0047)", /sales-order step/.test(e || ""), e);
  const dec = (await q("select respond_to_quote($1, false) r", [o3]))[0].r;
  check("decline still works and is still the way to turn a whole quote down", dec.status === "cancelled");

  const bad = res.filter((x) => !x).length;
  console.log(`\n${res.length - bad}/${res.length} passed`);
  process.exit(bad ? 1 : 0);
})();
