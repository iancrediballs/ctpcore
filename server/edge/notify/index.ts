// CTP Core — the notification relay.
//
// A database trigger (0023) fires this on order events; this turns the event
// into an email via Resend. It lives in an Edge Function rather than in the
// trigger itself so the RESEND_API_KEY stays in function secrets — never in a
// table, never in SQL, never in the repo.
//
// AUTH: verify_jwt is OFF because the caller is Postgres, not a person — but
// that does NOT mean unauthenticated. The trigger sends a shared secret in
// x-notify-token, minted once in 0023 and stored in Supabase Vault; anything
// without it gets a 401. Without this check, anyone on the internet could make
// the business send itself email.
//
// 2026-09-05: recipients and per-event switches moved out of environment
// variables into the `notify_setting` table, so an owner can change who gets
// order email from inside the app instead of asking a developer to edit
// function secrets. The API KEY stays in secrets — a key in a database row is
// a key in every backup.
//
// 2026-09-14: the app link in these emails was hardcoded to a domain that no
// longer resolves (`ctp-core.vercel.app`, freed when the Vercel project was
// renamed) so every link sent to a customer 404'd. Migration 0031 had already
// moved the canonical URL onto `company.app_url` for exactly this reason; this
// function simply never read it. It does now. The constant below is a last
// resort for when the row can't be read at all — if the domain changes again,
// change the SETTING, not this file.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const NOTIFY_TOKEN = Deno.env.get("NOTIFY_TOKEN") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Fallbacks only — used when the settings row cannot be read at all.
const FALLBACK_TO = Deno.env.get("NOTIFY_TO") ?? "iancrediblemusic@gmail.com";
// Without a verified domain Resend only delivers from its onboarding sender —
// fine for internal alerts. Swap once a CTP domain is verified in Resend.
const FROM_ADDRESS = Deno.env.get("NOTIFY_FROM_ADDRESS") ?? "onboarding@resend.dev";
const FALLBACK_APP_URL = "https://ctpcore.vercel.app";

type OrderEvent = {
  kind: "request_received" | "quote_accepted" | "quote_declined" | "test";
  number: string;
  customer: string;
  contact?: string | null;
  lines?: number;
  total_zar?: string | null;
  note?: string | null;
};

type Settings = {
  enabled: boolean;
  recipients: string[];
  from_name: string;
  reply_to: string | null;
  on_request: boolean;
  on_quote_accepted: boolean;
  on_quote_declined: boolean;
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function db() {
  if (!SUPABASE_URL || !SERVICE_KEY) return null;
  try {
    return createClient(SUPABASE_URL, SERVICE_KEY);
  } catch (e) {
    console.warn("could not create db client:", String(e));
    return null;
  }
}

async function loadSettings(): Promise<Settings | null> {
  const client = db();
  if (!client) return null;
  try {
    const { data, error } = await client
      .from("notify_setting")
      .select(
        "enabled, recipients, from_name, reply_to, on_request, on_quote_accepted, on_quote_declined",
      )
      .eq("id", 1)
      .maybeSingle();
    if (error || !data) return null;
    return data as Settings;
  } catch (e) {
    console.warn("could not read notify_setting:", String(e));
    return null;
  }
}

// The app URL is a setting, not a constant. A dead link in a customer's inbox
// is worse than no link, so this falls back to the known-good domain rather
// than emitting an empty href.
async function loadAppUrl(): Promise<string> {
  const client = db();
  if (!client) return FALLBACK_APP_URL;
  try {
    const { data, error } = await client
      .from("company")
      .select("app_url")
      .eq("id", 1)
      .maybeSingle();
    const url = (data?.app_url ?? "").trim();
    if (error || !url) return FALLBACK_APP_URL;
    return url.replace(/\/+$/, "");
  } catch (e) {
    console.warn("could not read company.app_url:", String(e));
    return FALLBACK_APP_URL;
  }
}

function wantsEvent(s: Settings, kind: OrderEvent["kind"]): boolean {
  if (kind === "test") return true; // a test is an explicit human action
  if (kind === "request_received") return s.on_request;
  if (kind === "quote_accepted") return s.on_quote_accepted;
  if (kind === "quote_declined") return s.on_quote_declined;
  return true;
}

function render(e: OrderEvent, app: string): { subject: string; html: string } {
  const who = esc(e.customer) + (e.contact ? ` (${esc(e.contact)})` : "");
  const link = esc(app);

  if (e.kind === "test") {
    return {
      subject: "CTP Core — test email",
      html: `<h2>Notifications are working</h2>
        <p>This test was sent from Settings by <b>${esc(e.customer)}</b>.</p>
        <p>Order emails will reach this address.</p>
        <p><a href="${link}">${link}</a></p>`,
    };
  }
  if (e.kind === "request_received") {
    return {
      subject: `New parts request ${e.number} from ${e.customer}`,
      html: `<h2>New request: ${esc(e.number)}</h2>
        <p><b>${who}</b> sent a request with <b>${e.lines ?? "?"} line(s)</b>.</p>
        ${e.note ? `<p>Their note: <i>${esc(e.note)}</i></p>` : ""}
        <p>Price it in the app → Orders → <b>Needs pricing</b>.</p>
        <p><a href="${link}">${link}</a></p>`,
    };
  }
  if (e.kind === "quote_accepted") {
    return {
      subject: `✅ ${e.number} ACCEPTED by ${e.customer}${e.total_zar ? ` — R${e.total_zar}` : ""}`,
      html: `<h2>Quote accepted: ${esc(e.number)}</h2>
        <p><b>${who}</b> accepted${e.total_zar ? ` — <b>R${esc(e.total_zar)}</b> excl VAT` : ""}.</p>
        <p><b>Warehouse:</b> this order is ready to pick.</p>
        <p><a href="${link}">${link}</a></p>`,
    };
  }
  return {
    subject: `${e.number} declined by ${e.customer}`,
    html: `<h2>Quote declined: ${esc(e.number)}</h2>
      <p><b>${who}</b> declined the quote. Worth a call to ${esc(e.contact ?? "them")}?</p>`,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("nope", { status: 405 });

  if (!NOTIFY_TOKEN || req.headers.get("x-notify-token") !== NOTIFY_TOKEN) {
    return new Response("unauthorized", { status: 401 });
  }

  let event: OrderEvent;
  try {
    event = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, reason: "bad json" }), { status: 200 });
  }

  const settings = await loadSettings();

  if (settings && !settings.enabled) {
    console.log("notifications disabled in settings — event received, nothing sent");
    return new Response(JSON.stringify({ ok: false, reason: "disabled" }), { status: 200 });
  }
  if (settings && !wantsEvent(settings, event.kind)) {
    console.log(`event ${event.kind} switched off in settings`);
    return new Response(JSON.stringify({ ok: false, reason: "event off" }), { status: 200 });
  }

  const to = settings?.recipients?.length ? settings.recipients : [FALLBACK_TO];
  const fromName = settings?.from_name?.trim() || "CTP Core";

  if (!RESEND_KEY) {
    // Configured-off is a state, not an error: the trigger keeps firing and
    // this says so in the logs without failing the database's HTTP call.
    console.warn("RESEND_API_KEY not set — event received but no email sent");
    return new Response(JSON.stringify({ ok: false, reason: "no api key" }), { status: 200 });
  }

  const appUrl = await loadAppUrl();
  const { subject, html } = render(event, appUrl);

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${fromName} <${FROM_ADDRESS}>`,
        to,
        subject,
        html,
        ...(settings?.reply_to ? { reply_to: settings.reply_to } : {}),
      }),
    });
    const body = await res.text();
    if (!res.ok) {
      console.error("resend rejected:", res.status, body);
      return new Response(JSON.stringify({ ok: false, status: res.status, body }), { status: 200 });
    }
    console.log(`sent ${event.kind} to ${to.join(", ")}`);
    return new Response(JSON.stringify({ ok: true, to }), { status: 200 });
  } catch (e) {
    // Still 200: the caller is a database trigger, and a mail outage must never
    // roll back an order.
    console.error("send failed:", String(e));
    return new Response(JSON.stringify({ ok: false, reason: String(e) }), { status: 200 });
  }
});
