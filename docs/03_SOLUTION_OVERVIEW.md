# CTP Core — Solution Overview & Handover

**Prepared for the owner of China Truck Parts.**
5 September 2026 · Every figure below was read from the live system on the day.

---

## 1. What has been built

CTP Core is a parts-trading system for the business: catalogue, stock control,
quoting, invoicing and an accounting hand-off. It exists in two forms that share
one set of records.

| | Who uses it | Where |
|---|---|---|
| **Phone app** | Counter and warehouse staff, and customers | `ctp-core.vercel.app` — installs to the home screen, no app store |
| **Desktop app** | Office: pricing, invoicing, catalogue admin | Windows installer, version 1.0.0, `.exe` or `.msi` |

The desktop installer is a normal signed-format Windows package that appears in
Add/Remove Programs as **CTP Core 1.0.0**, published by China Truck Parts (Pty)
Ltd. It is around 126 MB because every catalogue photograph and exploded diagram
is bundled inside it — which is the point: a counter PC with no internet still
shows the pictures.

It is not a prototype. It runs on the real catalogue, the real customers and
the real order book.

### What is actually in it, today

| | Count |
|---|---|
| Parts in the catalogue | **161** |
| Loaded prices | **117** |
| Part photographs | **318** |
| Exploded diagrams | **72** |
| Diagram callouts linking a drawing to a part | **298** |
| Customers | **5** |
| Sales orders | **14** |
| Order lines | **58** |
| Stock movements recorded | **199** |
| Catalogue images in cloud storage | **421 files, 116 MB** |

---

## 2. The idea the whole thing rests on

Most stock systems store a number and change it. This one does not. It stores
**events** — *twelve received*, *one sold*, *two returned* — and the quantity
you see is the sum of them.

That single decision buys three things that are otherwise very hard:

- **It works offline.** Two people in two places with no signal can both sell
  the same part. When they reconnect, both events are kept and the arithmetic
  is simply right. There is no conflict to resolve, because nothing was
  overwritten.
- **It is auditable by construction.** The history is not a log written
  alongside the data; the history *is* the data. Nothing can be silently
  changed, because nothing is ever changed at all.
- **Mistakes are cheap.** A wrong entry is corrected by a further entry, and
  both remain visible.

The same discipline runs through the money: every price is held in whole cents
as an integer, never as a decimal fraction, so rounding cannot quietly drift.
And every action carries a unique key, so a retry on a bad connection cannot
book the same sale twice.

---

## 3. What is live right now

| Piece | Where it runs | Status |
|---|---|---|
| Database | Supabase Postgres 17.6, Frankfurt (EU) | **Healthy** |
| Phone app | Vercel | **Live** |
| Device sync | PowerSync | **Live** |
| Image storage | Supabase, 421 files | **Live** |
| Order emails | Supabase edge function via Resend | **Live and verified** |

**Data protection.** All 25 tables have row-level security switched on with
real policies. A customer login is blocked *at the database*, not merely hidden
in the app — so even a leaked password or a direct API call cannot reach
another customer's orders, our cost prices or our margins.

Customer records sit in the EU. That is lawful under POPIA on the basis of the
provider's data-processing agreement plus explicit consent, and the consent
wording is built into the system's lead capture. Worth a formal review before
the customer list grows substantially.

---

## 4. What was fixed in this pass

A full audit was run across the desktop app, the phone app and the live
database. The material findings and their resolutions:

| Finding | Severity | Status |
|---|---|---|
| Every price displayed with a **`$`** although all data is rand | High — visible on every screen and every printed invoice | **Fixed** |
| Printed invoices had no rand symbol at all, falling back to `ZAR 1234.56` | High — appears on customer documents | **Fixed** |
| Any logged-in customer could read the **entire price list, every tier**, via the API | High — commercial exposure | **Fixed and verified** |
| A device whose role could not be determined was shown the **staff** interface — bins, costs, the order desk | High — wrong-way-round default | **Fixed** |
| A single bad record could hang the order desk on *Loading…* permanently, with no error and no way out | Medium — silent total failure of a screen | **Fixed** |
| Photo and diagram uploads wrote to a path that only exists on the developer's machine — they would fail in an installed copy | Medium — feature dead once packaged | **Fixed** |
| If the local database failed to open, the desktop app **vanished with no message** | Medium — unexplainable failure | **Fixed** |
| 116 MB of part photos and diagrams were missing from this machine | High — broken images throughout | **Restored, 421/421** |
| Launcher scripts pointed at the previous machine's user folder | Low — fails on first use | **Fixed** |
| `NODE_ENV=production` set system-wide silently broke dependency installation | Low — blocks any rebuild | **Fixed and documented** |
| **Order emails had never once been sent.** The trigger was built but no notification had ever left the system — and it fails silently by design, so nothing ever said so | High — a whole feature believed working, wasn't | **Fixed, sent and confirmed** |
| Cross-reference and vehicle-fitment tables were completely empty | High — the product's headline capability was undemonstrable | **Populated: 223 + 161 records** |
| Stock transfer between locations existed in the engine with no way to reach it | Medium — a built feature nobody could use | **Fixed — now on the phone** |

Price-list isolation was verified by simulating both a customer and a staff
session directly against the live database: the customer sees **0** price rows,
**0** cost rows and **0** margin rows; staff still see all **117**, **159** and
**3** respectively.

---

## 5. What the owner controls directly

A system that needs its developer for every change is a liability. The
**Settings** area — in the phone app, which also opens in a desktop browser —
puts the following in the owner's hands, with no code involved:

| | |
|---|---|
| **Company** | Letterhead, VAT number, registration number, VAT rate, quote and invoice prefixes, banking details for the invoice footer, payment terms |
| **Order emails** | On/off, recipients, reply-to, sender name, which events send, and a test send that proves the chain |
| **Staff & access** | Invite staff, set roles, remove access — administrators only |
| **Warehouses** | Add and retire locations |
| **Pricing tiers** | Discount off list and the margin floor per tier |

Every one of those writes is checked on the server, not in the browser. This
was verified by simulating both a manager session and a customer session
directly against the live database: the manager can write all of them; the
customer login is refused and the letterhead is unchanged after the attempt.

Staff management runs through a separate secured server function, because
creating a login requires a key that must never reach a browser. It checks the
caller's role against the database rather than trusting their own token, and it
refuses to let the last administrator remove or demote themselves. It has no
code path that can set or reveal anyone's password — invited staff choose their
own.

---

## 6. What is honestly not finished

Listed plainly, because a handover that hides these is worthless.

**Competitor cross-reference is not loaded.** FAW *catalogue* interchange now
is — 223 records covering all 161 parts, so a customer reading a FAW catalogue
number finds the right stock item, including the 62 parts whose own stock
number carries a grade suffix the catalogue number does not. What it will not
yet do is turn a competitor's part number into our equivalent. That needs data
the business does not hold, and it is the highest-value data job remaining.

**The desktop app is not yet joined to the cloud.** It runs against its own
local database. The cloud database has been the real record for weeks, and the
phone app uses it.

This one deserves a straight explanation, because the shortcut is tempting and
wrong. The desktop app's screens reach their data through a Rust engine that
implements 52 operations; the cloud path currently implements 19 of them.
Simply switching the desktop over would take out the accounting screen
entirely, the sales order desk almost entirely, and all diagram and part
editing. Joining them properly means either porting those operations to the
cloud path or building a sync engine into the Rust side — days of work, and the
highest-risk change in the project. It is being done properly rather than
quickly, which is why it is on this list rather than shipped.

**The local desktop database is not encrypted.** A stolen office machine would
expose a copy of the catalogue and orders. The cloud data is unaffected. Worth
closing before the app goes on any laptop that leaves the building.

**Payments and live accounting sync are designed, not built.** Accounting
currently exports a file for QuickBooks or Xero, which is a deliberate and
sound early choice — integrate rather than rebuild. Payments move real money
and the verification has to be exactly right; that is the one area where being
slow is the correct decision.

**Two small housekeeping items:** one orphaned user record with no matching
login, and the database's own migration history has gaps in its record-keeping
(the schema itself is correct and current — only the audit trail of how it got
there is incomplete).

---

## 7. What it would take next

In the order that returns the most value soonest:

1. **Load competitor interchange data.** FAW catalogue numbers are in. Adding
   the competitor and OEM equivalents is what turns this from a good internal
   tool into a reason a customer phones us instead of someone else. Highest
   value by a wide margin, and it is a data-sourcing job rather than a coding
   one.
2. **Join the desktop app to the cloud.** The largest remaining piece, and the
   one to do carefully rather than quickly — see section 6.
3. **Encrypt the local desktop database.** Small, bounded, closes a real risk.
4. **Then** consider payments and live accounting — only once the above are
   solid.

---

## 8. Running it

**Accounts that must not be lost.** Supabase (database, storage, logins),
PowerSync (device sync), Vercel (phone app hosting), Resend (order emails),
GitHub (source code). Access to these *is* ownership of the system — make sure
more than one person can get into each.

**Backups.** Supabase takes automatic backups. **A restore has never been
tested.** An untested backup is a hope, not a backup — test one.

**Costs.** Three managed services on their respective plans. Confirm current
figures from each provider's billing page before relying on a number.

**Source code.** A complete Git repository with full history, pushed to
`github.com/iancrediballs/ctpcore` and up to date with it. The history no
longer exists in only one place.

**Two settings worth changing today**, both one click in the Supabase
dashboard: enable leaked-password protection, and confirm who holds
administrator access.

---

## 9. The honest summary

The foundations here are unusually sound for a system of this size. The stock
ledger, the money handling and the retry-safety are done properly — the way
they would be done in a system built by a team, and they are the parts that are
expensive to retrofit later. Security is enforced at the database rather than
only in the interface, which is the right way round and is not common.

The gap is not in the engineering. It is that two of the most commercially
valuable capabilities — interchange lookup and a single joined system across
desktop and phone — are built but not switched on or not fed with data. Both
are finishing work rather than new construction.

**It is a real system with real data doing real work, with a clear and short
list of what remains.**

---

### Documents in this pack

| File | For |
|---|---|
| `01_DEMO_SCRIPT.md` | Ian — running the meeting |
| `02_OPERATOR_MANUAL.md` | Counter, warehouse and sales staff |
| `03_SOLUTION_OVERVIEW.md` | This document — the owner |
| `04_ADMIN_RUNBOOK.md` | Whoever keeps it running |
