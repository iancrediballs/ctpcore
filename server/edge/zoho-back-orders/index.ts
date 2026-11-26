// CTP Core — 0097: back-order stock. Zoho POs ticked "Back order" → zoho_back_order_line.
//
//   { "action": "sync", "force"?: true }   staff (the part sheet's Refresh) or the server token (cron, every 10 min)
//   { "action": "hook", "module": "purchaseorder|bill|purchasereceive", "id": "…" }   from zoho-hook (anon key):
//                                          trusts nothing but that it was called; re-reads Zoho, at most once a minute
//
// Its own function so it ships without redeploying zoho-push. Same Zoho token path (_shared/zoho.ts).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { env, zohoInit, zohoMissing, type Logger } from "../_shared/zoho.ts";
import { backOrderSync } from "./sync.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sync-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function authorise(req: Request, db: SupabaseClient) {
  const syncToken = env("ZOHO_SYNC_TOKEN");
  if (syncToken && req.headers.get("x-sync-token") === syncToken) return { ok: true, actor: null as string | null };
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data } = jwt ? await db.auth.getUser(jwt) : { data: null };
  if (!data?.user) return { ok: false, actor: null };
  const { data: me } = await db.from("app_user").select("role").eq("id", data.user.id).maybeSingle();
  return { ok: ["sales", "warehouse", "manager", "admin"].includes(me?.role ?? ""), actor: data.user.id as string | null };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  const body = await req.json().catch(() => ({}));
  const hook = body.action === "hook";
  const who = hook ? { ok: true, actor: null as string | null } : await authorise(req, db);
  if (!who.ok) return json({ error: "Staff only" }, who.actor ? 403 : 401);
  if (!hook && body.action !== "sync") return json({ error: `Unknown action ${body.action}` }, 400);
  const log: Logger = async (r) => { await db.from("zoho_push_log").insert({ ...r, actor: who.actor }); };
  await zohoInit(db);
  const missing = zohoMissing();
  if (missing.length) return json({ ok: false, error: `Zoho is not connected yet. Missing secrets: ${missing.join(", ")}` }, 412);
  try {
    const minAge = hook ? 60_000 : body.force === true ? 0 : 10 * 60_000;
    return json({ ok: true, ...(await backOrderSync(db, log, minAge)) });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
