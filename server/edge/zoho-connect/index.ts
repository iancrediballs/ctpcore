// CTP Core — connect (or reconnect) Zoho Books, without a terminal.
//
// 2026-09-26. Getting a Zoho refresh token used to mean generating a code in
// the API console and racing a curl command before the code expired three
// minutes later. That went wrong three times in a row, and an authorisation
// code ended up stored where the refresh token belonged.
//
// So the exchange happens here instead:
//   1. Ian generates the code at api-console.zoho.com (Self Client).
//   2. He pastes it into Supabase → Edge Functions → Secrets as ZOHO_GRANT_CODE.
//   3. This function swaps it for a refresh token and writes that to
//      integration_secret, which only the service role can read.
//   4. He deletes ZOHO_GRANT_CODE. It is single-use and already spent.
//
// It never returns a token, a code, or any part of one — only whether it
// worked. The nonce is there so a passer-by cannot burn a code Ian just
// pasted; it is not protecting a secret, because there is no secret in the
// response either way.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { exchangeAuthorisationCode, storeRefreshToken, refreshTokenValue, ZohoError } from "../accept-quote/zoho.ts";

const NONCE = Deno.env.get("ZOHO_CONNECT_NONCE") ?? "ctp-2609-connect-9f31a";
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b, null, 2), { status: s, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (url.searchParams.get("n") !== NONCE) return new Response("no", { status: 404 });

  // status only — safe to call any time, says nothing about the values
  if (url.searchParams.get("status") === "1") {
    return json({
      client_id: !!Deno.env.get("ZOHO_CLIENT_ID"),
      client_secret: !!Deno.env.get("ZOHO_CLIENT_SECRET"),
      grant_code_waiting: !!Deno.env.get("ZOHO_GRANT_CODE"),
      refresh_token_stored: !!await refreshTokenValue(),
    });
  }

  const code = Deno.env.get("ZOHO_GRANT_CODE");
  if (!code) return json({ ok: false, step: "read code", error: "ZOHO_GRANT_CODE is not set. Paste the authorisation code into Supabase → Edge Functions → Secrets and try again." }, 400);
  if (!Deno.env.get("ZOHO_CLIENT_ID") || !Deno.env.get("ZOHO_CLIENT_SECRET")) {
    return json({ ok: false, step: "read client", error: "ZOHO_CLIENT_ID or ZOHO_CLIENT_SECRET is missing." }, 400);
  }

  let refresh: string;
  try {
    ({ refresh_token: refresh } = await exchangeAuthorisationCode(code));
  } catch (e) {
    const msg = e instanceof ZohoError ? e.message : String(e);
    // The two that actually happen, told apart plainly.
    const hint = msg === "invalid_code"
      ? "Zoho rejected the code. It expires about three minutes after you generate it, and it only works once — generate a fresh one and paste that."
      : msg === "invalid_client"
      ? "Zoho rejected the client id/secret, which usually means the org is on a different Zoho data centre. Set ZOHO_ACCOUNTS_URL and ZOHO_API_BASE for it."
      : "";
    return json({ ok: false, step: "exchange", error: msg, hint }, 400);
  }

  try {
    await storeRefreshToken(refresh, `exchanged ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC by zoho-connect`);
  } catch (e) {
    return json({ ok: false, step: "store", error: String(e) }, 500);
  }

  return json({
    ok: true,
    stored: true,
    refresh_token_length: refresh.length,   // a shape check, not the value
    next: "Delete ZOHO_GRANT_CODE from the Supabase secrets — it is spent. Ordering is live.",
  });
});
