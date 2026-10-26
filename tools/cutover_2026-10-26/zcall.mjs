// zoho-auth cutover op. bash env.sh node zcall.mjs '<json extra>' [maxchars]
const extra = JSON.parse(process.argv[2]);
const r = await fetch(`${process.env.SUPA_URL}/functions/v1/zoho-auth`, { method: "POST", headers: { Authorization: `Bearer ${process.env.SUPA_SR}`, "Content-Type": "application/json" },
  body: JSON.stringify({ action: "cutover", confirm: "GO ZERO 2026-10-26", ...extra }) });
const t = await r.text(); console.log(r.status, t.slice(0, Number(process.argv[3] ?? 6000)));
