# 14 — Rebates by accrual and credit note (design, 26 Oct 2026)

**Asked by:** Anton, after the demo; confirmed by Ian.
**The change:** rebate customers are invoiced at the **full list price**. CTP works out the rebate on every
invoice, adds it up on a second Zoho account, and settles it with a **credit note**. This replaces invoicing
at the rebate price through the "FAW JH6 – Rebate" price book.

**Status:** design for Ian. It is built behind a switch that is **off for Hermans**. It has been proven only
on TEST customers. Hermans' price book, prices and invoices stay exactly as they are until Ian says go.

---

## What is already there, and what is reused

| Existing | What it is | Reused how |
|---|---|---|
| `rebate_scheme` + `rebate_scheme_sku` (0069) | Ian's rule (highest of 25/20/15/10/0 % keeping ≥30 % contribution after 10 % commission) and the 154 FAW JH6 SKUs | **The rule stays the rule.** Each SKU's rebate % is now *stored* (`rebate_bps`), frozen from the live "FAW JH6 – Rebate" book, so every invoice uses the same % the price book gives today. |
| `rebate_agreement`, `rebate_tier`, `rebate_accrual` (0039) | Built for **supplier** rebates (what suppliers owe CTP). Empty (0 rows). | Extended to **customer** rebates as well, with `party = 'customer'`. The accrual ledger keeps its design: append-only, corrections by reversing entries, idempotent. One ledger for both directions, told apart by `party`. |
| `customer.zoho_pricebook_*`, `price_book*`, `order_prices`, `my_prices` (0071–0076) | The price-book route | Kept for customers who stay on price books. For accrual customers, the same calls also return "rebate earned" figures instead of a lower price. |
| Status read-back every 15 min, Zoho webhooks (zoho-push) | Reads invoices back | This is the **trigger** for accruals. |

---

## 1. Two linked Zoho accounts per rebate customer

- **Main account:** the existing contact, e.g. "Hermans Panel Beaters". All quotes, sales orders and
  invoices go here, at full list.
- **Rebate account:** a second Zoho contact named **"<customer name> – Rebate"**, e.g. "Hermans Panel
  Beaters – Rebate".
  - It is created by CTP from the customer screen (admin): **Create rebate account**.
  - It copies the company name, VAT number and billing address.
  - It gets no email address, so Zoho can't email it by accident, and no price list.
  - Its Zoho notes say "Rebate account of Hermans Panel Beaters (Zoho contact …). Created by CTP Core".
- **Link:**
  - CTP stores the rebate account on the customer (`customer.zoho_rebate_contact_id`).
  - On the Zoho side, the link is in the notes. If Michelle adds a contact custom field "Main account",
    CTP fills it in too; the Zoho API can't create custom fields.
  - A contact *person* is not used, because that is for people and email.
- If a contact with that exact name already exists, CTP links it and doesn't create a second one.

## 2. Full-price invoicing

For a customer in **accrual mode**:

- **Quotes and SOs.** Quote prices fill at the **list price**. Sales orders go to Zoho at list, with **no
  price book**.
  - CTP doesn't put a price book on an accrual customer's SO, even if the contact still has one.
  - Michelle's invoices from those SOs are therefore at list too.
- **Price list.** At cutover, the "Price List" (price book) is **removed from the main contact**:
  `assign_pricebook` with none, read back and checked like today. **Only when Ian says go.**
  - The book itself stays, unused, for any customer who remains on the price-book route.
- **App display.** Instead of a struck-through lower price, the customer sees the full price and a line:
  **"Your rebate on this order: R x — credited to your rebate account each month"**.
  - The quote total, the order and the part sheet say "Rebate R x" next to each rebated line.
  - Staff see the same, plus the % per line.

## 3. Accrual (automatic)

- **Which invoices.** All invoices on the main account from the **cutover date**, not just those that came
  from a CTP order. Michelle sometimes invoices directly in Zoho.
  - CTP lists the customer's invoices every 15 min with the status read-back, and also when a Zoho
    webhook fires.
  - It reads any that are new or changed.
- **When an invoice counts:** once it is **sent** (also partially paid, paid or overdue). A **draft
  doesn't count**, the same rule as Fulfil (0078).
- **The rule per line:** rebate = line amount excl. VAT, after any line discount × that SKU's rebate %
  (25/20/15/10/0, the same % the book uses today).
  - SKUs outside the scheme earn 0.
  - A line already priced at or below the rebate price (the old route) earns 0 and is **flagged**, so
    nothing is rebated twice.
- **Stored in `rebate_accrual`.** Each row records the invoice, Zoho line, SKU, qty, line amount, % and
  amount (excl. VAT), the customer, the rebate account and the period (calendar month of the invoice
  date).
- **Changes:**
  - An invoice edited after it was sent gets its accrual recalculated. The **difference** is posted as a
    new row.
  - An invoice voided or deleted in Zoho gets a **reversing** row for the full amount.
  - A credit note **on the main account** that returns lines of an invoice reverses the rebate on the
    returned value. This needs the credit-note line to reference the invoice line; otherwise it is
    flagged for Michelle.
  - Nothing is ever edited or deleted. The sum of the rows is what the customer has earned.
- **Idempotent.** Running it twice adds nothing. Each row has a key built from the invoice, line and
  version.

## 4. Settlement: one credit note per customer per month

**Recommended (matches Anton's sketch):**

1. **Rebate statement (CTP, automatic).** On the 1st of the month, CTP drafts
   **RB-2026-11-HERMANS**: every invoice of the month, its rebatable lines, and the total.
   - Staff can look at it any time during the month (the running figure).
2. **Credit note on the rebate account (CTP creates it as a DRAFT; Michelle opens it).**
   - One credit note on **"Hermans – Rebate"**, dated the last day of the period.
   - **One line per invoice**: "Rebate on INV-000123 (Oct 2026)", amount excl. VAT, Standard Rate 15 %.
   - The reference is the statement number.
   - The lines are booked to an account, never to items. This matters: an item line on a credit note
     would put stock back into Zoho Inventory.
   - VAT is right: a rebate reduces what was charged, so the output VAT goes down with it. This is a SA
     VAT s21 credit note; Michelle or the auditor confirms.
   - This puts the rebate on the second account, as in Anton's drawing. The customer's main-account
     statement stays at full prices, and the rebate account's statement shows exactly what they earned.
3. **Giving the customer the money.** Zoho can only apply a credit note to invoices **of the same
   contact**, so the rebate account's credit can't reduce a main-account invoice directly. There are two
   ways, chosen per customer:
   - **(a) Offset against what they owe (default).**
     - Michelle **refunds** the rebate credit note to a clearing account "Rebate Clearing".
     - CTP drafts a **journal**: Dr Rebate Clearing / Cr Accounts Receivable, with contact = the main
       account. Zoho turns an AR credit on a contact into a credit that can be **applied to that
       contact's open invoices**.
     - Michelle publishes it and applies it.
     - Result: the clearing account nets to 0, and every step is a native Zoho document linked by the
       statement number.
   - **(b) Pay it out.** Michelle refunds the rebate credit note by EFT, using Zoho's normal Refund.
4. **CTP reads the results back** and closes the loop. The credit note opened marks the statement and
   its rows **credited**. When the refund, journal or applied credit is read back, they become
   **settled**.

**Rejected alternatives:**
- **A credit note on the main account, with the second account as a tracking ledger only:** the simplest,
  but the second account would hold nothing in Zoho, which isn't what Anton drew.
- **Journals only:** no customer-facing document, and VAT has to be done by hand.
- **A credit note per invoice:** about 30 documents a month instead of 1.

**Liability ("Rebates Payable").**
- The credit note is dated at month end for that month's invoices, so the rebate expense lands in the
  right month without a separate accrual journal.
- Until it is settled, the rebate account's open credit **is** the liability: a credit balance in
  receivables.
- If the accountant wants a liability on the balance sheet *during* the month (for example, mid-month
  management accounts), CTP can draft a month-end journal: Dr Sales Rebates / Cr Rebates Payable,
  reversed on the 1st. **Off by default**; it's the accountant's call.

**Who does what:**

| Step | Automatic (CTP) | Michelle (Zoho) |
|---|---|---|
| Accrue each sent invoice; reverse on void or return | ✔ | — |
| Monthly statement + **draft** credit note on the rebate account | ✔ | checks it, clicks **Mark as Open** (never emailed by CTP) |
| Offset: refund to clearing + **draft** journal on main | ✔ drafts the journal | records the refund, publishes the journal, **applies** the credit to open invoices |
| Pay out instead | — | Refund by EFT |
| Read back and mark credited / settled | ✔ | — |

**Accounts Michelle sets up once:**
- "Sales Rebates": income, contra. One per make if she wants rebates by make, e.g. "Sales Rebates - FAW";
  CTP takes it from the make profile.
- "Rebate Clearing": other current liability.
- Optionally "Rebates Payable".

## 5. Who sees what

- **Staff, on the customer screen:**
  - rebate mode (price book / accrual);
  - the linked rebate account;
  - **earned this month (accruing)**, **credited** (credit notes open), **settled**, and **outstanding**
    (earned, not yet settled);
  - per statement: invoices, lines, credit note no., status, and links to Zoho.
- **Staff, on an order:** the rebate per line and in total ("accrues on invoice").
- **The customer:**
  - on a quote or order: "Your rebate on this order: R x";
  - in the account area: **"Rebate earned this month R x · credited to date R y · last credit note
    CN-000123"**.
  - Only their own figures; no %, cost or rule. Served by an RPC that resolves the customer from the
    login, as `my_prices` does.

## 6. Migration and cutover for Hermans

- **Today:**
  - Hermans has the "FAW JH6 – Rebate" price list since 24 Oct.
  - Their CTP invoices are INV-000005 (20 Oct) and INV-000006 (22 Oct), both **before** the book, so at
    list.
  - At go time, CTP lists every Hermans invoice since 24 Oct and reports any at rebate prices. Those keep
    their rebate and earn nothing more.
- **Cutover**, on Ian's go, on the **1st of a month** so the statements are clean:
  1. Create the rebate account.
  2. Remove the price list from the main contact.
  3. Set Hermans to accrual mode from that date.
  4. From then on, quotes and SOs go at list.
- **Before the cutover:**
  - Old invoices are not accrued.
  - Ian decides whether to back-accrue the pre-book invoices at list (INV-000005/6). CTP can do it as a
    one-off "opening" statement.
  - Open quotes priced at book rates: re-price at list before sending, or let them go through at book
    price, where they earn 0 and are flagged.

## 7. Scale

- The rule is per **scheme**, and a scheme belongs to makes through `make_profile.rebate_scheme_id`.
  - Sinotruk can have its own scheme or join FAW's.
  - A customer can be on **several** agreements (one per scheme).
  - Unlike Zoho price books (one per contact), accruals have no one-per-customer limit.
- The monthly credit note has lines per invoice for all schemes. The account per line comes from that
  scheme or make (for example "Sales Rebates - Sinotruk").
- New schemes are data: a scheme, its SKUs and %, and an agreement per customer. No code change.

## 8. Build plan (step B, TEST customers only)

1. **Migration.** Adds:
   - `customer.rebate_mode` ('price_book' | 'accrual'), `rebate_from` date, `zoho_rebate_contact_id`;
   - `rebate_agreement.party`, `customer_id`, `scheme_id` (supplier_id becomes optional);
   - `rebate_scheme_sku.rebate_bps`, frozen from the live book;
   - `rebate_accrual` invoice columns, plus source type 'invoice';
   - `rebate_statement`;
   - the RPCs (accrue an invoice, build a statement, positions, `my_rebate`);
   - `zoho_config.rebate_accrual_enabled`, a **global switch, off**. Only customers in accrual mode take
     part even when it is on.
2. **zoho-push actions:**
   - `rebate_account` (create or link the second contact);
   - `rebate_accrue` (one customer, or all; also run in the read-back);
   - `rebate_statement` (build + draft credit note);
   - `rebate_offset` (draft journal);
   - `rebate_readback`.
   - SOs for accrual customers go without a price book.
3. **App:** "Your rebate on this order", and the rebate panel on the customer screen. Nothing shows unless
   a customer is in accrual mode.
4. **Proof on TEST customers** (TESTCO2 already has sent invoices at list):
   - create its rebate account;
   - accrue;
   - statement;
   - **draft credit note in Zoho**, opened;
   - offset journal (draft);
   - read back;
   - a void reverses.

   Then the TEST documents are voided, not deleted.

---

## Built and proven, 26 Oct 2026 (TEST customers only)

**What exists now:**
- **Migration 0092** (applied live).
- **zoho-push** `rebate_*` actions (`server/edge/zoho-push/rebate.ts`), deployed.
- **PWA v48.**
- **Global switch** `zoho_config.rebate_accrual_enabled`: **on**. Only customers whose `customer_rebate.mode`
  is `accrual` take part, and those are **TESTCO2 and TESTACC**.
- **Hermans** has no `customer_rebate` row. It stays on the price book: prices, SOs and the app are unchanged
  (checked with `order_prices(45)`).
- `rebate_setup` refuses accrual mode for a non-TEST customer unless `confirm: "Ian approved"` is sent.

**Per-SKU % frozen from the live book.**
- 25 % on 102 parts, 20 % on 2, 15 % on 8, 10 % on 1 and 0 % on 41. None off-tier.
- This is the same split as the 24 Oct build.

**Proof run:**
1. **TESTCO2** set to accrual from 1 Oct. Its rebate account **"Test Co 2 – Rebate"** was created in Zoho,
   copying the VAT number and address, with no email address.
2. **Accrual:** 4 invoices were read.
   - INV-000020 (sent): R1,533.64.
   - INV-000014 (overdue): R188.36.
   - INV-000013 (draft): 0, not counted.
   - INV-000012 (paid): 0. Both its lines were already at the rebate price, and both are flagged.
   - Total **R1,722.00 excl. VAT**. The amounts were checked by hand (R4,642.52 × 25 % = R1,160.63, and so
     on).
3. **Re-runs:** a forced re-read posted 0 rows.
4. **Void test**, run on the ledger only: a voided INV-000014 reversed −R188.36, and the re-read restored it.
   The history is kept.
5. **Statement** RB-2026-10-TESTCO2 → **credit note CN-00004** on "Test Co 2 – Rebate":
   - R1,980.30 incl. VAT, 2 account lines (one per invoice), standard rate 15 %.
   - The read-back marked the statement **credited**.
6. **TESTACC:** statement RB-2026-10-TESTACC → **CN-00005 created as a DRAFT** (R61.27). The "Michelle
   opens it" step was done by API (TEST only), and the read-back marked it credited.
7. **Offset preview:** the journal entry and Michelle's three click steps for RB-2026-10-TESTCO2.
8. **Customer and staff views,** checked through the RPCs with a simulated login:
   - staff: rebate per line + %;
   - the TESTACC customer: rebate amount only, plus "credited R53.28, last credit note CN-00005".
9. **Cleanup:**
   - CN-00004 and CN-00005 are **voided** in Zoho, not deleted. The statements are void and the accruals are
     back to "accruing".
   - A new October statement for these customers would get the number "…-2".
   - The two TEST rebate contacts stay, linked to the TEST customers, so Ian can see them.

**What the run found:**
- **The API opens credit notes straight away** unless `is_draft: true` is sent, and an open credit note can't
  be turned back into a draft. CTP now sends `is_draft`. CN-00004 was created before that fix, which is why
  it opened directly; it is voided.
- **CTP's Zoho token can't post journals or read the chart of accounts** (401, code 57). So the offset
  journal is **Michelle's**, from the exact steps `rebate_offset` prints. Alternatively, Ian re-consents the
  Zoho connection with `ZohoBooks.accountants.ALL`, and CTP then drafts the journal too.
- **There is no "Sales Rebates" account yet.** Lines are booked to "Sales - FAW" (the FAW JH6 profile's sales
  account) until Michelle creates one and its id goes on `rebate_scheme.zoho_rebate_account_id`.

**Before Hermans goes live (Ian's go):**
1. Michelle creates the accounts "Sales Rebates" and "Rebate Clearing" and gives the ids. They go on
   `rebate_scheme.zoho_rebate_account_id` and `zoho_config.rebate_clearing_account_id`.
2. Run `rebate_account` for HERMANS, which creates "Hermans Panel Beaters – Rebate".
3. Run `rebate_setup` for HERMANS: mode accrual, `rebate_from` on the 1st of a month, scheme "FAW JH6 –
   Rebate", `confirm: "Ian approved"`.
4. Remove the Price List from the Hermans contact (`assign_pricebook` to none). It has **not** been touched.
5. On the 1st of each month: `rebate_statement` with `apply`, for the month just ended. Michelle opens the
   draft credit note and settles it (offset or pay-out).
