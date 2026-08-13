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
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const NOTIFY_TOKEN = Deno.env.get("NOTIFY_TOKEN") ?? "";
const TO = Deno.env.get("NOTIFY_TO") ?? "iancrediblemusic@gmail.com";
// Without a verified domain Resend only delivers from its onboarding sender —
// fine for internal alerts. Swap once a CTP domain is verified in Resend.
const FROM = Deno.env.get("NOTIFY_FROM") ?? "CTP Core <onboarding@resend.dev>";

type OrderEvent = {
  kind: "request_received" | "quote_accepted" | "quote_declined";
  number: string;
  customer: string;
  contact?: string | null;
  lines?: number;
  total_zar?: string | null;
  note?: string | null;
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function render(e: OrderEvent): { subject: string; html: string } {
  const who = esc(e.customer) + (e.contact ? ` (${esc(e.contact)})` : "");
  const app = "https://ctp-core.vercel.app";
  if (e.kind === "request_received") {
    return {
      subject: `New parts request ${e.number} from ${e.customer}`,
      html: `<h2>New request: ${esc(e.number)}</h2>
        <p><b>${who}</b> sent a request with <b>${e.lines ?? "?"} line(s)</b>.</p>
        ${e.note ? `<p>Their note: <i>${esc(e.note)}</i></p>` : ""}
        <p>Price it in the app → Orders → <b>Needs pricing</b>.</p>
        <p><a href="${app}">${app}</a></p>`,
    };
  }
  if (e.kind === "quote_accepted") {
    return {
      subject: `✅ ${e.number} ACCEPTED by ${e.customer}${e.total_zar ? ` — R${e.total_zar}` : ""}`,
      html: `<h2>Quote accepted: ${esc(e.number)}</h2>
        <p><b>${who}</b> accepted${e.total_zar ? ` — <b>R${esc(e.total_zar)}</b> excl VAT` : ""}.</p>
        <p><b>Warehouse:</b> this order is ready to pick.</p>
        <p><a href="${app}">${app}</a></p>`,
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
  if (!RESEND_KEY) {
    // Configured-off is a state, not an error: the trigger keeps firing and
    // this says so in the logs without failing the database's HTTP call.
    console.warn("RESEND_API_KEY not set — event received but no email sent");
    return new Response(JSON.stringify({ ok: false, reason: "no api key" }), { status: 200 });
  }

  let event: OrderEvent;
  try {
    event = await req.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }
  if (!event?.kind || !event?.number) return new Response("bad event", { status: 400 });

  const { subject, html } = render(event);
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [TO], subject, html }),
  });
  const body = await r.text();
  if (!r.ok) console.error("resend failed", r.status, body);
  return new Response(JSON.stringify({ ok: r.ok }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
