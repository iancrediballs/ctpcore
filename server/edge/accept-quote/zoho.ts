// Zoho Books, the little of it CTP Core needs: an access token from the refresh
// token, and four calls on sales orders. Secrets come from the function's
// environment, set by Ian in the Supabase dashboard — never from a request,
// never from the database, never through a chat.
//
//   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN   (a "Self Client" in
//     api-console.zoho.com with scope ZohoBooks.salesorders.ALL, ZohoBooks.contacts.READ)
//   ZOHO_ORG_ID          default 939422621 (China Truck Parts)
//   ZOHO_ACCOUNTS_URL    default https://accounts.zoho.com   (the org's data centre)
//   ZOHO_API_BASE        default https://www.zohoapis.com/books/v3

const ORG = Deno.env.get("ZOHO_ORG_ID") ?? "939422621";
const ACCOUNTS = (Deno.env.get("ZOHO_ACCOUNTS_URL") ?? "https://accounts.zoho.com").replace(/\/+$/, "");
const API = (Deno.env.get("ZOHO_API_BASE") ?? "https://www.zohoapis.com/books/v3").replace(/\/+$/, "");

export class ZohoError extends Error {
  constructor(message: string, public status: number, public code?: number) { super(message); this.name = "ZohoError"; }
}

export function zohoConfigured(): boolean {
  return !!(Deno.env.get("ZOHO_CLIENT_ID") && Deno.env.get("ZOHO_CLIENT_SECRET") && Deno.env.get("ZOHO_REFRESH_TOKEN"));
}

// One token per warm instance; refreshed a minute before Zoho says it expires.
let cached: { token: string; until: number } | null = null;
async function accessToken(): Promise<string> {
  if (cached && Date.now() < cached.until) return cached.token;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: Deno.env.get("ZOHO_CLIENT_ID")!,
    client_secret: Deno.env.get("ZOHO_CLIENT_SECRET")!,
    refresh_token: Deno.env.get("ZOHO_REFRESH_TOKEN")!,
  });
  const r = await fetch(`${ACCOUNTS}/oauth/v2/token`, { method: "POST", body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new ZohoError(`Zoho sign-in failed: ${j.error ?? r.status}`, 502);
  cached = { token: j.access_token, until: Date.now() + (Number(j.expires_in ?? 3600) - 60) * 1000 };
  return cached.token;
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

/** Draft → open, so the number is committed and it can be emailed / invoiced. Best effort. */
export async function markOpen(salesorderId: string): Promise<void> {
  await call("POST", `/salesorders/${salesorderId}/status/open`);
}

/** Zoho emails its own PDF from the org's sales-order template. */
export async function emailSalesOrder(salesorderId: string, to: string[], subject?: string, body?: string): Promise<void> {
  await call("POST", `/salesorders/${salesorderId}/email`, { to_mail_ids: to, subject, body, send_from_org_email_id: true });
}

/** The compensation: a sales order that CTP could not record is removed again. */
export async function deleteSalesOrder(salesorderId: string): Promise<void> {
  await call("DELETE", `/salesorders/${salesorderId}`);
}
