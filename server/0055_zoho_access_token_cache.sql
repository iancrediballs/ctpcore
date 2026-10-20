-- ============================================================================
--  CTP Core — Zoho access-token cache in Vault (0055)
--
--  Zoho allows roughly 10 new access tokens per refresh token per 10 minutes.
--  Every Edge Function invocation used to mint one, so a busy desk (or a test)
--  hit "Access Denied". The access token (valid 1 h) is now kept in Vault as
--  'zoho_access_token' = "<epoch ms expiry>|<token>", shared by every function
--  and every cold start; it is refreshed only when < 5 minutes remain.
--  Service role only, like the refresh token (0048).
-- ============================================================================
begin;
create or replace function public.zoho_secret_put(p_name text, p_value text)
returns void language plpgsql security definer set search_path = public, vault, pg_temp as $$
declare v_id uuid;
begin
  if p_name not in ('zoho_refresh_token', 'zoho_access_token') then raise exception 'unknown secret %', p_name; end if;
  select id into v_id from vault.secrets where name = p_name;
  if v_id is null then perform vault.create_secret(p_value, p_name,
      case p_name when 'zoho_refresh_token' then 'Zoho Books OAuth refresh token (CTP Core)'
                  else 'Zoho Books access token cache, expiry|token (CTP Core)' end);
  else perform vault.update_secret(v_id, p_value); end if;
end $$;
create or replace function public.zoho_secret_get(p_name text)
returns text language sql security definer set search_path = public, vault, pg_temp as $$
  select decrypted_secret from vault.decrypted_secrets
   where name = p_name and p_name in ('zoho_refresh_token', 'zoho_access_token')
$$;
revoke all on function public.zoho_secret_put(text, text) from public, anon, authenticated;
revoke all on function public.zoho_secret_get(text) from public, anon, authenticated;
grant execute on function public.zoho_secret_put(text, text) to service_role;
grant execute on function public.zoho_secret_get(text) to service_role;
commit;
