# chinatruckparts.co.za: public website

Static site, zero dependencies. `node build.mjs` writes `dist/`.

- Catalogue: fetched at build time from the `public-catalogue` edge function
  (whitelisted fields only: no cost, prices, stock quantities or POs).
- Join our list: posts to the `contact-signup` edge function, which writes
  `public.contact` (migration `server/0100_public_contacts.sql`). No logins.
- Business details: `business.json` (phone, WhatsApp and hours render only when set).

Local preview with a saved catalogue:

    CATALOGUE_FILE=catalogue.json node build.mjs && python3 -m http.server -d dist 4173

## Deploy (Vercel)

New project on the Pro team, same GitHub repo, **Root Directory = `site`**.
`vercel.json` sets build command, output directory and headers. Redeploy (or a
Vercel deploy hook on a schedule) refreshes the catalogue and stock flags.

## Go-live order

1. Apply `server/0100_public_contacts.sql`, deploy `public-catalogue` and `contact-signup`.
2. Deploy this project, check the preview URL.
3. Add `chinatruckparts.co.za` and `www` in Vercel, then at GoDaddy: turn off
   forwarding, set the A and CNAME values Vercel shows. Leave MX/TXT (Microsoft 365 email) alone.
4. Move CTP Core to `app.chinatruckparts.co.za` (CNAME), add it to Supabase
   auth redirect URLs, then update `app_url` in `business.json`.
