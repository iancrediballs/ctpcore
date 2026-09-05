# CTP Core — Demo Script

**For Ian, to run the meeting. Not for circulation.**
Prepared 5 September 2026 · Verified against the live system the same morning.

---

## Before you walk in — 10 minutes

Do these in order. Each one has bitten someone before.

1. **Open the phone app and sign in.** `https://ctp-core.vercel.app`
   Wait for the sync dot to read **synced**, not "offline". First sync pulls
   the whole catalogue and takes 20–60 seconds on a decent connection.
2. **Search one part on the phone.** Anything — `5302010` will do. If you see
   a photo, the images are live and the whole visual side of the demo works.
3. **Start the desktop app** (`start-fleetview.bat`) and let it finish
   compiling *before* you leave the house. First build is 10–20 minutes. It is
   fast every time after that.
4. **Check the letterhead.** Desktop app → gear icon → Settings. Confirm the
   company name, address and VAT number are what you want printed on a tax
   invoice in front of the owner.
5. **Have a fallback.** If the venue's wifi is bad, the *desktop* app still
   works completely offline — that is the whole point of it. The phone app
   needs to have synced at least once. Sync at home.

---

## The through-line

Everything below is one story told in four moves. If you only get through the
first two, you have still shown the thing that matters.

> **The old way:** a customer phones with a part number off a competitor's
> invoice. Someone walks to the shelf, guesses, phones back an hour later.
> **The new way:** you type the number, you see the part, the picture, what is
> on the shelf and what it costs — in about a second, on a phone, in the yard.

---

## Move 1 — The counter search *(2 minutes, this is the money shot)*

**On the phone.**

1. Open **Counter**. Type a partial number — `5302` — and let it filter as you
   type.
2. Tap a result. The part detail opens: photo, description, the bin it lives
   in, how many are on the shelf, the price.
3. Say the line that matters:
   > "That worked with no head office, no server in the building, and it would
   > have worked with the phone in aeroplane mode. The whole catalogue is on
   > the device."

**Then turn on aeroplane mode and search again.** It still works. This is the
single most convincing five seconds in the demo and almost nobody expects it.

⚠️ **Do not promise competitor cross-reference lookup.** The feature is built
and the table is there, but it currently holds **zero rows** — no OEM or
competitor numbers have been loaded yet. Search matches your own SKU, the
manufacturer number, the part name and 24 learned aliases. If asked, the honest
answer is: *"the mechanism is built, loading the interchange data is the next
job."* Do not type a competitor number and hope.

---

## Move 2 — Stock is a ledger, not a number *(3 minutes, this is the credibility)*

**On the phone, on a part you just looked at.**

1. Tap **Issue**, take one off the shelf, confirm.
2. Show the on-hand drop by one.
3. Tap **Receive**, put it back.

Then explain what actually happened, because this is the part that separates
this from a spreadsheet:

> "It did not change a quantity. It wrote a line in a ledger — *minus one, this
> part, this bin, this person, this second* — and the quantity you see is the
> sum of every line ever written. Nothing is ever overwritten, so nothing can
> be quietly lost, and the history is the audit trail. It also means two people
> in two places, both offline, can each sell one, and when they reconnect the
> books are simply right. There is no conflict to resolve."

That is the architectural decision the whole system rests on. Say it out loud;
it is worth more than any feature.

---

## Move 3 — Quote to invoice *(4 minutes, this is the business case)*

**On the desktop app.**

1. **Sales** → open an existing Hermans order (there are 14 real orders in the
   system — use real data, not a toy).
2. Show the lines, the prices, VAT at 15%, the total.
3. **Print** → the quote opens as a proper document on the company letterhead →
   *Save as PDF*. That is the file that goes to the customer.
4. Move the order along a stage and point out that fulfilling it **issues the
   stock through the same ledger** from Move 2. One truth, not two systems.
5. **Accounting** → show the export queue. Invoiced orders export to QuickBooks
   (IIF) or Xero (CSV), and the outbox is append-only so **an order physically
   cannot be posted to the books twice.**

---

## Move 4 — The customer sees their own quote *(2 minutes, this is the future)*

If you have a second device or can log out and back in as the Hermans account:

1. A customer logs in and sees **only their own** orders and quotes. Not
   prices, not costs, not bins, not anyone else's business — the database
   itself enforces that, not just the screen.
2. They add parts to a request and send it. It lands on your order desk.
3. You price it. It appears on their phone.

> "That is Hermans placing an order without phoning anyone, and without ever
> seeing what we paid or what we charge anyone else."

---

## Questions you should expect, with honest answers

**"Is our data safe if a laptop is stolen?"**
The real records live in a managed Postgres database in the EU with row-level
security — every table has policies, and a customer login is blocked at the
database, not just hidden in the app. A stolen staff laptop holds a local copy;
encrypting that local file is on the roadmap and is not done yet. Say so.

**"What happens if the internet goes down?"**
The desktop app does not care — it is built local-first and keeps trading. The
phone app keeps working on everything it has already synced and catches up when
the signal returns.

**"Can we get our data out?"**
Yes. Standard Postgres, plus accounting exports to QuickBooks and Xero. There
is no lock-in and no proprietary format.

**"How much does it cost to run?"**
Three managed services — Supabase, PowerSync and Vercel. Confirm the exact
current plan figures before you quote a number. Do not guess in the room.

**"What is not finished?"**
Have this list ready; volunteering it buys more credibility than it costs:
- Cross-reference and vehicle-fitment tables are built but **empty**.
- The desktop app runs against its own local database — it is **not yet
  synced** to the cloud that the phone uses. Two surfaces, one not yet joined.
- Stock transfer between locations exists in the engine but has **no button**.
- The local desktop database is **not encrypted** at rest.
- Payments (PayFast) and live accounting sync are designed, not built.

**"When can staff actually use it?"**
The phone app is genuinely usable today. The desktop app needs the sync switch
turned on before it should be trusted as the system of record.

---

## If something breaks live

- **Phone shows "offline":** carry on. Everything already synced still works.
  Say so out loud rather than tapping at it — it demonstrates the point.
- **A screen is stuck loading:** it will now show an error and a *Try again*
  button rather than hanging. Tap it.
- **Desktop app won't open:** it will now tell you why in a message box. Read
  it out; the cloud data is unaffected either way.
- **Anything else:** move to the next section. Never debug in the room.

---

## The one-sentence close

> "It is a working system with our real parts, our real customers and our real
> orders in it — not a prototype — and every decision in it was made so that it
> keeps working on a bad day rather than only on a good one."
