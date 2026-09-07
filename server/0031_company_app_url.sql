-- 0031 — the app's own address, stored where it can be changed without a release.
--
-- The URL of the hosted phone app was hardcoded in two places: the desktop's
-- "Open shared settings" button and the order-notification email template. That
-- was survivable until the Vercel consolidation moved the deployment, at which
-- point both pointed at a domain serving nothing — and the desktop copy is
-- compiled into the installer, so correcting it meant shipping a new .msi to
-- every machine.
--
-- A column costs one migration and ends that permanently: a custom domain later
-- is a settings change, not a release. The desktop reads it from the company row
-- it already loads; the phone app reads it from the row it already syncs.
--
-- The edge function deliberately does NOT read this. It sends mail without a
-- user session and would need its own query per send; it keeps APP_URL as an
-- environment variable, which is already the pattern for the four other values
-- in that file. Two mechanisms, but each is the cheap one for its surface.
--
-- Falls back in code to https://ctpcore.vercel.app when null, so an unmigrated
-- or offline database still renders a working link rather than a dead one.
-- ============================================================================

alter table public.company add column if not exists app_url text;

comment on column public.company.app_url is
  'Base URL of the hosted phone app, e.g. https://ctpcore.vercel.app. Read by '
  'the desktop "Open shared settings" link. Null falls back to the compiled '
  'default. The notify edge function uses the APP_URL env var instead.';

-- Seed the current deployment. Hyphenless: ctp-core.vercel.app and
-- app-2sry.vercel.app were both retired in the account consolidation and now
-- return 404 DEPLOYMENT_NOT_FOUND. Verified on the wire, not from the dashboard.
update public.company
   set app_url    = 'https://ctpcore.vercel.app',
       rev        = rev + 1,
       updated_at = now()
 where id = 1;

-- ── set_company_profile: accept app_url ──────────────────────────────────────
--
-- NOTE, and this is a deliberate difference from the other fields. Every other
-- nullable column here is written as `payload->>'field'`, which cannot tell
-- "the caller omitted this key" from "the caller wants it cleared" — a partial
-- payload silently blanks them. For a letterhead field that is merely annoying;
-- for the URL every desktop install resolves its settings link through, a silent
-- blanking is the kind of fault that shows up as a dead link weeks later with no
-- obvious cause. `payload ? 'app_url'` distinguishes the two, so app_url is only
-- touched when the caller actually sends the key.
--
-- The same exposure exists on address / phone / email / tax_id / reg_no /
-- bank_details / terms from 0028. Not changed here — that is a separate call to
-- make deliberately rather than a side effect of this migration.
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
    app_url         = case when payload ? 'app_url'
                           then nullif(payload->>'app_url','')
                           else app_url end,
    rev             = rev + 1,
    updated_at      = now()
  where id = 1
  returning * into row_out;

  return row_out;
end $$;

grant execute on function public.set_company_profile(jsonb) to authenticated;
