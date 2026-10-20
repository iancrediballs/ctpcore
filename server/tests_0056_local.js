// 0056 on PGlite: Zoho customers -> CTP customers (match by id / name / email, no duplicates, no logins, removed stay removed).
//   Run from the repo root: NODE_PATH=<pglite install>/node_modules node server/tests_0056_local.js
const { PGlite } = require("@electric-sql/pglite");
const fs = require("fs"); const path = require("path"); const SRV = __dirname;
const res = []; const check = (n, ok, d) => { res.push(ok); console.log((ok ? "PASS " : "FAIL ") + n + (d !== undefined ? "  — " + d : "")); };
(async () => {
  const db = new PGlite(); const q = async (s, p) => (await db.query(s, p)).rows; const exec = (s) => db.exec(s);
  await exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create table customer (id bigint primary key, code text not null unique, name text not null, contact text, phone text, email text,
      price_tier text not null default 'list', notes text, auth_user_id uuid, rev int not null default 1, updated_at timestamptz not null default now(),
      deleted_at timestamptz, origin text, rebate_pct numeric not null default 0, zoho_contact_id text, vat_no text);
    insert into customer (id, code, name, email, zoho_contact_id, deleted_at, auth_user_id) values
      (1, 'WALKIN', 'Walk-in / Cash', null, 'Z-WALK', null, null),
      (2, 'HERMANS', 'Hermans Panel Beaters', 'denver@hermans.co.za', 'Z-HERM', null, '22222222-2222-2222-2222-222222222222'),
      (3, 'GSLOGI', 'Gansu Logistics Co.', null, null, now(), null),
      (4, 'ACME', 'Acme Trucks', null, null, null, null),
      (5, 'BYMAIL', 'Some Other Name', 'buyer@fleet.co.za', null, null, null),
      (6, 'OTHERZ', 'Linked Elsewhere', null, 'Z-OLD', null, null);`);
  await exec(fs.readFileSync(path.join(SRV, "0056_zoho_customer_sync.sql"), "utf8"));
  const contacts = JSON.stringify([
    { contact_id: "Z-WALK", contact_name: "Walk-in / Cash" },
    { contact_id: "Z-HERM", contact_name: "Hermans Panel Beaters (renamed in Zoho)", email: "x@y" },
    { contact_id: "Z-GANSU", contact_name: "Gansu Logistics Co." },
    { contact_id: "Z-ACME", contact_name: "Acme  Trucks" },
    { contact_id: "Z-FLEET", contact_name: "Fleet Buyer", email: "Buyer@Fleet.co.za" },
    { contact_id: "Z-NEW1", contact_name: "Multicat (Pty) Ltd", email: "a@multicat.co.za" },
    { contact_id: "Z-NEW2", contact_name: "Multicat Parts", company_name: "Multicat Parts" },
    { contact_id: "Z-DUP", contact_name: "Linked Elsewhere" },
  ]);
  const before = await q("select count(*)::int n from customer");
  const pv = (await q("select zoho_sync_customers($1::jsonb, false) r", [contacts]))[0].r;
  check("preview writes nothing", (await q("select count(*)::int n from customer"))[0].n === before[0].n && (await q("select zoho_contact_id from customer where code='ACME'"))[0].zoho_contact_id === null);
  check("preview: already linked by id = Walk-in, Hermans (Zoho rename does not matter)", pv.already_linked.map((x) => x.ctp).join() === "WALKIN,HERMANS", JSON.stringify(pv.already_linked));
  check("preview: link by name (whitespace-insensitive) and by email (case-insensitive)", JSON.stringify(pv.linked) === JSON.stringify([{ by: "name", ctp: "ACME", zoho: "Acme  Trucks" }, { by: "email", ctp: "BYMAIL", zoho: "Fleet Buyer" }]), JSON.stringify(pv.linked));
  check("preview: removed customer is skipped, not revived", pv.skipped.length === 1 && pv.skipped[0].ctp === "GSLOGI");
  check("preview: a CTP customer linked to another Zoho contact is a conflict, not relinked", pv.conflicts.length === 1 && pv.conflicts[0].ctp === "OTHERZ");
  check("preview: two new, unique codes", pv.new.length === 2 && pv.new[0].code === "MULTICAT" && pv.new[1].code !== "MULTICAT", JSON.stringify(pv.new));
  const ap = (await q("select zoho_sync_customers($1::jsonb, true) r", [contacts]))[0].r;
  const rows = await q("select id, code, name, email, zoho_contact_id, auth_user_id, deleted_at, origin from customer order by id");
  check("apply: Acme linked by name, BYMAIL linked by email; names unchanged", rows.find((r) => r.code === "ACME").zoho_contact_id === "Z-ACME" && rows.find((r) => r.code === "BYMAIL").zoho_contact_id === "Z-FLEET" && rows.find((r) => r.code === "BYMAIL").name === "Some Other Name");
  check("apply: Hermans keeps its name and email", rows.find((r) => r.code === "HERMANS").name === "Hermans Panel Beaters" && rows.find((r) => r.code === "HERMANS").email === "denver@hermans.co.za");
  check("apply: Gansu stays deleted", rows.find((r) => r.code === "GSLOGI").deleted_at !== null);
  check("apply: OTHERZ keeps its own Zoho id", rows.find((r) => r.code === "OTHERZ").zoho_contact_id === "Z-OLD");
  const created = rows.filter((r) => r.origin === "zoho");
  check("apply: 2 customers created, no logins, Zoho id stored, ids allocated", created.length === 2 && created.every((r) => r.auth_user_id === null && r.zoho_contact_id && r.id > 6), JSON.stringify(created));
  const again = (await q("select zoho_sync_customers($1::jsonb, true) r", [contacts]))[0].r;
  check("re-run creates nothing (no duplicates) and links nothing new", again.new.length === 0 && again.linked.length === 0 && (await q("select count(*)::int n from customer"))[0].n === rows.length, JSON.stringify(again.new));
  const priv = (await q("select has_function_privilege('authenticated','public.zoho_sync_customers(jsonb,boolean)','execute') a, has_function_privilege('service_role','public.zoho_sync_customers(jsonb,boolean)','execute') b"))[0];
  check("grants: service_role only", priv.a === false && priv.b === true);
  const n = res.filter(Boolean).length; console.log(`\n${n}/${res.length} passed`); process.exit(n === res.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(3); });
