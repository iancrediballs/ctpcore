-- 0085 (QA sweep, 26 Oct): revert 0083. Column grants apply to the whole `authenticated` role,
-- and staff screens (Settings → Zoho "In Zoho" list, waiting-to-send) read sales_order through
-- the Data API — they got 403. Customers seeing their own orders' credit_warning / Zoho error
-- text (P2) goes back on the post-demo list; the proper fix is a staff-only view or RPC.
begin;
grant select on public.sales_order to authenticated;
commit;
