-- CTP Core 0060 — the Zoho read-back on a schedule (22 Oct 2026).
--
-- Every 10 minutes pg_cron asks zoho-push for { action: "status" }: Zoho's status
-- for every open invoice / sales order / bill, Michelle's sales-order edits
-- (0059 apply_zoho_salesorder) and, at most every 6 hours, account terms.
-- zoho-push throttles itself to once per 2 minutes, so the desk opening at the
-- same moment costs nothing extra. One GET per open document: well inside
-- Zoho's 5,000/day.
--
-- Secrets (set 22 Oct, not in this file): Vault `zoho_sync_token` (also the
-- edge secret ZOHO_SYNC_TOKEN) and `ctp_anon_key` (the gateway needs a JWT).
-- Requires pg_cron + pg_net. Remove with: select cron.unschedule('zoho-readback');
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'zoho-readback';
select cron.schedule('zoho-readback', '*/10 * * * *', $job$
  select net.http_post(
    url := 'https://hkzmydowyiajkbakxfkj.supabase.co/functions/v1/zoho-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'ctp_anon_key'),
      'x-sync-token', (select decrypted_secret from vault.decrypted_secrets where name = 'zoho_sync_token')),
    body := '{"action":"status"}'::jsonb,
    timeout_milliseconds := 60000);
$job$);
