// Cut-over smoke test (26 Oct): CTP TEST order → Zoho TEST SO + invoice → Ship in Zoho from CTP (stock master
// Zoho) → stock -1 in Zoho and in the CTP cache, CTP ledger untouched → then everything deleted, stock back.
import fs from "node:fs";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
const LOG = "C:/Users/iancr/OneDrive/Desktop/CTP Zoho Backup 2026-10-26/ZERO_LOG.txt";
const log = (s) => { const l = `${new Date().toISOString()} smoke: ${s}`; console.log(l); fs.appendFileSync(LOG, l + "\n"); };
const sb = createClient(process.env.SUPA_URL, process.env.SUPA_SR, { auth: { persistSession: false } });
const za = async (b) => { const r = await fetch(`${process.env.SUPA_URL}/functions/v1/zoho-auth`, { method: "POST", headers: { Authorization: `Bearer ${process.env.SUPA_SR}`, "Content-Type": "application/json" }, body: JSON.stringify(b) }); return r.json(); };
const C = { action: "cutover", confirm: "GO ZERO 2026-10-26" };
const push = (p) => za({ ...C, op: "push", push: p });
const zstock = async () => (await za({ action: "inv_get", path: "/items/1429405000000102001" })).body?.item;
const cache = async () => (await sb.from("zoho_item").select("actual_available, stock_on_hand").eq("part_id", 1001).eq("status", "active").single()).data;
const ledger = async () => (await sb.from("stock_movement").select("delta, reason").eq("part_id", 1001)).data.filter((m) => !["reserve", "release"].includes(m.reason)).reduce((s, m) => s + m.delta, 0);
const ref = `RQ-TEST-${new Date().toISOString().slice(2, 10).replace(/-/g, "")}C`;
const z0 = await zstock(), c0 = await cache(), l0 = await ledger();
log(`start: Zoho 1001 physical ${z0.actual_available_stock} / accounting ${z0.stock_on_hand}; cache ${c0.actual_available}; CTP ledger ${l0}`);
const { data: o, error: oe } = await sb.from("sales_order").insert({ number: ref, customer_id: 7, location_id: 10, status: "confirmed", currency: "ZAR", tax_rate_bps: 1500,
  notes: "CTP CORE TEST — cut-over smoke test 26 Oct, deleted afterwards", client_uuid: crypto.randomUUID() }).select("id, number").single();
if (oe) { log(`order insert failed: ${oe.message}`); process.exit(1); }
const { error: le } = await sb.from("sales_line").insert({ order_id: o.id, part_id: 1001, qty: 1, unit_price_minor: 100, customer_id: 7 });
if (le) log(`line insert: ${le.message}`);
log(`CTP order ${o.number} (id ${o.id}) confirmed, 1 x 2803035B1063-DQ`);
const so = await za({ action: "inv_fixture", op: "so", reference: ref, item_id: "1429405000000102001", qty: 1 });
if (!so.ok) { log(`SO failed: ${JSON.stringify(so)}`); process.exit(1); }
const inv = await za({ action: "inv_fixture", op: "invoice_from_so", id: so.id });
if (!inv.ok) { log(`invoice failed: ${JSON.stringify(inv)}`); process.exit(1); }
log(`Zoho ${so.number} (open) → ${inv.number} (${inv.status})`);
await sb.from("sales_order").update({ zoho_salesorder_id: so.id, zoho_salesorder_number: so.number, zoho_so_status: "open", zoho_invoice_id: inv.id, zoho_invoice_number: inv.number,
  zoho_status: inv.status, fulfil_override_at: new Date().toISOString(), fulfil_override_note: "cut-over smoke test (TEST order; cash payment not recordable on our token)" }).eq("id", o.id);
const sh = await push({ action: "ship", order_id: o.id });
log(`ship: ${JSON.stringify(sh).slice(0, 400)}`);
await push({ action: "stock_sync", force: true });
const z1 = await zstock(), c1 = await cache(), l1 = await ledger();
const { data: o1 } = await sb.from("sales_order").select("status, zoho_package_number, zoho_shipment_number, zoho_shipment_status").eq("id", o.id).single();
log(`after ship: order ${o1.status} ${o1.zoho_package_number}/${o1.zoho_shipment_number} ${o1.zoho_shipment_status}; Zoho physical ${z1.actual_available_stock} / accounting ${z1.stock_on_hand}; cache ${c1.actual_available}; CTP ledger ${l1}`);
// void + clean up (shipment → package → invoice → SO → CTP order)
const res = sh.result ?? {};
for (const [kind, id] of [["shipment", res.shipment_id], ["package", res.package_id], ["invoice", inv.id], ["salesorder", so.id]]) {
  if (!id) { log(`cleanup: no ${kind} id`); continue; }
  const d = await za({ ...C, op: "delete", kind, id: String(id) });
  log(`cleanup ${kind} ${id}: ${d.ok ? (d.gone ? "already gone" : "deleted") : d.error}`);
}
await sb.from("sales_order").update({ deleted_at: new Date().toISOString(), zoho_do_not_push: true, status: "cancelled",
  staff_log: `[cut-over smoke test] Zoho ${so.number} ${inv.number} ${res.package_number ?? ""} ${res.shipment_number ?? ""} deleted` }).eq("id", o.id);
await push({ action: "stock_sync", force: true });
const z2 = await zstock(), c2 = await cache(), l2 = await ledger();
log(`end: Zoho physical ${z2.actual_available_stock} / accounting ${z2.stock_on_hand}; cache ${c2.actual_available}; CTP ledger ${l2}; net change ${z2.actual_available_stock - z0.actual_available_stock}`);
