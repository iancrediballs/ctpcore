-- CTP Core 0078 — Fulfil needs a SENT Zoho invoice, for account customers too (24 Oct 2026).
--
-- Ian: account customers (Hermans) must have a SENT invoice before Fulfil unlocks; a
-- draft invoice no longer counts. Until now 0061 unlocked an account customer's order
-- as soon as any non-void invoice was linked, draft included. Not sent = Zoho status
-- draft, pending_approval or approved. Cash customers keep the paid-in-full rule
-- (a draft can't be paid, so they now get the clearer "draft" reason first).
-- Only fulfil_block_reason() changes; the trigger (0061) calls it as before.
begin;

create or replace function public.fulfil_block_reason(so public.sales_order)
returns text language plpgsql stable set search_path = public, pg_temp as $$
declare v_account boolean;
begin
  if so.zoho_salesorder_id is null then return null; end if;          -- no Zoho SO: not gated
  if so.fulfil_override_at is not null then return null; end if;      -- admin override, recorded
  if so.zoho_so_status in ('deleted', 'void') then
    return format('The Zoho sales order %s was %s in Zoho — ask accounts before taking stock out.', coalesce(so.zoho_salesorder_number, ''), so.zoho_so_status);
  end if;
  if so.zoho_invoice_id is null or coalesce(so.zoho_status, '') in ('void', 'deleted') then
    return 'Waiting for accounts to invoice this sales order in Zoho.';
  end if;
  -- 0078: the invoice must have been sent
  if coalesce(so.zoho_status, 'draft') in ('draft', 'pending_approval', 'approved') then
    return format('Invoice %s is %s in Zoho, ask Michelle to mark it sent.', coalesce(so.zoho_invoice_number, ''),
                  case coalesce(so.zoho_status, 'draft') when 'draft' then 'a draft' when 'approved' then 'approved but not sent' else 'waiting for approval' end);
  end if;
  if so.zoho_so_readback_issue is not null then
    return 'The Zoho invoice has a line CTP cannot match: ' || so.zoho_so_readback_issue;
  end if;
  select c.on_account into v_account from customer c where c.id = so.customer_id;
  if not coalesce(v_account, false) and coalesce(so.zoho_status, '') <> 'paid' then
    return format('Waiting for payment: %s is %s%s (cash customer — accounts record the payment in Zoho).',
                  coalesce(so.zoho_invoice_number, 'the invoice'), replace(coalesce(so.zoho_status, 'unpaid'), '_', ' '),
                  case when coalesce(so.zoho_invoice_balance_minor, 0) > 0
                       then ', R' || to_char(so.zoho_invoice_balance_minor / 100.0, 'FM999,999,990.00') || ' due' else '' end);
  end if;
  return null;
end $$;

commit;
