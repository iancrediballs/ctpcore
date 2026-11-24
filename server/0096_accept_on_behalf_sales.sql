-- CTP Core 0096 — sales reps accept a quote on the customer's behalf (24 Nov 2026).
--
-- Ian, 24 Nov: a CTP sales rep (Delen, role 'sales') raises and prices Hermans' quotes at the
-- counter but could not accept them for the customer: the button, the accept-quote edge function
-- and accept_quote_on_behalf() all required role 'admin' (0058). RQ-261116-71 and RQ-261124-75
-- were accepted by Ian with the note "Delen" for that reason. 0094 (16 Nov) added the
-- customer_rep role for people at a customer company; it did not touch the staff path.
--
-- Change: accept_quote_on_behalf() accepts sales, manager or admin. Nothing else differs; the
-- caller is still recorded in accepted_by / accepted_note / notes, and the note stays required.
-- Warehouse is deliberately left out. The edge function's own check is changed to match.
--
-- APPLIED on live 24 Nov 2026 (Ian GO), accept-quote v30 deployed the same minute (files verified
-- identical to this branch). Same day: Andre (ajh@hermans.co.za, owner of Hermans) moved from
-- staff role sales to customer, linked to Hermans (customer 6) via customer_person.
begin;

do $mig$
declare d text;
        k1 text := $q$where a.id = p_staff and a.role = 'admin';$q$;
        k2 text := $q$'Only an admin can accept a quote on the customer''s behalf.'$q$;
begin
  d := pg_get_functiondef('public.accept_quote_on_behalf(bigint, uuid, text, text, text)'::regprocedure);
  if (length(d) - length(replace(d, k1, ''))) / length(k1) <> 1
     or (length(d) - length(replace(d, k2, ''))) / length(k2) <> 1 then
    raise exception '0096: accept_quote_on_behalf() is not the version this migration was written against';
  end if;
  d := replace(d, k1, $q$where a.id = p_staff and a.role in ('sales', 'manager', 'admin');$q$);
  d := replace(d, k2, $q$'Only CTP sales staff can accept a quote on the customer''s behalf.'$q$);
  execute d;
end $mig$;

-- grants are unchanged by create or replace; restated so the file stands alone
revoke all on function public.accept_quote_on_behalf(bigint, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.accept_quote_on_behalf(bigint, uuid, text, text, text) to service_role;

commit;
