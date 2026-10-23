# CTP Core — system map (current, 23 Oct 2026)

The facts for the dev system diagram. Replaces the version given in chat on 23 Oct morning.

## Masters — who owns what
| Data | Master | CTP Core holds |
|---|---|---|
| **Items / parts** (part no. = Zoho SKU, name, selling rate, purchase rate, main image) | **Zoho Inventory** | `part` as a working copy plus what Zoho can't hold: diagrams, hotspots, sections, photo library, cross-references, fitment. **New parts are added in Zoho**; "Pull & apply" (Settings → Zoho) creates them in CTP under "New from Zoho" (0066) and brings name/price changes across. Codes never change. Multicat is no longer used. |
| **Stock** | CTP ledger today (rehearsal switch `stock_master = ctp`); **Zoho Inventory** after cut-over (`zoho`) | Zoho stock cache on each part (physical on hand, available for sale), refreshed every 15 min, by webhooks and after each ship/count/receive. In `zoho` mode: Fulfil = Zoho package + shipment, counts = Zoho adjustments, receiving = Zoho purchase receives. |
| **Prices** | CTP list today; Zoho rate is copied on Pull & apply | Once a document exists, Zoho wins on price/qty/discount: estimates (0063), sales orders and invoices (0059/0061). Zoho price books are planned (Phase 5). |
| **Customers / companies / people** | Zoho contacts and contact persons | Logins, roles, login→company/person map, account/cash flag. |
| **Quotes** | **Zoho estimates** (QT-…), switch on since 23 Oct | Link, status, and lines read back from Zoho (locked in CTP). |
| **Sales orders, invoices, payments, credit notes, bills, POs** | Zoho Books / Inventory | Links and read-back status only. |

## Hosting
- **Vercel:** project `ctp-core` → https://ctpcore.vercel.app (PWA; manual CLI deploys from the repo root; git auto-deploy off).
- **Supabase:** project `ctp-core`, ref `hkzmydowyiajkbakxfkj`, region eu-central-1 (Frankfurt), Postgres 17.
  - **Edge functions:**
    - `accept-quote`: accept → linked SO from the estimate;
    - `zoho-push`: estimates, read-back, stock cache, ship/adjust/receive, hook;
    - `zoho-hook`: public webhook endpoint, no key, refetch-only;
    - `zoho-auth`: grant exchange, probes, test helpers;
    - `zoho-sync`: item/customer pull; new parts;
    - `zoho-company`, `admin-users`, `notify` (Resend), `rocky-chat`.
  - **Scheduler:** pg_cron `zoho-readback` every 10 min → zoho-push `status` (documents + 15-min stock cache).
  - **Storage:** bucket `ctp-assets` (public: photos, diagrams, section images).
  - **Vault:** Zoho refresh + access token, sync token, anon key.
- **PowerSync Cloud:** offline sync to phones/browsers (staff `SELECT *`; customers an explicit column list).
- **Zoho:** org 939422621 (.com).
  - Books: 5,000 calls/day; no webhooks on this plan.
  - Inventory Premium: 7,500 calls/day, 1 location "Head Office".
  - One grant with 24 scopes (Books + Inventory).
- **Resend:** staff emails via `notify`, from onboarding@resend.dev until a CTP domain is verified.
- **GitHub:** iancrediballs/ctpcore, main.
- **Tauri desktop:** local SQLite only (no cloud sales sync); Sales locked to "Quotes are Zoho estimates" (source; ships with the next desktop build).

## Supabase-only (cannot live in Zoho)
- Logins, roles, RLS, the login→company/person map.
- Diagrams, hotspots, sections, the photo library, cross-references, fitment.
- App, notification and prefix settings; account/cash flags; audit trails (push log, overrides).
- The CTP stock ledger, until cut-over freezes it.
- The offline cache on each device.
