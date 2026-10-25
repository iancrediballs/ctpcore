-- 0084 (QA sweep, 26 Oct): small hardening from the Supabase advisors.
begin;
-- `lead` had an open anon INSERT policy and no public form uses it yet.
drop policy if exists lead_insert_any on public.lead;
revoke insert on public.lead from anon;
-- pin search_path on the functions the advisor flagged
alter function public.touch_rev() set search_path = public, pg_temp;
alter function public.pct_text(numeric) set search_path = public, pg_temp;
alter function public.rebate_net_minor(bigint, numeric) set search_path = public, pg_temp;
alter function public.sales_order_invoice_guard() set search_path = public, pg_temp;
alter function public.sales_line_rebate_guard() set search_path = public, pg_temp;
alter function public.customer_rebate_guard() set search_path = public, pg_temp;
alter function public.part_max_rebate_guard() set search_path = public, pg_temp;
commit;
