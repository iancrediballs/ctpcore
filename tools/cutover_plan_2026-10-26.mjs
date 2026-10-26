// Cut-over prep (26 Oct): READ-ONLY. From the backup snapshot, writes
//   delete_plan.csv   every Zoho document the zero would delete or void, in execution order
//   opening_stock.csv the opening-stock adjustment draft: CTP on hand (master) beside Zoho physical
//                     and the 23 Oct reconciliation verdict, valued at the Zoho purchase rate
//   ctp_reset.csv     CTP orders whose Zoho links are cleared at the reset
//   summary.json      the counts
//   node tools/cutover_plan_2026-10-26.mjs "<backup folder>" docs/cutover/2026-10-26
import fs from "node:fs";
import path from "node:path";
const [B, OUT] = process.argv.slice(2);
fs.mkdirSync(OUT, { recursive: true });
const J = (p) => JSON.parse(fs.readFileSync(path.join(B, p), "utf8"));
const csv = (name, rows) => {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  fs.writeFileSync(path.join(OUT, name), [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n"));
};
const T = J("zoho/transactions_list.json").transactions;

// ── 1. delete plan, in dependency order (docs/09 §4.3)
const steps = [
  ["customerpayments", "payment_number", "Payments first: an invoice with a payment cannot be deleted", (r) => `R${r.amount} on ${r.invoice_numbers}`],
  ["creditnotes", "creditnote_number", "Credit notes: un-apply from invoices (closed = fully applied), then delete; void ones delete directly", (r) => `${r.status}, R${r.total}`],
  ["shipments", "shipment_number", "Shipments before packages (deleting a delivered shipment puts the stock back)", (r) => `${r.status}, ${r.salesorder_number}`],
  ["packages", "package_number", "Packages before their sales order", (r) => `${r.status}, ${r.salesorder_number}`],
  ["invoices", "invoice_number", "Invoices after payments and credits", (r) => `${r.status}, R${r.total}, open R${r.balance}`],
  ["salesorders", "salesorder_number", "Sales orders after their invoices and packages", (r) => `${r.status}, R${r.total}`],
  ["estimates", "estimate_number", "Estimates last on the sales side", (r) => `${r.status}, R${r.total}`],
  ["vendorpayments", "payment_number", "Vendor payments before bills", () => ""],
  ["purchasereceives", "purchasereceive_number", "Receives before bills/POs", () => ""],
  ["bills", "bill_number", "Bills (this removes the stock they brought in)", (r) => `${r.status}, R${r.total}, open R${r.balance}`],
  ["purchaseorders", "purchaseorder_number", "POs after bills and receives", () => ""],
  ["inventoryadjustments", "reference_number", "Adjustments", () => ""],
  ["transferorders", "transfer_order_number", "Transfer orders", () => ""],
  ["salesreceipts", "receipt_number", "Sales receipts", () => ""],
];
const plan = []; const counts = {};
let n = 0;
for (const [k, numKey, why, what] of steps) {
  const rows = Array.isArray(T[k]) ? T[k] : [];
  counts[k] = rows.length;
  for (const r of rows) plan.push({ step: ++n, type: k, number: r[numKey] ?? r.number ?? "", contact: r.customer_name ?? r.vendor_name ?? "", date: r.date ?? "",
    detail: what(r), test_or_real: /test|ian/i.test(r.customer_name ?? "") ? "TEST" : "REAL", why });
}
csv("delete_plan.csv", plan);
const unreadable = Object.fromEntries(Object.entries(T).filter(([, v]) => !Array.isArray(v)).map(([k, v]) => [k, `${v._status} ${v._message ?? ""}`]));

// ── 2. opening stock (CTP master)
const parts = J("ctp/tables/part.json").filter((p) => !p.deleted_at);
const links = J("ctp/tables/zoho_item.json");
const moves = J("ctp/tables/stock_movement.json");
const zi = Object.fromEntries(J("zoho/items.json").items.map((i) => [String(i.item_id), i]));
const rec = Object.fromEntries(fs.readFileSync("docs/stock/reconciliation_2026-10-23.csv", "utf8").split("\n").slice(1).filter(Boolean)
  .map((l) => l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"'))).map((c) => [c[2], c]));
const onHand = {};
for (const m of moves) if (!["reserve", "release"].includes(m.reason)) onHand[m.part_id] = (onHand[m.part_id] ?? 0) + Number(m.delta);
const stock = [];
for (const p of parts) {
  const link = links.find((l) => l.part_id === p.id && l.status !== "inactive") ?? links.find((l) => l.part_id === p.id);
  const z = link ? zi[String(link.zoho_item_id)] : null;
  const qty = onHand[p.id] ?? 0;
  const r = rec[String(p.id)];
  const add = r && /^Zoho/.test(r[16]) ? Math.max(0, Number(r[12]) || 0) : 0;
  if (!qty && !(z && Number(z.actual_available_stock))) continue;
  stock.push({ sku: p.sku, name: p.name, ctp_part_id: p.id, zoho_item_id: link?.zoho_item_id ?? "", zoho_tracked: z?.track_inventory ?? "",
    ctp_on_hand_now: qty, zoho_physical_now: z?.actual_available_stock ?? "", zoho_accounting_now: z?.stock_on_hand ?? "",
    reconciliation_23oct: r ? r[16] : "", purchase_rate: z?.purchase_rate ?? "",
    // Ian 23 Oct: both Supalift deliveries arrived, so the shipment CTP's opening load missed is added back
    missed_shipment_add: add, opening_qty_recommended: qty + add,
    count_needed: r && /COUNT|count|Documents|CTP is right/i.test(r[16]) ? "YES" : "",
    opening_value_recommended: z?.purchase_rate != null ? +((qty + add) * Number(z.purchase_rate)).toFixed(2) : "",
    note: !link ? "NOT LINKED to a Zoho item" : z && z.track_inventory === false ? "Zoho item not stock-tracked: turn tracking on first" : "" });
}
csv("opening_stock.csv", stock);

// ── 3. CTP reset list
const orders = J("ctp/tables/sales_order.json");
const reset = orders.filter((o) => [o.zoho_salesorder_id, o.zoho_invoice_id, o.zoho_estimate_id, o.zoho_package_id, o.zoho_shipment_id].some(Boolean) || !o.deleted_at)
  .map((o) => ({ id: o.id, number: o.number, status: o.status, already_deleted: !!o.deleted_at, estimate: o.zoho_estimate_number ?? "", so: o.zoho_salesorder_number ?? "",
    invoice: o.zoho_invoice_number ?? "", package: o.zoho_package_number ?? "", shipment: o.zoho_shipment_number ?? "" }));
csv("ctp_reset.csv", reset);

const sum = (a, f) => +a.reduce((s, x) => s + (Number(f(x)) || 0), 0).toFixed(2);
const summary = {
  read_at: J("zoho/COUNTS.json").read_at, delete_counts: counts, delete_total: plan.length,
  delete_test: plan.filter((p) => p.test_or_real === "TEST").length, delete_real: plan.filter((p) => p.test_or_real === "REAL").length,
  unreadable_on_token: unreadable,
  hermans_open_receivable: sum(T.invoices.filter((i) => /hermans/i.test(i.customer_name)), (i) => i.balance),
  open_payables: sum(T.bills, (b) => b.balance),
  opening_stock: { lines: stock.length, ctp_units: sum(stock, (s) => s.ctp_on_hand_now), zoho_physical_units: sum(stock, (s) => s.zoho_physical_now),
    recommended_units: sum(stock, (s) => s.opening_qty_recommended), count_needed: stock.filter((s) => s.count_needed).length,
    value_recommended: sum(stock, (s) => s.opening_value_recommended),
    lines_differing: stock.filter((s) => Number(s.zoho_physical_now) !== s.ctp_on_hand_now).length,
    not_linked: stock.filter((s) => s.note.startsWith("NOT")).length, not_tracked: stock.filter((s) => s.note.startsWith("Zoho item not")).length },
  ctp_orders_to_reset: reset.length, ctp_orders_live: reset.filter((r) => !r.already_deleted).length,
};
fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
