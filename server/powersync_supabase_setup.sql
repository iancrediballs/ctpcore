-- PowerSync <-> Supabase wiring. Run in the Supabase SQL editor (as postgres).
-- Per PowerSync's official Supabase integration guide.

-- 1) Dedicated least-privilege replication role for PowerSync.
--    >>> REPLACE the password below with a STRONG one and SAVE it (password
--        manager). You'll paste the SAME password into PowerSync's connection
--        form (Username = powersync_role). <<<
CREATE ROLE powersync_role WITH REPLICATION BYPASSRLS LOGIN PASSWORD 'CHANGE_ME_STRONG_PASSWORD';

-- read-only access is all PowerSync needs
GRANT SELECT ON ALL TABLES IN SCHEMA public TO powersync_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO powersync_role;

-- 2) Publication PowerSync replicates from — MUST be named exactly "powersync".
CREATE PUBLICATION powersync FOR ALL TABLES;
