-- 0028 — the settings backbone.
--
-- Everything an owner needs to change about how this business runs, without a
-- developer: the letterhead, VAT, banking details, who gets order emails, the
-- warehouses, and the discount tiers.
--
-- Writes go through SECURITY DEFINER functions rather than direct table access,
-- for the same reason the rest of this system does: the check lives in one
-- place, server-side, and cannot be skipped by a client that decides not to.

-- ── company: the fields a real tax invoice needs ──────────────────────────
alter table public.company add column if not exists reg_no          text;
alter table public.company add column if not exists bank_details    text;
alter table public.company add column if not exists default_tax_bps integer not null default 1500;
alter table public.company add column if not exists invoice_prefix  text not null default 'INV-';
alter table public.company add column if not exists quote_prefix    text not null default 'QT-';

comment on column public.company.default_tax_bps is
  'Default VAT in basis points applied to new orders. 1500 = 15%.';

-- ── order email settings ──────────────────────────────────────────────────
-- The Resend API key deliberately does NOT live here. Secrets stay in function
-- secrets; this table holds only the choices a person should be able to make.
create table if not exists public.notify_setting (
  id                 integer primary key default 1 check (id = 1),
  enabled            boolean not null default true,
  recipients         text[]  not null default '{}',
  from_name          text    not null default 'CTP Core',
  reply_to           text,
  on_request         boolean not null default true,
  on_quote_accepted  boolean not null default true,
  on_quote_declined  boolean not null default true,
  updated_at         timestamptz not null default now()
);

insert into public.notify_setting (id) values (1) on conflict (id) do nothing;

alter table public.notify_setting enable row level security;

drop policy if exists notify_setting_read  on public.notify_setting;
drop policy if exists notify_setting_write on public.notify_setting;

-- Staff may see whether notifications are on; only managers may change them.
create policy notify_setting_read on public.notify_setting
  for select to authenticated using (is_staff());
create policy notify_setting_write on public.notify_setting
  for all to authenticated using (is_manager()) with check (is_manager());

-- ── settings writers ──────────────────────────────────────────────────────

create or replace function public.set_company_profile(payload jsonb)
returns public.company
language plpgsql security definer set search_path = public
as $$
declare row_out public.company;
begin
  if not is_manager() then
    raise exception 'Only a manager or administrator can change company details';
  end if;

  update company set
    name            = coalesce(nullif(payload->>'name',''), name),
    address         = payload->>'address',
    phone           = payload->>'phone',
    email           = payload->>'email',
    tax_id          = payload->>'tax_id',
    reg_no          = payload->>'reg_no',
    bank_details    = payload->>'bank_details',
    terms           = payload->>'terms',
    currency        = coalesce(nullif(payload->>'currency',''), currency),
    invoice_prefix  = coalesce(nullif(payload->>'invoice_prefix',''), invoice_prefix),
    quote_prefix    = coalesce(nullif(payload->>'quote_prefix',''), quote_prefix),
    default_tax_bps = coalesce((payload->>'default_tax_bps')::int, default_tax_bps),
    rev             = rev + 1,
    updated_at      = now()
  where id = 1
  returning * into row_out;

  return row_out;
end $$;

create or replace function public.set_notify_setting(payload jsonb)
returns public.notify_setting
language plpgsql security definer set search_path = public
as $$
declare row_out public.notify_setting;
begin
  if not is_manager() then
    raise exception 'Only a manager or administrator can change notification settings';
  end if;

  update notify_setting set
    enabled           = coalesce((payload->>'enabled')::boolean, enabled),
    recipients        = coalesce(
                          (select array_agg(trim(v)) from jsonb_array_elements_text(
                             case when jsonb_typeof(payload->'recipients') = 'array'
                                  then payload->'recipients' else '[]'::jsonb end) v
                           where trim(v) <> ''),
                          recipients),
    from_name         = coalesce(nullif(payload->>'from_name',''), from_name),
    reply_to          = payload->>'reply_to',
    on_request        = coalesce((payload->>'on_request')::boolean, on_request),
    on_quote_accepted = coalesce((payload->>'on_quote_accepted')::boolean, on_quote_accepted),
    on_quote_declined = coalesce((payload->>'on_quote_declined')::boolean, on_quote_declined),
    updated_at        = now()
  where id = 1
  returning * into row_out;

  return row_out;
end $$;

-- ── warehouses ────────────────────────────────────────────────────────────
create or replace function public.upsert_location(
  p_id bigint, p_code text, p_name text)
returns public.location
language plpgsql security definer set search_path = public
as $$
declare row_out public.location;
begin
  if not is_manager() then
    raise exception 'Only a manager or administrator can change locations';
  end if;
  if coalesce(trim(p_code),'') = '' then
    raise exception 'A location needs a short code';
  end if;

  if p_id is null then
    insert into location (code, name)
    values (upper(trim(p_code)), coalesce(nullif(trim(p_name),''), upper(trim(p_code))))
    returning * into row_out;
  else
    update location
       set code = upper(trim(p_code)),
           name = coalesce(nullif(trim(p_name),''), name),
           rev = rev + 1, updated_at = now()
     where id = p_id
    returning * into row_out;
  end if;

  return row_out;
end $$;

-- Locations are never hard-deleted: stock movements point at them, and the
-- ledger is history. Retiring one hides it from pickers and nothing else.
create or replace function public.retire_location(p_id bigint)
returns void
language plpgsql security definer set search_path = public
as $$
declare in_use bigint;
begin
  if not is_manager() then
    raise exception 'Only a manager or administrator can retire a location';
  end if;

  select count(*) into in_use
    from stock_movement m
   where m.location_id = p_id
     and coalesce((select sum(delta) from stock_movement s
                    where s.location_id = p_id and s.part_id = m.part_id), 0) <> 0;

  if in_use > 0 then
    raise exception 'That location still holds stock. Move it out first.';
  end if;

  update location set deleted_at = now(), rev = rev + 1, updated_at = now()
   where id = p_id;
end $$;

-- ── price tiers ───────────────────────────────────────────────────────────
create or replace function public.upsert_price_tier(
  p_id bigint, p_code text, p_name text,
  p_discount_bps integer, p_min_margin_bps integer)
returns public.price_tier
language plpgsql security definer set search_path = public
as $$
declare row_out public.price_tier;
begin
  if not is_manager() then
    raise exception 'Only a manager or administrator can change pricing tiers';
  end if;
  if p_discount_bps is null or p_discount_bps < 0 or p_discount_bps > 10000 then
    raise exception 'Discount must be between 0%% and 100%%';
  end if;
  if p_min_margin_bps is not null and (p_min_margin_bps < 0 or p_min_margin_bps > 10000) then
    raise exception 'Minimum margin must be between 0%% and 100%%';
  end if;

  if p_id is null then
    insert into price_tier (code, name, discount_bps, min_margin_bps)
    values (lower(trim(p_code)), coalesce(nullif(trim(p_name),''), p_code),
            p_discount_bps, p_min_margin_bps)
    returning * into row_out;
  else
    update price_tier
       set code = lower(trim(p_code)),
           name = coalesce(nullif(trim(p_name),''), name),
           discount_bps = p_discount_bps,
           min_margin_bps = p_min_margin_bps,
           rev = rev + 1, updated_at = now()
     where id = p_id
    returning * into row_out;
  end if;

  return row_out;
end $$;

revoke all on function public.set_company_profile(jsonb)   from public, anon;
revoke all on function public.set_notify_setting(jsonb)    from public, anon;
revoke all on function public.upsert_location(bigint,text,text) from public, anon;
revoke all on function public.retire_location(bigint)      from public, anon;
revoke all on function public.upsert_price_tier(bigint,text,text,integer,integer) from public, anon;

grant execute on function public.set_company_profile(jsonb)   to authenticated;
grant execute on function public.set_notify_setting(jsonb)    to authenticated;
grant execute on function public.upsert_location(bigint,text,text) to authenticated;
grant execute on function public.retire_location(bigint)      to authenticated;
grant execute on function public.upsert_price_tier(bigint,text,text,integer,integer) to authenticated;
