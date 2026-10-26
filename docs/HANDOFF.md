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
  Phase 2 estimates → 0062 (docs/07 updated).

## 22 Oct (late) — fulfil only after accounts INVOICE the SO (0061, live) — supersedes 0059's gate
Ian: "the fulfill stock button should only become available once michelle
converts a sales order into tax invoice"; "michelle has a button in zoho 'i have
received payment' and she converts to tax invoice".
- **Gate (all customers):** an order with a Zoho SO can be fulfilled only once
  Zoho shows an invoice raised FROM that SO, read back and linked onto the order.
  **Cash** customers: that invoice must also be **paid**. Reason text names the
  missing step ("Waiting for accounts to invoice this sales order in Zoho." /
  "Waiting for payment: INV-… is sent, R… due (cash customer …)"). The 0059
  "emailed" requirement is dropped (still shown). Admin release-with-note stays.
- **Account vs cash = `customer.on_account`** (CTP flag, admin: "Make account… /
  Make cash…" on the order card, `set_customer_on_account`). NOT Zoho terms: on
  22 Oct Hermans' contact said Due on Receipt, SO-00011 Net 30, INV-000005
  "Custom (39 days)". Default cash; **Hermans = account**.
- **Read-back:** once the SO has invoice(s), CTP lines follow the INVOICE lines
  (summed per item) — fulfil takes exactly what was invoiced; before that, the SO
  lines. `apply_zoho_invoice_link` stores invoice id/number/status/total/balance/
  paid/payments (+ notes "raised by accounts — linked", "sent → paid (paid R…)").
  Invoice status/payments keep refreshing (10-min cron, Refresh, opening the order).
- **No double invoicing:** for an order with a Zoho SO, CTP NEVER creates a Zoho
  invoice — zoho-push adopts the SO's invoice or refuses (Blocked); the DB trigger
  refuses CTP's own "invoiced" status until a Zoho invoice is linked. The phone
  button becomes **"Close order — invoiced in Zoho as INV-…"** (records it, links,
  creates nothing); with no Zoho invoice it is hidden ("Waiting for accounts …").
  Orders without a Zoho SO keep "Issue tax invoice" as before.
- **"I have received payment"** (on Zoho's convert-to-invoice screen) records a
  customer payment against the new invoice → invoice paid + payment; it is not a
  sales receipt. Not used on INV-000005 (sent, balance R1,329.40, no payments);
  Hermans has no customer payments and no sales receipts in Zoho. Sales receipts
  have no SO link, so they cannot satisfy the gate.
- **Live RQ-261020-43:** linked to INV-000005 (R1,329.40, sent, unpaid); Hermans
  on account → Fulfil is available. Next on the phone: Fulfil → "Close order".
- Tests: tests_0061_local.js 19/19 (+0057 10, 0058 13, 0059 26). Live: 0061
  applied, zoho-push + zoho-auth deployed, PWA SW v23.

## 23 Oct — header basket + order desk filters (PWA v24, live)
Ian: "a cart icon showing number of items being added as they are being
clicked, obviously clickable, and filtering in the orders menu, by date, by
item, by invoice, by quote etc."
- **Header basket** (`CartButton`, MobileShell): on every screen — each brand
  row (Home, Find/Shelf, Orders, Request, Info), the part sheet header and the
  diagram viewer header (`DiagramView headerExtra`). Badge = **total quantity**
  (each "Add to order"/"+" tap is +1; the bottom tab badge for customers now
  matches). Pops on every increase (`mb-cartpop`, off under reduced-motion).
  Tap → closes the sheet/drawing and opens the basket: customers' Request tab;
  staff the counter-sale card at the top of Orders.
- **Persists**: localStorage `ctp-cart.v1:<auth uid>` = lines + note + counter
  customer, per login (two people on one PC never share a basket). Cleared when
  the basket is sent/cleared. Device-only; nothing new on the server.
- **Order desk search + filters** (`app/src/mobile/orderFilter.ts`, pure):
  search RQ no., Zoho SO / invoice / estimate no., CTP invoice no., customer,
  part SKU / catalogue no. / name (separators ignored: "so00011" = SO-00011).
  Filters: date (any / today / 7 days / this month / custom from–to, on
  created_at, local time), stage (quote, accepted, awaiting invoice, invoiced,
  fulfilled, cancelled — they overlap by design), customer, part, has/no
  invoice, paid/unpaid (Zoho status paid, or read-back balance 0). Clearable
  chips, "Clear all", "N of M" count. Remembered for the session
  (sessionStorage `ctp-order-filter.v1`). No Zoho calls.
- Cancelled orders now have their own "Cancelled" group (they used to sit
  under Completed). `staffOrders()` cap 60 → 1000 and lines load in one query
  (json_each) instead of one per order.
- **Shell harness** (dev only): `cd app && npx vite --config vite.harness.config.ts`
  → `http://localhost:4174/shell-harness.html` (`?role=customer`). The REAL
  MobileShell over mocked backend/auth/sync (`app/src/dev/shell/`), because the
  signed-in app needs a password we don't type. Not in the build.
- Tests: `node --experimental-strip-types server/tests_orderfilter_local.mjs`
  33/33; harness: basket +3 → badge 3, survives reload, separate per login,
  opens the basket from header and sheet; filters combine, chips clear,
  remembered across reload, Clear all. tsc + build clean. Deployed to
  ctpcore.vercel.app, SW v24. The Tauri desktop app is unchanged.

## 23 Oct — Phase 2 started: quotes as Zoho estimates, built DARK (0062, live, switch OFF)
docs/07. Nothing changes for anyone until an admin runs `select set_zoho_estimates(true)`
(no UI switch yet). Today's flow — quote in CTP, accept raises the confirmed SO
directly — is untouched while it is off.
- **0062** (live; dry run first): `sales_order.zoho_estimate_id/_number/_status/
  _status_at/_error/_modified_at`; `zoho_config.estimates_enabled` (default false);
  `set_zoho_estimates(bool)` admin-only, logged; `apply_zoho_estimate()` server-only
  (links, status-change note on the order, deleted → flagged + id kept, never
  re-created); push log doc_type 'estimate'.
- **_shared/zoho.ts**: `estimateFor()` = draft estimate per quote (reference = RQ
  no., lines by SKU via zoho_item, Standard Rate VAT, rebate as line discount,
  unpriced/unlinked lines block); idempotent (stored id, then by reference); updates
  only while DRAFT — once sent, a difference is a warning for the desk (accounts
  revise in Zoho). `salesOrderFromEstimate()` = estimate draft→sent→accepted, then
  the confirmed SO from the ESTIMATE's lines with `estimate_id` (Zoho links it).
  `reopenEstimate()` = compensation.
- **zoho-push** `{action:"estimate", order_id}` (staff; skipped while the switch is
  off or before go-live). Status read-back (10-min cron) now reads estimates too and
  marks an estimate DECLINED in Zoho when the customer declined / the desk cancelled.
- **accept-quote**: with the switch on and an estimate on the quote → estimate
  accepted + SO from it, then the same accept_quote() transaction; failure deletes the
  new SO and puts the estimate back to sent. No estimate → the 20 Oct path.
- **Phone**: "Send quote" (fully priced) calls the estimate action (skipped now);
  the order card shows "Estimate QT-… in Zoho · draft — accounts send it" and any
  estimate warning; estimate numbers are searchable in the order filters.
- **Live test** (`zoho-auth {action:"est_test"}`, Test Account contact, 23 Oct 08:31):
  Zoho numbers estimates **QT-000001** (Zoho calls them quotes); found by reference;
  PUT while draft OK; **accept from draft is REFUSED (code 4043)** → must be marked
  sent first (the code does this); SO with `estimate_id` accepted and linked
  (SO-00013, open); estimate stays "accepted" after the SO. Both deleted after.
  QT-000001 and SO-00013 are therefore gaps in Zoho's numbering.
- Tests: `tests_0062_local.js` 17/17 (+0061 19/19); deno check: no new type errors
  (71 pre-existing, all GenericStringError on string-built selects); tsc + build clean.
  Deployed: zoho-push v18, zoho-auth v19, accept-quote v20 (verify_jwt on); PWA SW v25.
- Slip on 23 Oct: one `vercel deploy` ran from `app/` and created a stray Vercel
  project **"app"** (app-1q7hm1fyd-ian-33be3d61.vercel.app). Production was not
  affected; the local link was removed. Delete the "app" project in Vercel when
  convenient. Always deploy from the repo root.
- **Before switching on** (next): Settings → Zoho toggle for the switch; customer
  "Decline" path check; decide whether an accepted-in-app quote that Michelle never
  sent is OK to mark sent automatically (Zoho requires sent before accepted);
  re-price after sent = warning only. Then Ian + Michelle switch on together.

## 23 Oct (late morning) — quotes ARE Zoho estimates now; Zoho leads; accept only after accounts send (0063, live, switch ON)
Ian's decisions (23 Oct): switch on immediately; the app must NOT mark estimates
sent; Zoho leads estimate content; delete the stray Vercel project; soft-delete
RQ-261020-44.
- **Switch ON** since 23 Oct ~09:25 SAST (`zoho_config.estimates_enabled = true`, push log
  id 22). Settings → Zoho → "Quotes as Zoho estimates" card: Turn on/off (admin,
  `set_zoho_estimates`).
- **Send quote** (staff, fully priced) creates the DRAFT estimate in Zoho ONCE
  (`estimateFor`, create-only; found by reference if a retry). CTP never edits it
  after that. If creation failed, the card shows "Create estimate in Zoho".
- **Zoho leads** (0063): a trigger (`sales_line_estimate_lock`) refuses any change
  to a quote's lines once it has a live estimate — "Edit prices in Zoho (QT-…)".
  Only `apply_zoho_estimate` (read-back) changes them: lines, prices, discounts,
  qty, added/removed lines, total incl VAT, expiry, emailed, status; old → new in
  the notes; unmapped Zoho items → "Differs from Zoho: …" on the order. Read-back
  runs on the 10-min cron, when the desk opens the order (`so_sync`, 30 s throttle)
  and on "Refresh from Zoho". A deleted/declined/expired estimate releases the lock.
  CHOICE (Ian asked): changes before Michelle sends = **ask Michelle to edit in Zoho**
  (no "Re-send to Zoho" — Zoho leads; CTP follows within 10 min or on Refresh).
- **Accept only after accounts SEND**: `quote_accept_check` blocks with
  "Your quote is being finalised by our accounts team." (customer) / "Waiting for
  accounts to send estimate QT-… from Zoho." (staff) while there is no estimate or it
  is draft; declined/expired/invoiced are refused. The admin "Accept on customer's
  behalf" button is disabled until sent. accept-quote refuses too (409).
- **On accept**: Zoho converts only ACCEPTED estimates (live test: "Only accepted
  quotes can be converted to sales orders"). So: estimate sent → accepted (the
  customer's act — never "sent"), then the confirmed SO raised from the ESTIMATE's
  lines with `estimate_id` (linked in Zoho), then accept_quote() (stock held). If CTP
  fails: SO deleted, estimate stays accepted (logged), retry allowed and links.
- **Customer sees Zoho's figures**: their stream has no discounts/totals, so
  `quote_accept_check` returns `estimate` {number, status, total incl VAT, expiry,
  per-line discount and net}; the Request card shows "Total R… incl VAT · Quote QT-…
  · valid until …", line nets with "less x%". Remove-line ✕ hidden on estimates.
- Live est_test (07:21 UTC): QT-000003 → (test plays accounts: price 2 × R1.50, sent)
  → accepted → SO-00015 open, total 3.45, `estimate_link` set → both deleted. Earlier
  runs left gaps QT-000001/2, SO-00013/14 (deleted).
- Tests: tests_0063_local.js 24/24, 0062 17/17, 0061 19/19, 0059 26/26, 0058 13/13,
  orderFilter 33/33; deno check 71 (baseline, none new); tsc + build clean; harness:
  draft-estimate card text, on-behalf disabled "waiting for accounts to send QT-…".
- Deployed: 0063 (dry run first), zoho-push / zoho-auth / accept-quote (verify_jwt on),
  PWA SW v26 at ctpcore.vercel.app. Cron read-back on the new code: 0 errors.
- **Vercel "app" project deleted** (23 Oct). Correction: it was NOT created today — it
  dated from 26 Sept (one earlier accidental Vite deploy from `app/`, same user, no
  domains); today's slip deployed into it. ctp-core / ctpcore.vercel.app untouched.
- **RQ-261020-44 soft-deleted** (Test Account; Zoho SO-00009 already deleted); stock
  effect reversed (+1 each on parts 1018, 1019, origin `cleanup20261023`); net 0.
- Hermans VAT: Michelle adding the VAT no. in Zoho (23 Oct). Contact sync picks it up.
- Not covered: the Tauri desktop has no estimate awareness (its quote edits would be
  refused on upload by the lock — price on the phone/Zoho). Customer Decline marks the
  estimate declined on the next read-back. Quotes priced before the switch with no
  estimate: staff tap "Create estimate in Zoho" (none were open at switch-on).

## 23 Oct — dark-mode bug: order card name/amount black on dark (PWA v27, live)
Ian's screenshot: "Hermans Panel Beaters" and "R 1 329,40" near-black on the dark card.
- Root cause: the order-list cards are `<button className="mb-row">`; a button does
  not inherit `color` (the UA gives it ButtonText = black), and `.mb-cname`/`.mb-rv`
  set none. Fix: `:where(.mb-root) :where(button,input,select,textarea){color:inherit;
  font-family:inherit}` (zero specificity, so every class colour still wins), plus
  explicit `color:var(--txt)` on `.mb-cname`/`.mb-rv`; `color-scheme` dark/light on the
  root so native selects and date pickers follow the theme.
- AA sweep (measured in the shell harness, every visible text element against its real
  background, both themes: Home, Orders with all cards open + filter panel + chips +
  counter basket, part sheet + header cart, Info): all ≥ 4.5:1 now. Token changes:
  dark `--dimmer` #6B7887→#7D8A99 (root + lightbox); light `--dimmer` #8C98A6→#5F6B78,
  `--amber` #D96B00→#A85600 (white button text was 3.5:1), `--green` #178A54→#12703F;
  cart/filter-chip badges white text in light (dark text inside the always-dark lightbox);
  Settings CTA subtitle/chevron use `--dim`. Undefined tokens `--bad`/`--ok` (which fell
  back to #c0392b/#2f855a, ~3:1 on dark) replaced by `--red`/`--green` (Zoho status lines,
  Add customer messages).
- Not swept: the Settings screen (st-*) and the Tauri desktop app.

## 23 Oct (midday) — Phase 2 closed out (0064, PWA v28, live)
- **Decline, tested live** (RQ-TEST-2610230854, Test Account): Send quote → QT draft from CTP
  lines → (test plays accounts) sent → the CUSTOMER declined via the real `respond_to_quote`
  → status read-back declined it in Zoho (QT-000005 declined) → CTP "cancelled / QT-000005
  declined", notes old → new. Completed/cancelled cards now show "Estimate QT-… · <status>".
- **Admin "Create new estimate"** (phone, admin, only when the estimate is deleted/voided):
  zoho-push `{action:"estimate_recreate"}` re-checks Zoho (refuses if it still exists, and
  refreshes CTP), links a LIVE estimate with the same RQ reference instead of making a second
  one (`findLiveEstimate` scans all matches — `findByReference` stops at the first, which could
  be the voided one), then `reset_zoho_estimate()` (0064, server-only: quote + deleted/void
  only; old number kept in the notes) and a fresh draft from the current CTP lines, logged.
  Live: QT-000004 deleted in Zoho → CTP flagged → new QT-000005 → second attempt 409.
  Voided estimates now behave like deleted ones (lock released, customer "being finalised",
  staff told an admin can create a new one).
- `zoho-auth {action:"test_estimate", estimate_id, op: sent|delete|get}` plays accounts in
  live tests, refuses any estimate whose reference is not `RQ-TEST-…`.
- Test docs deleted: QT-000004, QT-000005 (gaps in Zoho numbering); CTP test orders 46, 47
  soft-deleted (46 was a first run that failed before reaching Zoho — the sync token is read
  from `vault.decrypted_secrets`, not `zoho_secret_get`).
- **Desktop (Tauri)**: it does not sync sales orders at all — local SQLite, no sign-in
  (`AUTH_ENABLED=false`), pull-only for parts/stock; it has no price-edit command (tier price
  at add). So it cannot show estimate numbers/statuses or a Zoho fulfil gate. Done instead:
  SalesView `QUOTES_IN_ZOHO` — notice "Quotes are Zoho estimates … edit prices in Zoho (QT-…)",
  "+ New quote", line/qty edits, Confirm and Fulfil locked; history readable/printable. NOT
  SHIPPED: this laptop has no Rust toolchain; it ships with the next `tauri build` (desktop PC).
- Tests: 0064 15/15, 0063 24/24, 0062 17/17; deno check 71 (baseline); tsc + build clean.
  Deployed: 0064 (dry run first), zoho-push / zoho-auth / accept-quote, PWA SW v28.

## 23 Oct (afternoon) — Phase 3 PLANNED (no stock changed anywhere)
- Read: `docs/08_PHASE3_STOCK_TO_ZOHO.md`; report `docs/stock/reconciliation_2026-10-23.{xlsx,csv}`
  (+ `_totals.json`, raw pull in `docs/stock/raw_2026-10-23/`, script `tools/stock_reconcile.py`).
- New read-only `zoho-auth {action:"stock_report", part: items|details|docs}` (GET only,
  throttled ~1.2 calls/s). Deployed.
- Totals: CTP on hand 812 (809 on linked items + 3 untracked in Zoho), held 5; Zoho on hand
  937, committed 0, available 937; difference +128 net / 174 gross on 70 of 155 items; 85 match.
- Main cause: the 28 Jun CTP opening load took ONE Supalift shipment per SKU where the item is
  on both PI000001 and PI000002 (19 Oct bills in Zoho) — 53 items, 158 units. If both deliveries
  were received, Zoho is right for those. Rest: 12 document gaps, 24 to count, 2 parts to track
  in Zoho. Four parts carry an extra INACTIVE zoho_item link (report uses the active one).
- Books token cannot read/create inventory adjustments (401 code 57) → recommendation: buy Zoho
  Inventory before the Phase 3 build; one new grant code with Books + Inventory scopes (doc 08 §3).
- Awaiting Ian + Michelle: approve the reconciliation, confirm both Supalift deliveries, decide
  on Inventory, cut-over date. NO adjustments until then.

## 23 Oct (late afternoon) — Inventory Premium bought; cut-over plan; waiting on the new grant code
- Ian: both Supalift deliveries arrived; plan approved (spot-check ~5, count 24, Michelle checks 12
  sales); **Zoho Inventory Premium bought**; webhooks yes; cut-over = run as REHEARSAL until Ian
  says zero Zoho + re-initialise + go live.
- `zoho-auth {action:"inv_probe"}` (read-only): every Inventory endpoint is 401 code 57 with the
  current token (Books scopes only); the Books org record has no plan fields. Plan limits are read
  via the API after the new code. Published Premium (ZA page, 23 Oct): 7,500 orders/month,
  3,000 POs/bills a month, 6 locations, **2 users**, API 7,500/day (ZA page) vs 10,000/day (API
  docs) — to be confirmed by the x-rate-limit header after the grant.
- `docs/09_CUTOVER_ZERO_AND_INIT.md`: wipe vs keep, options (scripted delete recommended, Zoho
  support reset, fresh org), re-import order, CTP reset, dry-run checklist, rollback. Caution:
  the rehearsal org holds REAL records (DS invoices ≈ R1.7m Hermans receivable, Supalift bills);
  Michelle signs off deletes and opening balances.
- NEXT: exchange the new code (Books + Inventory scopes, in the reply of 23 Oct) via zoho-auth,
  re-run `inv_probe` (plan, limits, warehouse id), then build Phase 3 on Inventory behind
  `zoho_config.stock_master` ('ctp' until cut-over): packages+shipments on Fulfil, purchase
  receives, adjustments from counts, `zoho-hook` webhooks, stock cache.

## 23 Oct (evening) — Michelle's cut-over answers; dry run built (read-only)
- Michelle: no VAT returns filed (deletes allowed); Hermans' opening receivables ITEMISED invoice
  by invoice; all number series restart at 00001. Still open: who takes the Zoho backup; which
  account the no-VAT opening documents post to.
- Dry run: `zoho-auth {action:"cutover_dryrun"}` (list endpoints only) + `tools/cutover_dryrun.py`
  → `docs/cutover/dryrun_2026-10-23.{xlsx,json}` (+ the raw read). 33 docs to delete (21 invoices,
  3 credit notes, 2 SOs, 7 bills); 19 itemised opening invoices for Hermans = R1,757,210.30
  (original no./dates kept, open balance, no VAT); 7 open bills = R2,024,950.90; 13 number
  series to reset. Inventory documents unreadable until the new grant code — re-run then.
- docs/09 updated. Nothing destructive has run; it needs Ian's "go" on the day.
- Waiting for the new grant code to start Phase 3 on Inventory.

## 23 Oct (evening) — new grant code (Books + Inventory); Phase 3 BUILT on Inventory, behind the rehearsal switch (0065, PWA v29)
- **Grant exchanged** via zoho-auth: all 24 scopes granted (12 Books + 12 Inventory, incl.
  packages, shipmentorders, purchasereceives, inventoryadjustments, transferorders). The exchange
  writes the new access token into the Vault cache, so Inventory worked at once.
- **Plan, read via API:** Inventory answers with its own allowance, **7,500 calls/day** (Books stays
  5,000/day); 100/min. One location "Head Office" (`1429405000000095060`, stored in
  `zoho_config.zoho_location_id`); 3 active admin users (Premium lists 2 — check licences, not
  urgent); inventory start date 1 Mar 2026. The plan name is not exposed by the API.
  `/settings/warehouses` is 401 (deprecated) — `/locations` works.
- **Zoho keeps two stocks (live test):** `stock_on_hand` = ACCOUNTING stock (moves when invoices/
  bills are approved — Michelle keeps them draft); `actual_available_stock` = PHYSICAL (moves on
  shipments and purchase receives). CTP's cache shows PHYSICAL as "on the shelf" plus Zoho's
  available-for-sale; the accounting figure is kept in `zoho_item.actual_available`.
- **0065** (live): `zoho_config.stock_master` 'ctp'|'zoho' (default **ctp** = rehearsal),
  `set_zoho_stock_master` (admin), `ctp_ledger_frozen` (off; for cut-over), Zoho stock cache on
  `part.zoho_*` (staff stream SELECT * — no sync-rule change) and `zoho_item`; `apply_zoho_stock`;
  `record_goods_out` (fulfilled + package/shipment refs + hold released, NO CTP sale; the fulfil
  gate trigger still applies); trigger `stock_movement_zoho_guard` (CTP sale refused in zoho mode;
  everything refused when frozen except origin 'cutover'); logs `zoho_stock_adjustment`,
  `zoho_purchase_receive`.
- **zoho-push** new actions:
  - `stock_sync` (also every 15 min with the 10-min status read-back);
  - `ship` (package + shipment, marked delivered, then `record_goods_out`; idempotent);
  - `adjust` (count → Inventory adjustment of counted − Zoho physical);
  - `receive_list` / `receive` (purchase receive against a Zoho PO);
  - `hook` (Zoho webhooks with the public anon key; trusts only the id and re-reads Zoho; 10 s
    throttle per record).
  
  Ship / adjust / receive act only when `stock_master = 'zoho'`, or as an explicit rehearsal test
  (admin / server token + `rehearsal_test: true`).
- **Phone (v29):**
  - part sheet shows "Zoho: N on the shelf · M available";
  - in zoho mode: "Post count to Zoho", Fulfil becomes "Ship in Zoho — package + shipment",
    Info → **Receive goods** (open Zoho POs, quantities, receive);
  - Settings → Zoho → **Stock master** switch (admin) + "Refresh Zoho stock".
- **Live rehearsal test** (TEST docs only, all deleted, stock back to start), on part 1001:
  - stock cache 155 items;
  - ship refused before invoice; after INV linked → PKG-00005 / SHP-00005 delivered; CTP
    fulfilled; no CTP sale; repeat = already; anon key cannot ship; webhook ok;
  - count 12 vs Zoho 11 → adjustment +1, cache 12;
  - receive PR-PO-00002-2 against TEST PO-00002;
  - physical stock moved 11→10 on ship and 11→12 on receive.

  Gaps left by tests: SO-00016/17, INV-000007/8, PKG-00004/5, SHP-00004/5, PO-00001/2, adjustment
  CTP-COUNT-2.
- Found: **PKG-00001–003 / shipments for Hermans SO-00011 and SO-00012** were created in Zoho on 23 Oct
  (delivered) — apparently by accounts. Consistent with CTP (both orders already out).
  Re-run dry run: 33 Books docs + 3 packages + 3 shipments to delete at cut-over.
- `inv_fixture` (zoho-auth): creates/deletes ONLY TEST-marked docs for live tests; `inv_get`:
  whitelisted read-only Inventory GETs. Tests: tests_0065_local.js 20/20 (+0064 15, 0063 24,
  0061 19, 0059 26); deno check at baseline (71).
- **Webhooks:** `docs/10_ZOHO_WEBHOOKS.md` — workflow rules can only be created in Zoho's UI
  (Ian/Michelle, ~15 min). Polling covers until then.

**Defaults taken (Ian: urgent questions only):**
1. The rehearsal switch stays on CTP; an admin flips it in Settings → Zoho to rehearse; back any time.
2. A shipment is marked delivered immediately (counter collection); delivery method "Collection",
   tracking no. = the RQ number.
3. Counts post straight to Zoho (no draft); reason "Stock count"; description says who and what Zoho had.
4. Receives: Zoho's auto-numbering for purchase receives is OFF in this org → CTP numbers them
   `PR-<PO>-<n>` (Michelle can switch auto-numbering on; then Zoho's numbers are used).
5. Webhooks authenticate with the public anon key + refetch-only (no secret to share).
6. Cache shows physical stock; customers' `in_stock` is unchanged (still CTP) until cut-over.
7. Phone "Count" (CTP ledger) stays as-is in ctp mode; in zoho mode the Zoho count is offered on
   the part sheet.

## 23 Oct (late) — webhooks: Books plan has none; Inventory ones are manual; keyless zoho-hook live
- API check: Books/Inventory both have an undocumented settings API for webhooks/workflows.
  Books CREATE refused: "Webhook has been disabled for your account. Please upgrade your plan"
  (code 13116) → no Books webhooks; quotes/estimates stay on polling. Nothing was created.
  Inventory: webhooks offered (item, SO, invoice, package, shipment, bill, purchase receive,
  adjustment) but our token has `ZohoInventory.settings.READ` only → manual setup in Zoho
  Inventory (docs/10), or a later grant with `ZohoInventory.settings.CREATE`.
- New edge function **`zoho-hook`** (verify_jwt OFF; `supabase/config.toml`): Zoho calls it with
  just a URL + `{"module","id"}` — no key, no secret. It forwards to zoho-push `hook`
  (refetch-only, 10 s throttle). Tested keyless (JSON body and query string). Deploy with
  `--no-verify-jwt`.
- zoho-auth: `webhook_probe` (read-only), `webhook_admin` (list / placeholders read-only;
  create/delete only objects named "CTP Core …"). Placeholders read from Zoho are in docs/10.

## 23 Oct (night) — Zoho Inventory is the item master; Multicat out (0066, PWA v30)
- Ian: "why is multicat still being referenced?" — Zoho Inventory is the item/parts master;
  Multicat is no longer a source. Codes unchanged (part no. = Zoho SKU).
- App: Settings → Zoho text now says Zoho Inventory is the parts master; the only other mention
  was a code comment. Nothing in code used Multicat as a source (only historical migration 0046,
  its one-off generator, desktop migration 0025 and an unused root CSV — all left as history).
- **New parts come from Zoho** (0066, live): category "New from Zoho" (code NEW, id 117);
  `zoho_new_part()` (server-only: id = max+1 under a lock, part + list price + landed cost + Zoho
  link; idempotent on SKU). zoho-sync "Pull & apply" creates them; "Check Zoho" previews
  (`new_parts`). Live preview 23 Oct: none pending (161/162 linked, 0 unmatched); 37 name/price
  differences wait for a staff Pull & apply (Zoho wins when applied).
- Default: Pull & apply stays a manual staff action (Settings → Zoho), not automatic.
- Docs: `docs/11_SYSTEM_MAP.md` (current masters + hosting); notes added to
  CTP_Internal_Naming_Convention.md, ARCHITECTURE.md §7, docs/06; docs/09 wording.
  Tests: tests_0066_local.js 10/10.

## 23 Oct (night) — Zoho Inventory webhooks LIVE; item Unit set to "pcs"
- Webhooks set up in Zoho Inventory via the browser: 8 webhooks + 8 active workflow rules →
  `zoho-hook`. Verified: Zoho's test for item 1429405000000099011 was processed — that item alone
  re-read at 13:45:32 (between crons at 13:40 and 13:50); 0 hook errors. docs/10 updated.
  Estimates (Books) stay on polling.
- Zoho items had an empty Unit, which blocked saving edits in Zoho's UI. zoho-auth `set_unit`
  (sets ONLY `unit` on ACTIVE items with an empty unit; re-reads and checks 12 other fields) →
  all **155 active items now unit = "pcs"**. Verified against the morning snapshot
  (docs/stock/raw_2026-10-23): 162 items / 155 details, 0 differences in name, SKU, status, type,
  rate, purchase rate; 0 empty units left. The 7 inactive items were not touched.

## 23 Oct (late night) — end-to-end test fixes (0067, PWA v31)
Ian's browser e2e passed every stage (RQ-261023-50 → QT-000006 → SO-00018 → INV-000009 paid →
fulfilled/closed). Findings fixed:
- **PRIVACY (#4, 0067, live):** `sales_order.notes` syncs to the customer's phone but also carried
  staff history (accounts' price changes, "Accepted on the customer's behalf by …", holds, Zoho
  events). Now:
  - new `staff_log`; live notes were split (customer text stays, system lines moved);
  - trigger `sales_order_notes_to_staff_log` redirects every later write to notes into
    staff_log — every existing function is covered without rewriting it;
  - `authenticated`/`anon` lose SELECT on staff_log (column grants: verified "permission denied"
    live); staff phones get it via the SELECT * stream and show it as "History (staff only)".

  **NOTE:** column-level grants mean a NEW sales_order column must be granted to authenticated
  explicitly (`grant select (col) on sales_order to authenticated`) if anything reads it over the
  Data API. The app reads sales_order via PowerSync / RPCs only.
- **SO status (#1):** labels per document — sales order open = "Confirmed", plus closed / void /
  on hold / invoiced / shipped; no "Draft" fallback. Root cause: accept functions hard-code
  zoho_so_status 'draft' until accept-quote writes Zoho's status → trigger
  `sales_order_so_open_on_accept` records 'open' at acceptance (Zoho confirms the SO first).
- **Fill from list (#2):** fills the price boxes only (latest list price read locally — no
  write). With estimates on, a priced quote without an estimate stays in "Needs pricing"
  (`stageOf`) until **Send quote** saves and creates the estimate.
- **Close toast (#3):** SO-backed orders: "Order closed — invoiced in Zoho as INV-…".
- **Accept on behalf (#5):** in-app dialog with a required note (no window.prompt). Still
  window.prompt: Cancel order, Release for fulfil (not asked yet).
- **Outstanding (#6):** the customer's Zoho balance is re-read whenever an invoice is linked or
  changes (was 6-hourly; the test read it 1 min before the invoice). refreshTerms always reads a
  named customer.
- **Lane headers (#7):** reflect the orders in them (invoiced/paid → "close the order", etc.).
- **Word wrap (#8):** `.mb-rv` breaks only overlong words (no "accou/nts").
- **#9:** two test customers exist — "CTP TEST - Ian" and "Test Account (Ian)" (TESTACC, used by
  the live tests). Left as is.
- docs/09: note for Michelle — Zoho's payment form ticks "Send a Thank you note" by default.
- Tests: 0067 14/14 (+0066 10, 0065 20, 0064 15, 0063 24, 0061 19, 0059 26, orderFilter 33);
  tsc + build clean. Deployed: 0067 (dry run first), zoho-push, PWA SW v31.

## 24 Oct — stock consistency across CTP, Zoho Inventory and Zoho Books (PWA v32)
Traced part 2803052B1063 (E2E order RQ-261023-50 / SO-00018 / INV-000009) with the new read-only
`zoho-auth {action:"item_trace", sku, so_number?, invoice_number?}`.
- **Zoho keeps two stock figures in one org.**
  - ACCOUNTING `stock_on_hand`: the SAME number in Books and Inventory. Moves when invoices and
    bills are approved, and with adjustments.
  - PHYSICAL `actual_available_stock`: Inventory only. Moves with shipments, purchase receives
    and adjustments.
  - Each document moves each figure once → **no double deduction inside Zoho**.
- **Found:** in CTP mode, Fulfil moved only the CTP ledger. INV-000009 (approved) took accounting
  13→12, but no package/shipment existed (SO shipped_status "pending"), so physical stayed 13
  with 1 "committed". That was the 13 vs 12.
- **Fix:** CTP-mode Fulfil on an SO-backed order now also calls zoho-push `ship` with
  `mirror: true` (package + shipment, delivered). The mirror is allowed only for an order CTP has
  already fulfilled, and `record_goods_out` is then a no-op → never a second CTP movement.
  Zoho mode is unchanged: Ship creates package + shipment and CTP writes no sale.
- **Movement (backfill of SO-00018 → PKG-00006 / SHP-00006):**

  | | CTP ledger | Inventory physical | Inventory accounting | Books |
  |---|---|---|---|---|
  | before | 11 | 13 | 12 | 12 |
  | after | 11 | 12 | 12 | 12 |

  CTP sale movements on the order: still 1. App cache 12.
- **CTP 11 vs Zoho 12** is the known pre-existing +1 from the reconciliation, settled by the
  counts at cut-over:
  - CTP's opening load missed PI000001's 3;
  - CTP sold 3 that Zoho never invoiced;
  - CTP adjustments/returns +5 never reached Zoho.
- **COGS / inventory-asset journal for INV-000009: not readable** with our scopes
  (`/journals`, `/chartofaccounts/transactions` → 401). It needs `ZohoBooks.accountants.READ` in a
  future grant if Ian wants it verified by API. In Books+Inventory, COGS posts with the approved
  invoice (accounting stock).
- **Default:** stay on `stock_master = ctp` through the rehearsal (the counts and adjustments
  stay frozen until the reconciliation is approved). Flip to `zoho` at cut-over.
  Receiving/counts in CTP mode do not touch Zoho:
  - Michelle's bills move Zoho accounting;
  - Zoho physical moves only via phone Receive (Zoho mode) or Zoho's own purchase receive.

## 24 Oct — Anton demo glitches (PWA v33)
Demo passed every step (RQ-261023-51 → QT-000007 → SO-00019 → INV-000010 paid → fulfilled/closed,
PKG-00007/SHP-00007, stock 12→11 in Zoho).
- **#3 SO status "not read yet" — real bug, now fixed:** `staffOrders()` SELECTed `zoho_so_status`
  and `zoho_so_error` but never mapped them into the order object, so the phone always saw blank
  (v30 showed it as "Draft", v31 as "not read yet"). DB had it right (SO-00019 "invoiced").
- **#1 Send quote:** the log shows QT-000007 created by Ian at 15:06. The symptoms (Fill wrote
  prices, Send quote vanished) were v30 behaviour → the open tab was still running an older
  build. Now:
  - **the app shows its version** (Info → "App version vNN · built …", Settings → Zoho header);
  - main.tsx shows "A new version of CTP Core is ready — Reload" when a new service worker takes
    over, and checks for updates whenever the app returns to the foreground;
  - Send quote creates the estimate whenever the quote is fully priced (price warnings no longer
    skip it);
  - the "No Zoho estimate yet / Create estimate" block appears only after a failed attempt
    (recovery).
- **#2 Refresh:** the server applies Zoho's latest at once, but the change reaches the phone via
  sync a moment later → Refresh re-reads the orders at +1.5 s and +4 s, so one tap shows it.
- **#4:** CTP ledger for 2803052B1063: sale −1 at 15:12 (RQ-261023-51) → 11 → 10. Zoho
  physical = accounting = Books 11.
- Version shown in the app: **v33** (= the service-worker cache version, read at build time in
  vite.config.ts).

## 24 Oct — read-only audit of Anton's Zoho changes after the demo (nothing changed)
New read-only `zoho-auth {action:"audit", part: settings|items|contacts|transactions|pricebook|contact_detail}`.
Compared with the 23 Oct item snapshot, the dry-run transaction list, the 23 Oct Inventory
settings reads and CTP's caches.
- **Unchanged:**
  - org, preferences, location, 3 admin users, currencies, taxes (8 at 15%/0%; "Standard Rate"
    is NOT flagged default — CTP matches it by name), templates;
  - prefixes INV- / QT- / SO-;
  - all 162 items (no new / renamed / deactivated; rates, purchase rates, unit, tracking same;
    2801070-1063 saved at 16:40 with no tracked field changed);
  - CTP's 8 Inventory webhooks + 8 workflow rules intact and active;
  - no bills, POs, payments, adjustments, receives or packages since the demo.
- **New or changed:**
  - customer **Test Co 2** created from CTP Core (15:20, VAT 4670222333, contact Piet Pompies,
    anton@supalift.co.za), edited in Zoho 15:39 → **credit limit R20,000** (CTP has it);
  - CTP quotes **RQ-261023-52 → QT-000008** (R17,733.45, sent) and **RQ-261023-53 → QT-000009**
    (R10,794.44) **accepted in Zoho at ~16:22** with no sales order — CTP still shows it as a quote;
  - price book **"Rebate"** (per item, sales) created ~16:4x, 1 item (5704145CB45 at its normal
    R527.21), assigned to nobody;
  - invoice counter at INV-000012 while the newest invoice is INV-000010 → **INV-000011 was created
    and deleted** after the demo (possibly a "convert to invoice" from QT-000009, then deleted).
- Expenses / journals not readable with our scopes (401).

## 24 Oct — new direction (docs/12): rebates via price books, catalogue, PO acceptance; items 6–7 built (0068, PWA v34)
- **docs/12_REBATES_CATALOGUE_PO_FLOW.md** = the design for confirmation.
  Read-only API checks:
  - contacts have a "Price List" (`pricebook_id`) field;
  - per-item price books are writable;
  - `/salespersons` is empty;
  - SO attachments endpoint exists;
  - Anton created Manufacturer **FAW** + Brand **JH6** (set on 2801070-1063) and made item
    **Brand MANDATORY** (Zoho UI saves of other items need a brand) — corrects the earlier audit;
  - categories empty.
  
  No Zoho data changed.
- **Built — item 6, audit trail (0068, live):**
  - `sales_order.timeline` (jsonb, staff-only: not in customers' stream, not granted over the
    Data API — verified "permission denied");
  - a trigger records created / priced / estimate sent·accepted·… / accepted (customer or on
    behalf + note) / SO raised / invoiced / paid / released / fulfilled·shipped / closed /
    cancelled·declined;
  - actor from the session, accepted_by / fulfil_override_by / raised_by, the customer login, or
    a one-shot `event_actor` (set by `record_goods_out`); Zoho read-backs = "Zoho (accounts)";
  - `append_order_event()` (server) for edge steps: "Quote sent to Zoho as QT-…" (zoho-push
    estimate) and the CTP-mode mirror shipment;
  - existing orders back-filled ("reconstructed");
  - phone: "Timeline" on each order.

  Zoho side (salesperson + "CTP user" field) waits for confirmation.
- **Built — item 7, Orders colours:**
  - Needs pricing amber · Quote sent blue · Awaiting invoice purple · Ready to fulfil teal ·
    Goods out green · completed/cancelled muted;
  - left bar + labelled pill + legend;
  - AA measured: dark 6.6–9.9:1, light 5.3–6.7:1.
- **Item 8 part:** `zoho_config.tax_id` = 1429405000000095109 ("Standard Rate" 15%) — pushes use the
  id, so a rename can't break invoicing.
- Tests: tests_0068_local.js 18/18 (+0067 14, 0065 20); deno at baseline; tsc + build clean.
- Waiting on Ian/Anton: confirm docs/12 (then: PO flow with estimates OFF → rebates (needs the
  spreadsheet) → staff pricing view → public/walk-in RLS → catalogue fields → Zoho salespersons).

## 24 Oct — rebate price book "FAW JH6 – Rebate" LIVE in Zoho (0069)
- Ian chose option B. **Zoho price book `FAW JH6 – Rebate`** (id 1429405000000433001, per-item, sales).
  - 113 parts, every rate verified by read-back, 0 mismatches.
  - Tiers: 25% × 102, 20% × 2, 15% × 8, 10% × 1. The 41 parts at 0% are left OUT of the book (my call).
- **Rule** (from the sheet): pick the highest of 25/20/15/10/0% that keeps contribution margin
  ≥ 30% after 10% commission. It runs on Zoho's CURRENT sales price and cost.
- **What was not touched:**
  - item sales rates (0 changed against the 23 Oct snapshot);
  - Anton's "Rebate" book (still 1 item, 5704145CB45 at 527.21);
  - customer assignments (no contact has a price list; the book is not assigned yet).
- **Final list:** docs/rebates/faw_jh6_rebate_pricebook_2026-10-24.csv
  (part, name, Zoho price, cost, rebate %, rebate price, contribution margin, in book, flag).
- **Flags:**
  - DIA001 is in the sheet but not in Zoho, so it is left out of the scheme;
  - CAB001 is an active Zoho item that is not in the sheet;
  - 5201010-B45 was blank in the sheet. The rule now gives 0%, because 10% would drop the margin below 30%; at 0% the margin is 27.1%.
- **Reusable:**
  - tables `rebate_scheme` (tiers, min_contribution, commission, include_zero, zoho_pricebook_id,
    last_result) and `rebate_scheme_sku` hold the part list (staff-only RLS);
  - zoho-push `{action:"rebate_book", scheme:"FAW JH6 – Rebate", apply:false|true}` (admin or server
    token) recomputes from live Zoho prices and costs. `apply:false` previews; `apply:true` updates the
    same book in place and verifies it;
  - re-run it whenever prices or costs change. It never changes item rates or customers.
- JS rounds half-up and the Python dry run rounds half-even. This gave 9 one-cent differences against
  docs/rebates/rebate_dryrun_2026-10-24.csv. Zoho has the JS values.

## 24 Oct — PO flow LIVE: quote → customer PO → confirmed SO, estimates OFF (0070, PWA v35)
- **Estimates are switched off** (`zoho_config.estimates_enabled = false`). The switch and the code
  are kept.
  - Quotes already sent as a Zoho estimate still finish through that estimate: RQ-261023-52
    (QT-000008, sent).
- **Accept needs the customer's PO** (accept-quote):
  - A PO number is required (50 characters at most).
  - A PO file (PDF or photo) is required for customers and optional on behalf. The settings are
    `zoho_config.po_file_required` and `po_file_required_behalf` (SQL only, no UI yet).
  - The file goes to the private bucket **po-docs** `<customer id>/<order id>/…`:
    - a customer can write and read only their own folder;
    - staff read everything;
    - nobody can update or delete;
    - the limit is 10 MB, PDF or image.
  - The accept checks the file belongs to the order, then saves `po_number`, `po_file_path`,
    `po_file_name` and `credit_warning` on the order.
- **Zoho SO:**
  - `reference_number` = the PO;
  - the notes read "Accepted in CTP Core · order RQ-… · customer PO …";
  - the PO file is attached (`/salesorders/{id}/attachment`; if this fails it is logged and shown,
    and the order stands).
- **Idempotency:** `findOurSalesOrder` tries the old reference (= CTP no.) first, then every live SO
  carrying that PO, read in full, matched on "order RQ-…" in its notes (exact match:
  RQ-…-1 ≠ RQ-…-12).
  - Default taken: the CTP order no. is in the notes, not in a "CTP order" custom field. Zoho has no
    public API to create custom fields; Anton can add one later and CTP will fill it.
- **Credit limit:** `{order_id, check:true}` is a read-only precheck, shown when the accept / on-behalf
  dialog opens.
  - It compares Zoho outstanding + this order (incl. VAT) against the Zoho credit limit, read live.
  - It only warns, never blocks. The customer sees "accounts will review"; staff see the figures,
    and the warning is kept on the order.
- **Quotes accepted or converted in Zoho are followed** (zoho-push status read-back,
  `followZohoAccept` → `accept_quote_from_zoho`):
  - estimate converted to an SO in Zoho → that SO is linked, never a second one;
  - estimate newly accepted → its SO is raised from it;
  - converted straight to an invoice → the invoice is linked;
  - then the order is confirmed, the stock held, and the timeline shows "Accepted in Zoho" by
    Zoho (accounts);
  - skipped while a customer's own accept is in flight (the PO was written less than 3 minutes ago).
  - RQ-261023-53 (QT-000009, accepted in Zoho on 23 Oct, no SO) is NOT auto-accepted: it was already
    "accepted" before this shipped. Its test customer is Test Co 2, so the desk should tidy it by hand
    if wanted.
- **Phone:**
  - "Accept quote" opens a PO step: PO no., file, and the credit note if there is one.
  - The on-behalf dialog has a PO no. and a file.
  - Staff cards show "Customer PO …", "View PO" (a 5-minute signed link) and the credit warning.
  - The timeline shows "· PO …" on the accepted step.
- **Tests:**
  - tests_0070_local.js 19/19 (0068 18/18, 0067 14/14);
  - deno check at the 71-error baseline (no new errors);
  - tsc and build clean;
  - live `zoho-auth {action:"po_test"}` on TESTACC: SO-00020 was created with ref = PO, found again by
    its notes (a prefix of the number was not), and the PO PDF attached. The test SO was then deleted,
    leaving a gap in the SO numbering.
- **Not yet tested end to end with a real customer login.** The first real accept is Hermans
  (account customer): check that the SO shows the PO and that the attachment is there.
- **Deploying edge functions:** `server/edge` is staged as `supabase/functions` in a temp folder, then
  `supabase functions deploy <fn> --use-api` (there is no supabase/functions in the repo).
- Next: price-book-aware pricing (customer's pricebook_id, list price struck through + rebate price,
  staff margin, SO with pricebook_id) → public/walk-in RLS → catalogue fields → Zoho salespersons.

## 24 Oct — "FAW JH6 – Rebate" assigned to Hermans (0071)
- Ian: "apply to hermans". The Zoho contact **Hermans Panel Beaters** (1429405000000131019) now has
  Price List = FAW JH6 – Rebate (1429405000000433001).
- **Before writing,** the book was re-checked: it is live and has the scheme's 113 items.
- **Verified after,** by reading the contact back:
  - the price book is set;
  - comparing every field before and after, only Zoho's own `last_modified_by_id` changed;
  - only `pricebook_id` was sent, so the VAT number and everything else on the contact are as they
    were (Michelle adds the VAT no.).
- **No other contact was written to.**
  - Note: the `/contacts` list doesn't return the Price List field, so the earlier "no contact has a
    price list" check from the list was not conclusive. Use a per-contact GET instead.
- **CTP picks it up:**
  - 0071 adds `customer.zoho_pricebook_id / zoho_pricebook_name / zoho_pricebook_synced_at`;
  - the assignment writes them, and refreshTerms (account terms read-back) now re-reads them, so a
    change made in Zoho reaches CTP too;
  - Hermans' row: pricebook 1429405000000433001 ✓.
  - The pricing UI (sales price struck through, rebate price beside it) will read this column.
- **Reusable:** zoho-push `{action:"assign_pricebook", scheme, customer_code}`, admin or server token.

## 24 Oct — price-book-aware pricing LIVE (0072, PWA v36) — docs/12 items 1 + 3
- **Cache:** `price_book` / `price_book_item` is a staff-only cache of the Zoho books customers are on
  (RLS `is_staff()`; anon has no grant).
  - Filled by zoho-push `pricebook_sync`: at once after `rebate_book` apply or `assign_pricebook`,
    hourly with the status read-back, or on demand `{action:"pricebook_sync", force:true}`.
  - Live: FAW JH6 – Rebate, 113 items, all linked to CTP parts. A part dropped from the book is
    removed from the cache.
- **`order_prices(order)`:**
  - per line, list price + the customer's book rate;
  - staff also get cost (`part_current_cost`) and the 0041 floor;
  - a customer gets only list + their own book rate, and only on their own order.
- **`my_prices(part_ids)`:** a logged-in customer ON A BOOK gets list + their rebate price for book
  parts. Customers without a book get nothing: they are quoted, as before. That is my default:
  prices in the catalogue are shown only to customers on a rebate book.
- **Phone:**
  - **Staff, quote lines:** "~~list~~ **rebate** each · −25% rebate" (or "List R…"), then
    "Cost · margin R (x%) · floor", coloured against the floor: green is clear, amber is within 5%,
    red is below. "Price book" is shown on the order.
  - **Fill from list** now uses the customer's book rate first; the toast says how many lines.
  - **Customers (Hermans):** the part sheet shows "Your price (excl VAT) ~~R list~~ R rebate · x%
    rebate on your account". Their quote lines show the list total struck through next to their
    price.
- **Zoho SO:** raised with the customer's `pricebook_id`. Line rates stay explicit (they are the book
  rates).
- **Tests:**
  - tests_0072_local.js 30/30 (includes the 0070 checks);
  - deno at the 71 baseline; tsc + build clean;
  - live SQL as the Hermans login: my_prices returns 5/5 book parts, cache rows visible 0, and an
    order line shows list 4 642.52 / book 3 481.89 with no cost. As TESTACC (no book): 0 / 0.

## 24 Oct — docs/12 finished: hiding (0073), catalogue (0074), salesperson; PWA v37
- **Server-side hiding (0073, live):**
  - Over the Data API, `authenticated` reads every column EXCEPT:
    - part: list_price_minor, locator, inventory_pn, notes, match_status, max_rebate_pct, origin,
      zoho_* ids/stock, supplier;
    - customer: notes, price_tier, rebate_pct, origin;
    - sales_line: tier_at_add, rebate ceiling/override columns, origin.
  - The PowerSync streams, edge functions (service role), SECURITY DEFINER RPCs and staff PATCHes
    are unaffected.
  - TRUNCATE/TRIGGER/REFERENCES are revoked from anon and authenticated on every public table.
  - `public_parts(q, limit)` is for anon (a future public site): parts, OEM no., make/model,
    section, in stock yes/no. No prices.
  - Live check as the Hermans login: list price, bins, Zoho stock, customer notes, tiers and
    staff_log are refused; their name and line prices are readable; price rows visible = 0. Anon:
    part is refused, and public_parts returns 155 parts without prices.
  - Walk-in / cash customers have no login, so they are served from the staff screen only.
  - Found: **0049 (`part.in_stock`) is NOT on live**, though sync-streams.yaml lists it.
    public_parts derives in-stock from the ledger instead. Check the PowerSync dashboard copy of
    the streams against the repo file.
- **Catalogue (0074, live):**
  - `part.part_type` (OEM/Aftermarket; Zoho custom field "Part type" if Anton adds one, else OEM)
    and `part.supplier` (Zoho preferred vendor; staff only).
  - make = Zoho Manufacturer, model = Zoho Brand, read with the 15-minute item read
    (`apply_zoho_catalogue`; only changed rows are touched).
  - **Zoho changed:** Manufacturer FAW + Brand JH6 set on the 154 active items that had neither
    (Anton's 2801070-1063 already had them), via `{action:"catalogue_set", apply:true, limit:25}`
    in paced batches.
    - Every item was read back: 0 failed, 0 drift in rate, purchase rate, name, SKU or status.
    - Brand being mandatory no longer blocks UI saves.
    - Categories (sections) were NOT mirrored into Zoho: not asked for.
  - CTP: 155 parts are FAW · JH6 · OEM · Supalift Trading cc. The 2 parts not linked to Zoho keep
    FAW/JH6.
  - Phone: Find has Make / Model / Type filters (Supplier for staff), shown only when a field has
    more than one value. So with everything FAW JH6 they appear once aftermarket parts or other
    makes arrive. The part sheet shows "FAW · JH6 · OEM" (and the supplier for staff).
  - sync-streams.yaml: `part_type` was added to the customer part list. **It needs pasting into the
    PowerSync dashboard** (not urgent; until then customers see no Type).
- **Salesperson on Zoho SOs (live):**
  - SOs carry `salesperson_name` = the CTP staff member: the admin accepting on behalf, else
    whoever sent or priced the quote (timeline), else whoever raised it. Customer logins, names
    with "test" and unnamed users are skipped.
  - Zoho links the salesperson by name, or creates one the first time. Tested live:
    `zoho-auth {action:"sp_test"}` created salesperson **"Ian"** (1429405000000448002) on test
    SO-00021, which was deleted.
  - Accounts' invoices converted from the SO carry it.
  - The "CTP user" custom field is not set up: Zoho has no API to create custom fields.
  - Staff data to tidy: three "Ian" admin rows (two without a login email), a sales user with no
    display name, an "ian test customer" sales user, and no Michelle user.
- **Already live from earlier today:** item 4 PO flow + estimates off, item 6 credit warning,
  item 7 follow Zoho (0070, v35); item 8 tax by id (0068).
- **Tests:** tests_0074_local.js 51/51 (includes 0070 + 0072); deno at the 71 baseline; tsc + build
  clean.

## 24 Oct — staff logins tidied, Michelle invited, in_stock reconciled (0049 + 0075 live)
- **Staff (Ian approved):**
  - Removed three `app_user` rows that had **no login**: two "Ian" admins (e852b1f0…, 42743bef…)
    and "ian test customer" (711d7d75…).
    - Nothing referenced them (orders, ledger, timeline, push log, people).
    - A copy is in the session scratchpad (app_user_before_tidy.json).
  - Kept **Ian = 7efb7f16… (iancrediblemusic@gmail.com)**, the account he signs in with (31 Zoho log
    entries, 4 orders).
  - Labelled the unnamed sales user ian@proton.me (signed in once, 7 Oct, nothing attached) as
    "Ian (test login)". It was kept, not deleted.
  - **Michelle Smith** (michelle@supalift.co.za) was invited the admin-users way (Supabase Auth
    invite, redirect https://ctpcore.vercel.app). Role **manager**: she sees pricing, cost and
    margins, and can do everything accounts needs in CTP. Admin-only actions (users, accept on
    behalf, fulfil release) stay with Ian and Anton. Auth id ec87eadb…; Supabase accepted and sent
    the invite.
  - Staff now: Anton (admin), Ian (admin), Ian (test login) (sales), Michelle Smith (manager).
- **in_stock:**
  - 0049 (approved 20 Sep) had never been applied on live, though sync-streams.yaml and the
    customer app read `part.in_stock`. It is applied now.
  - 0075 grants the column under 0073's column grants.
  - Live: 154 of 157 parts in stock, 0 mismatches against the ledger.
  - Every table and column named in server/sync-streams.yaml exists on live (checked by query).
    **The file is final for the dashboard paste.**

## 24 Oct — customer-visibility check after PowerSync sync rules v8 (9ac1): PASS
Signed in on ctpcore.vercel.app as the test customer "Test Account (Ian)" (ian@iancredible.co.za,
customer 7) using a one-time admin magic link. No email was sent and no password was used. The
local PowerSync DB was read in the browser after hasSynced, then cleared and signed out.
- part_cost 0, price 0, price_tier 0, stock_policy 0, location 0, stock_movement 0, customer 0,
  part_alias 0.
- sales_order 13 and sales_line 27, every one customer_id 7 (2 live, 11 soft-deleted test orders).
  zoho_salesorder_number is present (8 orders, SO-00005 … SO-00019).
- part 162 = 157 live + 5 soft-deleted, so the file's "expect 161" comment is out of date.
  in_stock is set on all 162 rows (155 true). part_type is OEM on 155 rows; 2 live CTP-only parts
  (CTP-CBY-001-C, CTP-CBY-004-C) are null because they are not in Zoho.
- Columns actually synced, read from the raw ps_data JSON: part has no list_price_minor, locator,
  inventory_pn, notes, match_status, supplier or Zoho stock. sales_order has no internal fields.
  company carries our own invoice details (bank, VAT no.), which is intended.
- Caveat: sales_order.notes is the customer's own order note, but past staff test runs appended
  text to it (e.g. "DELETE ME"). Staff should not write internal remarks there.

## 24 Oct — rebate prices everywhere (0076, v38)
Ian: "List, Cost and Floor on an order line, but no rebate and no strikethrough."
- **Why it happened:** the rebate data was fine on the server: book "FAW JH6 – Rebate", 113 rates,
  all matched to parts, assigned to Hermans only. The app only read it online, once per open
  order (order_prices) or once per opened part (customers only). The order Ian looked at was a
  test customer's (CTP TEST - Ian / Test Co 2), and neither is on a book, so there was no rebate
  to show. Search, browse, the part page for staff and the cart never showed rebates at all.
  Nothing was synced locally (0 price_book rows on any device).
- **0076** (applied on live, additive):
  - price_book and price_book_item each get a sync `id`. Book rows also carry `list_minor`, the
    part's list price, kept current by a trigger on `price`, because customers never get the
    price table.
  - New RPC `my_price_book()`: the caller's own book only.
  - Live: 113 rows, all with list_minor; 112 cheaper than list, 1 not.
- **Sync rules (server/sync-streams.yaml), awaiting dashboard deploy:**
  - `ctp_staff` also syncs `price_book` and `price_book_item` (all books).
  - New bucket `ctp_client_book`, keyed on the customer row linked to the login
    (`zoho_pricebook_id` not null). It holds only that book's rows: id, pricebook_id, name,
    zoho_item_id, part_id, rate_minor, list_minor. No cost or floor.
- **App (v38):**
  - Every part card, staff part page, customer basket and unpriced customer order line shows the
    list price struck through, the rebate price, "−x%" and a label.
  - Staff labels follow context: the counter-sale customer, else the open order's customer
    ("Hermans rebate"). A customer with no book shows nothing. With no customer picked, staff
    see "Hermans rebate".
  - Staff order lines fill gaps from the on-device book. An unpriced line's price box now starts
    at the customer's rebate price, and Send quote uses it.
  - Until the new rules are deployed the app reads the same rows online once (staff: tables
    under RLS; customer: my_price_book()). After the deploy it reads them from the device and
    works offline.
- **Tested** on the local build against live:
  - Staff (Ian test login): 113 cards show "Hermans rebate"; counter customer CTP TEST →
    none; Hermans → 113; part page "Price book" box; RQ-261022-45 lines show
    strike/rebate/−25% plus cost/margin/floor.
  - Hermans login (Denver, via a one-time admin link; no email sent, read only, signed out
    after): 113 cards "your price", part page "Your price … 25% rebate on your account", basket
    shows the rebate, no cost/margin/floor/bin anywhere. Direct table read returns 0 rows; the
    customer list holds only Hermans; my_price_book returns 113 rows.
- Deployed to production with `vercel --prod` (a git push alone does not deploy); live sw.js is ctp-core-v38.
- Zoho prices untouched.

## 24 Oct — rebate on the Orders tab (v39)
Ian: "we are missing seeing the rebate visibility in the orders tab?"
- **Staff order cards** (pipeline and completed): a line under the total reads "rebate −R x"
  (the saving against list) and/or "R y above rebate" in amber (charged above the customer's
  rebate price). It is worked out on the device from the price book, so it shows without
  opening the order.
- **Inside an open staff order:**
  - A "Rebate · n lines" row shows the list total struck through (only when higher), the total
    at the charged price, and the same saving/above line.
  - Each line also shows "saves R x vs list" or "R y above the rebate price", next to
    cost/margin/floor.
- **Hermans login:**
  - A priced order's total shows the list total struck through and "you save R x with your
    rebate".
  - A quote still being priced says "your rebate: R x instead of R y".
  - Line strikethroughs as before.
  - Never cost, floor or "above rebate".
- **Rules:** only lines on the customer's book count. A R0 line counts at the rebate price only
  on a quote; on a settled order it was free and is skipped.
- **Finding for Ian/Anton:** Hermans' two newest invoices (RQ-261022-45, RQ-261020-43) were
  charged at list, so they show "R 15 620,90 above rebate" and "R 289,00 above rebate". Their
  older orders were partly below list.
- Tested on the local build against live as staff (Ian test login) and as Hermans (Denver,
  one-time admin link, read only, signed out after).
- Pricing/orders UI files only: MobileShell.tsx, mobile.css, sw.js.

## 24 Oct ~15:00: "app not pulling items" check (no change made)
- Supabase: part 162 rows (157 live), price_book 1, price_book_item 113 (no null ids). The
  `powersync` publication is FOR ALL TABLES, so price_book and price_book_item are in it. The
  replication slot is active with 0 bytes of lag.
- Sync rules v9: the diff from v8 only adds tables (price_book and price_book_item for staff,
  plus the new ctp_client_book bucket). The part queries are unchanged.
- Live app v39, fresh staff sign-in (Ian test login): connected, every bucket synced at
  15:00:21, 162 parts and 113 price-book rows on the device, catalogue grid shows 157 parts.
- The customer-side sign-in test was blocked by the permission check and not run.
- One transient CORS error on zoho-push in the console. The preflight is fine (204 with
  CORS headers) when re-tested.
- Conclusion: no server or rules fault, so no rollback needed. Ian's device is most likely
  holding a stale session or local state. Fix: reopen the app, else sign out and back in.

## 24 Oct — Aerokit "gone missing" + photo orientation (PWA v40)
Ian: "Aerokit parts, diagram etc. have gone missing??? A lot of the item images are not oriented
correctly as you would see them on the truck, or in the diagram."
- **Nothing was missing on the server.** Roof Deflector (DEF, category 115): 26 parts active and
  linked to Zoho (all active there), section drawing SEC115 live, files in ctp-assets, photos,
  xrefs (CTP-DEF-001…026) intact. Same under RLS as a staff and a customer user (rolled-back
  `set local role` reads). Not sync rules, not 0073 grants, not Multicat removal, not deactivation.
- **Cause: the drawing was 0 px wide on phones.** In DiagramView the "pinch… to zoom" hint
  (`.mb-lb-hint`, shown when `!wide`) sits inside `.dv-stage`, a flex ROW; its one long line took
  the whole width and squeezed `.dg-wrap` (flex-basis 0) to 0. Every section drawing was blank at
  phone width since 18 Sep; tablet/desktop were fine, which is why earlier checks passed. Fix:
  `.dv-stage>.mb-lb-hint` is an absolute overlay at the bottom of the drawing (mobile.css).
- **2 Aerokit parts never had a marker** (the OEM drawing gives each L/H–R/H pair one callout):
  5704145CB45 Adjustment Support Bracket L/H and 5704180CB45 Top Support Bracket R/H. Added on
  live as hotspots 378 (B5) and 379 (B26), beside their pair. SEC115: 26 markers / 26 parts.
  Still unmarked elsewhere: CBY CTP-CBY-001-C, CAB001; DOR 6105050-B45-C00.
- **Photo orientation:** no catalogue photo carries an EXIF orientation tag (148 WebP, 4 JPEG,
  3 PNG), so it was the pixels. Each marked part's photo was compared with its drawing crop.
  22 rotated (8 sure, 14 "upright for sure, which end is up judged from the drawing"); list,
  degrees and old→new paths in `docs/photos/orientation_2026-10-24.json`, contact sheet
  `docs/photos/orientation_before_after_2026-10-24.jpg`.
  - New files at NEW keys `<name>_r<deg>` (master + web variant, x-upsert false; the CDN and the
    SW cache by key, so overwriting would never reach phones). Originals untouched.
  - `part_image.path` updated on those 22 rows (guarded on the old path). Rollback = set the old path back.
  - Zoho: `zoho-auth {action:"item_images", skus:[22]}` dry run clean, then run: 22 updated,
    0 failed. Only item images touched; no prices or other fields.
  - `.mb-root img{image-orientation:from-image}` stated explicitly for future EXIF-tagged photos.
- **Not decided (need Ian's eye):** hinges/brackets/locks whose drawing is too small to say:
  1136, 1137, 1142, 1143, 1144, 1160 (DEF); 1084, 1085, 1092, 1093, 1096–1099 (DOR); 1065, 1066,
  1073, 1074 (FWL); 1104 (MRR); 1124 (WPR).
- **Probably the wrong photo (not orientation):** 1145 Top Support Bracket L/H shows a hinge;
  1146 Top Support Bracket R/H shows the adjustment-bracket arm; 1001/1002 Front Bumper L/H and
  R/H look like the same photo. 3 parts have no photo.
- **Live-data harness (dev):** `vite.livedata.config.ts` runs the REAL MobileShell and the REAL
  backend.web.ts SQL over sql.js seeded from a role-shaped dump of live rows
  (`src/dev/live/fixture.<role>.json`, gitignored; regenerate with the scratch script pattern in
  this entry's session). `/shell-harness.html?role=customer|admin`, port 4175.
- Sync rules: unchanged (v9 is fine for this).

## Rebate on the customer's Zoho quotes (v41)
- Resumed the Orders-tab rebate work on top of v40 (Aerokit, d901ec1). v39 already shows
  staff a "rebate −R x / R y above rebate" line on every order card, plus a Rebate row inside
  the order. Customers already saw the struck list total on orders priced in the app.
- Gap fixed: a customer's quote backed by a Zoho estimate (most Hermans quotes) showed no
  rebate. Now each line strikes the list price when Zoho's net is lower, and the incl-VAT
  total adds "you save R x excl VAT with your rebate". The saving counts book lines only,
  list minus Zoho net. Cost and floor are still staff-only.
- The customer view was not tested with a customer login, because the permission check
  blocked minting a customer session. It is type-checked and builds clean. Staff paths are
  unchanged.

## 24 Oct — Fulfil needs a SENT invoice (0078, PWA v42)
- Ian: account customers (Hermans) need a SENT Zoho invoice before Fulfil; a draft no longer counts.
- **0078** (applied on live) redefines `fulfil_block_reason()` only: after "no invoice", an invoice in
  Zoho status draft / pending_approval / approved blocks for everyone with
  "Invoice INV-… is a draft in Zoho, ask Michelle to mark it sent." (or "approved but not sent" /
  "waiting for approval"). Cash customers still need `paid`. `fulfilBlockReason()` in app/src/data/zoho.ts
  mirrors it.
- Checked on live: Hermans' INV-000005/INV-000006 (sent) still unlock; order 45 simulated as draft /
  approved / pending_approval blocks, sent / overdue / partially_paid unlocks; RQ-261023-52 (INV-000013
  draft) now shows the draft reason.
- Same evening's diagnosis: the 3 stuck orders were Zoho steps, not a bug — SO-00022/SO-00023 not
  invoiced; INV-000013 saved as Draft and unpaid (cash). zoho-readback cron 200 every 10 min;
  8 Inventory webhooks + rules active; 0 hook errors.

## 26 Oct — new makes are data-driven (0079, zoho-onboard, tools/onboard; docs/13)
- Ian: "replicate everything we've done with the FAW JH6 to any … make, model … Sonnet next, mechanical
  for all". Playbook + data checklist: **docs/13_ADD_A_NEW_MAKE.md**; templates **docs/templates/**.
- **0079** (applied on live, additive): `make_profile` (FAWJH6 row = what was hardcoded: Zoho FAW/JH6,
  Sales - FAW / COGS - FAW / Inventory Asset ids, scheme, pn pattern, rusauto lookup), `part.universal`,
  part_type + 'Universal', xref_type + 'alternate', vehicle_model years/engine, `part_supplier`,
  `import_batch(_row)`, `onboard_import(p, dry_run)`, `onboard_rollback(batch, purge, dry_run)`,
  `onboard_bump_ids()`. Sync rules: no change.
- **zoho-onboard** (new edge fn, admin/service): accounts (read), items (create/link), deactivate, verify.
- **zoho-push** (deployed): `catalogue_set` no longer defaults to FAW/JH6 (from each part's profile;
  explicit values need a SKU list); item reads up to 50 pages (was 10 = 2,000 items); rebate-book
  "not in the scheme" only for the scheme's makes. Live previews identical for FAW (0 to set; 154 / 113
  in book / same tiers / same 1 flag).
- Proof run with fictitious ZZTEST brand (+ a universal part) end to end, then rolled back: 3 TEST Zoho
  items INACTIVE (1429405000000514004, 515001, 520004), CTP purged. docs/onboard_proof/.
- App: unchanged tonight (demo). The UI follow-ups (drawing per make, Find filters with universal parts,
  Jefrey per make, rusauto button from profile) are listed at the end of docs/13.
- Note: the price-book preview runs inside the DB via pg_net (like the cron), so no secret leaves Vault.

### 26 Oct (later): next make is Sinotruk C7H, not "Sonnet"
- docs/13 and the checklist now say Sinotruk C7H. Templates' example rows are Sinotruk too.
- `docs/templates/sinotruk_c7h_template.xlsx` is pre-filled with the profile and vehicle rows. It passes
  `validate --offline` with 2 warnings: the GL account ids are empty until Michelle confirms "Sales -
  Sinotruk" / "Cost of Goods Sold - Sinotruk".
- `tools/onboard/profiles/sinotruk_c7h_profile.sql` holds the same entry as SQL. It is **not applied**;
  nothing has gone live.
- The app follow-ups (drawings per make, make filter with universal parts, Jefrey heading, lookup button)
  are planned in `docs/14_MULTI_MAKE_APP_TASK.md`, to run after the Anton demo. No app change tonight.
## 25–26 Oct overnight: QA sweep before Anton's demo (PWA v43–v46, migrations 0080–0089)
Full write-up: `docs/READINESS_REPORT.md`; the demo walkthrough is `docs/DEMO_SCRIPT_ANTON.md`.
- **QA harness** (outside the repo): `C:\Users\iancr\Projects\ctpcore-qa`.
  - Playwright, plus `mint.mjs` for no-email QA sessions; findings are in `findings/*.md`.
  - QA logins: qa.{admin,manager,sales,warehouse,cash,book}@ctpcore.test. cash → customer 8, book → customer 9.
  - Customer 9 (Test Co 2) was set `on_account` and onto Hermans' book in CTP only. A Zoho terms read-back wipes it.
- **Migrations applied on live:**
  - 0080: the definer views are invokers and revoked.
  - 0081: internal reservation RPCs revoked.
  - 0082: app_user writes are admin-only.
  - 0083: sales_order column allow-list. Reverted by 0085, because staff Settings reads those columns via REST.
  - 0084: lead insert closed; search_path pinned.
  - 0086: warehouse can't read cost / landed cost / tiers.
  - 0087: the 0048 stock guard (never applied before).
  - 0088: order_prices gives cost/floor only to can_see_cost.
  - 0089: the cancel guard, plus timeline wording.
- **Edge functions:**
  - zoho-push: an unknown action now returns 400; a new action "cancel" voids an open SO or declines the estimate.
  - accept-quote: salespersonFor skips "QA" names.
- **PWA:**
  - v43: WebP section and logo images; images in their own SW cache `ctp-img-v1`; security headers in **app/vercel.json** (Root Directory = app).
  - v44: roles and flow fixes.
  - v45: catalogue and search fixes.
  - v46: offline fixes (SyncBadge, precache.json, offline sessions).
- **Sync rules changed in the repo, NOT yet deployed:** warehouse is out of ctp_staff; the customer diagram stream has an explicit column list without `source`.
- **Fix work** was done in worktree `C:\Users\iancr\Projects\ctpcore-fix` (branch qa-fixes, pushed to main), because the main checkout is shared with the Aerokit session.
- **Final regression** (four agents on v46): no P0. Since then:
  - 0090 re-hid sales_order staff_log/timeline from customers (0085 had re-exposed them);
  - v47 shows completed-order VAT from the Zoho invoice and strikes a discount only when it is real;
  - customers now see Cancelled vs Declined correctly.
  Open items and the sync-rules diff are in `docs/READINESS_REPORT.md`.

## 26 Oct, Michelle's login had no role (app_user ↔ auth mismatch)
- Cause (auth logs): Staff & access invite at 06:58 created login 7d02d921 + its role row correctly.
  At 07:02:53 that login was deleted from the Supabase dashboard and re-added there at 07:03:30
  (d0e05d00, auto-confirmed). The dashboard never touches app_user, so the old row was orphaned
  and the new login had no role. Not the QA cleanup (that only removed *@ctpcore.test logins).
- Fixed on live: Ian added app_user for d0e05d00; orphan 7d02d921 removed (nothing referenced it);
  "QA Sales" 2ae41598 removed after nulling actor_id on its 13 test stock moves (zoho_push_log and
  timeline keep the id/name as text). Scan: no other orphan role rows, no logins without a role,
  no customer/person pointing at a missing login.
- Prevention, in repo, **NOT yet applied/deployed** (needs Ian's go):
  - `server/0091_app_user_follows_login.sql`: deleting a login anywhere removes its role row and
    parks the role by email; the next confirmed login for that email gets it back (30 days).
  - `admin-users` invite: checks the role write; if it fails the login is withdrawn instead of
    left role-less.

### 26 Oct: rebates by accrual + credit note (Anton) — built behind a switch, TEST only
- Design and proof: `docs/14_REBATE_ACCRUAL_CREDIT_NOTE.md`. 0092 is applied live; zoho-push and
  accept-quote are redeployed; PWA v48.
- Rebate customers are invoiced at list. Each sent invoice accrues the per-SKU % (frozen from "FAW JH6 –
  Rebate") into `rebate_accrual`. Once a month, a statement becomes ONE draft credit note on "<name> –
  Rebate".
- `zoho_config.rebate_accrual_enabled` is ON, but only TESTCO2 and TESTACC are in accrual mode. **Hermans is
  untouched:** price book, prices and contact are unchanged.
- The token has no journals scope: the offset is done by hand from `rebate_offset`'s steps. Credit notes need
  `is_draft: true`.
- TEST credit notes CN-00004 and CN-00005 are voided. The rebate contacts "Test Co 2 – Rebate" and "Test
  Account (Ian) — CTP Core testing – Rebate" remain.
- **26 Oct (later): Hermans is LIVE on accrual** (Ian GO): cutover 26 Oct, rebate account linked, price list
  off the contact (book kept), PWA v49.
  - Michelle still has to create "Sales Rebates" and "Rebate Clearing" (the token can't); then put their
    ids on `rebate_scheme.zoho_rebate_account_id` and `zoho_config.rebate_clearing_account_id`.
  - Until then, credit-note lines book to "Sales - FAW".
  - On the 1st of the month: `rebate_statement {customer_code: HERMANS, period: "2026-10" or "2026-11", apply: true}`.
