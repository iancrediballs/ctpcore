// zoho-push via zoho-auth's cut-over relay (server caller). bash env.sh node push.mjs '<json body>' [maxchars]
const body = JSON.parse(process.argv[2]);
const r = await fetch(`${process.env.SUPA_URL}/functions/v1/zoho-auth`, { method: "POST", headers: { Authorization: `Bearer ${process.env.SUPA_SR}`, "Content-Type": "application/json" },
  body: JSON.stringify({ action: "cutover", confirm: "GO ZERO 2026-10-26", op: "push", push: body }) });
const txt = await r.text(); console.log(r.status, txt.slice(0, Number(process.argv[3] ?? 4000)));
