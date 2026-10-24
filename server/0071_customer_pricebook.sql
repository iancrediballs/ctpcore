-- 0071 (24 Oct 2026, Ian: "apply to hermans"): the customer's Zoho price list ("Price List" on the
-- contact = pricebook_id), read back with the account terms (zoho-push refreshTerms) so CTP knows
-- which rebate book a customer is on. The pricing view (docs/12 item 1) shows the book's rate
-- next to the struck-through sales price for these customers.
begin;
alter table public.customer add column if not exists zoho_pricebook_id text;
alter table public.customer add column if not exists zoho_pricebook_name text;
alter table public.customer add column if not exists zoho_pricebook_synced_at timestamptz;
commit;
