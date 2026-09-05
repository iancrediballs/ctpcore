-- 0029 — let a manager prove email works, from inside the app.
--
-- Until now the only way to know whether order emails were reaching anyone was
-- to wait for a real order and hope. The notify function fails SAFE by design
-- (a missing API key logs a warning and returns 200, so a mail problem can
-- never block an order being saved) — which is right, but it also means a
-- broken mail setup is completely silent.
--
-- This reuses the exact plumbing migration 0023 built: pg_net, the vault token,
-- same endpoint. It adds no new trust path.

create or replace function public.send_test_notification()
returns text
language plpgsql security definer set search_path = public, extensions
as $$
declare
  tok  text;
  who  text;
begin
  if not is_manager() then
    raise exception 'Only a manager or administrator can send a test email';
  end if;

  select decrypted_secret into tok
    from vault.decrypted_secrets where name = 'notify_token';

  if tok is null then
    raise exception 'Notifications are not configured yet (no shared secret). '
                    'Ask whoever set the system up to run the 0023 vault step.';
  end if;

  select coalesce(u.email, 'a manager') into who
    from auth.users u where u.id = auth.uid();

  perform net.http_post(
    url     := 'https://hkzmydowyiajkbakxfkj.supabase.co/functions/v1/notify',
    headers := jsonb_build_object(
                 'Content-Type',    'application/json',
                 'x-notify-token',  tok),
    body    := jsonb_build_object(
                 'kind',     'test',
                 'number',   'TEST',
                 'customer', who)
  );

  -- pg_net sends after COMMIT, so this cannot report delivery — only that the
  -- request was queued. Delivery itself is visible in net._http_response.
  return 'Test email queued. If nothing arrives within a minute or two, the '
      || 'mail key or recipient list needs attention.';
end $$;

revoke all on function public.send_test_notification() from public, anon;
grant execute on function public.send_test_notification() to authenticated;
