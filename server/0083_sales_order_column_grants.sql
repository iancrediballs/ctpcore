-- 0083 (QA sweep, 26 Oct): customers could read staff-only columns on their own orders
-- through the Data API (credit_warning, override notes, Zoho error text, raised_by…).
-- Column SELECT is now an explicit allow-list. Staff read orders through PowerSync and
-- SECURITY DEFINER RPCs; edge functions use the service role — all unaffected.
begin;
revoke select on public.sales_order from authenticated, anon;
grant select (id, number, customer_id, location_id, status, currency, notes, fulfilled_at, tax_rate_bps, rev, created_at,
  updated_at, deleted_at, client_response, client_responded_at, client_uuid, invoice_no, invoiced_at,
  zoho_salesorder_number, zoho_invoice_number, zoho_status, zoho_so_status, accepted_note, zoho_so_terms_days,
  zoho_so_terms_label, zoho_invoice_total_minor, zoho_invoice_balance_minor, zoho_invoice_paid_minor, zoho_invoice_count,
  zoho_estimate_number, zoho_estimate_status, zoho_estimate_total_minor, zoho_estimate_expiry, zoho_shipment_number,
  zoho_shipment_status, po_number, po_file_path, po_file_name, accepted_via)
  on public.sales_order to authenticated;
commit;
