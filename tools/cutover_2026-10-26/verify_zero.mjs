import fs from "node:fs"; import path from "node:path";
const B = "C:/Users/iancr/OneDrive/Desktop/CTP Zoho Backup 2026-10-26/zoho";
const J = (f) => JSON.parse(fs.readFileSync(path.join(B, f), "utf8"));
const call = async (b) => { const r = await fetch(`${process.env.SUPA_URL}/functions/v1/zoho-auth`, { method: "POST", headers: { Authorization: `Bearer ${process.env.SUPA_SR}`, "Content-Type": "application/json" }, body: JSON.stringify(b) }); return r.json(); };
const out = {};
const T = (await call({ action: "audit", part: "transactions" })).transactions;
out.transactions = Object.fromEntries(Object.entries(T).map(([k, v]) => [k, Array.isArray(v) ? v.length : "n/a"]));
for (const part of ["items", "contacts", "pricebook", "settings"]) {
  const now = await call({ action: "audit", part });
  const keys = Object.keys(now).filter((k) => Array.isArray(now[k]) || (now[k] && typeof now[k] === "object"));
  out[part] = Object.fromEntries(keys.map((k) => [k, Array.isArray(now[k]) ? now[k].length : Object.keys(now[k]).length]));
  fs.writeFileSync(path.join(B, `..`, `after_zero_${part}.json`), JSON.stringify(now));
}
const bi = J("items.json").items, ni = JSON.parse(fs.readFileSync(path.join(B, "..", "after_zero_items.json"))).items;
const nmap = Object.fromEntries(ni.map((i) => [i.item_id, i]));
out.items_compare = { backup: bi.length, now: ni.length, missing: bi.filter((i) => !nmap[i.item_id]).map((i) => i.sku),
  rate_changed: bi.filter((i) => nmap[i.item_id] && (nmap[i.item_id].rate !== i.rate || nmap[i.item_id].purchase_rate !== i.purchase_rate)).map((i) => i.sku),
  status_changed: bi.filter((i) => nmap[i.item_id] && nmap[i.item_id].status !== i.status).map((i) => i.sku),
  stock_nonzero_now: ni.filter((i) => Number(i.stock_on_hand) || Number(i.actual_available_stock)).map((i) => `${i.sku}:${i.stock_on_hand}/${i.actual_available_stock}`) };
console.log(JSON.stringify(out, null, 1));
