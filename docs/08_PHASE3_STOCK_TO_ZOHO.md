# Phase 3 — stock moves fully to Zoho: reconciliation + design (23 Oct 2026)

**Status: PLAN ONLY.** Nothing was adjusted in Zoho or CTP. No stock change until Ian
and Michelle approve the reconciliation below.

Files (this folder):
- `stock/reconciliation_2026-10-23.xlsx` — Summary, Per item (coloured by recommendation),
  Zoho documents.
- `stock/reconciliation_2026-10-23.csv` — the same per-item table.
- `stock/reconciliation_2026-10-23_totals.json` — the totals.
- `stock/raw_2026-10-23/` — the read-only pull it was built from.
- Re-run: `python tools/stock_reconcile.py docs/stock/raw_2026-10-23 docs/stock/reconciliation_<date>`.
  Fresh data comes from `zoho-auth {action:"stock_report", part: items|details|docs}`, which is
  GET-only and throttled, plus `ctp_ledger.sql`.

## 1. Reconciliation — totals (live, 23 Oct ~11:00)

| | Units |
|---|---|
| CTP ledger on hand (holds excluded) | **812**: 809 on the 155 Zoho-linked tracked items, 3 on 2 parts not tracked in Zoho |
| CTP held for open orders (reservations) | 5 |
| Zoho on hand | **937** |
| Zoho committed (confirmed SOs) | 0 (both SOs are already invoiced) |
| Zoho available for sale | 937 |
| Difference, Zoho − CTP, on linked items | **+128 net**, 174 gross across 70 items |

For each item: difference = **stock-in** (+203) + **sales gap** (+20) − **CTP-only adjustments** (95 units).

- **Stock-in** = Zoho's opening plus approved bills, minus CTP's 28 Jun opening receipt.
- **Sales gap** = CTP sales minus Zoho's net invoiced quantity.
- **CTP-only adjustments** = CTP counts and returns that never reached Zoho.

| Item group | Items | Recommendation |
|---|---|---|
| Match exactly | **85** | Nothing to do. |
| **CTP's opening load missed a Supalift shipment** (only cause) | **34** | **Trust Zoho.** Spot-check 3–5 items on the shelf first. |
| Missed shipment **plus** another difference | 19 | Take Zoho's stock-in, then **count** them. |
| Sale recorded on one side only | 12 | **Documents.** Find the missing invoice or sale; no count needed if it's found. |
| CTP count/adjustment only | 2 | CTP is right if that was a real count; Zoho then needs the adjustment. Confirm by counting. |
| Mixed / unclear | 3 | **Count.** |
| CTP parts with stock but not tracked in Zoho | 2 (3 units) | In Zoho, turn on stock tracking (or link a tracked item) with the counted quantity. |

**The main finding (158 units on 53 items).** Zoho received the shelf on two Supalift bills,
PI000001 (339 units) and PI000002 (649 units), dated 19 Oct. On every one of the 53 items:
- CTP's 28 Jun opening load equals one bill's quantity exactly;
- the gap equals the other bill's quantity.

Items that are on only one bill match CTP exactly (52 of the 85 matches). So the CTP opening
load took one shipment per SKU instead of adding up both. If both shipments were physically
received, **Zoho is right** on these 53 for the stock-in part. One question for Michelle: were
PI000001 and PI000002 two real deliveries? A spot count of a few items settles it.

Other observations:
- Zoho also holds 19 historic DS invoices that Michelle imported on 19 Oct. Several have no CTP
  order behind them, and CTP has phone "Issue 1" sales with no Zoho invoice. Together these make
  the 12 document-only items.
- Inventory adjustments are **not readable** with the current Books token (401, code 57). Any
  adjustments made in the Zoho UI would therefore not show in this report. The item
  `initial_stock` field is 0 throughout.
- Four parts were linked to an old inactive Zoho item as well as the live one. The report uses
  the live link; cleaning up the inactive links is a small housekeeping job.

**Recommendation.** Do not do a full stock take. Instead:
1. Michelle confirms PI000001/PI000002 were both received; spot-count ~5 of those 34 items.
2. Count the 19 + 3 + 2 = **24 items** (list in the xlsx, yellow and green rows).
3. Michelle checks the 12 document gaps (blue rows).
4. On approval, one set of adjustments makes **Zoho** equal the counted shelf. That goes through
   Zoho (UI now, or the Inventory API once bought). Then the CTP ledger is frozen (§2).

## 2. Design — Zoho is the stock master

### What CTP stops doing
- **No new stock movements are written in CTP.** That covers sale on fulfil, receipt, count,
  transfer, reserve and release. `stock_movement` becomes read-only history: a trigger refuses
  inserts after the cut-over date, except a one-off "cutover" origin.
- **Stock on every screen comes from the Zoho cache** in `zoho_item`: `stock_on_hand`,
  `available_for_sale_stock` and `committed_stock` (columns to add).
  - The customer's `part.in_stock` flag becomes `available_for_sale > 0` from that cache.
  - Phone "Count" and "Issue 1" no longer post to the CTP ledger (see adjustments below).
- **The desktop's local ledger is retired for stock.** It already only pulls.

### Holds and commits → Zoho confirmed sales orders
- Accepting a quote already raises a **confirmed (open) SO**, which commits stock in Zoho. That
  replaces CTP's `reserve_order` and `release_order`.
- `quote_accept_check` warns, but does not block, when Zoho available-for-sale is below the
  quote quantity. Zoho allows over-commit unless the org forbids it.
- Cancelling an order voids or deletes its Zoho SO, which releases the commit. accept-quote's
  compensation already does this.

### Goods out (Fulfil)
- **Books only:** stock leaves Zoho when the invoice raised from the SO is **approved** (sent).
  "Fulfil" in CTP becomes a goods-out record (who, when, what was picked). It no longer writes
  stock; the gate stays "Zoho shows an invoice (cash: paid)".
- **With Zoho Inventory:** Fulfil = create a **package + shipment** from the SO. Stock leaves on
  the shipment, independent of Michelle's invoice timing.

### Receiving
- POs are raised in Zoho.
- **Books only:** there is no "receive" document. Stock arrives when the **bill** is approved,
  so it lags while Michelle reviews the draft. Desktop receiving would just create the draft bill
  from the PO.
- **With Zoho Inventory:** desktop/phone receiving = **purchase receive** against the PO (stock
  in on arrival). Michelle's bill follows, still as a draft.

### Adjustments (counts, damage, write-offs)
- **Books API:** not available on this token (401). Counts would go to a "variance queue" in CTP
  for Michelle to key into Zoho by hand.
- **With Zoho Inventory:** `POST /inventory/v1/inventoryadjustments` straight from the phone
  count, with a reason and the counter's name. Optionally as a draft for Michelle's approval.

### Webhooks vs polling
- **Polling (always):** items list every 15 min (1–2 calls), refreshing the `zoho_item` cache,
  plus the existing 10-min document read-back. Budget: about 200 calls a day of the 5,000.
- **Webhooks (recommended on top):** Books workflow rules on item / invoice / bill / sales order
  / estimate updates call a new edge function `zoho-hook`. It is authenticated by a shared-secret
  header and refreshes just that record (1 call), so stock and status changes show in seconds.
  This needs ~30 min of setup in Zoho (Ian or Michelle).
- Phones keep reading only the Supabase cache through PowerSync. They never call Zoho directly.

### Cut-over sequence (after approval)
1. Approve the reconciliation; do the counts; Michelle confirms the bills and documents.
2. Adjust Zoho to the counted shelf (UI, or the Inventory API).
3. Deploy: cache columns + poller + (optional) webhook; switch UI stock to the cache.
4. Freeze CTP stock writes (trigger) and remove reserve/release from accept (the SO commits).
5. Fulfil becomes goods-out (Books) or package/shipment (Inventory); receiving becomes bill or
   purchase receive.
6. One more reconciliation the next day; it should be all "match".

Effort is about 2–3 days with Books only, or 3–4 with Inventory (packages, shipments and
receives built in from the start).

## 3. Zoho Inventory — buy now?

**Yes: buy it before the Phase 3 build, and not wait until after.** Reasons, all observed on this org:
- Stock adjustments are not available through the Books API on our token (401). Without
  Inventory, every phone count becomes manual typing for Michelle.
- Under Michelle's draft-only rule, Books moves stock only when invoices and bills are approved,
  so Zoho stock lags reality. Inventory moves physical stock on **shipments** (out) and
  **purchase receives** (in), independent of her approvals.
- It maps exactly onto CTP's existing steps: Fulfil → package/shipment; Receiving → purchase
  receive; Count → inventory adjustment.
- It also adds multi-warehouse/transfers (if a second site ever appears), reorder points, and
  serial/batch tracking, all optional.

**What changes technically:**
- Same org (939422621), same items, contacts and documents; nothing is migrated.
- API base `https://www.zohoapis.com/inventory/v1` (same `organization_id`). CTP's shared Zoho
  module already switches base URL by API, so calls change one at a time.
- Estimates stay on the Books API (Inventory has none).
- **Scopes: yes, a new grant code is needed.** It should carry the current Books scopes **plus**:
  `ZohoInventory.items.READ, ZohoInventory.salesorders.ALL, ZohoInventory.packages.ALL,
  ZohoInventory.shipmentorders.ALL, ZohoInventory.purchaseorders.ALL,
  ZohoInventory.purchasereceives.ALL, ZohoInventory.inventoryadjustments.ALL,
  ZohoInventory.warehouses.READ, ZohoInventory.settings.READ`.
  One code with both sets; exchanged through `zoho-auth` exactly as on 22 Oct.
- Inventory has its own API call allowance on top of Books' 5,000 a day. Check the plan.

**Decisions for Ian and Michelle:**
1. Approve the reconciliation approach (spot-check + 24 counts + 12 document checks).
2. Confirm PI000001 and PI000002 were both physically received.
3. Buy Zoho Inventory (recommended), then do one new grant code with the scopes above.
4. Set up the Zoho workflow-rule webhooks (optional, ~30 min).
5. Choose a cut-over date (a quiet morning; the counts happen the evening before).
