// CTP Core — staff and access management.
//
// Creating a login, changing someone's role and removing access all require the
// service-role key, which must never reach a browser. So this runs server-side
// and is the ONLY route the app has to those operations.
//
// AUTH, two layers:
//   1. verify_jwt is ON, so Supabase rejects anything without a valid session
//      before this code runs at all.
//   2. That session's user is then looked up in app_user and must be 'admin'.
//      Being signed in is not enough — a warehouse login reaching this endpoint
//      gets 403. The check is done with the service client against the database,
//      never from a claim in the token the caller supplied.
//
// A note on what this deliberately does NOT do: it never returns a password and
// never sets one. New staff are invited by email and choose their own. There is
// no code path here that can hand anyone a credential.
//
// 2026-09-14, two faults fixed:
//   * No CORS. The browser's preflight (OPTIONS) got "405 POST only" with no
//     Access-Control-Allow-Origin, so the browser refused to send the real
//     request and every action — list, invite, change role, remove — failed
//     with "Failed to send a request to the Edge Function". Settings showed
//     "Nobody listed" and nobody could be invited. Every response now carries
//     the CORS headers and OPTIONS is answered with 204.
//   * The invite / reset link defaulted to ctp-core.vercel.app, a domain that
//     no longer resolves. The link is a setting — company.app_url, migration
//     0031 — read here the same way the notify function reads it, with the
//     live domain as the last resort only.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FALLBACK_SITE_URL = "https://ctpcore.vercel.app";

const ROLES = ["customer", "sales", "warehouse", "manager", "admin"] as const;
type Role = (typeof ROLES)[number];

// The browser sends the session token, the anon key and a client-info header;
// the preflight must say all three are welcome, or the real request never goes.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

const admin = () =>
  createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

// Where invite and reset emails send people. A setting, not a constant.
async function siteUrl(client: ReturnType<typeof admin>): Promise<string> {
  try {
    const { data, error } = await client
      .from("company").select("app_url").eq("id", 1).maybeSingle();
    const url = (data?.app_url ?? "").trim();
    if (error || !url) return FALLBACK_SITE_URL;
    return url.replace(/\/+$/, "");
  } catch (e) {
    console.warn("could not read company.app_url:", String(e));
    return FALLBACK_SITE_URL;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Not signed in" }, 401);

  const client = admin();

  // Who is calling?
  const { data: caller, error: callerErr } = await client.auth.getUser(token);
  if (callerErr || !caller?.user) return json({ error: "Not signed in" }, 401);

  // Are they allowed? Read the database, not the token.
  const { data: me } = await client
    .from("app_user").select("role").eq("id", caller.user.id).maybeSingle();
  if (me?.role !== "admin") {
    return json({ error: "Only an administrator can manage staff" }, 403);
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const action = String(body.action ?? "");

  try {
    // ── list ──────────────────────────────────────────────────────────────
    if (action === "list") {
      const { data: authUsers, error } = await client.auth.admin.listUsers({ perPage: 200 });
      if (error) throw error;
      const { data: rows } = await client
        .from("app_user").select("id, role, display_name, created_at");
      const byId = new Map((rows ?? []).map((r) => [r.id, r]));

      const users = authUsers.users.map((u) => {
        const r = byId.get(u.id);
        return {
          id: u.id,
          email: u.email,
          role: r?.role ?? null,           // null = signed up but never given a role
          display_name: r?.display_name ?? null,
          last_sign_in_at: u.last_sign_in_at,
          confirmed: !!u.email_confirmed_at,
          created_at: u.created_at,
        };
      });

      // Rows in app_user with no matching login are stale leftovers; surface
      // them rather than hiding them, so they can be cleaned up.
      const authIds = new Set(authUsers.users.map((u) => u.id));
      const orphans = (rows ?? []).filter((r) => !authIds.has(r.id));

      return json({ users, orphans });
    }

    // ── invite ────────────────────────────────────────────────────────────
    if (action === "invite") {
      const email = String(body.email ?? "").trim().toLowerCase();
      const role = String(body.role ?? "") as Role;
      const name = String(body.display_name ?? "").trim();

      if (!email.includes("@")) return json({ error: "That is not an email address" }, 400);
      if (!ROLES.includes(role)) return json({ error: "Unknown role" }, 400);

      const { data: invited, error } = await client.auth.admin.inviteUserByEmail(email, {
        redirectTo: await siteUrl(client),
      });
      if (error) {
        // Already-registered is the common case and deserves a human sentence.
        const msg = /already been registered|already exists/i.test(error.message)
          ? "That email already has a login. Change their role instead."
          : error.message;
        return json({ error: msg }, 400);
      }

      await client.from("app_user").upsert({
        id: invited.user.id,
        role,
        display_name: name || email.split("@")[0],
      });

      return json({ ok: true, id: invited.user.id, email, role });
    }

    // ── change role ───────────────────────────────────────────────────────
    if (action === "set_role") {
      const id = String(body.id ?? "");
      const role = String(body.role ?? "") as Role;
      if (!ROLES.includes(role)) return json({ error: "Unknown role" }, 400);

      // Never let the last administrator demote themselves out of the system.
      if (id === caller.user.id && role !== "admin") {
        const { count } = await client
          .from("app_user").select("id", { count: "exact", head: true }).eq("role", "admin");
        if ((count ?? 0) <= 1) {
          return json({ error: "You are the only administrator. Promote someone else first." }, 400);
        }
      }

      const { error } = await client.from("app_user")
        .upsert({ id, role, display_name: body.display_name ?? undefined });
      if (error) throw error;
      return json({ ok: true });
    }

    // ── remove access ─────────────────────────────────────────────────────
    if (action === "remove") {
      const id = String(body.id ?? "");
      if (id === caller.user.id) {
        return json({ error: "You cannot remove your own access" }, 400);
      }
      const { count } = await client
        .from("app_user").select("id", { count: "exact", head: true }).eq("role", "admin");
      const { data: victim } = await client
        .from("app_user").select("role").eq("id", id).maybeSingle();
      if (victim?.role === "admin" && (count ?? 0) <= 1) {
        return json({ error: "That is the last administrator. Promote someone else first." }, 400);
      }

      // Order matters: drop the role row first, so that if deleting the login
      // fails the account is already powerless rather than still privileged.
      await client.from("app_user").delete().eq("id", id);
      const { error } = await client.auth.admin.deleteUser(id);
      if (error) throw error;
      return json({ ok: true });
    }

    // ── send a fresh invite / password reset ──────────────────────────────
    if (action === "resend_invite") {
      const email = String(body.email ?? "").trim().toLowerCase();
      const { error } = await client.auth.admin.generateLink({
        type: "recovery", email, options: { redirectTo: await siteUrl(client) },
      });
      if (error) throw error;
      return json({ ok: true });
    }

    return json({ error: `Unknown action '${action}'` }, 400);
  } catch (e) {
    console.error(action, e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
