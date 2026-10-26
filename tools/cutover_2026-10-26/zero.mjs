// THE ZERO (26 Oct, Ian: "GO ZERO, scripted"). Re-reads Zoho, refuses if anything differs from the
// backup, then deletes in the approved order, one document per call, stopping at the first error.
//   bash env.sh node zero.mjs "<backup folder>" [--run]      (without --run: re-check only)
import fs from "node:fs";
import path from "node:path";
const B = process.argv[2], RUN = process.argv.includes("--run");
const LOG = path.join(B, "ZERO_LOG.txt");
const log = (s) => { const l = `${new Date().toISOString()} ${s}`; console.log(l); fs.appendFileSync(LOG, l + "\n"); };
const call = async (body) => {
  const r = await fetch(`${process.env.SUPA_URL}/functions/v1/zoho-auth`, { method: "POST",
    headers: { Authorization: `Bearer ${process.env.SUPA_SR}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
const C = { action: "cutover", confirm: "GO ZERO 2026-10-26" };
const backup = JSON.parse(fs.readFileSync(path.join(B, "zoho/transactions_list.json"), "utf8")).transactions;
const now = await call({ action: "audit", part: "transactions" });
if (!now.ok) { log(`STOP: could not re-read Zoho ${JSON.stringify(now).slice(0, 200)}`); process.exit(1); }
const T = now.transactions;
const ID = { customerpayments: "payment_id", creditnotes: "creditnote_id", shipments: "shipment_id", packages: "package_id", invoices: "invoice_id",
  salesorders: "salesorder_id", estimates: "estimate_id", bills: "bill_id", vendorpayments: "payment_id", purchasereceives: "receive_id",
  purchaseorders: "purchaseorder_id", inventoryadjustments: "inventory_adjustment_id", transferorders: "transfer_order_id", salesreceipts: "sales_receipt_id" };
let diff = false;
for (const k of Object.keys(ID)) {
  const a = new Set((Array.isArray(backup[k]) ? backup[k] : []).map((r) => String(r[ID[k]])));
  const b = (Array.isArray(T[k]) ? T[k] : []).map((r) => String(r[ID[k]]));
  const extra = b.filter((x) => !a.has(x));
  if (extra.length) { diff = true; log(`DIFF ${k}: ${extra.length} new since the backup: ${T[k].filter((r) => extra.includes(String(r[ID[k]]))).map((r) => JSON.stringify(r).slice(0, 160)).join(" | ")}`); }
  if (b.length !== a.size) log(`count ${k}: backup ${a.size}, now ${b.length}`);
}
if (diff) { log("STOP: Zoho changed since the backup. Nothing deleted."); process.exit(2); }
log(`re-check ok: Zoho matches the backup (${Object.entries(T).map(([k, v]) => `${k} ${Array.isArray(v) ? v.length : "n/a"}`).join(", ")})`);
if (!RUN) process.exit(0);

const num = (r) => r.payment_number ?? r.creditnote_number ?? r.shipment_number ?? r.package_number ?? r.invoice_number ?? r.salesorder_number ?? r.estimate_number ?? r.bill_number ?? "";
const stop = (s) => { log(`STOP: ${s}`); process.exit(3); };
// 1. un-apply credits
for (const cn of T.creditnotes.filter((c) => c.status !== "void")) {
  const r = await call({ ...C, op: "unapply_credits", id: cn.creditnote_id });
  if (!r.ok) stop(`un-apply ${cn.creditnote_number}: ${r.error}`);
  log(`un-apply ${cn.creditnote_number}: ${r.done.join("; ") || "nothing applied"}`);
}
// 2.. deletes in order. Credit notes moved after invoices (Ian, 26 Oct: "go, reordered"): deleting a
// restocking credit note takes stock out (Zoho 9205), so it waits until shipments/invoices put stock back.
// "soft" passes log a refusal and carry on; the last credit-note pass (after bills) stops on refusal.
// Bills are left for a separate run: CN-00003 may need a temporary stock-in first (Ian approved, 26 Oct).
const order = [["customerpayments", "customerpayment"], ["shipments", "shipment"], ["packages", "package"], ["invoices", "invoice", "soft"],
  ["creditnotes", "creditnote", "soft"], ["invoices", "invoice", "soft"], ["salesorders", "salesorder", "soft"], ["estimates", "estimate"],
  ["creditnotes", "creditnote", "soft"], ["invoices", "invoice", "soft"], ["salesorders", "salesorder", "soft"],
  ...(process.argv.includes("--bills") ? [["bills", "bill"], ["creditnotes", "creditnote"]] : [])];
for (const [k, kind, soft] of order) {
  let n = 0, refused = 0;
  const cur = (await call({ action: "audit", part: "transactions" })).transactions?.[k];
  for (const r of Array.isArray(cur) ? cur : T[k] ?? []) {
    const x = await call({ ...C, op: "delete", kind, id: r[ID[k]] });
    if (!x.ok) { if (soft) { refused++; log(`refused (will retry later) ${kind} ${num(r)}: ${x.error}`); continue; } stop(`delete ${kind} ${num(r)} (${r[ID[k]]}): ${x.error}`); }
    n++; log(`deleted ${kind} ${num(r)}${x.gone ? " (already gone)" : ""}`);
  }
  // check after each type
  const chk = await call({ action: "audit", part: "transactions" });
  const left = chk.transactions?.[k];
  if (!Array.isArray(left)) stop(`after ${k}: could not re-read`);
  if (left.length && !(soft && left.length === refused)) stop(`after ${k}: ${left.length} still listed`);
  log(`== ${k}: ${n} deleted, ${left.length} left`);
}
log("ZERO DONE");
