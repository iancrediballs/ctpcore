-- Sinotruk C7H make settings — PREPARED, NOT APPLIED (26 Oct 2026).
-- Normally you don't run this: `onboard.py import docs/templates/sinotruk_c7h_template.xlsx --apply` upserts
-- the same row from the workbook's profile tab. This file is the entry in SQL for review, or for creating the
-- profile on its own before any parts exist.
--
-- PLACEHOLDERS, Michelle to confirm in Zoho before the Zoho step:
--   zoho_sales_account_id    = id of "Sales - Sinotruk"              (or an existing sales account)
--   zoho_purchase_account_id = id of "Cost of Goods Sold - Sinotruk" (or an existing COGS account)
--   `python tools/onboard/onboard.py accounts` lists the ids in use once the accounts exist.
-- Left empty on purpose (Ian): rebate_scheme_id (does Sinotruk join Hermans' book?), pn_pattern, lookup_url.
insert into public.make_profile (code, make, model, display_name, parts_brand_code, zoho_manufacturer, zoho_brand,
  zoho_sales_account_id, zoho_purchase_account_id, zoho_inventory_account_id, unit, default_part_type,
  rebate_scheme_id, pn_pattern, lookup_url, description_template, is_test, active, notes)
values ('SINOTRUK_C7H', 'Sinotruk', 'C7H', 'Sinotruk C7H', 'SINOTRUK', 'Sinotruk', 'C7H',
  null,                    -- PLACEHOLDER: "Sales - Sinotruk"
  null,                    -- PLACEHOLDER: "Cost of Goods Sold - Sinotruk"
  '1429405000000034001',   -- Inventory Asset (same as FAW)
  'pcs', 'OEM', null, null, null, '{make} {model} · part no. {sku}', false, true,
  'Accounts are placeholders until Michelle confirms Sales - Sinotruk / Cost of Goods Sold - Sinotruk.')
on conflict (code) do nothing;
