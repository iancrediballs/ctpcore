# CTP Core — local-first commercial-truck parts ERP

Tauri (Rust) + React + SQLite. Offline-first. The whole system is built on one
idea: an **append-only stock ledger** — on-hand is always *derived* (summed),
never stored — which makes offline writes, retries, and audit trivial.

## What's built (Phases 0–4)

- **Counter** — type any number (yours, OEM, aftermarket, or a *competitor's*)
  and get the matching in-stock part, ranked, offline (SQLite FTS5 trigram).
  `matched_on` shows *why* it matched.
- **Inventory** — receive / issue / adjust stock and transfer between locations.
  Every write appends to the ledger and is idempotent on `client_uuid`.
- **Sales / CRM** — quote → confirmed → fulfilled → invoiced. Line prices snapshot
  at the customer's tier; fulfillment issues stock through the same ledger.
- **Accounting** — export invoiced orders to QuickBooks (IIF) / Xero (CSV) via an
  append-only outbox (one push per order per target — never double-posts).
- **Documents** — print quotes & invoices to PDF (browser Save-as-PDF) using the
  editable company profile (⚙ Settings) as the letterhead.

## Layout

```
app/
  src/            App.tsx (counter+nav+settings), SalesView.tsx,
                  AccountingView.tsx, invoiceDoc.ts, styles.css
  src-tauri/
    src/main.rs   all Rust commands (search, ledger, sales, accounting, company)
    migrations/   0001 schema · 0002 seed · 0003 sales · 0004 accounting · 0005 company
```

The DB is created in the OS app-data dir on first launch. A versioned migration
runner (`PRAGMA user_version`) applies 0001–0005 in order, so upgrades never wipe
local data.

## Run it

Prerequisites: **Node 18+**, **Rust (stable)**, and the Tauri 2 prerequisites for
your OS — on Windows that's the **Microsoft C++ Build Tools** and **WebView2**
(https://tauri.app/start/prerequisites/).

```bash
cd app
npm install
npm run tauri dev      # launches the desktop app with hot reload
```

Build a distributable:

```bash
npm run tauri build
```

## Verification status

- Frontend (TypeScript/React): type-checks clean.
- All SQL/ledger/sales/accounting logic: verified against the real migrations
  (idempotency, derived on-hand, price snapshots, tax math, IIF debit=credit).
- Rust compilation must be done on your machine (`cargo tauri dev`) — it needs
  the local toolchain + WebView2.

## Next candidates

Sync/server (Postgres + outbox push for multi-device), live QuickBooks/Xero
OAuth, or the marketing phase — see `../ARCHITECTURE.md`.
