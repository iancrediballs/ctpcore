-- 0098 — Multicat-style stock figures (26 Nov 2026, Ian): "In transit" and "On purchase order".
--
-- Multicat (what staff know): On Purchase Order = every unreceived PO line (inbound);
-- In Transit = paid stock on its way = Michelle's Zoho POs ticked "Back order" (0097).
-- Multicat's own "On Back Order" means CUSTOMER orders waiting for stock, so CTP no longer
-- uses that word for incoming stock.
--
-- zoho_back_order_line now caches EVERY unreceived line of every open Zoho PO; back_order marks
-- the lines of POs ticked "Back order".

alter table public.zoho_back_order_line add column if not exists back_order boolean not null default true;

drop view if exists public.back_order_part;
create view public.back_order_part with (security_invoker = true) as
  select part_id, sku,
         coalesce(sum(qty_outstanding) filter (where back_order), 0)                  as qty_incoming,   -- In transit
         sum(qty_outstanding)                                                          as qty_on_po,      -- On purchase order
         min(eta) filter (where back_order)                                            as next_eta,
         string_agg(distinct purchaseorder_number, ', ') filter (where back_order)     as purchaseorders,
         string_agg(distinct purchaseorder_number, ', ')                               as all_purchaseorders,
         max(synced_at)                                                                as synced_at
    from public.zoho_back_order_line
   where qty_outstanding > 0
   group by part_id, sku;
grant select on public.back_order_part to authenticated;

create or replace function public.apply_zoho_back_orders(p_lines jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare n int := 0; n_unlinked int := 0;
begin
  if auth.uid() is not null then
    raise exception 'apply_zoho_back_orders is called by the server, not from a session.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_lines) <> 'array' then raise exception 'p_lines must be a JSON array'; end if;
  delete from zoho_back_order_line where true;
  insert into zoho_back_order_line (line_item_id, zoho_purchaseorder_id, purchaseorder_number, reference_number, vendor_name,
         po_date, eta, po_status, billed_status, zoho_item_id, part_id, sku, name, model, qty_ordered, qty_received, qty_outstanding, back_order)
  select e->>'line_item_id', e->>'zoho_purchaseorder_id', e->>'purchaseorder_number', nullif(e->>'reference_number', ''),
         nullif(e->>'vendor_name', ''), nullif(e->>'po_date', '')::date, nullif(e->>'eta', '')::date,
         nullif(e->>'po_status', ''), nullif(e->>'billed_status', ''), e->>'zoho_item_id',
         (select z.part_id from zoho_item z where z.zoho_item_id = e->>'zoho_item_id'),
         nullif(e->>'sku', ''), nullif(e->>'name', ''), nullif(e->>'model', ''),
         (e->>'qty_ordered')::numeric, coalesce(nullif(e->>'qty_received', '')::numeric, 0),
         greatest((e->>'qty_ordered')::numeric - coalesce(nullif(e->>'qty_received', '')::numeric, 0), 0),
         coalesce((e->>'back_order')::boolean, true)
    from jsonb_array_elements(p_lines) e;
  get diagnostics n = row_count;
  select count(*) into n_unlinked from zoho_back_order_line where part_id is null;
  update zoho_config set back_orders_synced_at = now() where id = 1;
  return jsonb_build_object('lines', n, 'not_linked_to_a_part', n_unlinked);
end $$;
revoke all on function public.apply_zoho_back_orders(jsonb) from public, anon, authenticated;
grant execute on function public.apply_zoho_back_orders(jsonb) to service_role;
