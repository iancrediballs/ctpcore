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
