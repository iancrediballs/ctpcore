-- 0097 — Back-order stock from Zoho purchase orders (25 Nov 2026, Ian + Michelle).
--
-- Michelle's process starts in Zoho: paid-for stock still in transit goes on a Zoho purchase
-- order with the "Back order" tick box (PO custom field cf_back_order, created 25 Nov) and the
-- PO's Expected Delivery Date as the ETA. CTP mirrors every UNRECEIVED line of those POs here,
-- so staff see "4 incoming · ETA 19 Dec · PO-00005" on the part.
--
-- Zoho stays the master: this table is a cache, replaced in full on every read
-- (zoho-push "back_order_sync": the 10-minute read-back, the bill / purchase-receive / item
-- webhooks, and the staff "Refresh" button). A line drops out when it is fully received, the
-- PO is cancelled, or the tick box is cleared.
--
-- Not synced to phones (no PowerSync change): the app reads it online, staff only.

create table if not exists public.zoho_back_order_line (
  line_item_id          text primary key,              -- Zoho PO line id
  zoho_purchaseorder_id text not null,
  purchaseorder_number  text not null,
  reference_number      text,
  vendor_name           text,
  po_date               date,
  eta                   date,                          -- PO delivery date (Expected Delivery Date)
  po_status             text,                          -- Zoho status: open / billed / partially_received …
  billed_status         text,
  zoho_item_id          text not null,
  part_id               bigint references public.part(id),
  sku                   text,
  name                  text,
  model                 text,                          -- the item's Model field on the PO line (JH6 / JH7 / JH6/JH7)
  qty_ordered           numeric not null,
  qty_received          numeric not null default 0,
  qty_outstanding       numeric not null,
  synced_at             timestamptz not null default now()
);
create index if not exists zoho_back_order_line_part on public.zoho_back_order_line (part_id);

alter table public.zoho_back_order_line enable row level security;
drop policy if exists zbol_staff_read on public.zoho_back_order_line;
create policy zbol_staff_read on public.zoho_back_order_line for select to authenticated using (is_staff());
revoke all on public.zoho_back_order_line from anon;
grant select on public.zoho_back_order_line to authenticated;

-- one row per part: what is on its way, and the earliest ETA
create or replace view public.back_order_part with (security_invoker = true) as
  select part_id, sku,
         sum(qty_outstanding)                              as qty_incoming,
         min(eta)                                          as next_eta,
         string_agg(distinct purchaseorder_number, ', ')   as purchaseorders,
         max(synced_at)                                    as synced_at
    from public.zoho_back_order_line
   where qty_outstanding > 0
   group by part_id, sku;
grant select on public.back_order_part to authenticated;

alter table public.zoho_config add column if not exists back_orders_synced_at timestamptz;

-- ── the cache writer (server only) ───────────────────────────────────────────
-- p_lines: [{ line_item_id, zoho_purchaseorder_id, purchaseorder_number, reference_number, vendor_name,
--             po_date, eta, po_status, billed_status, zoho_item_id, sku, name, model,
--             qty_ordered, qty_received }]
-- Replaces the whole table: the caller always sends every back-order line Zoho has.
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
         po_date, eta, po_status, billed_status, zoho_item_id, part_id, sku, name, model, qty_ordered, qty_received, qty_outstanding)
  select e->>'line_item_id', e->>'zoho_purchaseorder_id', e->>'purchaseorder_number', nullif(e->>'reference_number', ''),
         nullif(e->>'vendor_name', ''), nullif(e->>'po_date', '')::date, nullif(e->>'eta', '')::date,
         nullif(e->>'po_status', ''), nullif(e->>'billed_status', ''), e->>'zoho_item_id',
         (select z.part_id from zoho_item z where z.zoho_item_id = e->>'zoho_item_id'),
         nullif(e->>'sku', ''), nullif(e->>'name', ''), nullif(e->>'model', ''),
         (e->>'qty_ordered')::numeric, coalesce(nullif(e->>'qty_received', '')::numeric, 0),
         greatest((e->>'qty_ordered')::numeric - coalesce(nullif(e->>'qty_received', '')::numeric, 0), 0)
    from jsonb_array_elements(p_lines) e;
  get diagnostics n = row_count;
  select count(*) into n_unlinked from zoho_back_order_line where part_id is null;
  update zoho_config set back_orders_synced_at = now() where id = 1;
  return jsonb_build_object('lines', n, 'not_linked_to_a_part', n_unlinked);
end $$;
revoke all on function public.apply_zoho_back_orders(jsonb) from public, anon, authenticated;
grant execute on function public.apply_zoho_back_orders(jsonb) to service_role;

alter table public.zoho_push_log drop constraint if exists zoho_push_log_doc_type_check;
alter table public.zoho_push_log add constraint zoho_push_log_doc_type_check
  check (doc_type in ('invoice','bill','contact','config','test','salesorder','estimate','package','shipment',
                      'purchasereceive','adjustment','item','hook','purchaseorder'));
