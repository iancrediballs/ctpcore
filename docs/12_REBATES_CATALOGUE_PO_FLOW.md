# Rebates, catalogue, pricing view, PO acceptance, audit trail (design, 24 Oct 2026)

Ian + Anton, 24 Oct. **Design for confirmation.** Items 6 (CTP audit trail) and 7 (order colours)
are built now. Everything that changes Zoho data waits for confirmation.

## What the API showed (read-only checks, 24 Oct)
- **Price books:**
  - The Books `/pricebooks` API reads and writes per-item price books (`pricebook_type: per_item`,
    `pricebook_items: [{item_id, pricebook_rate}]`; `maximum_item_limit` reported).
  - Anton's **"Rebate"** book exists (1 item).
  - Contacts carry a built-in **"Price List" (`pricebook_id`)** field, so a customer is assigned
    ONE price book by updating the contact.
  - Sales orders and invoices accept `pricebook_id`.
- **Catalogue fields Anton started on 23 Oct:**
  - **Manufacturer = "FAW"** and **Brand = "JH6"** (Inventory `/manufacturers`, `/brands`), set on
    item 2801070-1063.
  - He enabled the item **Brand** field and made it **MANDATORY**: a Zoho UI save of any other
    item now needs a brand.
  - Inventory **categories** exist but are empty (ROOT only). The item "SKU" and "Image" fields
    exist. Room for 135 custom fields.
- **Salespersons:** `/salespersons` answers but the list is **empty**. SO/invoice salesperson needs
  salespersons created in Zoho.
- **Attachments:** `/salesorders/{id}/attachment` exists, so a PO file can be attached to the SO
  (multipart upload).

---

## 1. Rebates via Zoho price books — Zoho stays the price source
- **Constraint:** a contact holds exactly ONE price book. A book is therefore a **rebate tier**,
  not a make. E.g. "Rebate A", "Rebate B", or per Anton "FAW JH6 – Rebate" while FAW JH6 is the
  only range.
  - As makes/models are added, their items are added **to the same tier books**. A customer
    stays on one book whatever they buy.
  - (A book per make would force a customer to choose one make.)
- **Import (Ian's spreadsheet):** CTP reads it and shows a preview (price book name, customer list,
  per-item rate or % off list, warnings for unknown part numbers / rates under cost).
  - On approval, zoho-push creates or updates the book(s) with `pricebook_items` and sets
    `pricebook_id` on each listed contact. Idempotent by book name.
  - Re-importing updates rates; items that are missing are reported, not deleted.
- **CTP side:**
  - `zoho-sync` pulls price books and contact assignments into a staff-only cache
    (`price_book`, `price_book_item`, `customer.zoho_pricebook_id`), refreshed with Pull & apply
    and on the 10-min read-back.
  - A quote line's price = the customer's book rate if present, else Zoho list (item rate).
  - SOs are raised with `pricebook_id` and those rates. Zoho remains the source: CTP never invents
    a rebate.
- **Retired:** CTP's own `rebate_pct` (kept for history, no longer applied once a book exists).
- **Effort:** 2–2.5 days (importer + preview 1, sync/cache 0.5, quote/SO pricing 0.5–1).

## 2. Catalogue structure for scale
**Recommendation: native Zoho fields first, custom fields only where Zoho has none.**

| Attribute | Zoho home | Why |
|---|---|---|
| **Make** (FAW, …) | item **Manufacturer** (native; Anton's FAW) | first-class, filterable in Zoho |
| **Model / range** (JH6, …) | item **Brand** (native; Anton's JH6; already mandatory) | same |
| **Section** (Front Bumper, Lighting, …) | Inventory **Categories** (hierarchical, empty today): mirror CTP's 16 sections | standard tree; shows in Zoho reports |
| **Part type** OEM / Aftermarket | item **custom field** (dropdown) "Part type" | no native field |
| **Supplier** | item **Preferred vendor** (native `vendor_id`; all 155 = Supalift Trading cc today) | native; aftermarket items get their vendor |
| **Fitment** (models a part fits, many-to-many) | stays in **CTP** (`part_fitment`, already there), optionally summarised in a "Fits" text custom field | Zoho has no many-to-many |

- **CTP mirror:** `part.make`, `part.model` (exist), `part.part_type`, `part.supplier`, filled by
  zoho-sync; Find gets Make/Model/Type/Supplier filters.
- **Aftermarket later:**
  - each aftermarket item is its own Zoho item (own SKU, vendor, cost), linked to the OEM part by
    CTP cross-reference;
  - item-level rebates simply join the same tier books. Nothing is activated now.
- **Bulk set** Manufacturer/Brand/Category on the 155 items via the API (Zoho data change: after
  confirmation). It also clears the "Brand mandatory" UI block.
- **Effort:** 1.5 days.

## 3. Staff pricing view (part sheet and quote lines)
- **Always:** list price (Zoho rate).
- **With a customer selected** (counter sale / their order):
  - ~~R list~~ **R rebate** (their book rate) and "−x%";
  - **cost** (Zoho purchase rate);
  - **margin** in R and %, e.g. "margin R420 (38%)";
  - **floor**: the lowest price the 0041 margin guard allows, in green / amber / red against it.
- Cost, margin and floor are shown to **staff roles only** (sales / manager / admin), never to
  customers. They come from the staff-only stream and RPCs.
- **Effort:** 1 day.

## 4. Public / walk-in protection — enforced on the server
- **Logged out** (future public website): parts, photos, diagrams, fitment; **no prices** ("ask
  for a quote"), no cost, no stock numbers (in stock yes/no only). Served through a public RPC
  that returns only those fields; tables stay closed to `anon`.
- **Walk-in / cash** (no login, served at the counter): staff screen only; no customer-facing
  price list.
- **Customer with a login:** only **their own** price: list struck through + their book rate, from
  an RPC `my_prices(part_ids)` that resolves the price book from *their* login.
  - Price books / costs / other customers' rates are never synced to customer devices. The
    customer PowerSync stream already lists columns explicitly and excludes price, cost and tier
    tables.
- **RLS:** new cache tables `price_book*` are staff-only (`is_staff()`), like `price`,
  `part_cost` and `price_tier` today. Column grants keep `staff_log` / `timeline` from the Data
  API (0067/0068 pattern).
- **Effort:** 1 day (public RPC + my_prices + RLS + tests).

## 5. Quote → customer PO → confirmed SO (Zoho estimate step skipped)
- Turn `estimates_enabled` **OFF** (switch kept; estimate code stays for later).
- **Staff:** price → **Send quote**. The quote lives in CTP with book prices.
- **Customer accepts in the app:** **PO number required**; PO **file (PDF/photo) required by
  default**, optional for "Accept on customer's behalf" (setting).
  - Upload to a private storage bucket `po-docs/<customer>/<order>/…` (RLS: own folder for the
    customer, staff read).
- **Acceptance creates the confirmed SO:**
  - `reference_number` = **PO number**;
  - the CTP order no. in a Zoho SO custom field **"CTP order"** (also the idempotency key, since
    the reference is now the PO);
  - `pricebook_id` + book rates;
  - salesperson = the CTP staff member (see 6);
  - the PO file attached (`/salesorders/{id}/attachment`);
  - stock hold as today.
- Then unchanged: Michelle invoices, CTP links, Fulfil unlocks (account / cash rule).
- **"Accept on customer's behalf":** the same PO fields (number required; file per setting).
- **Zoho-side actions CTP must follow (Anton's test):**
  - estimate accepted in Zoho → CTP accepts too (SO from it, hold), logged "accepted in Zoho";
  - estimate converted to an SO in Zoho → CTP links that SO (found by "CTP order" / reference),
    never a second one;
  - converted straight to an invoice → CTP links the invoice and treats the order as accepted and
    invoiced.
- **Credit limit (item 8):** before accepting, CTP compares the customer's Zoho outstanding plus
  this order against their credit limit and **warns** (staff and customer see "over credit
  limit — accounts will review"). Zoho's own refusal is shown plainly if it blocks.
- **Effort:** 2 days.

## 6. Full audit trail — CTP (BUILT 24 Oct) + Zoho (needs Zoho setup)
- **CTP:** `sales_order.timeline` (0068), one entry per step with who and when:
  - created; priced; quote sent (estimate); accepted (by customer / admin on behalf, with note and
    later PO);
  - sales order raised; invoiced in Zoho (accounts); paid; released (admin); fulfilled / shipped;
    closed; cancelled / declined.
  - Actors are resolved from the session, the accept/override columns, or the edge function's
    staff user. Zoho read-backs are attributed to "Zoho (accounts)".
  - Staff-only (not in customers' stream; not selectable over the Data API). Shown as a timeline
    on the order. Existing orders are back-filled from their dates.
- **Zoho (after confirmation):**
  - create one **salesperson per CTP staff member** (Ian, Michelle, Anton, …) and set
    `salesperson_id` on each SO;
  - accounts' invoices from the SO inherit it;
  - add custom fields **"CTP user"** and **"CTP order"** on Sales Order (and Invoice), filled by
    CTP.
  - Zoho then shows who did what, although the API user is the integration.
- **Effort:** CTP 1 day (done); Zoho 0.5 day.

## 7. Orders tab colours (BUILT 24 Oct)
- One colour per in-process stage, with a legend on the Orders tab:
  - **Needs pricing**: amber
  - **Quote sent**: blue
  - **Accepted, awaiting invoice**: purple
  - **Invoiced, ready to fulfil**: teal
  - **Goods out, close it**: green
- Completed and cancelled are muted grey.
- A left edge bar plus a labelled pill: colour is never the only cue. Text contrast is AA in both
  themes.
- **Effort:** 0.5 day (done).

## 8. Credit limit + tax by id
- Credit-limit warning: with item 5.
- **Tax by id:** `zoho_config.tax_id` = the Zoho id of "Standard Rate" 15% (CTP setting; no Zoho
  change). Pushes use the id directly, so a rename in Zoho can't break invoicing. Done 24 Oct.
- **Effort:** 0.5 day.

## Order of work after confirmation
5 (PO flow, estimates off) → 1 (rebates; needs the spreadsheet) → 3 → 4 → 2 → Zoho side of 6.
About 7–8 days in total.

## Defaults taken (no question needed)
- One price book per rebate tier; customers on one book.
- Logged-out visitors see no prices.
- PO file required for customers, optional on behalf.
- Make = Manufacturer, Model = Brand.
- Fitment stays in CTP.
