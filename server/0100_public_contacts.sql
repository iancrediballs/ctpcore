-- 0100: contacts captured by the public website (chinatruckparts.co.za).
--
-- "Contacts first" (Ian, 27 Nov 2026): walk-in visitors leave their details and
-- opt in to email / WhatsApp. They get NO login and NO role. The only writer is
-- the edge function `contact-signup` (service role); the browser never touches
-- these tables.
--
-- POPIA:
--   * s69 direct marketing needs opt-in consent per channel: consent_email and
--     consent_whatsapp are separate and default false.
--   * Proof of consent: contact_consent_log keeps every opt-in / opt-out with
--     the exact wording version and time. It is append-only.
--   * Opt-out: unsubscribe_token is used by the one-click link in every message.
--   * Minimality: only what the form asks for. ip_hash is a salted SHA-256 used
--     for rate limiting, never the raw address.
--
-- Who can read: sales, manager, admin. Who can change: manager, admin (to
-- record an opt-out received by phone, or to delete on request). Customers,
-- customer reps and warehouse see nothing.

begin;

create table if not exists public.contact (
  id                    bigint generated always as identity primary key,
  name                  text not null check (char_length(name) between 2 and 120),
  email                 text check (email is null or email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  phone                 text check (phone is null or phone ~ '^\+?[0-9 ()-]{9,20}$'),
  company               text check (company is null or char_length(company) <= 120),
  models                text[] not null default '{}',
  interest              text check (interest is null or char_length(interest) <= 1000),
  heard_from            text check (heard_from is null or char_length(heard_from) <= 120),
  source                text not null default 'website',
  consent_email         boolean not null default false,
  consent_whatsapp      boolean not null default false,
  consent_text_version  text not null,
  consent_at            timestamptz,
  privacy_ack_at        timestamptz not null,
  opted_out_at          timestamptz,
  unsubscribe_token     uuid not null default gen_random_uuid() unique,
  ip_hash               text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint contact_reachable check (email is not null or phone is not null),
  constraint contact_whatsapp_needs_phone check (not consent_whatsapp or phone is not null),
  constraint contact_email_needs_email check (not consent_email or email is not null)
);

create unique index if not exists contact_email_uq on public.contact (lower(email)) where email is not null;
create index if not exists contact_created_idx on public.contact (created_at desc);
create index if not exists contact_ip_recent_idx on public.contact (ip_hash, created_at desc);

create table if not exists public.contact_consent_log (
  id                    bigint generated always as identity primary key,
  contact_id            bigint not null references public.contact(id) on delete cascade,
  action                text not null check (action in ('opt_in', 'opt_out', 'signup_no_marketing')),
  email                 boolean not null,
  whatsapp              boolean not null,
  consent_text_version  text not null,
  via                   text not null check (via in ('website', 'unsubscribe_link', 'staff')),
  ip_hash               text,
  at                    timestamptz not null default now()
);
create index if not exists contact_consent_log_contact_idx on public.contact_consent_log (contact_id, at desc);

create or replace function public.contact_touch() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists contact_touch on public.contact;
create trigger contact_touch before update on public.contact
  for each row execute function public.contact_touch();

-- RLS: deny by default, then open exactly what staff need.
alter table public.contact enable row level security;
alter table public.contact_consent_log enable row level security;

revoke all on public.contact from anon, authenticated;
revoke all on public.contact_consent_log from anon, authenticated;
grant select, update, delete on public.contact to authenticated;
grant select on public.contact_consent_log to authenticated;

drop policy if exists contact_staff_read on public.contact;
create policy contact_staff_read on public.contact for select to authenticated
  using (public.auth_role() in ('sales', 'manager', 'admin'));

drop policy if exists contact_manager_update on public.contact;
create policy contact_manager_update on public.contact for update to authenticated
  using (public.auth_role() in ('manager', 'admin'))
  with check (public.auth_role() in ('manager', 'admin'));

drop policy if exists contact_manager_delete on public.contact;
create policy contact_manager_delete on public.contact for delete to authenticated
  using (public.auth_role() in ('manager', 'admin'));

drop policy if exists contact_consent_log_staff_read on public.contact_consent_log;
create policy contact_consent_log_staff_read on public.contact_consent_log for select to authenticated
  using (public.auth_role() in ('sales', 'manager', 'admin'));

commit;
