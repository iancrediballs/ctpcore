// Order desk filters (app/src/mobile/orderFilter.ts). Run: node --experimental-strip-types server/tests_orderfilter_local.mjs
import { applyFilter, EMPTY_FILTER, inStage, isPaid, matchesQuery, parseTs, rangeBounds } from "../app/src/mobile/orderFilter.ts";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL", m); } };
const L = (part_id, sku, name, pn = null) => ({ part_id, sku, name, catalogue_pn: pn });
const now = new Date(2026, 9, 23, 10, 0, 0); // 23 Oct 2026 local
const orders = [
  { id: 1, number: "RQ-261020-43", status: "fulfilled", created_at: "2026-10-20 09:12:00.1+00", fulfilled_at: "2026-10-22 10:00:00+00",
    invoice_no: null, customer_id: 6, customer_name: "Hermans", zoho_salesorder_id: "x", zoho_salesorder_number: "SO-00011",
    zoho_invoice_id: "i5", zoho_invoice_number: "INV-000005", zoho_status: "sent", zoho_invoice_total_minor: 132940, zoho_invoice_balance_minor: 132940,
    lines: [L(10, "3732015-1063-C00", "Front Fog Lamp L/H")] },
  { id: 2, number: "RQ-261023-50", status: "quote", created_at: "2026-10-23 07:00:00+00", fulfilled_at: null, invoice_no: null,
    customer_id: 7, customer_name: "Test Account", lines: [L(11, "CTP-CBY-006-C", "Cab mirror", "CBY-006")] },
  { id: 3, number: "RQ-261021-45", status: "confirmed", created_at: "2026-10-21T08:00:00Z", fulfilled_at: null, invoice_no: null,
    customer_id: 6, customer_name: "Hermans", zoho_salesorder_id: "y", zoho_salesorder_number: "SO-00012", lines: [L(10, "3732015-1063-C00", "Front Fog Lamp L/H")] },
  { id: 4, number: "RQ-260812-01", status: "invoiced", created_at: "2026-08-12 08:00:00+00", fulfilled_at: "2026-08-12 09:00:00+00", invoice_no: "26081201",
    customer_id: 6, customer_name: "Hermans", zoho_invoice_number: "DS000001", zoho_status: "paid", lines: [L(12, "X-1", "Hinge")] },
  { id: 5, number: "RQ-261001-02", status: "cancelled", created_at: "2026-10-01 08:00:00+00", fulfilled_at: null, invoice_no: null,
    customer_id: 7, customer_name: "Test Account", lines: [] },
];
const ids = (f) => applyFilter(orders, { ...EMPTY_FILTER, ...f }, now).map((o) => o.id).join(",");
ok(Number.isFinite(parseTs("2026-10-20 09:12:00.1+00")), "parse pg ts");
ok(ids({}) === "1,2,3,4,5", "no filter = all");
ok(ids({ q: "SO-00011" }) === "1", "SO number");
ok(ids({ q: "so00011" }) === "1", "SO compact");
ok(ids({ q: "inv 5" }) === "1", "invoice words");
ok(ids({ q: "INV-000005" }) === "1", "invoice number");
ok(ids({ q: "rq-261023" }) === "2", "RQ number");
ok(ids({ q: "hermans" }) === "1,3,4", "customer");
ok(ids({ q: "fog lamp" }) === "1,3", "part name");
ok(ids({ q: "CBY-006" }) === "2", "catalogue pn / sku");
ok(ids({ q: "26081201" }) === "4", "CTP invoice no");
ok(ids({ range: "today" }) === "2", "today");
ok(ids({ range: "7d" }) === "1,2,3", "7 days");
ok(ids({ range: "month" }) === "1,2,3,5", "this month");
ok(ids({ range: "custom", from: "2026-10-20", to: "2026-10-21" }) === "1,3", "custom inclusive");
ok(ids({ range: "custom", from: "2026-10-22" }) === "2", "custom open end");
ok(ids({ stage: "quote" }) === "2", "stage quote");
ok(ids({ stage: "accepted" }) === "3", "stage accepted");
ok(ids({ stage: "awaiting_invoice" }) === "3", "awaiting invoice");
ok(ids({ stage: "invoiced" }) === "1,4", "invoiced");
ok(ids({ stage: "fulfilled" }) === "1,4", "fulfilled");
ok(ids({ stage: "cancelled" }) === "5", "cancelled");
ok(ids({ customer: "7" }) === "2,5", "customer filter");
ok(ids({ part: 10 }) === "1,3", "part filter");
ok(ids({ invoice: "has" }) === "1,4", "has invoice");
ok(ids({ invoice: "none" }) === "2,3,5", "no invoice");
ok(ids({ paid: "paid" }) === "4", "paid");
ok(ids({ paid: "unpaid" }) === "1", "unpaid");
ok(ids({ customer: "6", stage: "invoiced", paid: "unpaid", range: "7d" }) === "1", "combined");
ok(isPaid({ ...orders[0], zoho_invoice_balance_minor: 0 }), "zero balance = paid");
ok(!inStage(orders[4], "invoiced"), "cancelled never invoiced");
ok(matchesQuery(orders[0], "  "), "blank query");
const [a, b] = rangeBounds({ ...EMPTY_FILTER, range: "today" }, now); ok(b - a === 86400000, "today bounds");
console.log(`orderFilter: ${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);
