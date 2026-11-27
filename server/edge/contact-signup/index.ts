// CTP Core — contact sign-up and one-click unsubscribe for chinatruckparts.co.za.
//
// verify_jwt is OFF: walk-in visitors have no login ("contacts first", Ian,
// 27 Nov 2026). This function is the ONLY writer of public.contact and
// public.contact_consent_log (migration 0100); the browser never gets table access.
//
//   POST { action: "signup", ...form }      -> { ok: true }
//   POST { action: "unsubscribe", token }   -> { ok: true }
//
// Abuse controls: honeypot field, minimum fill time, field validation, and at
// most RATE_MAX submissions per hashed IP per hour. Responses never say whether
// an email is already on file.
//
// POPIA: consent per channel (email, WhatsApp), never pre-ticked by the form,
// logged with the wording version. An existing contact's opt-ins can only be
// ADDED by the form; name, phone and earlier choices are never overwritten by
// a stranger who types the same email address. Opting out is the unsubscribe
// link (or staff).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Must match CONSENT_VERSION in site/build.mjs. Bump both when the wording changes.
const CONSENT_VERSIONS = new Set(["2026-11-27"]);
const RATE_MAX = 5;
const MIN_FILL_MS = 3000;
const MODELS = new Set(["FAW JH6", "FAW JH7", "Sinotruk C7", "Other"]);

const ALLOWED_ORIGIN = /^https:\/\/((www\.)?chinatruckparts\.co\.za|[a-z0-9-]+\.vercel\.app)$|^http:\/\/localhost(:\d+)?$/;

function cors(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGIN.test(origin) ? origin : "https://chinatruckparts.co.za",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Vary": "Origin",
  };
}

function reply(origin: string | null, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors(origin) },
  });
}

const clean = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};

/** South African numbers: 0XX XXX XXXX -> +27XXXXXXXXX. Others kept as typed (digits, +). */
export function normPhone(v: unknown): string | null {
  const s = clean(v, 30);
  if (!s) return null;
  let d = s.replace(/[^\d+]/g, "");
  if (d.startsWith("00")) d = "+" + d.slice(2);
  if (/^0\d{9}$/.test(d)) d = "+27" + d.slice(1);
  if (/^27\d{9}$/.test(d)) d = "+" + d;
  return /^\+?\d{9,15}$/.test(d) ? d : "";
}

export function normEmail(v: unknown): string | null {
  const s = clean(v, 200);
  if (!s) return null;
  const e = s.toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : "";
}

async function ipHash(req: Request): Promise<string> {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(SERVICE_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST") return reply(origin, { error: "method not allowed" }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY) return reply(origin, { error: "not configured" }, 500);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return reply(origin, { error: "bad request" }, 400);
  }
  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const hash = await ipHash(req);

  // ---------------------------------------------------------------- unsubscribe
  if (body.action === "unsubscribe") {
    const token = clean(body.token, 64);
    if (!token || !/^[0-9a-f-]{36}$/i.test(token)) return reply(origin, { error: "invalid link" }, 400);
    const { data: c, error } = await db.from("contact")
      .update({ consent_email: false, consent_whatsapp: false, opted_out_at: new Date().toISOString() })
      .eq("unsubscribe_token", token)
      .select("id, consent_text_version")
      .maybeSingle();
    if (error) { console.error("unsubscribe failed:", error.message); return reply(origin, { error: "try again" }, 502); }
    if (!c) return reply(origin, { error: "invalid link" }, 404);
    await db.from("contact_consent_log").insert({
      contact_id: c.id, action: "opt_out", email: false, whatsapp: false,
      consent_text_version: c.consent_text_version, via: "unsubscribe_link", ip_hash: hash,
    });
    return reply(origin, { ok: true });
  }

  if (body.action !== "signup") return reply(origin, { error: "bad request" }, 400);

  // ---------------------------------------------------------------- signup
  // Bots: honeypot filled, or the form submitted faster than a person can type.
  const started = Number(body.started_at);
  if (clean(body.website, 200) || !Number.isFinite(started) || Date.now() - started < MIN_FILL_MS) {
    return reply(origin, { ok: true }); // look successful; store nothing
  }

  const since = new Date(Date.now() - 3600_000).toISOString();
  const { count } = await db.from("contact_consent_log")
    .select("id", { count: "exact", head: true })
    .eq("ip_hash", hash).gte("at", since);
  if ((count ?? 0) >= RATE_MAX) return reply(origin, { error: "Too many sign-ups from this connection. Please try again later." }, 429);

  const name = clean(body.name, 120);
  const email = normEmail(body.email);
  const phone = normPhone(body.phone);
  const version = clean(body.consent_text_version, 20);
  const wantEmail = body.consent_email === true;
  const wantWhatsapp = body.consent_whatsapp === true;

  const errors: string[] = [];
  if (!name || name.length < 2) errors.push("Please enter your name.");
  if (email === "") errors.push("That email address doesn't look right.");
  if (phone === "") errors.push("That phone number doesn't look right.");
  if (email === null && phone === null) errors.push("Please give an email address or a mobile number.");
  if (wantEmail && !email) errors.push("Add an email address to get email updates.");
  if (wantWhatsapp && !phone) errors.push("Add a mobile number to get WhatsApp updates.");
  if (body.privacy_ack !== true) errors.push("Please confirm you have read the privacy notice.");
  if (!version || !CONSENT_VERSIONS.has(version)) errors.push("Please reload the page and try again.");
  if (errors.length) return reply(origin, { error: errors.join(" ") }, 422);

  const models = Array.isArray(body.models)
    ? [...new Set(body.models.filter((m): m is string => typeof m === "string" && MODELS.has(m)))]
    : [];
  const now = new Date().toISOString();
  const anyConsent = wantEmail || wantWhatsapp;

  // Existing contact (same email): only ADD opt-ins. Never overwrite details.
  if (email) {
    const { data: existing, error } = await db.from("contact")
      .select("id, consent_email, consent_whatsapp, phone")
      .eq("email", email) // always stored lower-case by normEmail
      .maybeSingle();
    if (error) { console.error("lookup failed:", error.message); return reply(origin, { error: "Please try again." }, 502); }
    if (existing) {
      const nextEmail = existing.consent_email || wantEmail;
      const nextWa = existing.consent_whatsapp || (wantWhatsapp && !!existing.phone);
      const grows = nextEmail !== existing.consent_email || nextWa !== existing.consent_whatsapp;
      if (grows) {
        await db.from("contact").update({
          consent_email: nextEmail, consent_whatsapp: nextWa, consent_text_version: version,
          consent_at: now, opted_out_at: null,
        }).eq("id", existing.id);
      }
      // Log only a real change: a repeat sign-up that adds nothing is not a consent event.
      if (grows) {
        await db.from("contact_consent_log").insert({
          contact_id: existing.id, action: "opt_in",
          email: nextEmail, whatsapp: nextWa, consent_text_version: version!, via: "website", ip_hash: hash,
        });
      }
      return reply(origin, { ok: true });
    }
  }

  const { data: created, error: insErr } = await db.from("contact").insert({
    name, email, phone,
    company: clean(body.company, 120),
    models,
    interest: clean(body.interest, 1000),
    heard_from: clean(body.heard_from, 120),
    source: "website",
    consent_email: wantEmail,
    consent_whatsapp: wantWhatsapp,
    consent_text_version: version,
    consent_at: anyConsent ? now : null,
    privacy_ack_at: now,
    ip_hash: hash,
  }).select("id").single();
  if (insErr) {
    // 23505 = the same email raced in; treat as success, as above.
    if (insErr.code === "23505") return reply(origin, { ok: true });
    console.error("insert failed:", insErr.message);
    return reply(origin, { error: "Please try again." }, 502);
  }
  await db.from("contact_consent_log").insert({
    contact_id: created.id, action: anyConsent ? "opt_in" : "signup_no_marketing",
    email: wantEmail, whatsapp: wantWhatsapp, consent_text_version: version!, via: "website", ip_hash: hash,
  });
  return reply(origin, { ok: true });
});
