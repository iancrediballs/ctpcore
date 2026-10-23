# Zoho → CTP Core webhooks (workflow rules) — setup, ~15 minutes in Zoho

Ian said yes to webhooks (23 Oct). They make Zoho changes show in CTP within seconds.
Without them, CTP still catches up on its own: documents every 10 min, stock every 15 min.
Zoho's workflow rules can only be created in Zoho's screens, so someone with a Zoho admin login
(Ian or Michelle) does this once.

## How it is safe without a shared secret
- Every webhook calls one endpoint, `zoho-push`, with action `"hook"`, a module name and the
  record id. **CTP trusts nothing in the call except the id.** It re-reads that record from Zoho
  with its own token and applies only what Zoho itself says.
- A forged call can do no more than make CTP refresh a real record, and each record is throttled
  to once per 10 s.
- The key used is the Supabase **public anon key**, the same one already inside the app on every
  phone. Copy it from Supabase dashboard → Project Settings → API ("anon public").

## The webhook (same for all modules; only `module` and the id placeholder change)
- **URL:** `https://hkzmydowyiajkbakxfkj.supabase.co/functions/v1/zoho-push`
- **Method:** POST, body type JSON (raw).
- **Headers:**
  - `Authorization: Bearer <anon key>`
  - `apikey: <anon key>`
  - `Content-Type: application/json`
- **Body:** `{"action":"hook","module":"<module>","id":"${<placeholder>}"}`

In Zoho Inventory: Settings → Automation → Workflow Rules → New rule for each module below.
- When: "Created or Edited".
- Action: Webhook (create the webhook under Automation → Webhooks first, then attach it).
- Use Zoho's field picker for the id placeholder; the names below are what Zoho shows.

| Module (rule) | `module` value | id placeholder |
|---|---|---|
| Items | `item` | Item ID |
| Sales Orders | `salesorder` | Sales Order ID |
| Invoices | `invoice` | Invoice ID |
| Estimates/Quotes (Books) | `estimate` | Estimate ID |
| Packages | `package` | Package ID |
| Shipments | `shipment` | Shipment ID |
| Bills | `bill` | Bill ID |
| Purchase Receives | `purchasereceive` | Purchase Receive ID |
| Inventory Adjustments | `adjustment` | Adjustment ID |

Premium allows 10 workflow rules per module; this uses 1 per module.

**Check it works:** edit any item's description in Zoho. Within seconds,
`zoho_push_log` should show no `hook` error. In Settings → Zoho the "Zoho stock read" time moves
on the next item change.
