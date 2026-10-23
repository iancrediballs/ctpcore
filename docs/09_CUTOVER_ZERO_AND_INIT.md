# Cut-over: zero Zoho, re-initialise, begin official operations (plan, 23 Oct 2026)

Ian: *"we need to see everything functioning until we are ready to zero zoho, re import to
initialize state and begin official operations"*.

Until that day the current Zoho org (939422621) and CTP Core are a **rehearsal**. Everything
can be exercised end to end there: quotes→estimates, SOs, invoices, packages and shipments,
purchase receives, adjustments, webhooks. This document plans the day it becomes real.
**Nothing here runs without Ian's explicit go on the day, given in chat.**

## 0. The one caution that shapes everything

The "rehearsal" org already holds **real accounting records**:
- 19 historic DS invoices (Hermans; outstanding about R1.7m) and 3 credit notes, imported by
  Michelle on 19 Oct;
- the real Supalift bills PI000001–004 plus 3 other supplier bills;
- INV-000005/6 from SO-00011/12 (live Hermans orders).

Zeroing Zoho must not lose what Hermans owes or what CTP owes Supalift. Those balances come back
as opening balances (§3). **Michelle signs off what is deleted and what is re-imported**,
because VAT returns may already have been filed using these documents. A filed or locked period
cannot be deleted and must be kept or reversed by her.

## 1. What is wiped vs kept in Zoho

| Kept (master data) | Wiped (transactions) |
|---|---|
| Organisation, settings, taxes (Standard Rate 15%), branding, customer portal | All **test** documents (none remain: every CTP test doc was deleted after its test) |
| **Items** (162; SKU = Multicat code; images, rates, purchase rates) | **Estimates** QT-… |
| **Contacts** (customers, vendors, contact persons; Hermans' VAT no.) | **Sales orders** SO-…, **packages**, **shipments** |
| Locations/warehouses (Inventory) | **Invoices**, **credit notes**, **customer payments** |
| Users and roles | **Bills**, **purchase orders**, **purchase receives**, **vendor payments** |
| Numbering *settings* (prefixes) | **Inventory adjustments**, transfer orders |
| | Stock on hand → 0 (falls out of the above), then re-initialised (§3) |

### How Zoho can be zeroed — three options

| Option | How | Keeps | Cost / risk |
|---|---|---|---|
| **A. Scripted delete (recommended)** | CTP runs a reviewed delete list through the API in dependency order (§4.3). Michelle handles by hand anything the API refuses (locked or filed periods, reconciled bank items). | Org, items, contacts, settings, portal, the Inventory subscription, OAuth link | Deletes cannot be undone. Needs the full backup (§4.1) and a dry-run list. Document numbers do not restart unless the prefixes or next-number are reset in Settings. |
| B. Zoho support data reset | Ask Zoho support to clear transactions for the org | Org and settings (check what they keep) | Not self-service; timing is up to Zoho; their scope must be confirmed in writing first. |
| C. Fresh organisation | Create a new Books + Inventory org; re-import everything | Nothing | Re-link every Zoho id in CTP, move the Inventory subscription, new OAuth grant, new portal. Most work and most risk. |

**Recommendation: A.** The items and contacts carry the ids CTP already links to: `zoho_item`,
`customer.zoho_contact_id` and contact persons. Keeping them avoids re-linking everything.

**Michelle by hand, on the day:**
- confirm no VAT period containing these documents is filed or locked (or decide to keep it);
- un-reconcile any bank or payment matches;
- reset the document numbering in Settings (INV-, SO-, QT-, PO-, bills) if new numbers should
  start at 00001;
- approve the opening balances (§3).

## 2. CTP Core alongside

| Kept | Reset |
|---|---|
| Logins, roles, login→company/person map; customer and part master; diagrams, hotspots, sections, photos, cross-references, fitment; app and notification settings | **Orders**: every pre-go-live `sales_order` gets `deleted_at` + `zoho_do_not_push`, with history kept (never hard-deleted) |
| `zoho_item` links (items kept in Zoho, so ids are unchanged) | **Zoho refs on orders** cleared with them (estimate / SO / invoice / package / shipment ids) |
| `customer.zoho_contact_id` (contacts kept) | **Stock**: CTP ledger frozen with a cut-over snapshot (§3.2); app stock = Zoho cache, re-read after the opening stock posts |
| | `zoho_config.push_from` = go-live timestamp; `stock_master = 'zoho'`; numbering prefixes if changed |
| | `zoho_push_log` kept (audit), with a cut-over marker row |

## 3. Re-import order (after the wipe)

1. **Settings check**: taxes, numbering, the one location/warehouse, workflow-rule webhooks
   pointing at `zoho-hook`.
2. **Items**: already there (kept). Only fix the 6 not stock-tracked (turn tracking on) and
   retire the 4 inactive duplicate links.
3. **Opening stock from the counted shelf.** One Inventory **opening-stock adjustment** dated the
   go-live morning (reason "Opening stock — stock take <date>").
   - Per item: quantity = counted quantity; value = purchase rate (FIFO opening cost).
   - The quantities come from the approved reconciliation plus the counts.
   - CTP generates the adjustment file from `docs/stock/` and posts it through the API (or as a
     CSV Michelle imports).
4. **Customers/contacts**: kept. Check Hermans' VAT number and terms (Net 30); account vs cash
   flags stay in CTP.
5. **Opening receivables**: per customer, the amount owed at go-live. Either as Zoho **opening
   balances** (Settings → Opening Balances, as of the day before go-live), or as one "opening
   balance" invoice per open document, if Michelle wants them itemised for statements.
   Hermans ≈ R1.7m (her figure rules).
6. **Open supplier bills**: per vendor, what is still owed (Supalift PI000001–004 if unpaid), as
   opening balances or re-entered bills (Michelle).
7. **Inventory value check**: the opening stock value must equal the Inventory Asset opening
   balance in the accounts (Michelle).
8. CTP: `stock_master = 'zoho'`; first stock-cache read; a fresh reconciliation must show
   **all match**.

## 4. The day — dry-run checklist, then execution

### 4.1 The evening before
- [ ] Stock take done (spot check + 24 counts) and the reconciliation signed by Ian + Michelle.
- [ ] **Backups**:
  - Zoho: full data backup/export from Settings (Michelle downloads it). Also CTP's own read-only
    pull of every document (`zoho-auth stock_report` + a document export) saved under
    `docs/cutover/<date>/`.
  - Supabase: `supabase db dump` (schema + data) saved off the laptop. Storage needs no action
    (nothing in it changes).
- [ ] Opening balances agreed by Michelle (receivables, payables, stock value).
- [ ] Freeze: no quotes accepted or invoices raised after 17:00.

### 4.2 Dry run (no writes)
- [ ] CTP prints the **delete list**: every Zoho document by type, number, status, date, total,
      plus the documents the API will refuse and why. It goes to Ian + Michelle as a file.
- [ ] CTP prints the **CTP reset list**: orders to soft-delete, refs to clear.
- [ ] CTP prints the **opening-stock adjustment** (items, quantities, value) and the opening
      balances to be keyed.
- [ ] Ian says **"go"** in chat. Without it nothing below runs.

### 4.3 Execution (order matters; each step logged)
1. Customer payments → credit notes (refunds first) → invoices → packages/shipments → sales
   orders → estimates.
2. Vendor payments → purchase receives → bills → purchase orders.
3. Inventory adjustments / transfer orders.
4. Check: Zoho stock on hand is 0 everywhere; no transactions are left except what Michelle chose
   to keep.
5. Michelle: numbering reset, opening balances, un-reconciliations.
6. Post the opening-stock adjustment; re-read the stock cache; reconcile → all match.
7. CTP reset (§2): soft-delete pre-go-live orders, clear refs, freeze the ledger with a snapshot,
   `push_from = now`, `stock_master = 'zoho'`.
8. Smoke test with a real first order: quote → estimate → sent → accept → SO → invoice →
   package/shipment → stock down by one in Zoho and in the app.

### 4.4 Rollback
- **Before step 1**: stop, nothing changed.
- **During Zoho deletes**: deletes are irreversible. Rollback is re-import from the Zoho backup,
  done by Michelle with Zoho's import tools, or option B/C via Zoho support. That is why the
  dry-run list and backup are mandatory, and why deletes run type by type with a check after each.
- **CTP**: restore from the `db dump`. The soft-deletes are reversible by SQL anyway
  (`deleted_at = null`); the ledger freeze is a trigger that can be dropped.
- **If go-live has to wait** after the wipe: CTP stays on the rehearsal settings
  (`stock_master = 'ctp'`, sending on) and nothing customer-facing breaks. Quotes simply start
  from the new numbers.

## 5. Open questions for Michelle
1. Are any VAT periods containing the DS invoices or the PI bills filed or locked?
2. Opening receivables: one opening balance per customer, or itemised opening invoices?
3. Should document numbers restart at 00001 after the wipe?
4. Is a Zoho Books data backup/export available on this plan, and who keeps it?
