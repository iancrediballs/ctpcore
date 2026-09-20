-- 0047_zoho_sales_order.sql — accepting a quote creates the sales order in Zoho Books.
--
-- Ian, 2026-09-20: Zoho Books (org 939422621) already owns the document chain
-- — estimate, sales order, invoice, payment — so CTP Core stops rendering a
-- proforma of its own. The Zoho SALES ORDER is the proforma the customer
-- receives; Zoho issues the tax invoice from it with Zoho's numbering and
-- records the payment. What stays here is the stock: inventory tracking is
-- off in Books, so the CTP ledger (0046 reservations) is the source of truth.
--
-- THE PATH. The customer's phone no longer calls respond_to_quote(accept).
-- It calls the accept-quote edge function, which (1) runs quote_accept_check,
-- (2) creates the sales order in Zoho, (3) calls accept_quote() below in ONE
-- transaction: status → confirmed, Zoho refs stamped, stock reserved. If (3)
-- fails the function deletes the Zoho order again; if THAT fails it writes an
-- integration_issue row so the desk sees it. Nothing is ever half-done from
-- the customer's point of view: either the order exists in Zoho AND the stock
-- is held, or neither and they see why.
--
-- MAPPING. Zoho items carry the CTP SKU as their SKU; part.zoho_item_id is
-- seeded from that (116 items, matched on sku). Customers are matched on
-- code. The 41 parts with no list price are exactly the parts not in Zoho —
-- a quote holding one cannot become a sales order, so quote_accept_check
-- names them and the app refuses acceptance before any API call.
--
-- WHAT THIS DOES NOT TOUCH. invoice_order / next_invoice_no (0042/0045) stay
-- as they are for now; see the write-up for the end state (Zoho's number,
-- one series).
--
-- REVERSE: drop the four functions and integration_issue; drop the columns;
-- re-run 0021 for respond_to_quote.

begin;

-- ── refs and mapping ──────────────────────────────────────────────────────
alter table public.sales_order add column if not exists zoho_salesorder_id     text;
alter table public.sales_order add column if not exists zoho_salesorder_number text;
alter table public.sales_order add column if not exists zoho_created_at        timestamptz;
create unique index if not exists sales_order_zoho_so_key on public.sales_order (zoho_salesorder_id) where zoho_salesorder_id is not null;
comment on column public.sales_order.zoho_salesorder_id is 'Zoho Books salesorder_id created on acceptance (0047). The proforma the customer receives is that document.';

alter table public.part     add column if not exists zoho_item_id    text;
alter table public.customer add column if not exists zoho_contact_id text;
comment on column public.part.zoho_item_id is 'Zoho Books item_id, matched on SKU (0047). NULL = cannot be put on a sales order.';
comment on column public.customer.zoho_contact_id is 'Zoho Books contact_id (0047). NULL = cannot receive a sales order.';

-- Delivery: Zoho emails its own sales-order PDF to the customer on acceptance
-- (Ian favours email over the portal login). A setting, default on.
alter table public.company add column if not exists zoho_email_on_accept boolean not null default true;

update public.part p set zoho_item_id = v.item_id
  from (values
    ('CTP-BMP-001-L', '1429405000000102001'),
    ('CTP-BMP-002-R', '1429405000000108001'),
    ('CTP-BMP-003-L', '1429405000000109001'),
    ('CTP-BMP-004-R', '1429405000000110001'),
    ('CTP-BMP-005-L', '1429405000000111001'),
    ('CTP-BMP-006-R', '1429405000000112001'),
    ('CTP-BMP-007-L', '1429405000000113001'),
    ('CTP-BMP-008-R', '1429405000000114001'),
    ('CTP-BMP-009-C', '1429405000000115001'),
    ('CTP-BMP-010-C', '1429405000000114010'),
    ('CTP-BMP-011-C', '1429405000000116001'),
    ('CTP-BMP-012-C', '1429405000000113010'),
    ('CTP-BMP-013-C', '1429405000000113019'),
    ('CTP-BMP-014-L', '1429405000000114019'),
    ('CTP-BMP-015-R', '1429405000000105010'),
    ('CTP-BMP-016-C', '1429405000000117001'),
    ('CTP-BMP-017-C', '1429405000000118001'),
    ('CTP-BMP-018-C', '1429405000000115010'),
    ('CTP-BMP-019-C', '1429405000000119001'),
    ('CTP-BMP-020-L', '1429405000000120001'),
    ('CTP-BMP-021-R', '1429405000000121001'),
    ('CTP-CBY-008-R', '1429405000000122001'),
    ('CTP-CHX-001-C', '1429405000000099002'),
    ('CTP-CHX-002-C', '1429405000000123001'),
    ('CTP-DEF-001-C', '1429405000000101002'),
    ('CTP-DEF-002-C', '1429405000000114028'),
    ('CTP-DEF-003-C', '1429405000000111010'),
    ('CTP-DEF-004-L', '1429405000000101011'),
    ('CTP-DEF-005-R', '1429405000000115019'),
    ('CTP-DEF-006-C', '1429405000000113028'),
    ('CTP-DEF-007-C', '1429405000000108010'),
    ('CTP-DEF-008-C', '1429405000000124001'),
    ('CTP-DEF-009-L', '1429405000000099011'),
    ('CTP-DEF-010-R', '1429405000000122010'),
    ('CTP-DEF-012-R', '1429405000000122019'),
    ('CTP-DEF-013-R', '1429405000000125001'),
    ('CTP-DEF-014-L', '1429405000000121010'),
    ('CTP-DEF-015-R', '1429405000000126001'),
    ('CTP-DEF-016-L', '1429405000000127001'),
    ('CTP-DEF-017-R', '1429405000000099020'),
    ('CTP-DEF-018-L', '1429405000000123010'),
    ('CTP-DEF-019-R', '1429405000000104010'),
    ('CTP-DEF-020-L', '1429405000000123019'),
    ('CTP-DEF-021-R', '1429405000000106008'),
    ('CTP-DEF-022-L', '1429405000000128001'),
    ('CTP-DEF-023-R', '1429405000000129001'),
    ('CTP-DEF-024-L', '1429405000000123028'),
    ('CTP-DEF-025-R', '1429405000000123037'),
    ('CTP-DEF-026-C', '1429405000000127010'),
    ('CTP-DOR-005-L', '1429405000000101020'),
    ('CTP-DOR-006-R', '1429405000000113037'),
    ('CTP-DOR-009-L', '1429405000000099029'),
    ('CTP-DOR-010-R', '1429405000000130001'),
    ('CTP-FND-001-L', '1429405000000131001'),
    ('CTP-FND-002-R', '1429405000000132001'),
    ('CTP-FND-003-C', '1429405000000111019'),
    ('CTP-FND-004-C', '1429405000000120010'),
    ('CTP-FND-005-B', '1429405000000131010'),
    ('CTP-FND-006-L', '1429405000000107008'),
    ('CTP-FND-007-R', '1429405000000130010'),
    ('CTP-FND-008-L', '1429405000000106017'),
    ('CTP-FND-009-R', '1429405000000133001'),
    ('CTP-FND-010-C', '1429405000000106026'),
    ('CTP-FND-011-L', '1429405000000116010'),
    ('CTP-FND-012-R', '1429405000000123046'),
    ('CTP-FND-013-L', '1429405000000110010'),
    ('CTP-FND-014-R', '1429405000000134001'),
    ('CTP-FWL-001-C', '1429405000000105019'),
    ('CTP-FWL-002-C', '1429405000000132010'),
    ('CTP-FWL-003-C', '1429405000000122028'),
    ('CTP-FWL-004-C', '1429405000000135001'),
    ('CTP-FWL-005-C', '1429405000000117010'),
    ('CTP-FWL-006-L', '1429405000000102010'),
    ('CTP-FWL-007-R', '1429405000000109010'),
    ('CTP-FWL-008-C', '1429405000000099038'),
    ('CTP-FWL-009-C', '1429405000000106035'),
    ('CTP-FWL-010-C', '1429405000000116019'),
    ('CTP-FWL-011-C', '1429405000000109019'),
    ('CTP-FWL-012-C', '1429405000000099047'),
    ('CTP-FWL-013-C', '1429405000000117019'),
    ('CTP-FWL-014-L', '1429405000000120019'),
    ('CTP-FWL-015-R', '1429405000000108019'),
    ('CTP-FWL-016-C', '1429405000000109028'),
    ('CTP-FWL-017-C', '1429405000000107017'),
    ('CTP-FWL-018-L', '1429405000000130019'),
    ('CTP-FWL-019-R', '1429405000000104019'),
    ('CTP-FWL-020-C', '1429405000000113046'),
    ('CTP-INT-001-L', '1429405000000136001'),
    ('CTP-INT-002-R', '1429405000000109037'),
    ('CTP-INT-003-L', '1429405000000109047'),
    ('CTP-INT-004-R', '1429405000000110019'),
    ('CTP-INT-005-L', '1429405000000127019'),
    ('CTP-INT-006-R', '1429405000000108028'),
    ('CTP-INT-007-L', '1429405000000106044'),
    ('CTP-INT-008-R', '1429405000000122037'),
    ('CTP-INT-009-C', '1429405000000110028'),
    ('CTP-LGT-001-L', '1429405000000127028'),
    ('CTP-LGT-002-R', '1429405000000117028'),
    ('CTP-MRR-001-L', '1429405000000117037'),
    ('CTP-MRR-002-R', '1429405000000123055'),
    ('CTP-MRR-003-L', '1429405000000136010'),
    ('CTP-MRR-004-R', '1429405000000113055'),
    ('CTP-MRR-005-C', '1429405000000109056'),
    ('CTP-MRR-006-C', '1429405000000138001'),
    ('CTP-MUD-001-L', '1429405000000118010'),
    ('CTP-MUD-002-R', '1429405000000112010'),
    ('CTP-STP-001-B', '1429405000000136019'),
    ('CTP-STP-002-L', '1429405000000122046'),
    ('CTP-STP-003-C', '1429405000000110037'),
    ('CTP-STP-004-R', '1429405000000106053'),
    ('CTP-STP-005-R', '1429405000000126010'),
    ('CTP-STP-006-C', '1429405000000120028'),
    ('CTP-STP-007-C', '1429405000000127037'),
    ('CTP-STP-008-C', '1429405000000121019'),
    ('CTP-WPR-001-C', '1429405000000099056'),
    ('CTP-WPR-002-C', '1429405000000132019')
  ) as v(sku, item_id)
 where p.sku = v.sku and p.zoho_item_id is distinct from v.item_id;

update public.customer c set zoho_contact_id = v.contact_id
  from (values
    ('WALKIN', '1429405000000113065'),
    ('HXFLEET', '1429405000000139001'),
    ('DESERTHL', '1429405000000109065'),
    ('HERMANS', '1429405000000131019'),
    ('GSLOGI', '1429405000000119010')
  ) as v(code, contact_id)
 where c.code = v.code and c.zoho_contact_id is distinct from v.contact_id;

-- ── what the desk sees when the compensation itself failed ───────────────
create table if not exists public.integration_issue (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  system      text not null,               -- 'zoho'
  kind        text not null,               -- 'orphan_salesorder' | ...
  order_id    bigint references public.sales_order(id),
  external_id text,
  detail      text,
  resolved_at timestamptz
);
alter table public.integration_issue enable row level security;
drop policy if exists integration_issue_staff_read on public.integration_issue;
create policy integration_issue_staff_read on public.integration_issue for select to authenticated using (public.is_staff());
grant select on public.integration_issue to authenticated;

-- ── can this quote become a sales order? ─────────────────────────────────
-- Named blockers, in the customer's words. Callable by the owning customer
-- (the Accept button reads it first) and by staff.
create or replace function public.quote_accept_check(order_id bigint)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_o record; v_blockers jsonb := '[]'::jsonb; v_me bigint;
begin
  select so.id, so.number, so.status, so.customer_id, c.zoho_contact_id, c.name as customer_name
    into v_o from sales_order so join customer c on c.id = so.customer_id
   where so.id = quote_accept_check.order_id and so.deleted_at is null;
  if v_o.id is null then raise exception 'No such order.' using errcode = '42704'; end if;
  v_me := my_customer_id();
  if not is_staff() and (v_me is null or v_me <> v_o.customer_id) then
    raise exception 'That order belongs to a different customer.' using errcode = '42501';
  end if;
  if v_o.status <> 'quote' then
    v_blockers := v_blockers || jsonb_build_object('kind', 'status', 'message', format('This order is already %s.', v_o.status));
  end if;
  if v_o.zoho_contact_id is null then
    v_blockers := v_blockers || jsonb_build_object('kind', 'customer_unmapped', 'message',
      format('%s is not set up in our accounts system yet — we will do that first.', v_o.customer_name));
  end if;
  v_blockers := v_blockers || coalesce((
    select jsonb_agg(jsonb_build_object('kind', case when sl.unit_price_minor <= 0 then 'unpriced' else 'not_in_zoho' end,
                                        'part_id', p.id, 'sku', p.sku, 'name', p.name,
                                        'message', case when sl.unit_price_minor <= 0
                                          then format('%s (%s) has no price yet — we will finish it first.', p.name, p.sku)
                                          else format('%s (%s) is not set up for ordering yet — we will finish it first.', p.name, p.sku) end)
                     order by p.sku)
      from sales_line sl join part p on p.id = sl.part_id
     where sl.order_id = v_o.id and sl.deleted_at is null and (sl.unit_price_minor <= 0 or p.zoho_item_id is null)), '[]'::jsonb);
  return jsonb_build_object('order_id', v_o.id, 'number', v_o.number, 'ok', jsonb_array_length(v_blockers) = 0, 'blockers', v_blockers);
end $$;
revoke all on function public.quote_accept_check(bigint) from public, anon;
grant execute on function public.quote_accept_check(bigint) to authenticated;

-- ── the customer's answer: decline here; accept goes through the edge function ──
CREATE OR REPLACE FUNCTION public.respond_to_quote(order_id bigint, accept boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_customer bigint; v_owner bigint; v_status text;
BEGIN
  v_customer := my_customer_id();
  IF v_customer IS NULL THEN
    RAISE EXCEPTION 'This login is not linked to a customer account.' USING ERRCODE = '42501';
  END IF;
  SELECT so.status, so.customer_id INTO v_status, v_owner
    FROM sales_order so WHERE so.id = respond_to_quote.order_id AND so.deleted_at IS NULL;
  IF v_status IS NULL THEN RAISE EXCEPTION 'No such order.' USING ERRCODE = '42704'; END IF;
  IF v_owner <> v_customer THEN
    RAISE EXCEPTION 'That order belongs to a different customer.' USING ERRCODE = '42501';
  END IF;
  IF v_status <> 'quote' THEN
    RAISE EXCEPTION 'That order is already %, so it cannot be answered.', v_status USING ERRCODE = '22023';
  END IF;
  IF accept THEN
    -- Accepting creates the sales order in Zoho Books first; that happens in
    -- the accept-quote function, which then calls accept_quote(). A direct
    -- accept would leave the customer with a hold and no document.
    RAISE EXCEPTION 'Accepting a quote goes through the sales-order step — use the Accept button in the app.' USING ERRCODE = '22023';
  END IF;
  UPDATE sales_order
     SET status = 'cancelled', client_response = 'declined', client_responded_at = now(), updated_at = now()
   WHERE id = respond_to_quote.order_id;
  RETURN jsonb_build_object('order_id', respond_to_quote.order_id, 'status', 'cancelled');
END;
$$;

-- ── accept: the one transaction, called by the edge function (service role) ──
-- p_auth_user is the customer login the function verified; the order must be
-- theirs. Idempotent on the Zoho id: a retry after a dropped response is a
-- no-op that returns the same answer.
create or replace function public.accept_quote(order_id bigint, p_auth_user uuid, p_zoho_salesorder_id text, p_zoho_salesorder_number text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_o record; v_check jsonb; v_reserved int := 0;
begin
  if auth.uid() is not null then
    raise exception 'accept_quote is called by the server, not from a session.' using errcode = '42501';
  end if;
  if coalesce(p_zoho_salesorder_id, '') = '' then
    raise exception 'accept_quote needs the Zoho sales order id.' using errcode = '22023';
  end if;
  select so.id, so.number, so.status, so.customer_id, so.zoho_salesorder_id, c.auth_user_id
    into v_o from sales_order so join customer c on c.id = so.customer_id
   where so.id = accept_quote.order_id and so.deleted_at is null for update of so;
  if v_o.id is null then raise exception 'No such order.' using errcode = '42704'; end if;
  if v_o.auth_user_id is null or v_o.auth_user_id <> p_auth_user then
    raise exception 'That order belongs to a different customer.' using errcode = '42501';
  end if;
  if v_o.status = 'confirmed' and v_o.zoho_salesorder_id = p_zoho_salesorder_id then
    return jsonb_build_object('order_id', v_o.id, 'number', v_o.number, 'status', 'confirmed',
                              'zoho_salesorder_number', p_zoho_salesorder_number, 'reserved_lines', 0, 'already', true);
  end if;
  if v_o.status <> 'quote' then
    raise exception '% is already %, so it cannot be accepted.', v_o.number, v_o.status using errcode = '22023';
  end if;
  -- the same blockers the app showed; the function cannot be talked past them
  v_check := (select jsonb_agg(b) from jsonb_array_elements((
      select coalesce(jsonb_agg(jsonb_build_object('sku', p.sku, 'name', p.name)), '[]'::jsonb)
        from sales_line sl join part p on p.id = sl.part_id
       where sl.order_id = v_o.id and sl.deleted_at is null and (sl.unit_price_minor <= 0 or p.zoho_item_id is null))) b);
  if v_check is not null then
    raise exception 'This quote has a line that cannot be ordered yet: %', (select string_agg(b->>'name' || ' (' || (b->>'sku') || ')', ', ') from jsonb_array_elements(v_check) b) using errcode = '22023';
  end if;
  update sales_order
     set status = 'confirmed', client_response = 'accepted', client_responded_at = now(),
         zoho_salesorder_id = p_zoho_salesorder_id, zoho_salesorder_number = p_zoho_salesorder_number,
         zoho_created_at = now(), updated_at = now()
   where id = v_o.id;
  v_reserved := public.reserve_order(v_o.id);
  return jsonb_build_object('order_id', v_o.id, 'number', v_o.number, 'status', 'confirmed',
                            'zoho_salesorder_number', p_zoho_salesorder_number, 'reserved_lines', v_reserved, 'already', false);
end $$;
revoke all on function public.accept_quote(bigint, uuid, text, text) from public, anon, authenticated;
grant execute on function public.accept_quote(bigint, uuid, text, text) to service_role;

-- ── the compensation's last resort ───────────────────────────────────────
create or replace function public.log_integration_issue(p_system text, p_kind text, p_order_id bigint, p_external_id text, p_detail text)
returns bigint language sql security definer set search_path = public, pg_temp as $$
  insert into integration_issue (system, kind, order_id, external_id, detail)
  values (p_system, p_kind, p_order_id, p_external_id, p_detail) returning id;
$$;
revoke all on function public.log_integration_issue(text, text, bigint, text, text) from public, anon, authenticated;
grant execute on function public.log_integration_issue(text, text, bigint, text, text) to service_role;

commit;

-- VERIFY:
--   select count(*) filter (where zoho_item_id is not null) mapped, count(*) filter (where zoho_item_id is null and deleted_at is null) unmapped from part;   -- 115 / 41
--   select code, zoho_contact_id from customer;                                                  -- all five mapped
--   select quote_accept_check(<a quote id>);
