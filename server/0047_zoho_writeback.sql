-- ============================================================================
--  CTP Core — WRITE-BACK TO ZOHO: invoices to customers, bills from suppliers (0047)
--
--  Ian, 2026-10-19: CTP Core reads items and stock FROM Zoho (0046, zoho-sync)
--  and pushes its own documents INTO Zoho:
--
--    customer side  invoice_order() in CTP Core  -> Zoho INVOICE  (customer contact)
--    supplier side  posted goods receipt         -> Zoho BILL     (vendor contact)
--
--  Not Zoho sales orders: CTP Core's own quote -> confirmed -> fulfilled flow is
--  the order; a Zoho sales order on top would commit the same stock twice.
--
--  GUARDRAILS, all enforced here or in server/edge/zoho-push:
--    * GO-LIVE ONLY. zoho_config.push_from is the cut-off. Nothing invoiced or
--      received before it is ever pushed — Michelle imports the history
--      (Supalift bills, Hermans invoices) herself, and pushing it would double
--      it. push_enabled is FALSE until someone deliberately turns it on.
--    * IDEMPOTENT. The Zoho document id is stored on the CTP record. The push
--      also writes a reference (CTP-INV-<no> / CTP-GRN-<no>) on the Zoho
--      document and searches for it before creating, so a create that succeeded
--      while saving its id failed is FOUND on retry, not made twice.
--    * ALWAYS DRAFT — the standing rule (Michelle, 19 Oct 2026). Every invoice
--      and bill CTP Core creates in Zoho is a DRAFT; Michelle reviews and
--      approves it in Zoho. invoice_as_draft / bill_as_draft stay as flags,
--      default true, and are deliberately NOT in the app: only an admin can
--      change them, through set_zoho_draft_policy(), from the SQL editor.
--    * STATUS COMES BACK. zoho-push {action:"status"} reads each pushed
--      document's Zoho status (draft / sent / paid / void …) onto the CTP
--      record, so staff can see when Michelle has approved it.
--    * NEVER SILENT. Every attempt is a zoho_push_log row; the last error sits
--      on the document (zoho_error) and is shown in the app.
--
--  Receipts: receiving runs on the DESKTOP only and never reached the cloud.
--  submit_goods_receipt() is how a posted desktop receipt arrives here, so the
--  Zoho secret never has to live on a workstation. It records the document
--  only — it writes NO stock_movement (the desktop's ledger already did).
-- ============================================================================

begin;

-- ── 1. configuration (one row) ───────────────────────────────────────────────
create table if not exists public.zoho_config (
  id               integer primary key default 1 check (id = 1),
  push_enabled     boolean not null default false,
  push_from        timestamptz,              -- go-live cut-off; null = nothing pushes
  invoice_as_draft boolean not null default true,
  bill_as_draft    boolean not null default true,
  use_ctp_invoice_number boolean not null default true,  -- Zoho invoice number = CTP invoice_no
  tax_id           text,                     -- Zoho tax id for VAT lines; null = look up by rate
  status_synced_at timestamptz,              -- last status read-back (throttles automatic refreshes)
  updated_at       timestamptz not null default now(),
  updated_by       uuid
);
insert into public.zoho_config (id) values (1) on conflict (id) do nothing;
alter table public.zoho_config add column if not exists status_synced_at timestamptz;
alter table public.zoho_config enable row level security;
drop policy if exists zoho_config_staff_read on public.zoho_config;
create policy zoho_config_staff_read on public.zoho_config for select to authenticated using (is_staff());
grant select on public.zoho_config to authenticated;

-- Managers: on/off, go-live date, tax id. NOT the draft rule (below).
create or replace function public.set_zoho_config(
  p_push_enabled boolean, p_push_from timestamptz, p_tax_id text default null)
returns public.zoho_config
language plpgsql security definer set search_path = public, pg_temp
as $$
declare r public.zoho_config;
begin
  if not is_manager() then
    raise exception 'Only a manager or administrator can change the Zoho settings.' using errcode = '42501';
  end if;
  if p_push_enabled and p_push_from is null then
    raise exception 'Set the go-live date before turning pushing on — without it every historical document would qualify.'
      using errcode = '22023';
  end if;
  update zoho_config set push_enabled = p_push_enabled, push_from = p_push_from,
         tax_id = nullif(trim(coalesce(p_tax_id, '')), ''),
         updated_at = now(), updated_by = auth.uid()
   where id = 1 returning * into r;
  insert into zoho_push_log (doc_type, action, ok, message, actor)
  values ('config', 'update', true,
          format('push_enabled=%s push_from=%s', p_push_enabled, p_push_from), auth.uid());
  return r;
end $$;
revoke all on function public.set_zoho_config(boolean, timestamptz, text) from public, anon;
grant execute on function public.set_zoho_config(boolean, timestamptz, text) to authenticated;

-- The draft rule. Admin only, and only from the SQL editor — there is no
-- button for it. Default (and Michelle's standing rule): both true.
--   select set_zoho_draft_policy(true, true);
-- From the SQL editor auth.uid() is null (a server session), which is allowed;
-- from the app, only a signed-in admin passes.
create or replace function public.set_zoho_draft_policy(p_invoice_as_draft boolean, p_bill_as_draft boolean)
returns public.zoho_config
language plpgsql security definer set search_path = public, pg_temp
as $$
declare r public.zoho_config;
begin
  if auth.uid() is not null then
    if coalesce((select role from app_user where id = auth.uid()), '') <> 'admin' then
      raise exception 'Only an administrator can change the Zoho draft rule.' using errcode = '42501';
    end if;
  end if;
  update zoho_config set invoice_as_draft = p_invoice_as_draft, bill_as_draft = p_bill_as_draft,
         updated_at = now(), updated_by = auth.uid()
   where id = 1 returning * into r;
  insert into zoho_push_log (doc_type, action, ok, message, actor)
  values ('config', 'draft_policy', true,
          format('invoice_as_draft=%s bill_as_draft=%s', p_invoice_as_draft, p_bill_as_draft), auth.uid());
  return r;
end $$;
revoke all on function public.set_zoho_draft_policy(boolean, boolean) from public, anon;
grant execute on function public.set_zoho_draft_policy(boolean, boolean) to authenticated;

-- ── 2. Zoho identity on CTP records ──────────────────────────────────────────
alter table public.customer add column if not exists zoho_contact_id text;
alter table public.customer add column if not exists vat_no text;
alter table public.supplier add column if not exists zoho_contact_id text;
alter table public.supplier add column if not exists vat_no text;

alter table public.sales_order add column if not exists zoho_invoice_id     text;
alter table public.sales_order add column if not exists zoho_invoice_number text;
alter table public.sales_order add column if not exists zoho_status         text;
alter table public.sales_order add column if not exists zoho_pushed_at      timestamptz;
alter table public.sales_order add column if not exists zoho_error          text;
create unique index if not exists sales_order_zoho_invoice_uniq
  on public.sales_order (zoho_invoice_id) where zoho_invoice_id is not null;

alter table public.goods_receipt add column if not exists zoho_bill_id     text;
alter table public.goods_receipt add column if not exists zoho_bill_number text;
alter table public.goods_receipt add column if not exists zoho_status      text;
alter table public.goods_receipt add column if not exists zoho_pushed_at   timestamptz;
alter table public.goods_receipt add column if not exists zoho_error       text;
create unique index if not exists goods_receipt_zoho_bill_uniq
  on public.goods_receipt (zoho_bill_id) where zoho_bill_id is not null;

-- When the Zoho status was last read back (zoho_status holds Zoho's own word:
-- draft, sent, viewed, overdue, partially_paid, paid, void, open … or
-- 'deleted' when the document no longer exists in Zoho).
alter table public.sales_order   add column if not exists zoho_status_at timestamptz;
alter table public.goods_receipt add column if not exists zoho_status_at timestamptz;

-- ── 3. the log: every attempt, success or not ────────────────────────────────
create table if not exists public.zoho_push_log (
  id        bigint generated by default as identity primary key,
  at        timestamptz not null default now(),
  doc_type  text not null check (doc_type in ('invoice','bill','contact','config','test')),
  ctp_id    bigint,
  ctp_ref   text,
  action    text not null,     -- create | found_existing | blocked | error | delete | update
  ok        boolean not null,
  zoho_id   text,
  message   text,
  actor     uuid
);
create index if not exists zoho_push_log_doc_idx on public.zoho_push_log (doc_type, ctp_id, at desc);
alter table public.zoho_push_log enable row level security;
drop policy if exists zoho_push_log_staff_read on public.zoho_push_log;
create policy zoho_push_log_staff_read on public.zoho_push_log for select to authenticated using (is_staff());
grant select on public.zoho_push_log to authenticated;

-- ── 4. what is due: the queue the push function works from ───────────────────
create or replace view public.zoho_push_queue
with (security_invoker = true) as
  select 'invoice'::text as doc_type, so.id as ctp_id, so.invoice_no as ctp_ref,
         so.invoiced_at as doc_at, so.zoho_error as last_error
    from sales_order so, zoho_config c
   where so.status = 'invoiced' and so.deleted_at is null
     and so.invoice_no is not null and so.zoho_invoice_id is null
     and c.push_from is not null and so.invoiced_at >= c.push_from
  union all
  select 'bill', gr.id, gr.number, gr.posted_at, gr.zoho_error
    from goods_receipt gr, zoho_config c
   where gr.status = 'posted' and gr.kind = 'purchase' and gr.deleted_at is null
     and gr.supplier_id is not null and gr.zoho_bill_id is null
     and c.push_from is not null and gr.posted_at >= c.push_from;
grant select on public.zoho_push_queue to authenticated;

-- Everything already in Zoho, with its current Zoho status — invoices AND
-- bills in one list (bills are not on the phone otherwise).
create or replace view public.zoho_documents
with (security_invoker = true) as
  select 'invoice'::text as doc_type, so.id as ctp_id, so.invoice_no as ctp_ref,
         c.name as party, so.zoho_invoice_id as zoho_id, so.zoho_invoice_number as zoho_number,
         so.zoho_status, so.zoho_status_at, so.zoho_pushed_at, so.zoho_error
    from sales_order so join customer c on c.id = so.customer_id
   where so.zoho_invoice_id is not null
  union all
  select 'bill', gr.id, gr.number, s.name, gr.zoho_bill_id, gr.zoho_bill_number,
         gr.zoho_status, gr.zoho_status_at, gr.zoho_pushed_at, gr.zoho_error
    from goods_receipt gr join supplier s on s.id = gr.supplier_id
   where gr.zoho_bill_id is not null;
grant select on public.zoho_documents to authenticated;

-- ── 5. a posted desktop receipt arrives in the cloud ─────────────────────────
-- p: { client_uuid, number, supplier:{code,name,email,vat_no}, received_at,
--      posted_at, supplier_invoice_ref, supplier_invoice_total_minor,
--      invoice_currency, fx_rate_ppm, notes,
--      lines:[{sku, qty_received, unit_cost_minor}] }
-- Idempotent on client_uuid: a resend returns the existing receipt.
create or replace function public.submit_goods_receipt(p jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_id bigint; v_sup bigint; v_loc bigint; v_bad text; l jsonb;
begin
  if not is_staff() then
    raise exception 'Only staff can submit a goods receipt.' using errcode = '42501';
  end if;
  if coalesce(p->>'client_uuid', '') = '' or coalesce(p->>'number', '') = '' then
    raise exception 'A receipt needs client_uuid and number.' using errcode = '22023';
  end if;

  select id into v_id from goods_receipt where client_uuid = p->>'client_uuid';
  if v_id is not null then
    return jsonb_build_object('receipt_id', v_id, 'already', true);
  end if;

  -- every line must name a live part by its item code, or nothing is written
  select string_agg(x->>'sku', ', ') into v_bad
    from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) x
   where not exists (select 1 from part where sku = x->>'sku' and deleted_at is null);
  if v_bad is not null then
    raise exception 'Unknown item codes on receipt %: %', p->>'number', v_bad using errcode = '22023';
  end if;
  if jsonb_array_length(coalesce(p->'lines', '[]'::jsonb)) = 0 then
    raise exception 'Receipt % has no lines.', p->>'number' using errcode = '22023';
  end if;

  insert into supplier (code, name, email, vat_no, origin)
  values (p->'supplier'->>'code', coalesce(p->'supplier'->>'name', p->'supplier'->>'code'),
          p->'supplier'->>'email', p->'supplier'->>'vat_no', 'desktop')
  on conflict (code) do update
     set email  = coalesce(supplier.email,  excluded.email),
         vat_no = coalesce(supplier.vat_no, excluded.vat_no)
  returning id into v_sup;

  select id into v_loc from location where deleted_at is null order by id limit 1;

  insert into goods_receipt (number, supplier_id, kind, location_id, received_at,
         supplier_invoice_ref, supplier_invoice_total_minor, invoice_currency, fx_rate_ppm,
         status, posted_at, notes, client_uuid, actor_id, actor_source, origin)
  values (p->>'number', v_sup, 'purchase', v_loc,
          coalesce((p->>'received_at')::timestamptz, now()),
          p->>'supplier_invoice_ref', (p->>'supplier_invoice_total_minor')::bigint,
          coalesce(p->>'invoice_currency', 'ZAR'), coalesce((p->>'fx_rate_ppm')::bigint, 1000000),
          'posted', coalesce((p->>'posted_at')::timestamptz, now()),
          p->>'notes', p->>'client_uuid', auth.uid(), 'desktop', 'desktop')
  returning id into v_id;

  for l in select * from jsonb_array_elements(p->'lines') loop
    insert into goods_receipt_line (receipt_id, part_id, qty_received, unit_cost_minor, origin)
    values (v_id, (select id from part where sku = l->>'sku' and deleted_at is null),
            (l->>'qty_received')::integer, coalesce((l->>'unit_cost_minor')::bigint, 0), 'desktop');
  end loop;

  return jsonb_build_object('receipt_id', v_id, 'already', false);
end $$;
revoke all on function public.submit_goods_receipt(jsonb) from public, anon;
grant execute on function public.submit_goods_receipt(jsonb) to authenticated;

-- ── 6. contact fields editable by managers (VAT no. for matching) ────────────
create or replace function public.set_party_vat(p_kind text, p_id bigint, p_vat_no text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if not is_manager() then
    raise exception 'Only a manager or administrator can change VAT numbers.' using errcode = '42501';
  end if;
  if p_kind = 'customer' then
    update customer set vat_no = nullif(trim(p_vat_no), ''), updated_at = now() where id = p_id;
  elsif p_kind = 'supplier' then
    update supplier set vat_no = nullif(trim(p_vat_no), ''), updated_at = now() where id = p_id;
  else
    raise exception 'kind must be customer or supplier' using errcode = '22023';
  end if;
end $$;
revoke all on function public.set_party_vat(text, bigint, text) from public, anon;
grant execute on function public.set_party_vat(text, bigint, text) to authenticated;

commit;

-- VERIFY:
select (select push_enabled from zoho_config)     as push_enabled,
       (select push_from from zoho_config)        as push_from,
       (select invoice_as_draft and bill_as_draft from zoho_config) as always_draft,
       (select count(*) from zoho_push_queue)     as queued;
-- expect: false, null, true, 0 — nothing can push until a manager sets the go-live date.
