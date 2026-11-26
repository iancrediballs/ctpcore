// CTP Core — public endpoint for Zoho Inventory workflow-rule webhooks (23 Oct 2026, docs/10).
//
// Deployed with verify_jwt OFF so Zoho needs no key: Ian pastes only the URL and a one-line body.
// Safe because it does nothing itself: it forwards {module, id} to zoho-push's "hook" action (PO, bill and
// receive also to zoho-back-orders, 0097), which trusts nothing but the record id, re-reads that record
// from Zoho with CTP's own token, and is throttled per record. Accepts the id in the JSON body or as ?module=…&id=… query parameters.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const MODULES = new Set(["item", "salesorder", "invoice", "estimate", "package", "shipment", "bill", "purchasereceive", "adjustment", "purchaseorder"]);
const BACK_ORDER = new Set(["purchaseorder", "bill", "purchasereceive"]);

Deno.serve(async (req: Request) => {
  if (req.method !== "POST" && req.method !== "GET") return new Response("POST", { status: 405 });
  const u = new URL(req.url);
  let b: Record<string, unknown> = {};
  if (req.method === "POST") {
    const t = await req.text();
    try { b = JSON.parse(t); } catch { b = Object.fromEntries(new URLSearchParams(t)); }
  }
  const module = String(b.module ?? u.searchParams.get("module") ?? "").toLowerCase();
  const id = String(b.id ?? u.searchParams.get("id") ?? "");
  if (!MODULES.has(module) || !/^\d{6,25}$/.test(id)) {
    return new Response(JSON.stringify({ ok: false, error: "module and a numeric id are required" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const call = (fn: string) => fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/${fn}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${anon}`, apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "hook", module, id }),
  }).then((r) => r.text()).catch((e) => JSON.stringify({ ok: false, error: String(e) }));
  // 0097: a PO, bill or receive changes what is still incoming → the back-order sync too
  const [push, back] = await Promise.all([
    module === "purchaseorder" ? Promise.resolve(null) : call("zoho-push"),
    BACK_ORDER.has(module) ? call("zoho-back-orders") : Promise.resolve(null),
  ]);
  const out = back === null ? push! : push === null ? back : `{"push":${push},"back_orders":${back}}`;
  // Always 200 to Zoho: a record CTP cannot read must not make Zoho retry-storm or disable the rule.
  return new Response(out, { status: 200, headers: { "Content-Type": "application/json" } });
});
