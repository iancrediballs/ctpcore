-- ============================================================================
--  CTP Core — COMPANY app_url (migration 0016)
--
--  The desktop's "Open shared settings" button opens the hosted phone app. That
--  URL was a string literal in App.tsx, which meant it was COMPILED INTO THE
--  INSTALLER: when the Vercel account consolidation retired the old domain, the
--  only way to correct the link on a machine that already had CTP Core was to
--  build and ship a new .msi.
--
--  Storing it on the company row the app already loads makes a future domain
--  change a settings edit instead of a release. The cloud gets the same column
--  in its own migration 0031, so the two databases hold the same fact.
--
--  Nullable on purpose. The app falls back to https://ctpcore.vercel.app when
--  it is null, so a database that has not run this migration — or a machine
--  that has never synced — still renders a working link rather than a dead one.
--
--  No view touches `company`, so nothing needs redefining here. (part_detail
--  and the rest join part/price/stock only — checked, not assumed.)
-- ============================================================================

ALTER TABLE company ADD COLUMN app_url TEXT;

-- The deployment as it actually stands. Hyphenless: both ctp-core.vercel.app
-- and app-2sry.vercel.app return 404 DEPLOYMENT_NOT_FOUND after the account
-- consolidation. Verified by fetching them, not from the Vercel dashboard.
UPDATE company
   SET app_url    = 'https://ctpcore.vercel.app',
       rev        = rev + 1,
       updated_at = datetime('now')
 WHERE id = 1;
