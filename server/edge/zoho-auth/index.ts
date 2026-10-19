// CTP Core — swap a Zoho Self Client grant code for a refresh token (19 Oct 2026).
//
// The code expires minutes after it is generated, so the exchange is one call:
//   POST { "code": "1000.xxxx" }   (service_role JWT, or a signed-in admin; verify_jwt ON)
//
//   * The data centre is found by trying each Zoho accounts server in turn; a
//     code only works on its own DC, and a wrong DC never spends it.
//   * The refresh token goes straight into Supabase Vault (zoho_secret_put,
//     0048) and the DC into zoho_config.dc. zoho-push / zoho-sync read both.
//   * Then the new access token is used once to list the organisations, to
//     prove ZOHO_ORG_ID is reachable with it.
//   * The code and the tokens are never logged and never returned.
//
// POST { "action": "status" } says whether a token is stored, nothing more.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

const env = (k: string) => Deno.env.get(k) ?? "";
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

// accounts server per DC; the API host follows from it
const DCS: [string, string][] = [
  ["com", "https://accounts.zoho.com"], ["eu", "https://accounts.zoho.eu"],
  ["in", "https://accounts.zoho.in"], ["com.au", "https://accounts.zoho.com.au"],
  ["jp", "https://accounts.zoho.jp"], ["ca", "https://accounts.zohocloud.ca"],
  ["sa", "https://accounts.zoho.sa"], ["uk", "https://accounts.zoho.uk"],
  ["com.cn", "https://accounts.zoho.com.cn"],
];

async function isAdmin(req: Request, db: SupabaseClient): Promise<boolean> {
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!bearer) return false;
  // deployed WITH verify_jwt: the gateway has already checked the signature,
  // so a service_role claim here is genuine
  try {
    const claims = JSON.parse(atob(bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (claims.role === "service_role") return true;
  } catch { /* not a JWT */ }
  const { data } = await db.auth.getUser(bearer);
  if (!data?.user) return false;
  const { data: me } = await db.from("app_user").select("role").eq("id", data.user.id).maybeSingle();
  return me?.role === "admin";
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  if (!(await isAdmin(req, db))) return json({ error: "Admin only" }, 401);
  const body = await req.json().catch(() => ({}));

  if (body.action === "status") {
    const { data: tok } = await db.rpc("zoho_secret_get", { p_name: "zoho_refresh_token" });
    const { data: cfg } = await db.from("zoho_config").select("dc").eq("id", 1).maybeSingle();
    return json({ ok: true, refresh_token_stored: !!tok, dc: cfg?.dc ?? null,
                  client: !!env("ZOHO_CLIENT_ID") && !!env("ZOHO_CLIENT_SECRET"), org: env("ZOHO_ORG_ID") || null });
  }

  const code = String(body.code ?? "").trim();
  if (!code) return json({ ok: false, error: "No code given" }, 400);
  if (!env("ZOHO_CLIENT_ID") || !env("ZOHO_CLIENT_SECRET")) {
    return json({ ok: false, error: "ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET secrets missing" }, 412);
  }

  const tried: { dc: string; error: string }[] = [];
  for (const [dc, accounts] of DCS) {
    const p = new URLSearchParams({
      grant_type: "authorization_code", code,
      client_id: env("ZOHO_CLIENT_ID"), client_secret: env("ZOHO_CLIENT_SECRET"),
    });
    let b: Record<string, unknown> = {};
    try {
      const r = await fetch(`${accounts}/oauth/v2/token`, { method: "POST", body: p });
      b = await r.json().catch(() => ({}));
    } catch (e) {
      tried.push({ dc, error: "unreachable" });
      continue;
    }
    if (!b.refresh_token) {
      tried.push({ dc, error: String(b.error ?? (b.access_token ? "no refresh_token (code already used?)" : "no token")) });
      continue;
    }

    const { error: putErr } = await db.rpc("zoho_secret_put", { p_name: "zoho_refresh_token", p_value: String(b.refresh_token) });
    if (putErr) return json({ ok: false, dc, error: `token received but not stored: ${putErr.message}` }, 500);
    await db.from("zoho_config").update({ dc, updated_at: new Date().toISOString() }).eq("id", 1);

    // prove the org is reachable
    const apiDomain = String(b.api_domain ?? (dc === "ca" ? "https://www.zohoapis.ca" : `https://www.zohoapis.${dc}`));
    const api = (env("ZOHO_API") || "inventory").toLowerCase() === "books" ? "books/v3" : "inventory/v1";
    let orgs: { id: string; name: string }[] = [];
    let orgError: string | null = null;
    try {
      const r = await fetch(`${apiDomain}/${api}/organizations`, { headers: { Authorization: `Zoho-oauthtoken ${b.access_token}` } });
      const o = await r.json().catch(() => ({}));
      if (!r.ok || (o.code !== undefined && o.code !== 0)) orgError = `${r.status}: ${o.message ?? "no message"}`;
      // deno-lint-ignore no-explicit-any
      orgs = ((o.organizations ?? []) as any[]).map((x) => ({ id: String(x.organization_id), name: String(x.name) }));
    } catch (e) {
      orgError = e instanceof Error ? e.message : String(e);
    }
    const org = env("ZOHO_ORG_ID");
    return json({
      ok: true, dc, api_domain: apiDomain, api, scope: b.scope ?? null,
      org_id: org, org_found: orgs.some((x) => x.id === org), organizations: orgs, org_error: orgError,
      tried,
    });
  }
  return json({ ok: false, error: "No Zoho data centre accepted the code", tried }, 400);
});
