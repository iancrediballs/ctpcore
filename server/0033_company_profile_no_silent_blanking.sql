-- 0033 — stop set_company_profile silently blanking seven fields.
--
-- THE BUG
-- Every nullable field in this function is written as `payload->>'field'`.
-- That expression cannot tell "the caller omitted this key" from "the caller
-- wants this cleared" — both arrive as SQL NULL. So any caller that sends a
-- PARTIAL payload silently erases every field it did not mention:
--
--     address, phone, email, tax_id, reg_no, bank_details, terms
--
-- Today's only caller (SettingsView) happens to send the whole row, so nothing
-- has been lost yet. That is luck, not design: the next caller — a mobile
-- screen, a script, a "just update the phone number" helper — inherits a
-- function that quietly deletes six other fields as a side effect.
--
-- WHY THIS IS WORSE THAN IT SOUNDS
-- Two of these fields are what a customer pays against. `tax_id` is the VAT
-- number and `bank_details` is the account money is transferred into, and both
-- are printed on invoices. A blanked VAT number produces an invoice that breaks
-- the customer's own VAT claim; blanked banking details produce an invoice
-- nobody can pay. Neither failure announces itself at the moment it happens —
-- it surfaces later, on a document already sent to someone else.
--
-- THE FIX
-- `payload ? 'key'` tests for the KEY's presence rather than the value's, which
-- is the distinction the old expression could not make:
--
--     key absent   -> leave the stored value alone
--     key present  -> write it ('' normalises to NULL, so a cleared form field
--                     still clears the column deliberately)
--
-- This is the same treatment 0031 gave app_url, now applied to the rest. 0031's
-- own comment flagged these seven as carrying the identical exposure and said
-- it should be a deliberate decision rather than a ride-along. This is that
-- decision.
--
-- UNCHANGED, deliberately: name, currency, invoice_prefix, quote_prefix and
-- default_tax_bps keep `coalesce(nullif(...), existing)`. Those are NOT NULL or
-- defaulted columns where blank is not a legal state, so "ignore an empty
-- value" is already the correct rule for them and there is nothing to fix.
--
-- One behavioural change worth stating: where the old code would store an empty
-- string, this stores NULL. That is a normalisation, not a loss — every reader
-- already treats null and empty the same — and it means "no VAT number" has one
-- representation rather than two.
--
-- Idempotent: create or replace, plus a re-grant.
-- ============================================================================

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
    -- NOT NULL / defaulted: an empty value means "no change", never "blank it".
    name            = coalesce(nullif(payload->>'name',''), name),
    currency        = coalesce(nullif(payload->>'currency',''), currency),
    invoice_prefix  = coalesce(nullif(payload->>'invoice_prefix',''), invoice_prefix),
    quote_prefix    = coalesce(nullif(payload->>'quote_prefix',''), quote_prefix),
    default_tax_bps = coalesce((payload->>'default_tax_bps')::int, default_tax_bps),

    -- Nullable: only touched when the caller actually sends the key.
    address         = case when payload ? 'address'
                           then nullif(payload->>'address','')      else address      end,
    phone           = case when payload ? 'phone'
                           then nullif(payload->>'phone','')        else phone        end,
    email           = case when payload ? 'email'
                           then nullif(payload->>'email','')        else email        end,
    tax_id          = case when payload ? 'tax_id'
                           then nullif(payload->>'tax_id','')       else tax_id       end,
    reg_no          = case when payload ? 'reg_no'
                           then nullif(payload->>'reg_no','')       else reg_no       end,
    bank_details    = case when payload ? 'bank_details'
                           then nullif(payload->>'bank_details','') else bank_details end,
    terms           = case when payload ? 'terms'
                           then nullif(payload->>'terms','')        else terms        end,
    app_url         = case when payload ? 'app_url'
                           then nullif(payload->>'app_url','')      else app_url      end,

    rev             = rev + 1,
    updated_at      = now()
  where id = 1
  returning * into row_out;

  return row_out;
end $$;

grant execute on function public.set_company_profile(jsonb) to authenticated;
