// Zoho Books, the little of it CTP Core needs: an access token from the refresh
// token, and three calls on sales orders.
//
//   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET   (a "Self Client" in api-console.zoho.com
//     with scope ZohoBooks.salesorders.ALL,ZohoBooks.contacts.READ)
//   ZOHO_ORG_ID          default 939422621 (China Truck Parts)
//   ZOHO_ACCOUNTS_URL    default https://accounts.zoho.com   (the org's data centre)
//   ZOHO_API_BASE        default https://www.zohoapis.com/books/v3
//
// THE REFRESH TOKEN IS NOT AN ENVIRONMENT VARIABLE ANY MORE (2026-09-26).
// It lives in integration_secret, key 'zoho_refresh_token', a table only the
// service role can read (RLS on, no policies). The reason is operational, not
// cryptographic: as an env var, every rotation meant a terminal, a curl and a
// three-minute authorisation code, and that is where it kept going wrong. In
// the table, the `zoho-connect` function can do the exchange server-side from a
// code pasted into the Supabase secrets box.
//
// ZOHO_REFRESH_TOKEN is still read as a fallback so an older deployment keeps
// working, but the database wins when both are present.

const ORG = Deno.env.get("ZOHO_ORG_ID") ?? "939422621";
const ACCOUNTS = (Deno.env.get("ZOHO_ACCOUNTS_URL") ?? "https://accounts.zoho.com").replace(/\/+$/, "");
const API = (Deno.env.get("ZOHO_API_BASE") ?? "https://www.zohoapis.com/books/v3").replace(/\/+$/, "");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

export const REFRESH_KEY = "zoho_refresh_token";

export class ZohoError extends Error {
  constructor(message: string, public status: number, public code?: number) { super(message); this.name = "ZohoError"; }
}

/** The refresh token: database first, environment second. Cached briefly so a
 *  burst of calls in one warm instance does not hammer PostgREST. */
let refreshCached: { token: string; until: number } | null = null;
export async function refreshTokenValue(): Promise<string | null> {
  if (refreshCached && Date.now() < refreshCached.until) return refreshCached.token;
  if (SUPABASE_URL && SERVICE_KEY) {
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/integration_secret?key=eq.${REFRESH_KEY}&select=value`,
        { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
      );
      if (r.ok) {
        const rows = await r.json().catch(() => []);
        const v = rows?.[0]?.value;
        if (typeof v === "string" && v.length > 0) {
          refreshCached = { token: v, until: Date.now() + 60_000 };
          return v;
        }
      }
    } catch { /* fall through to the environment */ }
  }
  return Deno.env.get("ZOHO_REFRESH_TOKEN") || null;
}

/** Store a freshly exchanged refresh token. Service role only, by table grant. */
export async function storeRefreshToken(token: string, note: string): Promise<void> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/integration_secret?on_conflict=key`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json", Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ key: REFRESH_KEY, value: token, note, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new ZohoError(`could not store the refresh token: ${r.status} ${await r.text()}`, 500);
  refreshCached = null;
}

/** Everything needed to talk to Books is present. */
export async function zohoConfigured(): Promise<boolean> {
  return !!(Deno.env.get("ZOHO_CLIENT_ID") && Deno.env.get("ZOHO_CLIENT_SECRET") && await refreshTokenValue());
}

// One access token per warm instance; refreshed a minute before Zoho says it expires.
let cached: { token: string; until: number } | null = null;
async function accessToken(): Promise<string> {
  if (cached && Date.now() < cached.until) return cached.token;
  const refresh = await refreshTokenValue();
  if (!refresh) throw new ZohoError("Zoho sign-in failed: no refresh token is stored", 503);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: Deno.env.get("ZOHO_CLIENT_ID")!,
    client_secret: Deno.env.get("ZOHO_CLIENT_SECRET")!,
    refresh_token: refresh,
  });
  const r = await fetch(`${ACCOUNTS}/oauth/v2/token`, { method: "POST", body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new ZohoError(`Zoho sign-in failed: ${j.error ?? r.status}`, 502);
  cached = { token: j.access_token, until: Date.now() + (Number(j.expires_in ?? 3600) - 60) * 1000 };
  return cached.token;
}

/** Swap a short-lived authorisation code for a refresh token. Used once per
 *  rotation by `zoho-connect`; the code is good for about three minutes. */
export async function exchangeAuthorisationCode(code: string): Promise<{ refresh_token: string; expires_in: number }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: Deno.env.get("ZOHO_CLIENT_ID") ?? "",
    client_secret: Deno.env.get("ZOHO_CLIENT_SECRET") ?? "",
    code,
  });
  const r = await fetch(`${ACCOUNTS}/oauth/v2/token`, { method: "POST", body });
  const j = await r.json().catch(() => ({})) as Record<string, unknown>;
  if (!r.ok || typeof j.refresh_token !== "string") {
    // Zoho answers 200 with an `error` field, so the status alone proves nothing.
    throw new ZohoError(String(j.error ?? `HTTP ${r.status}`), 400);
  }
  return { refresh_token: j.refresh_token, expires_in: Number(j.expires_in ?? 0) };
}

async function call<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await accessToken();
  const url = `${API}${path}${path.includes("?") ? "&" : "?"}organization_id=${ORG}`;
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({})) as Record<string, unknown> & { code?: number; message?: string };
  if (!r.ok || (typeof j.code === "number" && j.code !== 0)) {
    throw new ZohoError(`Zoho ${method} ${path}: ${j.message ?? r.statusText} (${j.code ?? r.status})`, r.status || 502, j.code);
  }
  return j as T;
}

export type ZohoLine = { item_id: string; quantity: number; rate: number; description?: string; discount?: string };
export type ZohoSalesOrder = { salesorder_id: string; salesorder_number: string; status: string; total: number; reference_number?: string };

/** An existing sales order for this CTP order number, if a previous attempt got that far. */
export async function findSalesOrderByReference(reference: string): Promise<ZohoSalesOrder | null> {
  const j = await call<{ salesorders: ZohoSalesOrder[] }>("GET", `/salesorders?reference_number=${encodeURIComponent(reference)}`);
  const live = (j.salesorders ?? []).filter((s) => s.status !== "void" && s.status !== "cancelled");
  return live[0] ?? null;
}

export async function createSalesOrder(p: {
  customer_id: string; reference_number: string; date: string; line_items: ZohoLine[]; notes?: string;
}): Promise<ZohoSalesOrder> {
  const j = await call<{ salesorder: ZohoSalesOrder }>("POST", "/salesorders", { ...p, is_inclusive_tax: false });
  return j.salesorder;
}

/** The compensation: a sales order that CTP could not record is removed again. */
export async function deleteSalesOrder(salesorderId: string): Promise<void> {
  await call("DELETE", `/salesorders/${salesorderId}`);
}
