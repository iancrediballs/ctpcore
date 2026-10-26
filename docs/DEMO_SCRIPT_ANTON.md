# CTP Core: demo for Anton

**For Ian to run the meeting.** Written 26 Oct 2026 after the overnight QA sweep, against live
**v44+** (https://ctpcore.vercel.app). This replaces `01_DEMO_SCRIPT.md` for this meeting; that one
predates Zoho.

**How long it takes:** about 25 minutes for everything, or 10 minutes for Moves 1, 3 and 5 alone.

---

## Accounts to use

| Who | Login | Used for |
|---|---|---|
| You (staff, admin) | your own: iancrediblemusic@gmail.com | the counter, the order desk, Settings |
| The customer view | **Test Account (Ian)**: ian@iancredible.co.za (your test customer) | the customer's phone: request, quote, accept |
| Anton | his own: anton@supalift.co.za (admin) | optional: hand him the phone in Move 6 |

- **Never demo with Denver's (Hermans) login.** That is a real customer's account.
- **For the customer view, use a second device or a private window** so you stay signed in as staff
  on the main phone.
- **Have a small PDF on the customer device** (any one-page PDF) to attach as the PO in Move 4.

## The night before (10 minutes)

1. **Open the app on both devices and sign in.** Wait until the dot at the top right reads
   **synced**. A first sync takes about 15 s on good Wi-Fi.
2. **Open the Home grid once and scroll it**, so every section picture is cached for offline.
3. **Open one diagram** (e.g. Front Bumper) and tap a marker, so the part sheet opens.
4. **Make sure your test customer has no open orders left over.** In Orders, search "Test Account"
   and cancel anything open.
5. **(Optional) The rebate on the customer's screen.** The customer side of the rebate needs a
   customer on a Zoho price book; only Hermans is. Show the rebate from the staff side (Move 2)
   instead. If you want the customer view of it too, ask Michelle to put the Test Account contact on
   "FAW JH6 – Rebate" in Zoho. A CTP-only setting is wiped by the next Zoho read-back.

---

## Move 1: Find a part in a second (3 minutes)

*On your staff phone.*

1. Tap **Find** and type part of a number, e.g. `28030`. The list narrows as you type.
2. Try a **name**, e.g. `bumper`, then **two words**, e.g. `bumper bracket`. Both words count, in any
   order.
3. Type an **OEM number without its dash**. It still finds the part.
4. Tap a result. The part sheet shows:
   - photos (swipe them);
   - bin and on-hand count;
   - list price;
   - the **Hermans rebate** box;
   - fitment and cross-references.

   > "Every number on this screen is on the phone. It works with no signal."
5. **Turn on aeroplane mode** and search again. It still works, and the dot says **offline**.
   Turn aeroplane mode off; the dot goes back to **synced**.

## Move 2: Diagrams and the rebate (3 minutes)

1. **Home** → tap a section picture, e.g. **Front Bumper**.
2. The drawing opens with numbered markers. Pinch or use **+ / −** to zoom, then tap a marker: that
   part's sheet opens.
3. Back on the drawing, scroll the parts list under it. It shows thumbnails, stock and **Open**.
4. On any part, point at **"Hermans rebate"**: the list price is struck through with Hermans'
   price next to it.

   > "Their Zoho price book comes straight through. Quotes for Hermans start at the rebate price
   > automatically."

## Move 3: A customer asks for parts (4 minutes)

*On the customer device (Test Account).*

1. Point out that the customer sees **no cost, no stock count and no other customers**, only
   in stock / out of stock.
2. Add 2 parts to the request (**Add**), open **Request** and add a note, e.g. "Need by Friday".
3. Tap **Send request**. The toast reads "Request RQ-… — we'll come back to you with prices".

*On your staff phone.*

4. Go to **Orders**. The new request is in the amber **Needs pricing** lane.
5. Open it. Each line shows list, cost, margin and floor. Only staff ever see these; a warehouse
   login doesn't either.
6. Type prices, or leave the pre-filled ones, and tap **Send quote**. The card turns blue.

## Move 4: The customer accepts with a PO, and it lands in Zoho (4 minutes)

*On the customer device.*

1. **Request** → the quote shows **Quote ready** with the total.
2. Tap **Accept**. Show that it wants a **PO number** and the **PO file**. Accept stays greyed out
   until both are there.
3. Enter PO `DEMO-001`, attach the PDF, and accept. The toast confirms the sales order number.

*On your staff phone (or in Zoho on the laptop).*

4. The card turns purple: **accepted → Zoho sales order**. Open it in Zoho Books and show:
   - status confirmed;
   - reference = `DEMO-001`;
   - the PO attached;
   - the salesperson;
   - the price-book rates.

   > "Nobody typed this into Zoho. Accounts work in Zoho exactly as before."

## Move 5: Invoice → Fulfil → Close (4 minutes)

Use an order that is **already invoiced**, e.g. a recent Hermans order (read only). Or ask Michelle
to invoice the demo SO live.

1. On a card whose invoice is still a draft, the pill says **"Invoiced — not sent yet"**. Fulfil is
   blocked with "ask Michelle to mark it sent".
   - A cash customer instead shows **"waiting for payment"**.
2. Once the invoice is sent (account) or paid (cash), the pill turns teal: **ready to fulfil**.
3. **Fulfil** takes the stock out in CTP and creates the package and shipment in Zoho Inventory.
4. **Close** links the invoice. The card goes green, then grey.
5. Open the **timeline** on the card: every step with who and when (Johannesburg time).

**Don't fulfil the demo order** unless Michelle has invoiced it. If she hasn't, finish Move 6 first,
then cancel it (step 4 of Move 6).

## Move 6: Hand him the keys (3 minutes)

1. **Orders filters:** date, customer, part, invoice and payment. Show "this week" and one customer.
2. **Settings → Staff & access** (admin only):
   - everyone's role;
   - an invite takes an email and a role;
   - changing a role or removing someone asks "are you sure";
   - you can't remove yourself.
3. **Settings → Zoho:** the stock master switch reads **CTP**. Don't touch it.
4. **Tidy the demo order:** open it → **Cancel** with a reason. The toast confirms the stock hold is
   released, and the card shows **"SO-… · void in Zoho"**. The Zoho sales order is voided
   automatically and no email goes anywhere.

## Questions to expect, with honest answers

- **"What if the internet drops?"**
  - Catalogue, search, diagrams and stock counts all work offline.
  - Changes queue up ("N to send") and go when the signal is back.
  - Sending a quote, accepting and fulfilling need a connection; the app says so plainly.
- **"Can a customer see our costs?"** No. The customer's phone and its logins are refused cost,
  stock counts and other customers. This was re-tested overnight, including direct database calls.
- **"Who can do what?"**
  - **Sales** quotes and fulfils.
  - **Manager** (Michelle) also sees settings.
  - **Admin** (you and Anton) manages staff, accepts on a customer's behalf, and can release before
    an invoice.
  - **Warehouse** sees stock and bins but no cost.
- **"Is Zoho still the master?"**
  - For items, prices, customers, sales orders, invoices and payments: yes.
  - Stock is still mastered in CTP until the cut-over (docs/09). The cut-over is not happening this
    week.

## If something goes wrong live

- **Dot stuck on "offline" with Wi-Fi on:** pull down to refresh, or close and reopen the app.
- **A part sheet won't open from a diagram:** go back to Home and reopen the section.
- **Accept spins on "Checking your account…":** it offers **Try again**. If it fails twice, accept
  on the customer's behalf from your staff phone (admin), with a note like "Confirmed by Ian in
  person".
- **Anything else:** say "that's the beta" and move to the next Move. Nothing in this script changes
  real customers' data.
