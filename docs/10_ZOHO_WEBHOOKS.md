# Zoho → CTP Core webhooks — what the API allows, and the manual steps (23 Oct 2026)

> **LIVE since 23 Oct 2026.** 8 webhooks plus 8 active workflow rules in Zoho Inventory (items, sales
> orders, invoices, packages, shipments, bills, purchase receives, inventory adjustments) post to
> `zoho-hook`, set up in the browser. Verified: Zoho's test call for item 1429405000000099011 was
> received and processed — that item alone was re-read at 13:45:32, between the 13:40 and 13:50
> cron runs, with no hook errors. Quotes/estimates (Books) stay on polling (no Books webhooks on
> this plan).

## What was checked (by API, 23 Oct)
- Zoho Books and Inventory both expose webhooks and workflow rules on an undocumented settings
  API (`/settings/webhooks`, `/settings/workflows`, `…/editpage`), the same one Zoho's screens use.
- **Books:** creating a webhook is refused — *"Webhook has been disabled for your account. Please
  upgrade your plan to create Webhook."* (code 13116). The **Books plan has no webhooks**, by API
  or by hand. Nothing was created. Estimates/quotes exist only in Books, so **quotes stay on
  polling**: the 10-min read-back, plus opening the order and "Refresh from Zoho".
- **Inventory (Premium):** offers webhooks for item, sales order, invoice, package, shipment, bill,
  purchase receive and inventory adjustment. Our token has `ZohoInventory.settings.READ` only, so
  CTP **cannot create them by API**. They are set up by hand in Zoho Inventory (below), or by
  another grant code adding `ZohoInventory.settings.CREATE` (it may still be plan-gated).

## No secret, no key
The webhooks call **`zoho-hook`**, a public endpoint (verify_jwt off) built for this. It only
forwards `{module, id}` to CTP's refetch-only handler, which:
- trusts nothing but the id;
- re-reads that record from Zoho with CTP's own token;
- throttles each record to once per 10 s.

Nothing secret is pasted into Zoho. Tested 23 Oct: a keyless call refreshed an item from Zoho;
bad input is rejected.

## Manual steps (Ian, in Zoho Inventory, ~10 minutes)
**Step 1 — Settings → Automation → Webhooks → + New Webhook**, once per row below:
- **Name:** `CTP Core - <module>`
- **Module:** as in the table
- **URL:** `https://hkzmydowyiajkbakxfkj.supabase.co/functions/v1/zoho-hook`
- **Method:** POST
- **Body:** Raw / JSON: `{"module":"<module value>","id":"<placeholder>"}`
- **Headers, parameters, authorization:** none

| Zoho module | `module` value | `id` placeholder (pick from Zoho's field list or paste) |
|---|---|---|
| Items | `item` | `${ITEM.ITEM_ID}` |
| Sales Orders | `salesorder` | `${SALESORDER.SALESORDER_ID}` |
| Invoices | `invoice` | `${INVOICE.INVOICE_ID}` |
| Packages | `package` | `${PACKAGE.PACKAGE_ID}` |
| Shipments | `shipment` | `${SHIPMENT_ORDER.SHIPMENT_ID}` |
| Bills | `bill` | `${BILL.BILL_ID}` |
| Purchase Receives | `purchasereceive` | `${PURCHASE_RECEIVE.PURCHASERECEIVE_ID}` |
| Inventory Adjustments | `adjustment` | `${INVENTORY_ADJUSTMENT.ADJUSTMENT_ID}` |

Example body for Items: `{"module":"item","id":"${ITEM.ITEM_ID}"}`

**Step 2 — Settings → Automation → Workflow Rules → + New Rule**, once per module:
- **Module:** the same;
- **When:** "Created or Edited";
- **Criteria:** none;
- **Action:** Webhook → the matching "CTP Core - …" webhook.

If Zoho Inventory also says webhooks need a plan upgrade, stop. Nothing else is needed: CTP
already polls (documents every 10 min, stock every 15 min).

**Check it works:** edit any item's description in Zoho Inventory, then look at
Settings → Zoho → recent log in CTP (no "hook" error). The part's Zoho stock time updates within
seconds.
