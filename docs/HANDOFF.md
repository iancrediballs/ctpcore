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

## 20 Oct — accept -> Zoho sales order, wired properly (Ian: "sales order as before")
- 0054 applied on live (dry run first): accept_quote/quote_accept_check use zoho_item
  (the 19 Oct link; part.zoho_item_id re-synced — it had drifted on 5 parts), no SO
  while sending is off / before push_from, SO required from go-live on; "customer
  not in Zoho" no longer blocks (contact matched/created); sales_order.zoho_so_status /
  zoho_so_status_at / zoho_so_error; zoho_push_log doc_type 'salesorder'.
- server/edge/_shared/zoho.ts: one Zoho module (Vault token, Books, contacts, SKU,
  Standard Rate VAT, rebate as line discount, salesOrderFor, linkToSalesOrder).
  accept-quote and zoho-push use it. accept-quote/zoho.ts, zoho-connect and the
  integration_secret token path are retired.
- Invoice from SO: lines carry salesorder_item_id; SO's contact; if Zoho refuses a
  draft SO, it is marked open then and logged. Rebate now on invoice lines too (was
  missing: a rebated order would have over-invoiced).
- Status read-back covers sales orders. Live test: + draft SO, + invoice from SO,
  all deleted after.
- Tests: tests_0054_local.js 15/15; all suites pass.
- TOKEN SCOPE: current token lacks ZohoBooks.salesorders (401). New code needed with
  the scope list in docs/05.

## 22 Oct — work moved to the LAPTOP; the desktop session is STALE
- From 22 Oct work runs on Ian's laptop (`C:\Users\iancr\Projects\ctpcore`). The
  home PC (DESKTOP-NEII4G1) session is stale: **`git pull` before doing anything
  there**, and don't deploy from it until it's up to date with main.
- Laptop setup: `npx.cmd supabase` (PowerShell blocks plain `npx`), logged in and
  linked to `hkzmydowyiajkbakxfkj`; Vercel CLI logged in (`npx.cmd vercel deploy
  --prod --scope ian-33be3d61` from the repo root).
- docs/07 (Phase 2 estimates design, 21 Oct) had not been pushed; it is now.

## 22 Oct — new Zoho token, all scopes
- New grant code exchanged via `zoho-auth` (refresh token in Vault, DC com, org
  939422621 found). Scopes = the docs/06 §1 string: adds estimates.ALL,
  creditnotes.ALL, customerpayments.READ, vendorpayments.READ.
- Read-only `assess` probe: estimates, creditnotes, customerpayments,
  vendorpayments, salesorders, invoices, bills, purchaseorders, pricebooks all
  200. `/settings/warehouses` 401 (expected without Zoho Inventory).
- `check`: 162 items, 19 invoices, 0 sales orders. Sending ON since 20 Oct
  (`push_from` 2026-10-20 12:13 UTC), invoices/bills draft, Zoho numbering.

## 22 Oct — admin "Accept on customer's behalf" (0058, live)
- For quotes a customer confirms by phone/email (Ian, Hermans demo). Phone order
  desk → quote "with customer" → **Accept on customer's behalf** (admin only) →
  prompt for the note, e.g. "Confirmed by Denver via phone" (required).
- Same path as the customer accept: `accept-quote` edge fn with
  `{order_id, on_behalf_note}` → confirmed Zoho SO (`salesOrderFor`) → new
  `accept_quote_on_behalf()` (service_role only) does status + Zoho refs +
  `reserve_order` in one transaction; Zoho SO deleted again if it fails.
  `accept_quote()` is unchanged.
- Recorded: `sales_order.accepted_by` (admin uid), `accepted_note`, and a line
  in `notes` ("[time] Accepted on the customer's behalf by <admin>: <note>").
- Live: 0058 applied, accept-quote redeployed (live source matched repo first),
  PWA SW v21. No orders touched. Tests: `tests_0058_local.js` 13/13,
  `tests_0057_local.js` 10/10, tsc + build clean.
- Desktop (Tauri) has no button for this; phone/web only.

## Hermans (checked 22 Oct, nothing changed)
- Customer HERMANS (id 6), Zoho contact 1429405000000131019 linked, trade tier
  (list prices), rebate 0. Only login: denver@hermans.co.za (company + primary
  person). Admins now accept for him with the button above.
- FLAG for Michelle: Zoho contact has NO VAT no. and tax_treatment
  `vat_not_registered` (Ian has 4170252953); contact email is
  michelle@supalift.co.za; Denver's contact person has no email.
- RQ-261020-43: Hermans, quote, 1 line unpriced (Front Fog Lamp L/H) — to
  cancel unless part of a real order.
- RQ-261020-44: actually Test Account (Ian), fulfilled, Zoho SO-00009 deleted,
  still live in CTP — to soft-delete. Both await Ian's go-ahead.

## 22 Oct (evening) — fulfil waits for accounts; Michelle's SO edits read back (0059, 0060, live)
Ian: Michelle corrected the price on the Hermans SO in Zoho and emailed it; that
must flow back, and "Fulfil" must wait until her side is done.
- The live order: **RQ-261020-43** (Hermans) = Zoho **SO-00011**. Michelle changed
  3732015-1063-C00 R1,195.94 → R1,156.00, emailed it (`is_emailed`), terms Net 30,
  and then INVOICED it herself in Zoho: **INV-000005 (sent)**. CTP now has her
  price; the order is still `confirmed` in CTP (goods not out yet).
- **Fulfil gate** (trigger `sales_order_fulfil_gate`, `fulfil_block_reason()`):
  an order with a Zoho SO cannot be fulfilled until the SO is open/invoiced/closed
  AND emailed AND read back with no unmatched lines. No Zoho SO → not gated.
  Admin **Release anyway** with a required note (`override_fulfil_gate`), recorded.
  fulfil_order() itself unchanged. NOTE: the desktop (Tauri) fulfils locally — an
  upload of a gated fulfil would be refused by the trigger; use the phone.
- **Read-back** (`apply_zoho_salesorder`, server only): Zoho wins — price,
  discount; qty/added/removed lines while `confirmed` (holds re-taken); after
  goods out only prices follow and qty differences are flagged. Every change goes
  into the order notes (old → new). Idempotent on Zoho `last_modified_time`.
  Runs on: opening the order on the phone (`zoho-push {action:"so_sync"}`, 30 s
  throttle), the order's Refresh chip, Settings → Refresh status, and **pg_cron
  every 10 min** (`zoho-readback`, 0060 → zoho-push `status` via pg_net; Vault
  `zoho_sync_token` + `ctp_anon_key`, edge secret ZOHO_SYNC_TOKEN). Uses the
  cached token; 1 GET per open document. Sales orders stop being read once
  Zoho says invoiced/closed.
- **No duplicate invoices**: if accounts already invoiced the SO in Zoho, "Issue
  tax invoice" ADOPTS that invoice (links its id/number) instead of creating one
  — this is what RQ-261020-43 will do (INV-000005). Toast: "Already invoiced by
  accounts in Zoho …".
- **Invoice from the SO** takes the SO line's rate, discount and tax (Michelle's),
  quantity = what CTP sent out.
- **Account terms** (`apply_zoho_contact_terms`): Zoho contact payment terms,
  outstanding receivables, unused credits, credit limit → customer row; shown on
  the order. Nothing blocks on payment. Hermans' CONTACT says "Due on Receipt"
  (only the SO says Net 30); outstanding ≈ R1.70m; no credit limit set — Michelle
  should set Net 30 (and a limit, if wanted) on the contact.
- Open question for Ian: block CASH customers (terms Due on Receipt) until paid?
  Not built; today nothing blocks on payment.
- The on-behalf prompt no longer pre-fills "Confirmed by  via phone" (saved once
  with no name on RQ-261020-43) and refuses a note without a name.
- Not in the repo: live has 0044 (rebate columns on sales_line); tests add them.
- Tests: tests_0059_local.js 26/26, 0058 13/13, 0057 10/10; tsc + build clean.
  Live: 0059 + 0060 applied, zoho-push + zoho-auth deployed, PWA SW v22.
- Migration numbers: 0058 accept-on-behalf, 0059 read-back, 0060 schedule;
  Phase 2 estimates → 0061 (docs/07 updated).
