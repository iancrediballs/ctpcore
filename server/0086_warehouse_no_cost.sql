-- 0086 (QA sweep, 26 Oct): docs/01 and docs/02 promise a warehouse login "physically cannot
-- read cost prices", but part_cost / part_landed_cost / price_tier read was is_staff(), which
-- includes warehouse. Reads now exclude warehouse; writes are unchanged (receiving still works).
-- FOR ALL policies also grant SELECT, so the staff write policies are split per command.
-- The PowerSync side (warehouse out of ctp_staff) is a sync-rules change: see READINESS_REPORT.
begin;
create or replace function public.can_see_cost() returns boolean
  language sql stable security definer set search_path = public, pg_temp
  as $$ select public.auth_role() in ('sales','manager','admin') $$;
revoke execute on function public.can_see_cost() from public, anon;
grant execute on function public.can_see_cost() to authenticated;

drop policy if exists part_cost_staff on public.part_cost;
create policy part_cost_read on public.part_cost for select to authenticated using (public.can_see_cost());
create policy part_cost_ins  on public.part_cost for insert to authenticated with check (public.is_staff());
create policy part_cost_upd  on public.part_cost for update to authenticated using (public.is_staff()) with check (public.is_staff());
create policy part_cost_del  on public.part_cost for delete to authenticated using (public.is_staff());

drop policy if exists part_landed_cost_staff_read  on public.part_landed_cost;
drop policy if exists part_landed_cost_staff_write on public.part_landed_cost;
create policy part_landed_cost_read on public.part_landed_cost for select to authenticated using (public.can_see_cost());
create policy part_landed_cost_ins  on public.part_landed_cost for insert to authenticated with check (public.is_staff());
create policy part_landed_cost_upd  on public.part_landed_cost for update to authenticated using (public.is_staff()) with check (public.is_staff());
create policy part_landed_cost_del  on public.part_landed_cost for delete to authenticated using (public.is_staff());

drop policy if exists price_tier_read on public.price_tier;
create policy price_tier_read on public.price_tier for select to authenticated using (public.can_see_cost());
commit;
