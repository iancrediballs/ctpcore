import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
const LOG = "C:/Users/iancr/OneDrive/Desktop/CTP Zoho Backup 2026-10-26/ZERO_LOG.txt";
const log = (s) => { const l = `${new Date().toISOString()} smoke: ${s}`; console.log(l); fs.appendFileSync(LOG, l + "\n"); };
const sb = createClient(process.env.SUPA_URL, process.env.SUPA_SR, { auth: { persistSession: false } });
const za = async (b) => { const r = await fetch(`${process.env.SUPA_URL}/functions/v1/zoho-auth`, { method: "POST", headers: { Authorization: `Bearer ${process.env.SUPA_SR}`, "Content-Type": "application/json" }, body: JSON.stringify(b) }); return r.json(); };
const C = { action: "cutover", confirm: "GO ZERO 2026-10-26" };
const { data: o } = await sb.from("sales_order").select("zoho_package_id, zoho_shipment_id, zoho_salesorder_id").eq("id", 66).single();
log(`order 66 links: ${JSON.stringify(o)}`);
for (const [kind, id] of [["shipment", o.zoho_shipment_id], ["package", o.zoho_package_id], ["salesorder", o.zoho_salesorder_id]]) {
  if (!id) { log(`cleanup: no ${kind} id`); continue; }
  const d = await za({ ...C, op: "delete", kind, id: String(id) });
  log(`cleanup ${kind} ${id}: ${d.ok ? (d.gone ? "already gone" : "deleted") : d.error}`);
}
await za({ ...C, op: "push", push: { action: "stock_sync", force: true } });
const z = (await za({ action: "inv_get", path: "/items/1429405000000102001" })).body?.item;
const list = (await za({ action: "inv_get", path: "/items?search_text=2803035B1063-DQ" })).body?.items?.[0];
const { data: c } = await sb.from("zoho_item").select("actual_available, stock_on_hand, available_stock, stock_synced_at").eq("part_id", 1001).eq("status", "active").single();
log(`end: item detail physical ${z.actual_available_stock} / accounting ${z.stock_on_hand}; list physical ${list?.actual_available_stock} / accounting ${list?.stock_on_hand}; cache ${JSON.stringify(c)}`);
const T = (await za({ action: "audit", part: "transactions" })).transactions;
log(`Zoho docs now: ${Object.entries(T).filter(([, v]) => Array.isArray(v) && v.length).map(([k, v]) => `${k} ${v.length}`).join(", ") || "none"}`);
