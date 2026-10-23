-- CTP Core 0062 — Phase 2: quotes become Zoho ESTIMATES (23 Oct 2026). docs/07.
--
-- Built dark: nothing changes until an admin turns zoho_config.estimates_enabled
-- on (set_zoho_estimates). Until then quotes stay CTP-only exactly as today and
-- accept-quote raises the sales order directly, as it has since 20 Oct.
--
-- When it is on (and Zoho sending is live, zoho_live()):
--   * "Send quote" → zoho-push {action:"estimate"} creates a DRAFT estimate
--     (reference = CTP order no.), or updates it while it is still draft.
--     Michelle sends it from Zoho; the app sends no customer documents.
--   * The customer accepts in the app → accept-quote marks the estimate
--     accepted and raises the CONFIRMED sales order from the estimate's lines
--     (Zoho wins on price/discount), then the same accept_quote() transaction.
--   * A declined or cancelled quote → the estimate is marked declined in Zoho
--     by the status read-back.
-- Supabase keeps links only: the estimate id/number/status on the order.
begin;

alter table public.sales_order add column if not exists zoho_estimate_id text;
alter table public.sales_order add column if not exists zoho_estimate_number text;
alter table public.sales_order add column if not exists zoho_estimate_status text;
alter table public.sales_order add column if not exists zoho_estimate_status_at timestamptz;
alter table public.sales_order add column if not exists zoho_estimate_error text;
alter table public.sales_order add column if not exists zoho_estimate_modified_at timestamptz;

alter table public.zoho_config add column if not exists estimates_enabled boolean not null default false;

alter table public.zoho_push_log drop constraint if exists zoho_push_log_doc_type_check;
alter table public.zoho_push_log add constraint zoho_push_log_doc_type_check
  check (doc_type in ('invoice','bill','contact','config','test','salesorder','estimate'));

-- ── the switch (admin) ───────────────────────────────────────────────────────
create or replace function public.set_zoho_estimates(p_enabled boolean)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if coalesce((select role from app_user where id = auth.uid()), '') <> 'admin' then
    raise exception 'Only an admin can switch quotes to Zoho estimates.';
  end if;
  update zoho_config set estimates_enabled = coalesce(p_enabled, false), updated_at = now(), updated_by = auth.uid() where id = 1;
  insert into zoho_push_log (doc_type, action, ok, message, actor)
  values ('config', 'estimates', true, case when p_enabled then 'Quotes → Zoho estimates: ON' else 'Quotes → Zoho estimates: OFF' end, auth.uid());
  return coalesce(p_enabled, false);
end $$;
revoke all on function public.set_zoho_estimates(boolean) from public, anon;
grant execute on function public.set_zoho_estimates(boolean) to authenticated;

-- ── read-back / link (server only) ───────────────────────────────────────────
-- p_est: { estimate_id, estimate_number, status, last_modified_time, error? }
-- Records Zoho's estimate on the order. An estimate deleted in Zoho is FLAGGED
-- (status 'deleted', id kept) so it is never silently re-created. A status
-- change is written into the order notes once.
create or replace function public.apply_zoho_estimate(p_order_id bigint, p_est jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  o sales_order;
  st text := nullif(p_est->>'status', '');
  note text;
begin
  select * into o from sales_order where id = p_order_id for update;
  if not found then raise exception 'order % not found', p_order_id; end if;
  if o.zoho_estimate_id is not null and p_est ? 'estimate_id'
     and o.zoho_estimate_id <> (p_est->>'estimate_id') then
    raise exception 'order % is linked to Zoho estimate %, not %', o.number, o.zoho_estimate_id, p_est->>'estimate_id';
  end if;
  if st is not null and st is distinct from o.zoho_estimate_status and o.zoho_estimate_status is not null then
    note := format('[%s] Zoho estimate %s: %s → %s', to_char(now() at time zone 'Africa/Johannesburg', 'YYYY-MM-DD HH24:MI'),
                   coalesce(p_est->>'estimate_number', o.zoho_estimate_number, ''), o.zoho_estimate_status, st);
  end if;
  update sales_order set
    zoho_estimate_id         = coalesce(p_est->>'estimate_id', zoho_estimate_id),
    zoho_estimate_number     = coalesce(nullif(p_est->>'estimate_number', ''), zoho_estimate_number),
    zoho_estimate_status     = coalesce(st, zoho_estimate_status),
    zoho_estimate_status_at  = now(),
    zoho_estimate_modified_at = coalesce(nullif(p_est->>'last_modified_time', '')::timestamptz, zoho_estimate_modified_at),
    zoho_estimate_error      = case
      when st = 'deleted' then 'This estimate was DELETED in Zoho. It will not be re-created automatically — ask the accountant.'
      when p_est ? 'error' then nullif(p_est->>'error', '')
      else null end,
    notes = case when note is null then notes else concat_ws(E'\n', nullif(notes, ''), note) end
  where id = p_order_id;
  return jsonb_build_object('order_id', p_order_id, 'status', coalesce(st, o.zoho_estimate_status), 'note', note);
end $$;
revoke all on function public.apply_zoho_estimate(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.apply_zoho_estimate(bigint, jsonb) to service_role;

commit;
