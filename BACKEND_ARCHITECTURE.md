# CTP Core — Backend Spine Blueprint

*The keystone that turns the local desktop ERP into a multi-surface platform: public website + client ordering + internal management, all on one source of truth with strict, role-based access.*

Status: proposal for review (2026-06-30). Nothing here is built yet — this is the plan to approve before code.

---

## 1. The shape of it

One backend, one source of truth, several **surfaces** reading from it:

```
                       ┌─────────────────────────┐
                       │   Postgres (the truth)   │
                       │  + Row-Level Security    │
                       └───────────▲─────────────┘
                                   │  authenticated, role-scoped API
            ┌──────────────────────┼──────────────────────┐
            │                      │                       │
   ┌────────┴────────┐   ┌─────────┴─────────┐   ┌─────────┴──────────┐
   │  PUBLIC WEBSITE │   │ INTERNAL DESKTOP  │   │  SYNC ENGINE       │
   │ (browser)       │   │ (Tauri, staff)    │   │ Postgres ⇄ SQLite  │
   │ marketing, 3D,  │   │ inventory, sales, │   │ offline-first      │
   │ catalogue,      │   │ accounting,       │   └────────────────────┘
   │ client orders,  │   │ diagram editor    │
   │ lead capture    │   │ (local SQLite)    │
   └─────────────────┘   └───────────────────┘
```

Key idea: the **3D truck module, catalogue, and the part panel are shared components** rendered differently per surface and per role. The same part panel shows a customer-facing "Request a quote" CTA on the website and a supplier/internal lookup on the staff app. We are NOT building one binary that is both a website and a desktop app — that's impossible. We build one codebase + one backend with two front-end delivery targets.

---

## 2. Stack — two honest options

**Option A — Managed (RECOMMENDED for a solo founder).**
- **Supabase** = hosted Postgres + Auth + Row-Level Security + storage + auto REST/realtime, in one platform. Collapses half this blueprint into config.
- **PowerSync** for offline sync: it is purpose-built for exactly your stack — Postgres on the server ⇄ SQLite on the desktop — with auth-rule-based partial replication. You do NOT hand-roll sync.
- **Next.js on Vercel** for the public website (great for marketing + SEO + the 3D module), talking to Supabase.
- **PayFast** for payments, **QuickBooks/Xero** for accounting (already decided).
- Why: lowest ops burden, security defaults you'd otherwise have to build (hashing, RLS, JWT, 2FA), fastest path to live. You stay a builder, not a sysadmin.

**Option B — Self-hosted (more control, more work).**
- Postgres you run + a **Rust (Axum) API** (one language with your Tauri core, shareable types/logic) + your own auth (argon2, JWT, 2FA) + a sync layer (PowerSync still recommended, or ElectricSQL).
- Why: full control, no per-seat SaaS cost at scale, data stays wherever you put it. Cost = you own uptime, backups, patching, and the security surface.

**My recommendation:** start on **Option A**. It is reversible — Supabase *is* standard Postgres, so if you outgrow it you lift-and-shift to Option B later. Decide hosting **region with POPIA in mind** (keep SA customer PII in an acceptable region; Supabase lets you pick).

---

## 3. Identity & access (the security core)

**Authority lives on the server. The client is never trusted** — the browser/desktop only ever receives what the API/RLS allows for that user's role.

Roles (start simple, expand later):

| role        | sees / can do                                                        |
|-------------|----------------------------------------------------------------------|
| `anonymous` | public catalogue, 3D, marketing; submit a lead/quote request         |
| `customer`  | own orders, own quotes, own account; place/track orders              |
| `sales`     | all customers, orders, quotes; pricing within guardrails             |
| `warehouse` | inventory, stock movements, fulfilment                               |
| `manager`   | + accounting export, pricing, reports                                 |
| `admin`     | + user management, company settings, role assignment                 |

Enforcement, defence-in-depth:
1. **API authorization** — every endpoint checks the caller's role/claims.
2. **Postgres Row-Level Security** — a second wall: even a leaked token can only read rows its role + ownership allow (e.g. a customer can `SELECT` only their own orders).
3. **Auth** — argon2 password hashing, short-lived JWT + refresh, **2FA mandatory for staff roles**. Managed by Supabase Auth in Option A.
4. **Public site ships zero internal code** and has no direct DB credentials.
5. **Secrets** (DB, PayFast keys, QBO/Xero tokens) live server-side only — never in the desktop binary or browser bundle.
6. **Desktop local cache encrypted at rest (SQLCipher)** + scoped to the staff member's role, so a lost laptop is not a breach.

---

## 4. Offline-first sync (don't lose what already works)

Your desktop app's append-only stock ledger + local SQLite is the right foundation — keep it. The spine adds the server half:

- **Postgres is canonical.** Each syncable row already carries `id / rev / updated_at / deleted_at / origin` (your existing convention) — perfect for sync.
- **PowerSync** replicates a role-scoped slice of Postgres down to each desktop's SQLite and pushes local writes back up. Staff keep working offline; changes reconcile on reconnect.
- The **append-only ledger makes conflict handling trivial** — movements are immutable facts, on-hand is derived; two devices can both append and the totals just add up. (This is exactly why we chose that model.)
- Web surface reads Postgres directly via the API (browsers are online anyway).

---

## 5. New data the spine introduces

**Leads (`lead`)** — the "Check price / Request a quote" capture, public surface.
- Fields: name, company, email, phone, part(s) of interest, message, source, created_at.
- **POPIA consent is first-class:** `marketing_consent` (bool), `consent_text` (the exact wording shown), `consent_at`, `consent_ip`; opt-out flow. Store the lead in your own DB (you own it); optional later push to a CRM/mailer.

**Payments (`payment`) — PayFast flow** for website orders:
1. Customer checks out → API creates a `payment` row (pending) + signs a PayFast request.
2. Customer pays on PayFast (hosted — you never touch card data).
3. PayFast calls your **server ITN webhook** → verify signature + amount server-side → mark order paid, write the ledger/accounting hooks.
4. Settlement lands in your bank account; reconciliation flows to QuickBooks/Xero.
- All PayFast keys live server-side. The desktop app never handles payments.

**Accounting bridge** — unchanged plan: invoiced orders export to QuickBooks/Xero (you already build the IIF/CSV). Later: live OAuth push from the server instead of manual download.

---

## 6. Security checklist (gate before go-live)

- [ ] All authz enforced server-side; client treated as hostile.
- [ ] Postgres RLS policies on every customer/PII table, tested with a non-privileged token.
- [ ] argon2 hashing; JWT short TTL + refresh; 2FA enforced for staff.
- [ ] Secrets in a server-side vault/env, never in repo, binary, or browser.
- [ ] Desktop SQLite encrypted (SQLCipher); cache scoped to role.
- [ ] PayFast ITN verified by signature + amount + source IP, server-side only.
- [ ] POPIA: consent captured + timestamped; data-subject access/erase path; SA-appropriate hosting region.
- [ ] Backups + point-in-time restore on Postgres; tested restore.
- [ ] Rate-limiting + audit log on auth and pricing endpoints.

---

## 7. Phased build order (ruthless on sequence)

- **Phase B0 — foundation:** stand up Postgres (Supabase), define roles + RLS, migrate the existing schema (parts/inventory/sales/accounting/diagrams) to the server, wire PowerSync to the desktop app. *Exit test: a part edited on the desktop appears in Postgres and vice-versa, scoped by role.*
- **Phase B1 — auth into the desktop app:** login screen, role-scoped UI, encrypted local cache. *Exit test: a `warehouse` user cannot see accounting.*
- **Phase B2 — public web surface:** marketing + 3D + catalogue (read-only from API) + lead capture (POPIA). *Exit test: a lead with consent lands in `lead`.*
- **Phase B3 — client ordering:** customer login, place/track orders, customer-scoped RLS.
- **Phase B4 — payments + live accounting:** PayFast checkout + ITN; QuickBooks/Xero OAuth push.

**Phase B0 is the next concrete piece of work.** Everything else is sequenced behind it.

---

## 8. What changes in today's desktop app

Minimal at first — the spine is additive:
- Point the app at PowerSync-backed SQLite instead of a standalone file (same SQLite API).
- Add a login gate + role context; existing views read the role to show/hide modules.
- The part panel gains a surface/role branch (internal lookup vs public CTA) — this is where the "Check price → lead capture" reroute lives, on the *public* surface.
- No rewrite of the ledger, sales, accounting, or diagram logic — they move under auth + sync as-is.

---

## 9. DECISION (2026-06-30) — Managed stack chosen

**Locked:** Supabase (Postgres + Auth + RLS, **EU region**) + PowerSync (offline sync) + PayFast (payments) + Next.js/Vercel (public site) + QuickBooks/Xero (accounting).

**POPIA posture:** customer data hosted offshore (EU) is lawful under Section 72 via (a) Supabase's **DPA** (binding agreement, GDPR ≈ substantially-similar protection) + (b) **explicit consent** in the privacy notice / lead form. Bake consent capture into the `lead` table from day one. Revisit a Cape Town (af-south-1) self-host migration before holding large PII volumes / payments at scale — it's a `pg_dump`/restore, not a rewrite.

### Phase B0 — concrete steps

**You (Ian) — account setup (unblocks live wiring):**
1. Create a **Supabase** project, **region = EU** (e.g. eu-west). Note the project URL + anon/service keys (keys stay server-side).
2. Accept/download Supabase's **DPA** (for the POPIA file).
3. Create a **PowerSync** account (free tier) and connect it to the Supabase Postgres.

**Me — generate (can start now, before accounts exist):**
1. Port the SQLite schema (migrations 0001–0009) → **Postgres** (`server/schema.postgres.sql`): types, FTS → Postgres full-text/`pg_trgm`, syncable columns intact.
2. **Roles + RLS policies** (`server/rls.sql`): anonymous/customer/sales/warehouse/manager/admin; customer rows owner-scoped.
3. **PowerSync sync rules** (`server/sync-rules.yaml`): role-scoped partial replication to each desktop's SQLite.
4. **Data migration script**: live SQLite (`fleetview.db`) → Supabase Postgres (one-time seed).
5. Desktop app changes: login gate + role context; point SQLite at PowerSync.

**Exit test for B0:** a part edited on the desktop app appears in Supabase Postgres and syncs back to a second device — scoped by role (a `warehouse` login can't read accounting).
