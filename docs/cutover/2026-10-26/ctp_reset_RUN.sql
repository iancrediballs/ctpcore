-- CTP reset for the zero (docs/09 §2, §4.3 step 7). RUN 26 Oct 2026 after the Zoho deletes (Ian: GO ZERO).
begin;

-- 1. Pre-go-live orders: soft-delete, never send again, Zoho links cleared (history and timeline kept).
--    Before clearing, the old Zoho refs are copied into staff_log so the history still says what they were.
update public.sales_order o set
  staff_log = coalesce(o.staff_log, '') || E'\n[cut-over 2026-10-27] Zoho zeroed. Old refs: '
              || concat_ws(' ', o.zoho_estimate_number, o.zoho_salesorder_number, o.zoho_invoice_number,
                           o.zoho_package_number, o.zoho_shipment_number),
  deleted_at = coalesce(o.deleted_at, now()),
  zoho_do_not_push = true,
  zoho_estimate_id = null, zoho_estimate_number = null, zoho_estimate_status = null, zoho_estimate_error = null,
  zoho_estimate_modified_at = null, zoho_estimate_total_minor = null, zoho_estimate_synced_at = null,
  zoho_salesorder_id = null, zoho_salesorder_number = null, zoho_so_status = null, zoho_so_error = null,
  zoho_so_modified_at = null, zoho_so_synced_at = null, zoho_so_readback_issue = null,
  zoho_invoice_id = null, zoho_invoice_number = null, zoho_status = null, zoho_invoice_total_minor = null,
  zoho_invoice_balance_minor = null, zoho_invoice_paid_minor = null, zoho_invoice_payments = null,
  zoho_invoice_count = null, zoho_invoice_linked_at = null,
  zoho_package_id = null, zoho_package_number = null, zoho_shipment_id = null, zoho_shipment_number = null,
  zoho_shipment_status = null, zoho_error = null,
  updated_at = now()
where o.created_at < '2026-10-26 14:22:00+00'::timestamptz;

-- 2. Holds: release whatever the soft-deleted orders still reserve, so CTP available = on hand.
insert into public.stock_movement (part_id, location_id, delta, reason, ref_type, ref_id, origin, actor_source, client_uuid)
select m.part_id, m.location_id, -sum(m.delta) filter (where m.reason in ('reserve','release')), 'release', 'sales_order', m.ref_id, 'cutover', 'server_session', gen_random_uuid()
  from public.stock_movement m
 where m.ref_type = 'sales_order' and m.reason in ('reserve','release')
 group by m.part_id, m.location_id, m.ref_id
having sum(m.delta) filter (where m.reason in ('reserve','release')) <> 0;

-- 3. Read-back state: start clean against the new Zoho.
-- rebate_doc_seen is KEPT: rebate_accrue runs right after, so the deleted test docs reverse to 0 (docs/14).
update public.zoho_config set push_from = '2026-10-26 14:22:00+00'::timestamptz, push_enabled = true;   -- nothing older is ever pushed; push back on (Ian)

-- 4. Audit marker.
insert into public.zoho_push_log (doc_type, action, ok, message)
values ('config', 'cutover_zero', true, 'Zoho zeroed; pre-go-live orders soft-deleted and unlinked; push_from = go-live; push on');

-- 5. Stock: CTP stays master until the opening stock is posted and checked in Zoho (PLAN §4).
--    stock_master stays 'ctp' here on purpose.
commit;
select (select count(*) from public.sales_order where deleted_at is null) live_orders, (select count(*) from public.sales_order where zoho_salesorder_id is not null or zoho_invoice_id is not null or zoho_estimate_id is not null) linked, (select row_to_json(c) from (select push_enabled, push_from, stock_master from public.zoho_config) c) cfg;
