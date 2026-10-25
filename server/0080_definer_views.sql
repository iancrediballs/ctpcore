-- 0080 (QA sweep, 26 Oct): four views ran as their owner and were granted to `authenticated`,
-- so a customer login could read every part's cost (part_current_cost) and on-hand stock
-- (stock_position) through the Data API, bypassing part_cost / stock_movement RLS.
-- Nothing in the app or the sync streams reads them; edge functions use the service role,
-- and SECURITY DEFINER callers still see everything (an invoker view runs as the function owner).
begin;
revoke all on public.part_current_cost, public.stock_position, public.rebate_position, public.po_line_status
  from anon, authenticated;
alter view public.part_current_cost set (security_invoker = true);
alter view public.stock_position    set (security_invoker = true);
alter view public.rebate_position   set (security_invoker = true);
alter view public.po_line_status    set (security_invoker = true);
commit;
