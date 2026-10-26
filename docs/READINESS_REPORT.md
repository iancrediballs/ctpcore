# CTP Core: readiness report (demo to Anton; sales-rep training Tuesday)

**Date:** 25–26 Oct 2026, overnight
**Live at sign-off:** PWA **v47** on https://ctpcore.vercel.app, with migrations **0080–0090** applied on live.
**Method:**
1. Six QA agents drove the real live app in headless Chromium at **390 px and 1440 px** and checked the live DB, edge functions and Zoho.
2. Five fix agents worked in isolated branches.
3. Four agents re-ran the whole matrix as a final regression on v46.
4. The lead re-checked the last two fixes on v47.

Detailed evidence (findings, scripts, screenshots) is in `C:\Users\iancr\Projects\ctpcore-qa\findings\`:

| Sweep | Files |
|---|---|
| First sweep | `security.md`, `roles.md`, `catalogue.md`, `flow.md`, `stock-offline.md`, `perf.md` |
| Regression | `regression-*.md` |

## Verdict

**Ready for the demo and for training.**
- No P0 or P1 is open in the app.
- The two remaining P1s are configuration changes that need Ian's hands: a dashboard toggle and the Zoho webhook secret. Workarounds are below.
- One sync-rules paste is pending. It tightens what a warehouse phone and a customer phone hold; everything works without it.

## Pass / fail by matrix item (final regression)

| # | Area | Result | Notes |
|---|---|---|---|
| 1 | Logins and roles: admin, manager, sales, warehouse, rebate customer, cash customer, logged out | **PASS** | Cost, floor, bins, other customers and staff notes do not leak, checked on screen, on the device DB and over raw REST. Warehouse sees no cost (UI, REST and order_prices); its *device* still holds cost rows until the sync-rules paste. |
| 2 | Catalogue | **PASS** | Covered: search (all words, OEM numbers without dashes, aliases); 16/16 diagrams; every marker opens the right part (7 sweeps, 112 drawings); 33 px tap targets; images; stock badges; rebate display; cart. Make/Model/Type filters don't appear yet because every part is FAW JH6; the Aerokit session owns that. |
| 3 | Quote → order → Zoho → fulfil → close | **PASS** | Run live twice end to end on test customers and tidied, with stock back to the start in CTP and Zoho. Cancel now voids the Zoho SO, and is refused while the invoice is live. The cash "paid" unlock is not live-tested: the Zoho token can't record payments. |
| 4 | Orders tab | **PASS** | Covered: filters, colour stages, honest pills ("not sent yet" / "waiting for payment" / "ready to fulfil"), rebate lines, Zoho discount totals, JHB times. Completed-order VAT is fixed in v47. |
| 5 | Stock | **PASS** | Counts match the ledger at 0 mismatches. The server negative-stock guard is now live. Stock master is still **CTP**. |
| 6 | Admin | **PASS** | Staff & access asks before Remove or a role change, you can't remove yourself, and the invite has no "customer". Manager sees no admin switches. Settings → Zoho lists load. |
| 7 | Offline / PowerSync | **PASS** | Diagrams and markers work offline. The app opens offline even with an expired login. The badge shows syncing / N to send / synced / offline. Plain offline messages. A first visit precaches the app. First sync: staff 14–16 s, customer 11–13 s. |
| 8 | Edge functions and crons | **PASS** (1 P1 open) | Auth is refused correctly on every function. zoho-push rejects unknown actions. 144/144 cron runs succeeded. Open: SECURITY-5 (anyone can use up the Zoho API quota via the webhook path). |
| 9 | Security | **PASS** (1 P1 open) | RLS is on every table. Anon is refused everywhere. No secrets in the bundle. Security headers are live. npm audit is clean. Advisors show 0 ERRORs. Open: SECURITY-3 (public sign-up is on). |
| 10 | Performance / debloat | **PASS** | Cold staff load 3.15 → 1.65 MB, of which images are 2.04 MB → 534 KB. Lighthouse warm 100, logged-out SEO 100. No console errors. Images survive deploys. |

## Bugs found and fixed tonight

**P0: data leaks and security holes**

| ID | Problem | Fix |
|---|---|---|
| SECURITY-1 | Any customer login could read every part's **cost** and **stock count** over the API | 0080 |
| SECURITY-2 | Anyone with the public key could release or reserve stock on any order | 0081 |
| SECURITY-4 | A manager could make themselves admin | 0082 |
| ROLES-4 | Warehouse saw cost, margin and floor (the docs promise it can't) | 0086 + 0088 + v44 UI |
| REG-RS-1 | Customers could read staff notes on their own orders, introduced and closed tonight | 0090 |

**P1: wrong behaviour Anton or a rep would hit**

| ID | Problem | Fix |
|---|---|---|
| FLOW-1 | Cancelling an accepted order left the Zoho SO open, with stock committed | zoho-push "cancel" + 0089 + v44 |
| FLOW-2 | The pill said "ready to fulfil" while Fulfil was blocked | v44 |
| SO-1 | The server negative-stock guard was never applied | 0087 |
| SO-2 | Diagram markers vanished offline | v46 |
| SO-3 | Opening offline with an expired login hung on "Loading…" | v46 |
| PERF-1 | Home pictures were 3.6 MB; tiles stayed black for 18 s+ on 4G | v43, now 0.98 MB |
| CAT-1 | "R 0.00 list" on 34 parts | v45 shows "no list price"; the data still needs Zoho rates |
| ROLES-5 | Settings → Zoho lists broke after a first security fix (0083), the same night | reverted in 0085 |
| ROLES-6 | Remove and role change acted on one tap | v44 |
| REG-CAT-1 | Completed orders showed the wrong VAT (R 15k on a R 52k invoice) | v47 |
| SECURITY-8 | A typo'd zoho-push call pushed the whole Zoho queue | deployed |

**P2 / P3 (selection)**
- Search:
  - multi-word and OEM numbers without dashes;
  - aliases;
  - category chips after the first sync;
  - fitment and cross-refs on the part sheet.
- Bigger diagram tap targets; zoom buttons no longer cover markers.
- Thumbnails use the small images; logos are 240 KB smaller; images get their own cache so a deploy doesn't wipe them.
- Customers:
  - the "Check what synced" false alarm is fixed;
  - they no longer see staff wording;
  - Decline has a confirm step;
  - they see Cancelled vs Declined correctly.
- Accept shows "Checking your account…" and can retry.
- Zoho discounts on staff cards; JHB times everywhere.
- Timeline: one "Priced" entry, correct names.
- No QA names as Zoho salespersons.
- Stock moves record who made them.
- The counter sale no longer covers the tab bar.
- Friendly offline errors.
- Security headers (CSP in report-only), immutable asset caching, `lead` insert closed, search_path pinned.

## Open items, with workarounds

| # | Sev | Item | Workaround / action |
|---|---|---|---|
| 1 | P1 | **Public email sign-up is on** (SECURITY-3). Anyone could create a login. They would see only the catalogue, because no cost or stock leaks now. | **Ian:** Supabase dashboard → Authentication → Sign In / Providers → Email → turn **off** "Allow new users to sign up"; also turn on leaked-password protection. Invites keep working. |
| 2 | P1 | **Zoho webhook path has no secret** (SECURITY-5). A flood could use up the day's Zoho API calls. | Not exploited, and nobody knows to try. After the demo: add a `?k=` secret to the 8 Inventory webhooks plus a check in zoho-hook. It needs the Zoho webhook settings, so it wasn't done tonight. |
| 3 | P2 | **Sync rules paste pending.** `server/sync-streams.yaml` changes are in the repo: warehouse out of ctp_staff; the customer diagram stream without `source`; the customer sales_line with `line_net_minor`. | **Ian:** paste the file into PowerSync (diff below). Until then a warehouse phone holds cost rows it doesn't display, and a customer's total ignores a Zoho line discount. |
| 4 | P2 | **Test Co 2's rebate book keeps being wiped** by the Zoho terms read-back (FLOW-4), because the book is set in CTP only. | It only matters for testing. Set the book on the Zoho contact if you want a permanent rebate test customer. |
| 5 | P2 | **Credit-limit warning** reads the Zoho contact live; untested end to end (FLOW-5). | Needs a test contact with a low Zoho limit. |
| 6 | P2 | **rocky-chat** (a personal bot) runs in the production project on a hardcoded token (SECURITY-6). | After the demo: set the `BOT_TOKEN` secret and rotate the watch-app token, or move it to its own project. |
| 7 | P2 | **PERF-2 / PERF-3:** the entry bundle carries desktop-only code; the login screen downloads the sync engine. | After the demo (lazy-load). Warm loads are 100 already. |
| 8 | P2 | **Make/Model/Type filters** hidden with a single make (CAT-4). | Aerokit session's work. |
| 9 | P3 | **Cleanup:** QA logins appear in Staff & access (qa.*@ctpcore.test); "QA Sales" / "QA Admin" salespersons exist in Zoho; 3 test PO PDFs are in `po-docs`; retired Zoho secrets (`ZOHO_REFRESH_TOKEN`, `ZOHO_GRANT_CODE`) are still set; Test Co 2 and CTP TEST - Ian are still linked to the QA logins. | **Ian's go needed.** Recommended before the demo: remove the six QA logins, unlink customers 8/9, and put Test Co 2 back as it was (`ctpcore-qa/customers_before.json`). The Zoho salesperson delete and the secrets unset were refused by the permission check or left on purpose. |
| 10 | P3 | Minor: Orders "Today" uses the device clock; edge-of-drawing markers have a smaller tap area at 390; one photo's web variant is missing; customers have no order search; the precache includes an unused wasm; duplicate DB indexes. | After the demo. |

### Sync-rules diff to paste (`server/sync-streams.yaml`)
```diff
   ctp_staff:
+    # 0086 (26 Oct): warehouse is out — a warehouse login never holds cost, tiers or books.
     parameters: |
       SELECT FROM app_user
        WHERE id = request.user_id()
-         AND (role = 'sales' OR role = 'warehouse'
-           OR role = 'manager' OR role = 'admin')
+         AND (role = 'sales' OR role = 'manager' OR role = 'admin')
 ...
   ctp_client:
       - SELECT * FROM part_image
-      - SELECT * FROM diagram
+      # 26 Oct: explicit list — `source` (where the drawing came from) stays staff-only.
+      - SELECT id, drawing_key, title, section_code, make, model, image_path, model_3d_path,
+               img_w, img_h, rev, updated_at, deleted_at, origin
+          FROM diagram
 ...
   ctp_client_orders:
-      - SELECT id, order_id, part_id, qty, unit_price_minor, customer_id,
+      # 26 Oct: line_net_minor = the line after Zoho's discount, so the customer's total matches their invoice
+      - SELECT id, order_id, part_id, qty, unit_price_minor, line_net_minor, customer_id,
                rev, updated_at, deleted_at
           FROM sales_line
```
Paste the whole current file from main. After deploying, a warehouse device's Info → "Check what synced" should show part_cost 0 and price_tier 0.

## Test documents created in Zoho / CTP tonight (all tidied)

| Run | Orders | Zoho documents | Status |
|---|---|---|---|
| First sweep | RQ-261026-56…59 | SO-00027/28/29, INV-000015/16, PKG/SHP-00010/11 | deleted |
| Fix verification | RQ-261026-60 | SO-00030 (voided by the fix, then deleted), INV-000017 | deleted |
| Regression | RQ-261026-61…63 | SO-00031/32, INV-000018/19, PKG/SHP-00012 | deleted |

- Stock is at its starting figures in CTP and Zoho, with committed 0 (cleanup adjustments are tagged origin `cleanup20261026` / `cleanupreg20261026`).
- CTP invoice numbers 26102601–03 are used up.
- No customer was emailed. Invoices were marked sent through the API only. Ian received the normal internal order alerts for the test orders.

## What changed, for the record

- **Migrations:**
  - 0080 views
  - 0081 RPC revokes
  - 0082 app_user admin-only
  - 0083 (reverted by 0085)
  - 0084 hardening
  - 0086 warehouse cost
  - 0087 stock guard
  - 0088 order_prices
  - 0089 cancel and timeline
  - 0090 sales_order staff columns
- **Edge functions:** zoho-push (unknown action → 400; `cancel`), accept-quote (no QA salespersons).
  - Deployed from main, including the Aerokit e374a49 changes.
- **PWA:** v43 → v47. Git: main (fix branch `qa-fixes`).
