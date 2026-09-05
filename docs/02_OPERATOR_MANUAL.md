# CTP Core — Operator Manual

**For the people who use it: counter staff, warehouse, sales.**
Version 1.0 · 5 September 2026

---

## What this is, in one paragraph

CTP Core keeps track of every part we stock: what it is, what it looks like,
which bin it is in, how many we have, and what it costs. There are two ways in
— a **phone app** for the yard and the counter, and a **desktop app** for the
office. They show the same catalogue. You do not need to learn both; use
whichever is in your hand.

**The one rule worth knowing:** the system never lets you type in a new stock
figure. You tell it what *happened* — "I took two off the shelf", "twelve
arrived" — and it works out the number. That is deliberate. It means the stock
figure can always be traced back to who did what and when, and it means two
people can work at the same time without standing on each other.

---

# PART ONE — THE PHONE

Open `ctp-core.vercel.app` in Chrome or Safari and sign in with the email and
password you were given.

**Install it properly on your phone** — it is worth the 20 seconds:
- **Android/Chrome:** menu (⋮) → *Add to Home screen*
- **iPhone/Safari:** Share button → *Add to Home Screen*

It then opens like any other app, full screen, with its own icon.

### The dot at the top right

- **synced** — you are connected and up to date.
- **offline** — no signal. **Keep working.** Everything you can see still
  works, and anything you record is saved and sent up the moment the signal
  comes back. You do not need to do anything.

---

## Find a part

Tap **Counter** and start typing. You can type:

- our part number (`5302010-B45`)
- the manufacturer's number
- part of the name (`bumper`, `headlamp`, `step`)

Results narrow as you type. You do not need the whole number, and you do not
need the dashes.

Tap a result to open it. You get the photo, the description, **BIN** (where it
lives on the shelf) and **ON HAND** (how many are there right now).

> **Tip:** if you cannot find something by number, try the name. If you find it
> that way and it took you a few goes, tell Ian — the system can be taught the
> words customers actually use, and it remembers.

---

## Take stock off the shelf — *Issue*

When parts leave for any reason — a sale, a job, a warranty replacement:

1. Find the part.
2. Tap **Issue**.
3. Enter how many.
4. Confirm.

The on-hand figure drops immediately. Do this **as it happens**, at the shelf.
Doing it later from memory is how stock figures go wrong.

## Put stock on the shelf — *Receive*

When a delivery lands:

1. Find the part.
2. Tap **Receive**.
3. Enter how many arrived.
4. Confirm.

## Correct a mistake — *Count*

If the shelf says 4 and the system says 6, do not try to work out the
difference. Tap **Count**, enter **what is actually on the shelf**, and confirm.
The system works out the correction and records it as a stock count, which is
what an auditor wants to see.

> **You cannot break this by making a mistake.** Every action is recorded as a
> separate line, so a wrong entry is corrected by adding a right one — nothing
> is ever overwritten or lost. If you fat-finger a number, just do a **Count**
> with the true figure.

## Move stock between places — *Move*

When a part physically moves from one location to another — main store out to
the shop, say — do not issue it from one and receive it into the other. There
is a proper way that keeps the total right:

1. Find the part and open the counter.
2. Tap **Move between locations instead**.
3. Pick where it is going.
4. Set how many, and tap **Move**.

You will see both sides before you commit it: what the source drops to and what
the destination rises to. If the source doesn't hold enough, it says so — do a
**Count** first if the shelf disagrees with the screen.

The option only appears when the part exists in more than one location, because
otherwise there is nowhere for it to go.

> Moving writes **two** ledger lines — out of one place, into the other. The
> total on hand across the business does not change, only where it sits. Undo
> moves it straight back.

---

## The order desk *(staff only)*

Tap **Orders**. Orders are grouped by what needs doing:

- **Needs pricing** — a customer has asked for parts and nobody has quoted yet.
  This is the queue that costs you business if it sits.
- **Quoted** — waiting on the customer.
- **Confirmed** — they said yes. Pick and fulfil.

Open an order to see the lines. Where a line has no price, type one in and
save. **Enter rand however you naturally type it** — `1850`, `1850.50`,
`1 850,50` and `R1,850.50` are all understood, comma or dot.

The moment you save, the customer sees the price on their phone.

---

## Photos

Good photos are the single biggest time-saver at the counter — a customer
recognises a part they cannot name.

On a part, tap the photo area to add one from the camera or gallery. Tap an
existing photo to set it as the main one or remove it.

**A good part photo:** the whole part, in frame, on a plain floor or bench,
decent light, no hands. Take it once, properly, and it serves forever.

---

# PART TWO — THE DESKTOP APP

Double-click **`start-fleetview.bat`**. The first launch after an update takes
a few minutes while it rebuilds; after that it opens in seconds.

The desktop app does everything the phone does, plus the office work: creating
parts, quoting, invoicing, printing and exporting to the accountant.

## Counter

Same search as the phone, more room. Results show why each one matched, so you
can tell a part-number hit from a name hit.

## Parts

The full list, and where parts are created and edited. To add a part you need
at minimum a part number, a name and a category. Add a photo while you are
there — it is much harder to go back and do later.

Deleting: the system will refuse to delete a part that is sitting on a live
order, and it will tell you which one. That is a feature. Close the order
first.

## Sales — quote to invoice

An order moves through four stages:

| Stage | What it means | What it does to stock |
|---|---|---|
| **Quote** | Priced, sent, not agreed | Nothing |
| **Confirmed** | Customer said yes | Nothing yet |
| **Fulfilled** | Parts handed over | **Issues the stock** |
| **Invoiced** | Billed | Goes to the accounting queue |

To quote: create the order, pick the customer, add lines, set quantities. Each
line takes the price for **that customer's tier** at the moment you add it, and
holds it — so a price change next week does not silently rewrite a quote you
already sent.

To print: **Print** opens the document on the company letterhead. Use your
browser's *Save as PDF* to make the file you email.

VAT is set per order and defaults to 15%.

## Accounting

**Accounting** lists invoiced orders waiting to go to the books. Export as
**IIF** for QuickBooks or **CSV** for Xero.

Once an order has been exported to a target it will not export to that target
again, no matter how many times the button is pressed. **You cannot
double-post.** Export as often as you like.

## Settings (the gear icon)

The company name, address, phone, email, VAT number and payment terms that
print on every quote and invoice. **Check these are right before sending
anything to a customer.**

---

# PART THREE — SETTINGS *(managers and owners)*

The full settings area lives in the **phone app**, which also opens perfectly
well in Chrome on a desktop. Sign in, go to **Info**, and tap **Settings** at
the top. It only appears for managers and administrators.

### Company
The letterhead. Registered name, trading address, phone, email, **VAT number**,
company registration number, the default VAT rate, quote and invoice number
prefixes, **banking details** (printed in the invoice footer so customers can
pay without phoning to ask), and payment terms.

> Leave the VAT number blank rather than guess at it. A wrong VAT number on a
> tax invoice breaks your customer's own VAT claim, and that is their problem
> arriving back as yours.

### Order emails
Who gets told when something happens. Turn emails on or off entirely, set the
recipients (several addresses, comma separated), the reply-to address, and the
sender name. You can switch each event separately: a customer sending a
request, accepting a quote, declining a quote.

**Send a test email** proves the whole chain — the app, the mail service and
the address. If it doesn't arrive within a minute or two, something in that
chain needs attention.

### Staff & access *(administrators only)*
Invite someone by email and pick their role. They get an email and **choose
their own password** — nobody, including you, ever sees or sets it.

| Role | Sees |
|---|---|
| **customer** | Only their own quotes and orders. No prices, no stock, no bins. |
| **sales** | Full catalogue, stock, order desk. Can quote and price. |
| **warehouse** | Full catalogue and stock. Receives, issues, counts. |
| **manager** | The above plus settings and accounting. |
| **admin** | Everything, including managing staff. |

Change a role from the dropdown next to anyone, or remove their access
entirely. The system will not let you remove or demote the **last**
administrator — that would lock everyone out permanently.

> Roles are enforced by the database itself, not by hiding buttons. A warehouse
> login physically cannot read cost prices, even through a direct request.

### Warehouses
Add a location, or retire one. A location still holding stock **cannot** be
retired — move the stock out first. Retiring never deletes history; past
movements keep pointing at it.

### Pricing tiers
What each kind of customer pays off the list price, and the margin floor a
salesperson cannot go below.

> Changing a tier does **not** rewrite quotes already sent. Every order line
> keeps the price it was quoted at. That is deliberate: a price change today
> cannot silently alter what you promised last week.

---

# WHEN SOMETHING GOES WRONG

| What you see | What it means | What to do |
|---|---|---|
| **offline** on the phone | No signal | Keep working. It catches up by itself. |
| A screen sits on *Loading…* | A load failed | Tap **Try again**. If it persists, close and reopen. |
| Part not found | Wrong number, or not loaded | Search by name instead. Then tell Ian. |
| Stock figure looks wrong | Something wasn't recorded | Do a **Count** with the true figure. Do not guess a correction. |
| "Cannot delete — on an order" | Part is on a live order | Close or cancel that order first. |
| Desktop app won't open | Local database problem | Read the message it shows. Cloud data is safe. Send Ian the message. |
| Photo won't upload | Signal, or file too large | Retry on wifi. |

**Nothing you can do from these screens can destroy data.** Every change adds a
record rather than replacing one. The worst case is an entry that needs
correcting with another entry.

---

# THE HABITS THAT MAKE IT WORK

1. **Record it at the shelf, not at the desk.** The system is only as accurate
   as the gap between the thing happening and it being entered.
2. **Count when in doubt.** A two-second count beats a wrong number that
   someone trusts next week.
3. **Photograph parts as they arrive.** Best time you will ever have.
4. **Price the quotes queue daily.** An unpriced request is a customer waiting.
5. **Say when the search fails you.** It can be taught, but only if you speak up.
