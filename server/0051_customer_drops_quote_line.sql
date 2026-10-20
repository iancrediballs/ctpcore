-- 0051_customer_drops_quote_line.sql — the customer takes a line off their own quote.
--
-- Ian, 2026-09-25: "for the quote that gets sent to a customer's phone, can we
-- add an X beside each item to allow the customer to remove items they don't
-- want based on the quote."
--
-- WHY THIS NEEDS NO CHANGE TO THE ZOHO PATH, which is the whole point of doing
-- it this way. The accept-quote edge function reads sales_line AT THE MOMENT OF
-- ACCEPTANCE and builds the Zoho sales order from what it finds. So a line that
-- is soft-deleted before acceptance is simply not there to be read: the Zoho
-- document, the reservation (reserve_order walks the same live lines) and the
-- customer's total all follow from one fact instead of three that have to be
-- kept in step. The accepted order therefore reflects what was ACCEPTED, not
-- what was sent, without the function knowing this feature exists. 0046/0047
-- are already applied and verified end to end against the real Zoho org; this
-- migration deliberately does not disturb them.
--
-- THE QUOTE AS SENT IS NOT LOST. The line is soft-deleted, never removed, and
-- the removal is written onto the order's notes in words. The desk needs to be
-- able to tell "the customer did not want this" from "this was never quoted" —
-- otherwise a five-line quote coming back as three looks like data loss and
-- somebody goes looking for a bug.
--
-- EMPTYING. A customer cannot remove the LAST live line. Ian: "emptying the
-- quote must not produce a zero-value order." Refusing the last removal is the
-- better answer than allowing an empty quote and then refusing to accept it:
-- the customer who wants none of it has a verb for that already, and it is
-- Decline, which cancels the order properly and releases nothing because
-- nothing was ever held. The two guards below (the no-lines blocker and the
-- accept_quote check) exist anyway, because an empty quote can still arrive by
-- another road — staff removing lines on the desk, say — and a rule that is
-- only enforced in the place you happened to think of is not enforced.
--
-- REVERSE: drop quote_drop_line; re-run 0047 for quote_accept_check and
-- accept_quote (this file only adds a guard to each).

begin;

-- ── the customer's verb ───────────────────────────────────────────────────
-- Customer-only on purpose: it stamps "the customer removed this" on the
-- order. Staff editing a quote have their own path on the desk, and if staff
-- could call this the note would be a lie.
create or replace function public.quote_drop_line(line_id bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_me bigint; v_l record; v_live int; v_total bigint;
begin
  v_me := my_customer_id();
  if v_me is null then
    raise exception 'This login is not linked to a customer account.' using errcode = '42501';
  end if;

  select sl.id, sl.order_id, sl.qty, sl.deleted_at,
         so.status, so.customer_id, so.number,
         p.sku, p.name
    into v_l
    from sales_line sl
    join sales_order so on so.id = sl.order_id and so.deleted_at is null
    join part p on p.id = sl.part_id
   where sl.id = quote_drop_line.line_id
   for update of sl, so;

  if v_l.id is null then raise exception 'No such line.' using errcode = '42704'; end if;
  if v_l.customer_id <> v_me then
    raise exception 'That order belongs to a different customer.' using errcode = '42501';
  end if;
  if v_l.status <> 'quote' then
    raise exception 'This order is already %, so its items can no longer be changed.', v_l.status using errcode = '22023';
  end if;
  -- Already gone: say so plainly rather than silently succeeding. Two taps on a
  -- slow connection must not read as two different removals.
  if v_l.deleted_at is not null then
    raise exception 'That item has already been removed.' using errcode = '22023';
  end if;

  select count(*) into v_live from sales_line
   where order_id = v_l.order_id and deleted_at is null;
  if v_live <= 1 then
    raise exception 'A quote has to keep at least one item. To turn the whole quote down, use Decline.' using errcode = '22023';
  end if;

  update sales_line
     set deleted_at = now(), updated_at = now()
   where id = v_l.id;

  -- What the desk reads. Appended, never overwritten: other things write here.
  update sales_order
     set notes = concat_ws(E'\n', nullif(notes, ''),
           format('%s — customer removed %s × %s (%s) from this quote.',
                  to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC',
                  v_l.qty, v_l.name, v_l.sku)),
         updated_at = now()
   where id = v_l.order_id;

  select coalesce(sum(qty::bigint * unit_price_minor), 0) into v_total
    from sales_line where order_id = v_l.order_id and deleted_at is null;

  return jsonb_build_object(
    'order_id', v_l.order_id, 'number', v_l.number, 'line_id', v_l.id,
    'removed_sku', v_l.sku, 'removed_name', v_l.name,
    'remaining_lines', v_live - 1, 'total_minor', v_total);
end $$;
revoke all on function public.quote_drop_line(bigint) from public, anon;
grant execute on function public.quote_drop_line(bigint) to authenticated;
comment on function public.quote_drop_line(bigint) is
  'A customer removes one item from their own quote before accepting it (0051). Soft-deletes the line and notes it on the order. Refuses the last remaining line.';

-- ── an empty quote is not acceptable, said twice ──────────────────────────
-- 0047's check aggregated over the live lines and asked whether any of them
-- were bad. No lines meant no bad lines, so ok came back TRUE and the Accept
-- button lit up on a quote worth nothing; the edge function then refused it
-- ("This quote has no lines") after the customer had already tapped. Name it
-- as a blocker instead, in the customer's words, like every other blocker.
-- Everything else in this function is 0047's, unchanged.
create or replace function public.quote_accept_check(order_id bigint)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_o record; v_blockers jsonb := '[]'::jsonb; v_me bigint; v_lines int;
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
  -- sl.order_id, not order_id: this function's PARAMETER is called order_id, so
  -- an unqualified column reference is ambiguous and plpgsql raises 42702 at
  -- runtime — which would have thrown on every quote and taken the Accept
  -- button out altogether. 0047 avoided it by always aliasing; so does this.
  select count(*) into v_lines from sales_line sl where sl.order_id = v_o.id and sl.deleted_at is null;
  if v_lines = 0 then
    v_blockers := v_blockers || jsonb_build_object('kind', 'no_lines', 'message',
      'There is nothing left on this quote to order.');
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

-- And in the transaction itself. The edge function already refuses to call
-- Zoho with no line items, so this is the second lock on the same door — but
-- it is the one that sits next to the UPDATE that would set status=confirmed,
-- and that is where an invariant belongs. Everything else is 0047's.
create or replace function public.accept_quote(order_id bigint, p_auth_user uuid, p_zoho_salesorder_id text, p_zoho_salesorder_number text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_o record; v_check jsonb; v_reserved int := 0; v_lines int;
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
  -- 0051: an order with nothing on it must never reach status = confirmed.
  -- Aliased for the same reason as in quote_accept_check: the parameter is
  -- order_id, so a bare column reference would be ambiguous.
  select count(*) into v_lines from sales_line sl where sl.order_id = v_o.id and sl.deleted_at is null;
  if v_lines = 0 then
    raise exception '% has no items left on it, so it cannot be accepted.', v_o.number using errcode = '22023';
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

commit;

-- VERIFY (nothing here writes on its own):
--   select proname from pg_proc where proname = 'quote_drop_line';
--   select quote_accept_check(<a quote whose lines are all deleted>);   -- ok=false, kind=no_lines
