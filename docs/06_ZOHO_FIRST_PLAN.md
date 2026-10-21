# CTP Core → Zoho-first: migration plan (21 Oct 2026)

Ian's direction: **Zoho Books is the system of record; CTP Core is a frontend.**
Supabase keeps only what Zoho cannot hold: logins and the login → company map,
hotspot diagrams and part-image mapping, UI settings, and a read cache.

Everything below about the org was read live (read-only) on 21 Oct 2026 via
`zoho-auth {action:"assess"}`. Nothing was written to Zoho for this assessment.

## 1. What the org actually is

| Fact | Value (live) | Meaning |
|---|---|---|
| Product / edition | Zoho Books, South Africa edition, org 939422621, ZAR | — |
| Daily API cap | **5,000 calls/day** (`x-rate-limit-limit: 5000`) | The Professional-tier cap. Resets daily (header showed ~14 h left). |
| Per-minute cap | Not exposed in headers. Zoho documents **100 requests/min per org** and a concurrency cap (≈10 in flight) for Books. | Burst-limit the backend; never fan out per row. |
| OAuth token minting | ~10 access tokens per refresh token per 10 min | Already solved: access token cached in Vault (0055). |
| Inventory tracking | **On.** 155/162 items `item_type=inventory`, `track_inventory=true`, FIFO, `stock_on_hand`, `committed_stock`, `available_for_sale_stock` all present; 948 units on hand | Books tracks stock per item well enough for one location. **Zoho Inventory is not needed** unless multi-warehouse, packages/shipments or serial/batch tracking are wanted. `/settings/warehouses` is 401 (not in plan/scope) — single location, which matches CTP Core's one location (0038). |
| Estimates | Enabled in the org (`is_estimate_enabled`) — **token lacks scope** (401) | Needs `ZohoBooks.estimates.ALL`. |
| Sales orders | Enabled; readable/writable | In use since 20 Oct. |
| Price books | Enabled (`is_pricebooks_enabled`); readable | Usable for tiers/rebates. |
| Credit notes | Readable (`creditnotes.READ`) | Creating them needs `creditnotes.ALL`. |
| Payments | **401** (customer and vendor payments) | Needs `customerpayments.READ` (+ `vendorpayments.READ`) to show paid status detail. Invoice status already shows paid/part-paid without it. |

**Scope string for the next grant code** (everything in use + what the plan needs):
```
ZohoBooks.settings.READ,ZohoBooks.settings.UPDATE,ZohoBooks.settings.CREATE,ZohoBooks.contacts.ALL,ZohoBooks.estimates.ALL,ZohoBooks.salesorders.ALL,ZohoBooks.invoices.ALL,ZohoBooks.creditnotes.ALL,ZohoBooks.customerpayments.READ,ZohoBooks.bills.ALL,ZohoBooks.purchaseorders.ALL,ZohoBooks.vendorpayments.READ
```

## 2. Entity by entity

| Entity | Today (CTP Core) | Zoho-first target | Gaps / decisions | Scope |
|---|---|---|---|---|
| **Items** | `part` master (sku, name, prices, cost), Zoho mirrored into `zoho_item`; SKU = Multicat code since 19 Oct | Zoho item is the master: name, SKU, rate, purchase rate, status, image (154/155 uploaded 20 Oct). Supabase keeps `part` only as **cache + the things Zoho can't hold**: diagram/hotspot links, photos, cross-references (OEM/CTP legacy numbers), fitment, sections | Zoho has no diagram/fitment/xref model → stays in Supabase keyed by `zoho_item_id`. New parts are created in Zoho first, then appear via sync. | have |
| **Stock levels** | CTP `stock_movement` ledger (append-only), reservations | Zoho `stock_on_hand` / `available_for_sale_stock` / `committed_stock` are the truth; CTP ledger frozen (kept for history), then retired | **Zoho moves stock only when a document is approved**: a *draft* invoice does not reduce stock, a *draft* bill does not add it, a *draft* SO does not commit it. With Michelle's draft-only rule, Zoho stock lags until she approves (see §4). Manual counts → Zoho inventory adjustments (needs `ZohoBooks.inventoryadjustments`? — in Books these sit under items/settings; verify on first use). CTP vs Zoho stock currently differ (backup CSV 19 Oct) — must reconcile once before the switch. | have (+ verify adjustments) |
| **Customers / companies** | `customer` row = company (+ zoho_contact_id), one login per company via `customer.auth_user_id` | Company = Zoho contact (customer type), read from Zoho; people = Zoho **contact persons**. Supabase keeps only `zoho_contact_id`, `zoho_contact_person_id` and the login map. The 0056 sync becomes the cache refresh. | Customer **logins** stay in Supabase (Zoho has its own portal, but CTP Core's login is ours). Rebate % and price tier are CTP fields → move to Zoho price books / contact custom fields (see price lists). | have (contacts.ALL) |
| **Quotes → Estimates** | CTP `sales_order` with status quote; customer accepts in app | Quote = Zoho **Estimate** (draft). Customer sees it in the app (read from Zoho) and accepts there; accept = mark estimate accepted + **convert to sales order** in Zoho. | Estimates have their own numbering; the app shows Zoho's number. Accept/decline from the app needs estimate status endpoints. Customer-removes-a-line (0051) becomes "edit draft estimate". | **estimates.ALL (new)** |
| **Sales orders** | Created on accept (since 20 Oct), draft, id stored | Unchanged, but **from the estimate** (convert) | Reservation: in Zoho only an **open/confirmed** SO commits stock; draft does not (decision §4). | have |
| **Invoices** | CTP `invoice_order` issues number, push to Zoho as draft converted from SO | Invoice is created **in Zoho from the SO** (draft); Zoho numbering becomes the invoice number (drop `use_ctp_invoice_number`) | Fulfil ("goods out") is a CTP step; Books has no shipments without Inventory → stock leaves Zoho at invoice approval. Either invoice at goods-out, or keep "goods out" as a UI state only. | have |
| **Bills / POs** | Desktop receiving → `goods_receipt` → Zoho bill (draft); POs in CTP (0039) | PO raised in Zoho; receiving converts **PO → bill** in Zoho (stock in when the bill is approved) | Books has no "purchase receive" document without Inventory: the bill is the receipt. Landed cost / foreign-currency invoices (Supalift USD) — bills in USD supported in Books; landed-cost allocation is manual. | have |
| **Credit notes** | None in CTP (Michelle raises CN in Zoho) | Read-only display on the order; create from the app later if wanted | — | creditnotes.ALL only if created from app |
| **Payments** | None in CTP | Read-only: show paid / part-paid / outstanding (status already read back); payment detail needs scope | — | **customerpayments.READ (new)**, vendorpayments.READ |
| **Price lists / rebates** | `price` tiers (list/trade/wholesale), customer `rebate_pct`, rebate guard (0044) | Zoho **price books** (enabled) per tier; rebate as a customer-specific price book or line discount (already sent as line discount since 20 Oct) | Price books are per item-set; customer-specific % rebates map to "markdown %" price books — one per rebate level. Margin-floor guard (0041) stays as an app check against Zoho purchase rate. | have (settings) |
| **Item images** | Supabase storage | Zoho holds one main image (done); app keeps the full photo set + crops in Supabase | — | have |

## 3. API budget and keeping the app fast

Budget: 5,000/day, ~100/min. Rough cost per order end to end on the Zoho-first
path: estimate create (1) + read-backs (2–3) + accept/convert (2) + invoice (2) +
contact match (0–2) ≈ **8–10 calls**. 50 orders/day ≈ 500 calls; catalogue +
stock refresh ≈ 1 call per 200 items. Comfortable — **if the app never reads
Zoho directly from the phone.**

Pattern:
1. **Read cache in Supabase** (what we already have: `zoho_item`, customer
   cache, document status columns). Phones and desktops read only the cache,
   through PowerSync as today — instant, offline-capable.
2. **Webhooks first.** Books workflow rules can call a webhook on create/update
   of invoices, sales orders, estimates, contacts, items (available on paid
   plans). Point them at one Supabase function that refreshes just that record
   (1 call). Needs Michelle/Ian to set up the workflow rules in Zoho (≈30 min).
3. **Polling as a safety net**: items + stock every 15 min (1–2 calls), open
   documents' status every 5 min only while any are open (today's read-back,
   throttled to 2 min when the desk is open).
4. **Writes go through the Edge Functions only** (never the browser), with
   the cached token, idempotent references, and a retry queue.

## 4. Michelle's draft-only rule

Rule today: every invoice and bill CTP Core creates is a **draft**; she approves.
Consequences in a Zoho-first world:
- **Stock**: drafts don't move stock in Books. Zoho stock = approved documents
  only, so it lags until Michelle approves. Options: (a) accept the lag and show
  "pending approval" quantities in the app from the cache; (b) let *sales
  orders* be **open** (confirmed) — they are not accounting entries — so stock
  is committed at acceptance, and keep invoices/bills draft. **Recommended: (b).**
- **Estimates** can stay draft until sent; sending is a customer-facing act.
- Nothing changes for her approval workflow on invoices and bills.

## 5. Customer emails

- **From Zoho** (recommended for documents): estimates, invoices and statements
  emailed from Zoho carry Zoho's templates, the customer portal link and
  payment links, and are logged on the contact. Under the draft rule Michelle
  (or the desk) presses Send in Zoho, or CTP Core triggers Zoho's email
  endpoint after approval.
- **From the app** (keep): internal notifications to staff (request received,
  quote accepted/declined) via Resend, and in-app status for the customer.
  The app never emails documents itself.
- Resend still sends from `onboarding@resend.dev` until a CTP domain is verified.

## 6. What cannot move to Zoho

- Logins, roles, the login → company (and person) map; RLS.
- Exploded diagrams, hotspots, the part ↔ diagram callouts, section locators.
- The full photo library and web crops (Zoho holds one image per item).
- Cross-references (OEM / CTP legacy / Multicat), fitment by model.
- App settings, notification settings, prefixes, UI preferences.
- Offline operation for the desktop and phones (PowerSync cache).
- The rebate approval/override trail (who overrode a floor and why) — keep as an
  audit table even if the price lives in Zoho.

## 7. Phased order of work

| Phase | What | Effort | Unblocks |
|---|---|---|---|
| **0. Live invoicing now** | Finish the end-to-end test (SO→invoice link), Michelle signs off, sending stays on; cancel RQ-261020-43; decide SO open vs draft (§4) | 0.5 day | Real invoices tomorrow |
| **1. Companies & people, Zoho-first** | Company picker reads the Zoho-contact cache; "+ New company" previews then creates a Zoho customer contact (VAT, billing address, email); people = Zoho contact persons (preview first); Supabase stores ids + login map only; invite flow links a login to a person/company | 1.5–2 days | Onboarding real customers |
| **2. Quotes → Estimates** | New scope code; quote = Zoho estimate (draft); app shows/accepts it; accept converts estimate → SO | 2–3 days | Zoho holds the whole sales chain |
| **3. Stock from Zoho** | Reconcile CTP vs Zoho stock once; app stock = Zoho cache; counts → Zoho adjustments; freeze CTP ledger; webhooks + 15-min poll | 2–3 days | One stock number |
| **4. Purchasing in Zoho** | POs in Zoho; desktop receiving converts PO → bill (draft) | 2 days | Supplier side |
| **5. Prices & rebates** | Price books per tier/rebate level; app reads prices from the cache; margin guard against Zoho purchase rate | 1.5 days | Pricing master in Zoho |
| **6. Payments & credit notes (read)** | Show payments/credit notes on orders | 0.5–1 day | Full customer view |
| **7. Retire Supabase masters** | Supabase `part`/`customer`/`price`/ledger become pure caches; remove write paths | 1–2 days | "Strictly a frontend" |

Total ≈ 11–15 working days, phases 1 and 2 being the ones that matter for
day-to-day live invoicing.

## 8. Decisions needed

1. Sales orders **open** at acceptance (commit stock) vs **draft** (Michelle). §4.
2. Invoice number: switch to Zoho's numbering (recommended with estimates).
3. Who presses Send on estimates/invoices to customers: Michelle in Zoho, or the
   app after approval.
4. One more grant code with the §1 scope string (estimates + payments) before
   phase 2.
5. Set up Books workflow-rule webhooks (Ian/Michelle in Zoho, ~30 min) for
   phase 3.
