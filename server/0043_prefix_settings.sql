-- 0043_prefix_settings.sql — the two prefix settings mean what they say.
--
-- WHAT WAS WRONG (Ian, 2026-09-14)
--   Settings → Company showed "Quote prefix" and "Invoice prefix". Neither
--   drove anything on the web: customer requests are numbered RQ-YYMMDD-id by
--   request_parts regardless, and no web path issued an invoice at all. A
--   control that does nothing gets changed, nothing happens, and the screen
--   stops being trusted.
--
-- WHAT IS TRUE NOW
--   * invoice_prefix drives every tax invoice number the app issues (0042:
--     prefix || YYMMDD || count). Ian's is '' — the bare number his issued
--     invoices already carry — and it must be POSSIBLE to set it to ''. The
--     0033 save function treated a blank as "keep the old value", so a prefix
--     once set could never be cleared from the screen. Fixed here: a key
--     present with an empty string clears it; a key absent keeps it.
--   * quote_prefix drives the numbers of quotes STAFF raise — the desktop
--     today ({quote_prefix}{device}-{1000+id}), the phone once walk-in quotes
--     exist. Customer requests stay RQ-: a request is not a quote until it is
--     priced, and the notify trigger (0023) recognises a request by that
--     prefix. Renaming requests to the quote prefix would have made every
--     desktop-minted quote send a "new request" email. The Settings screen now
--     says exactly this next to each field.
--   Existing numbers are untouched. This governs new documents only.

BEGIN;

CREATE OR REPLACE FUNCTION public.set_company_profile(payload jsonb)
 RETURNS company
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare row_out public.company;
begin
  if not is_manager() then
    raise exception 'Only a manager or administrator can change company details';
  end if;

  update company set
    name            = coalesce(nullif(payload->>'name',''), name),
    currency        = coalesce(nullif(payload->>'currency',''), currency),
    -- An empty invoice prefix is a real choice (bare numbers), so "key present"
    -- is the test, not "value non-empty". Whitespace-only counts as empty.
    invoice_prefix  = case when payload ? 'invoice_prefix'
                           then btrim(payload->>'invoice_prefix')          else invoice_prefix end,
    -- A quote prefix must not be empty: the desktop falls back to QT- for a
    -- blank, and a bare "A7K2-1001" would not read as a quote number.
    quote_prefix    = coalesce(nullif(btrim(payload->>'quote_prefix'),''), quote_prefix),
    default_tax_bps = coalesce((payload->>'default_tax_bps')::int, default_tax_bps),

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
end $function$;

COMMIT;

-- ── verify ──────────────────────────────────────────────────────────────────
-- as a manager:
--   select invoice_prefix from set_company_profile('{"invoice_prefix":""}');      -- ''
--   select invoice_prefix from set_company_profile('{"invoice_prefix":"INV-"}');  -- 'INV-'
--   select invoice_prefix from set_company_profile('{"name":"x"}');               -- unchanged
--   select quote_prefix   from set_company_profile('{"quote_prefix":""}');        -- unchanged (never blank)
