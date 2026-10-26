// Posts the ONE opening-stock adjustment from opening_stock.csv (recommended qty, purchase rate). --run to post.
import fs from "node:fs";
const B = "C:/Users/iancr/OneDrive/Desktop/CTP Zoho Backup 2026-10-26";
const rows = fs.readFileSync(`${B}/opening_stock.csv`, "utf8").split("\n").filter(Boolean);
const h = rows[0].split(",");
const parse = (l) => l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"'));
const recs = rows.slice(1).map((l) => Object.fromEntries(parse(l).map((v, i) => [h[i], v])));
const skip = recs.filter((r) => r.zoho_tracked !== "true" || !r.zoho_item_id);
const lines = recs.filter((r) => r.zoho_tracked === "true" && r.zoho_item_id && Number(r.opening_qty_recommended) > 0)
  .map((r) => ({ item_id: r.zoho_item_id, qty: Number(r.opening_qty_recommended), rate: Number(r.purchase_rate) || 0, sku: r.sku }));
const units = lines.reduce((s, l) => s + l.qty, 0), value = lines.reduce((s, l) => s + l.qty * l.rate, 0);
console.log(JSON.stringify({ csv_lines: recs.length, posted_lines: lines.length, units, value: +value.toFixed(2), skipped: skip.map((r) => `${r.sku} qty ${r.opening_qty_recommended}: ${r.note}`) }));
if (process.argv.includes("--run")) {
  const r = await fetch(`${process.env.SUPA_URL}/functions/v1/zoho-auth`, { method: "POST", headers: { Authorization: `Bearer ${process.env.SUPA_SR}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "cutover", confirm: "GO ZERO 2026-10-26", op: "opening_stock", date: "2026-10-26", reason: "Opening stock — cut-over 26 Oct 2026",
      lines: lines.map(({ item_id, qty, rate }) => ({ item_id, qty, rate })) }) });
  const t = await r.text(); console.log(r.status, t); fs.appendFileSync(`${B}/ZERO_LOG.txt`, `${new Date().toISOString()} opening stock: ${t}\n`);
}
