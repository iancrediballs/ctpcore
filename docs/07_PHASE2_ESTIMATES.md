# Phase 2 — quotes become Zoho Estimates (design, 21 Oct 2026)

Needs the new grant code (`ZohoBooks.estimates.ALL`). Builds on Phase 1
(companies/people) and the 21 Oct decisions (SO confirmed; invoices/bills
draft; Zoho numbering; Michelle sends customer documents from Zoho).

## Flow

| CTP Core step (unchanged on screen) | Zoho call | Notes |
|---|---|---|
| Staff "Send quote" (priced) | `POST /estimates` (draft), reference = CTP order no., lines by SKU via `zoho_item`, Standard Rate 15%, rebate as line discount, customer = company's Zoho contact, contact person = the requester if linked | Draft: Michelle sends it from Zoho (decision 3). The customer still sees the quote in the app at once. |
| Staff re-prices / customer drops a line (0051) | `PUT /estimates/{id}` while the estimate is draft | If Michelle already sent it, a change creates a revision note instead and is shown to staff. |
| Customer "Accept quote" | `POST /estimates/{id}/status/accepted`, then convert: `POST /salesorders` with the estimate's lines + `estimate_id` link, then `status/open` (confirmed, reserves stock) | Same both-or-neither as today; compensation = delete/void the new SO, estimate back to sent/draft. |
| Customer "Decline" | `POST /estimates/{id}/status/declined` | — |
| Fulfil / invoice | unchanged (invoice converted from the SO, draft) | — |

## Data (Supabase keeps links only)

- `sales_order.zoho_estimate_id`, `zoho_estimate_number`, `zoho_estimate_status`, `zoho_estimate_error` (migration 0062; 0058–0061 are taken).
- Status read-back gains a third kind (estimates): draft → sent → accepted/declined/expired/invoiced.

## Guardrails

- Only from go-live on (`zoho_live()`); before that quotes stay CTP-only, as today.
- Idempotent: find by reference before create; id stored on the order.
- An estimate Michelle deleted in Zoho is flagged, never silently re-created.
- No customer emails from the app; Zoho's "send" is Michelle's.

## Tests

- PGlite: 0062 columns + accept path with/without estimate.
- Live (admin `zoho-auth` test like `so_test`): create TEST estimate → accept →
  convert to SO → confirm → delete both; read statuses back.

## Effort

~2 days after the code: 0.5 migration + read-back, 1 push/accept/convert, 0.5 tests + deploy.

## Status (23 Oct 2026)

Built dark and live with the switch OFF (0062, zoho-push, accept-quote, zoho-auth
`est_test`) — see HANDOFF 23 Oct. Live-test facts that change the design above:
- Zoho numbers estimates `QT-000001…` (Books calls them quotes).
- An estimate cannot go draft → accepted (code 4043); it must be **sent** first.
  On customer accept the app marks it sent (no email) then accepted.
- `POST /salesorders` takes `estimate_id` and Zoho links the SO to the estimate;
  the estimate stays `accepted` (not `invoiced`) after the SO.
