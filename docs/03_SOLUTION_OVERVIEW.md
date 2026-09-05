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
| **Desktop app** | Office: pricing, invoicing, catalogue admin | Installed Windows application |

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
| Order emails | Supabase edge function via Resend | Deployed |

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

Price-list isolation was verified by simulating both a customer and a staff
session directly against the live database: the customer sees **0** price rows,
**0** cost rows and **0** margin rows; staff still see all **117**, **159** and
**3** respectively.

---

## 5. What is honestly not finished

Listed plainly, because a handover that hides these is worthless.

**Cross-reference and vehicle fitment are empty.** The tables and the search
that uses them are built, but **zero** OEM, competitor and supersession numbers
have been loaded, and **zero** vehicle-fitment records. This matters because
"type a competitor's number, get our equivalent" is the strongest commercial
argument the system has, and it cannot be demonstrated from data today. Loading
this is the highest-value next job in the whole project.

**The desktop app is not yet joined to the cloud.** It runs against its own
local database. The cloud database has been the real record for weeks, and the
phone app uses it. The desktop app has the sync and login machinery built and
switched off pending a test. Until it is switched on, the desktop app should be
treated as a tool, not as the system of record.

**Stock transfer between locations has no button.** The engine underneath is
complete, correct and double-entry balanced. Nothing calls it.

**The local desktop database is not encrypted.** A stolen office machine would
expose a copy of the catalogue and orders. The cloud data is unaffected. Worth
closing before the app is put on any laptop that leaves the building.

**Payments and live accounting sync are designed, not built.** Accounting
currently exports a file for QuickBooks or Xero, which is a deliberate and
sound early choice — integrate rather than rebuild.

**Two small housekeeping items:** one orphaned user record with no matching
login, and the database's own migration history has gaps in its record-keeping
(the schema itself is correct and current — only the audit trail of how it got
there is incomplete).

---

## 6. What it would take next

In the order that returns the most value soonest:

1. **Load the interchange data.** Turns the system from a good internal tool
   into a reason customers phone us instead of a competitor. Highest value by a
   wide margin.
2. **Switch on desktop sync.** Makes it genuinely one system. The work is
   built; it needs a controlled test, not new code.
3. **Encrypt the local database.** Small, bounded, closes a real risk.
4. **Wire up stock transfer.** A screen for an engine that already works.
5. **Then** consider payments and live accounting — only once the above are
   solid.

---

## 7. Running it

**Accounts that must not be lost.** Supabase (database, storage, logins),
PowerSync (device sync), Vercel (phone app hosting), Resend (order emails),
GitHub (source code). Access to these *is* ownership of the system — make sure
more than one person can get into each.

**Backups.** Supabase takes automatic backups. **A restore has never been
tested.** An untested backup is a hope, not a backup — test one.

**Costs.** Three managed services on their respective plans. Confirm current
figures from each provider's billing page before relying on a number.

**Source code.** A complete Git repository with full history, currently on one
machine and **not yet pushed to its remote**. This should be pushed
immediately — right now the project's entire history exists in one place.

**Two settings worth changing today**, both one click in the Supabase
dashboard: enable leaked-password protection, and confirm who holds
administrator access.

---

## 8. The honest summary

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
