-- CTP Core 0067 — PRIVACY: system history out of the customer-visible note (23 Oct 2026).
--
-- Found in Ian's end-to-end test: sales_order.notes is synced to the CUSTOMER's phone (their own
-- request note), but every server function also appended staff history to it — price changes
-- by accounts ("price R753.44 → R1,074.67"), "Accepted on the customer's behalf by …", stock
-- holds, Zoho estimate/invoice/payment events. Customers could read all of it.
--
--   1. sales_order.staff_log (new): the internal, staff-only history.
--   2. Existing notes are split: from the first system line onward (a line starting
--      "[YYYY-MM-DD" or "YYYY-MM-DD HH:MI UTC —") the text moves to staff_log; notes keeps only
--      what the customer wrote / the desk captured at entry.
--   3. A trigger makes it permanent for EVERY function, present and future: once an order
--      exists, any change to `notes` is redirected to staff_log (an append moves just the
--      appended text; anything else is logged as an edit), so the customer's note can no
--      longer gain system text.
--   4. Column privilege: `authenticated` (customers and staff via the Data API) can no longer
--      SELECT staff_log. Staff phones get it through their PowerSync stream (SELECT *);
--      customers' stream lists columns explicitly and never had it.
--   5. A newly accepted order records its Zoho SO as 'open' (accept-quote confirms the SO in
--      Zoho BEFORE the database step since 21 Oct), so the phone never shows a confirmed SO as
--      "Draft — awaiting accountant"; accept-quote then writes Zoho's real status.
begin;

alter table public.sales_order add column if not exists staff_log text;

-- 2. split what is there today (before the trigger exists)
with s as (
  select id, notes,
         (select min(ord) from regexp_split_to_table(notes, E'\n') with ordinality as t(line, ord)
           where line ~ '^\[\d{4}-\d{2}-\d{2}' or line ~ '^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC') as first_sys
    from public.sales_order where notes is not null and staff_log is null)
update public.sales_order so set
  notes = nullif(btrim((select string_agg(line, E'\n' order by ord) from regexp_split_to_table(s.notes, E'\n') with ordinality as t(line, ord) where ord < s.first_sys)), ''),
  staff_log = (select string_agg(line, E'\n' order by ord) from regexp_split_to_table(s.notes, E'\n') with ordinality as t(line, ord) where ord >= s.first_sys)
from s where so.id = s.id and s.first_sys is not null;

-- 3. every later write to notes lands in staff_log
create or replace function public.sales_order_notes_to_staff_log()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare o text := coalesce(old.notes, ''); n text := coalesce(new.notes, ''); added text;
begin
  if new.notes is not distinct from old.notes then return new; end if;
  if left(n, length(o)) = o and length(n) > length(o) then
    added := btrim(substr(n, length(o) + 1), E'\n ');
  else
    added := format('[%s] note edited: %s', to_char(now() at time zone 'Africa/Johannesburg', 'YYYY-MM-DD HH24:MI'), n);
  end if;
  new.staff_log := concat_ws(E'\n', nullif(new.staff_log, ''), nullif(added, ''));
  new.notes := old.notes;
  return new;
end $$;
drop trigger if exists sales_order_notes_to_staff_log on public.sales_order;
create trigger sales_order_notes_to_staff_log before update of notes on public.sales_order
  for each row execute function public.sales_order_notes_to_staff_log();

-- 4. nobody reads staff_log through the Data API (PowerSync and SECURITY DEFINER functions are unaffected)
do $$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
    from information_schema.columns where table_schema = 'public' and table_name = 'sales_order' and column_name <> 'staff_log';
  execute 'revoke select on public.sales_order from authenticated, anon';
  execute format('grant select (%s) on public.sales_order to authenticated', cols);
end $$;

-- 5. a newly accepted order's SO is confirmed in Zoho before this row is written
create or replace function public.sales_order_so_open_on_accept()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if old.zoho_salesorder_id is null and new.zoho_salesorder_id is not null and new.zoho_so_status = 'draft'
     and old.status = 'quote' and new.status = 'confirmed' then
    new.zoho_so_status := 'open';
  end if;
  return new;
end $$;
drop trigger if exists sales_order_so_open_on_accept on public.sales_order;
create trigger sales_order_so_open_on_accept before update on public.sales_order
  for each row execute function public.sales_order_so_open_on_accept();

commit;
