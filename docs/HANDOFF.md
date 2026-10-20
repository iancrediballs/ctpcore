# Handoff — Zoho go-live (19 Oct 2026, second session)

Read with `docs/05_ZOHO_GO_LIVE_2026-10-19.md`. No secrets in this file.

## Done
- **Zoho connected.** New Edge Function `zoho-auth` (`server/edge/zoho-auth`,
  verify_jwt ON): `{code}` → refresh token stored in Supabase Vault
  (`zoho_refresh_token`, via `zoho_secret_put` from 0048), DC written to
  `zoho_config.dc`. Exchanged 19 Oct: DC `com`, org 939422621 China Truck Parts
  (Pty) Ltd reachable. `{action:"check"}` is a read-only health check (items,
  taxes, invoices, bills); `{action:"status"}` says whether a token is stored.
  Callable with the legacy service_role JWT (`supabase projects api-keys`) or an
  admin's session.
- **zoho-push / zoho-sync** now read the token from Vault and the DC from
  `zoho_config`, and use the Books API (`ZOHO_API=books`). Env
  `ZOHO_REFRESH_TOKEN` (stale, Sept) is only a fallback — can be deleted.
- **Tax bug fixed:** Zoho has 8 taxes at 15%; push picked the first
  ("Change in use (Non-Taxable)"). Now picks the default / "Standard Rate".
- Migrations 0046, 0047, 0048 are on live (the first session). Sending OFF,
  `push_from` null, queue empty.
- Orders tidy (0048, first session): 4 live orders, all Hermans, all
  `zoho_do_not_push`: SO-1003=DS000006 (DS000005 credited by CN000001),
  SO-1004=DS000004, SO-1005=DS000001+2+3, INV-26072403=DS000009. Test orders and
  demo customers soft-deleted with stock reversed. Backup:
  `Desktop\CTP Core Backups\2026-10-19_1520`. No goods receipts exist in CTP
  Core, so nothing to match against Supalift PI000001–004.
- Zoho check: 162 items, 19 invoices (DS000001–019), 7 bills (PI000001–004 +
  3 others). DS000019 is newer than the 001–018 mapping.
- Email (Resend via `notify`): test sent to iancrediblemusic@gmail.com, 200 OK.
  Recipients: Ian only. Order triggers enabled.
- Tests: PWA build OK; `server/tests_0042_local.js` 36/36, `tests_0045_local.js`
  11/11 (PGlite).

## Needs a manager/admin signed in to the PWA (phone is fine)
Settings → Zoho: **Check Zoho** → **Pull & apply**, **Run Zoho test**
(creates + deletes TEST draft invoice, bill, contacts — confirm the bill comes
back `draft`; Books may create bills as `open`, the function warns if so),
**Refresh status from Zoho**. Then set go-live date + **Start sending** with
Michelle.

## Not present (no code exists)
WhatsApp, SMS, web push. Email is the only outbound channel. Email still sends
from `onboarding@resend.dev` until a CTP domain is verified in Resend.

## 20 Oct — diagram viewer regression (fixed)
Root cause: production had been running branch `final-sprint` (SW v16, deployed
7 Oct). `multicat-codes-zoho` was cut from main before final-sprint's web work,
so deploying it on 19 Oct (SW v15) rolled back the section → hotspot viewer,
gentle zoom, photo carousel, sheet layering, invite flow, counter sales and the
customer accept-via-`accept-quote` path. Data was fine: every section's diagram
and hotspots are intact and keyed by part_id (unchanged by the Multicat rename).
Fix: final-sprint merged into main (SW v17). Tests: focus harness 13/13, PGlite
0042 36, 0045 11, 0046_0047 23, 0048 18, 0049 12, 0051 23 — all pass.

Migration numbers now clash between the two lines of work. Live has: main's
0046_multicat_codes, 0047_zoho_writeback, 0048_go_live_tidy, AND final-sprint's
0046_reservations / 0047_zoho_sales_order (accept_quote, reserve_order) and
request_parts_for (0053). NOT on live: final-sprint 0048_stock_guard,
0049_part_in_stock, 0051_customer_drops_quote_line.

OPEN DECISION (Ian + Michelle): live accept_quote() requires a Zoho SALES ORDER
id (Sept design, accept-quote edge fn). The 19 Oct go-live design says invoices
only, no sales orders. accept-quote still reads its token from
integration_secret (Sept token), not the new Vault token. SO-00001..00007 were
created in Zoho by it for test orders now deleted in CTP — check Zoho.
