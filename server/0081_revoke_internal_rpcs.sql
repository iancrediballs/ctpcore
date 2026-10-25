-- 0081 (QA sweep, 26 Oct): reserve_order / release_order / order_reserved are internal
-- SECURITY DEFINER helpers with no role check, and Postgres grants EXECUTE to PUBLIC by
-- default, so anyone with the publishable key could release any order's reserved stock.
-- Every caller (accept_quote*, apply_zoho_salesorder, cancel_order, fulfil_order,
-- record_goods_out) is SECURITY DEFINER and runs as the owner, so revoking is safe.
begin;
revoke execute on function public.reserve_order(bigint)       from public, anon, authenticated;
revoke execute on function public.release_order(bigint, text) from public, anon, authenticated;
revoke execute on function public.order_reserved(bigint)      from public, anon, authenticated;
revoke execute on function public.zoho_live()                 from public, anon;
-- trigger functions: not callable as RPCs anyway; this silences the advisor
revoke execute on function public.fulfil_order_zoho_guard(), public.notify_order_event(),
  public.price_book_list_follow(), public.sales_line_estimate_lock(), public.sales_line_priced_event(),
  public.sales_order_timeline()
  from public, anon, authenticated;
commit;
