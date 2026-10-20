Copy of `server/edge/accept-quote/` in the layout the Supabase CLI expects.
Source of truth is `server/edge/accept-quote/`; keep the two identical.

Deploy (from the repo root, logged in to the CLI):
    npx supabase functions deploy accept-quote --project-ref hkzmydowyiajkbakxfkj

Secrets (dashboard → Edge Functions → Secrets, or the CLI):
    npx supabase secrets set ZOHO_CLIENT_ID=... ZOHO_CLIENT_SECRET=... ZOHO_REFRESH_TOKEN=... --project-ref hkzmydowyiajkbakxfkj
