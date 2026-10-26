-- Cut-over 26 Oct 2026, after the Zoho opening-stock adjustment (1429405000000514144, 154 lines, 965 units,
-- R575,168.56) and stock_sync: rebase the CTP ledger to Zoho's figures, freeze it, Zoho becomes stock master.
-- One 'cutover' adjustment per differing part (the missed Supalift shipment lines, CTP-CBY-001-C until
-- Michelle tracks it in Zoho, and deleted part CTP-CBY-002-C's old seed stock).
begin;
with ctp as (select part_id, sum(delta) q from public.stock_movement where reason not in ('reserve','release') group by part_id),
z as (select distinct on (part_id) part_id, actual_available from public.zoho_item where part_id is not null order by part_id, (status='active') desc),
d as (select coalesce(z.part_id, c.part_id) part_id, coalesce(z.actual_available,0) - coalesce(c.q,0) delta from z full join ctp c on c.part_id = z.part_id)
insert into public.stock_movement (part_id, location_id, delta, reason, ref_type, ref_id, origin, actor_source, client_uuid)
select part_id, 10, delta, 'adjustment', 'cutover', null, 'cutover', 'server_session', gen_random_uuid() from d where delta <> 0;

update public.zoho_config set ctp_ledger_frozen = true, stock_master = 'zoho', updated_at = now() where id = 1;
insert into public.zoho_push_log (doc_type, action, ok, message)
values ('config', 'stock_master', true, 'Stock master: ZOHO (cut-over 26 Oct; CTP ledger rebased to Zoho opening stock and frozen)');
commit;
with ctp as (select part_id, sum(delta) q from public.stock_movement where reason not in ('reserve','release') group by part_id),
z as (select distinct on (part_id) part_id, actual_available from public.zoho_item where part_id is not null order by part_id, (status='active') desc)
select (select sum(q) from ctp) ctp_units, (select sum(actual_available) from z) zoho_units,
  (select count(*) from z full join ctp c on c.part_id = z.part_id where coalesce(z.actual_available,0) <> coalesce(c.q,0)) diff_lines,
  (select count(*) from public.stock_movement where origin='cutover' and reason='adjustment') cut_adj,
  (select row_to_json(c) from (select stock_master, ctp_ledger_frozen, push_enabled from public.zoho_config) c) cfg;
