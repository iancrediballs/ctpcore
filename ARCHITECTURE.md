# FleetView ERP — Architecture Blueprint & Build Order

*A local-first inventory/CRM/sales spine for commercial truck parts. Working name: FleetView. Status: greenfield, Phase 0.*

---

## 0. The one decision that makes everything else easy

Most of the difficulty in your blueprint — "local-first, 100% uptime, offline, banking-grade, automatic reconciliation" — collapses into a single design choice:

**Model inventory as an append-only event ledger, not as mutable quantity fields.**

A normal ERP stores `qty_on_hand = 14` and updates it. The moment two devices are offline and both sell that part, you have a conflict, and conflict resolution across a distributed system is genuinely one of the hardest problems in software. It is where ambitious builds die.

Instead, stock is a list of immutable movements: `+10 receipt`, `-1 sale`, `-1 sale`, `+2 return`. On-hand is the *sum*. Now:

- **Offline just works.** Two devices each append a `-1 sale` row. When they sync, both rows survive. Reconciliation is a replay, not a fight.
- **It's banking-grade by construction.** An append-only ledger with idempotent IDs *is* the audit trail. Nothing is ever silently overwritten.
- **It's fast.** On-hand is a derived rollup you refresh on sync.

This is the "complexity dissolves with the correct framing" moment you're after. It's already baked into `schema/core.sql` (`stock_movement` + the `stock_on_hand` view). Everything else in this document follows from it.

---

## 1. The honest scope read (so you go big without losing wind)

Your north star — ERP + CRM + Sales + Marketing + Accounting, local-first, banking-grade, dead simple — is the *right* ambition. But as a **build order** it's five products plus a distributed-systems problem plus a compliance problem. A funded team treats that as multi-year. Solo, attempting it all at once is the exact "aim too high too soon and fall" risk.

The resolution isn't to shrink the dream. It's to build the **spine** correctly, then bolt modules on at speed:

> The parts data model and the local-first sync layer are the foundation. CRM, sales, marketing, and accounting are all *consumers* of that foundation. Get the spine right and new modules snap on in days. Get it wrong and every module forces a rebuild.

So: go big on the *vision*, ruthless on the *sequence*. Ship the spine first.

**Two guardrails, stated plainly:**

1. **Do not build banking or a general ledger yourself.** "Banking-grade" describes the *discipline* you apply to data integrity — not a mandate to become a bank. Real money movement uses established rails (Stripe, etc.); accounting syncs to QuickBooks/Xero via their APIs. Rolling your own here is a compliance and liability sinkhole that adds zero customer value early.
2. **Resist the marketing/CRM build until the spine earns it.** They're the visible, exciting part. They're also worthless on a shaky foundation.

---

## 2. Recommended stack (and *why* each piece)

| Layer | Choice | Why this, not the obvious alternative |
|---|---|---|
| **App shell** | **Tauri** (Rust core + web UI) | Local-first desktop, ~10 MB binary, native speed, Rust gives the integrity/security story. Electron is heavier and weaker on exactly the rugged/fast/secure axes you care about. |
| **Local store** | **SQLite** (FTS5 + trigram) | The proven local-first engine. Full-text + fuzzy part-number search runs *on device*, offline, in milliseconds. |
| **Server / source of truth** | **PostgreSQL 15+** | Banking-grade constraints, real transactions, `pg_trgm` fuzzy search. Mirrors cleanly to SQLite. |
| **Sync** | **Outbox + pull-cursor** (see §3). Consider **PowerSync** or **ElectricSQL** to avoid hand-rolling. | Full CRDT frameworks are overkill for relational ERP data. The append-only ledger means you need real CRDTs almost nowhere. |
| **Frontend** | **React + TypeScript**, **TanStack Table/Virtual** | Virtualized grids render a million-row inventory without breaking a sweat — the "massive database, rapid search" requirement. |
| **Client state** | **TanStack Query** (server cache) + **Zustand** (UI). | Lean and predictable. No Redux ceremony. Matches "consistency over complexity." |
| **Search** | SQLite FTS5 + trigram locally; Postgres GIN + `pg_trgm` on server | Same query shape both sides. The killer feature — cross-reference fuzzy lookup — is in `core.sql`. |

You can swap any single piece, but this set is mutually reinforcing and minimizes the number of hard problems you own.

---

## 3. Local-first sync, concretely

Every device holds a SQLite mirror. The contract:

1. **Every business row is *syncable*** — carries `id, rev, updated_at, deleted_at, origin`. A trigger keeps `rev`/`updated_at` honest (already in `core.sql`). Soft-delete only; synced rows are never hard-deleted.
2. **Writes go to a local outbox** (a `change_log` table) with a monotonic local sequence. The UI reads/writes SQLite and returns instantly — never blocks on the network.
3. **A background worker** pushes the outbox to the server and pulls server changes since the device's last cursor. Intermittent connectivity is the normal case, not the error case.
4. **Conflict policy is per-table, and mostly trivial:**
   - **Reference data** (`part`, `part_xref`, `fitment`, `price`): server-authoritative, last-write-wins by `rev`. Rare and low-stakes.
   - **Ledgers** (`stock_movement`): append-only + a `client_uuid` for idempotency → *no conflicts possible*. Apply-once even if a sync retries.
   - **Mutable config** (`stock_policy`): last-write-wins, flag divergences for human review.

That's the whole model. The hard 20% (stock) is designed out of existence; the easy 80% is last-write-wins.

---

## 4. The spine schema (`schema/core.sql`)

Production-ready and grammar-validated. Highlights:

- **`part`** — canonical master with supersession chains and a generated `tsvector`.
- **`part_xref`** — **differentiator #1: cross-reference / interchange.** One part ↔ many OEM/aftermarket/competitor/supersession numbers, with a confidence score for imported matches. *This is what a hollow ERP leaves out and what makes a customer call you instead of guessing.*
- **`part_fitment` + `vehicle_model`** — **differentiator #2: which trucks a part fits** (make/model/variant/year/engine).
- **`stock_movement`** — the append-only ledger (§0). `stock_on_hand` is the derived view.
- **`price`** — integer **minor units** (cents). Never floats for money.
- **Search indexes** — GIN full-text + trigram on every number a human actually types, including cross-reference numbers. The example query at the bottom of the file is your Phase-0 demo: fuzzy-match across SKU, MPN, name *and* every interchange number, ranked, with live on-hand, in one statement.

The CRM/Sales/Accounting **module seam** is sketched (commented) at the end: separate schemas referencing `core.part` by id only — addable later without touching core.

---

## 5. UI / UX spine (tech-noir, minimal-click)

- **The app is a search bar.** A persistently-focused global fuzzy search is the home screen. Type a number — partial, OEM, competitor, misspelled — get ranked parts with live stock. That single interaction is 80% of daily use; make it instant and the product feels magic.
- **Command palette (Cmd/Ctrl-K)** for every action. Keyboard-first = the minimal-click paradigm, literally.
- **Dark, high-contrast, dense** per the house style: rugged, scannable, fast. Monospace for part numbers so they're unmistakable.
- **No confirmation dialogs for reversible actions.** Append a movement; offer undo. Confirmations are friction that an event-ledger makes unnecessary — a "mistake" is just another movement.

---

## 6. Build order

**Phase 0 — The Spine + Demo (start here).**
Apply `core.sql`. Stand up Tauri + SQLite mirror + the sync skeleton (outbox/pull). Build exactly one screen: lightning search → part detail with cross-references, fitment, and live on-hand. Seed real parts data. **Deliverable: a demo that searches a competitor's part number offline and returns your equivalent in stock.** That single screen sells the whole vision.

**Phase 1 — Inventory operations.** Receiving and stock movements UI, locations/bins, suppliers, purchase receipts, reorder alerts off `stock_policy`. Now it's a real warehouse tool.

**Phase 2 — Sales + CRM.** `sales` + `crm` schemas. Quotes → orders (order lines write `stock_movement`). Customers, leads, predictive stock suggestions, automated follow-up triggers. The "high-velocity sales tool."

**Phase 3 — Accounting integration.** Thin sync to QuickBooks/Xero. *Integrate, don't build.*

**Phase 4 — Marketing.** Built on real CRM data, last because it's worth the least without everything above.

Each phase ships something usable. You never hold all five products in your head at once — you hold one, on a foundation that already anticipates the rest.

---

## 7. On Multicat

It "feels hollow" most likely because it's a generic catalog ERP without strong **interchange/cross-reference** and **fitment intelligence** — the two tables that make a *parts* business defensible. Before committing further, the high-value audit is narrow: does Multicat give you (a) fuzzy cross-reference search, (b) vehicle fitment, (c) an export path for your data, and (d) offline operation? Where it can't, that's precisely the gap FleetView fills. Say the word and I'll map its actual capabilities against this spine.

---

*Files in this project: `ARCHITECTURE.md` (this doc), `schema/core.sql` (the spine). Next concrete step on request: scaffold the Tauri + SQLite + sync skeleton, or seed the schema with sample truck-parts data so the Phase-0 search demo is real.*
