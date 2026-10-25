-- 0088 (QA sweep, 26 Oct): order_prices returned cost and floor to warehouse; now only to
-- roles that can_see_cost() (0086). Body otherwise unchanged.
begin;
CREATE OR REPLACE FUNCTION public.order_prices(p_order_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_o record; v_staff boolean := public.is_staff(); v_tier text;
begin
  select so.id, so.customer_id, c.zoho_pricebook_id as book, c.zoho_pricebook_name as book_name, coalesce(c.price_tier, 'list') as tier
    into v_o from sales_order so join customer c on c.id = so.customer_id
   where so.id = p_order_id and so.deleted_at is null;
  if v_o.id is null then raise exception 'No such order.' using errcode = '42704'; end if;
  if not v_staff and public.my_customer_id() is distinct from v_o.customer_id then
    raise exception 'That order belongs to a different customer.' using errcode = '42501';
  end if;
  return jsonb_build_object('order_id', v_o.id, 'pricebook', v_o.book_name, 'lines', coalesce((
    select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'line_id', sl.id, 'part_id', sl.part_id,
             'list_minor', (select pr.amount_minor from price pr where pr.part_id = sl.part_id and pr.tier = 'list' and pr.deleted_at is null
                             order by pr.valid_from desc limit 1),
             'book_minor', (select i.rate_minor from price_book_item i where i.pricebook_id = v_o.book and i.part_id = sl.part_id limit 1),
             'cost_minor', case when v_staff and public.can_see_cost() then (select cc.cost_invoiced_minor from part_current_cost cc where cc.part_id = sl.part_id) end,
             'floor_minor', case when v_staff and public.can_see_cost() then public.price_floor_minor(sl.part_id, coalesce(sl.tier_at_add, v_o.tier)) end))
           order by sl.id)
      from sales_line sl where sl.order_id = v_o.id and sl.deleted_at is null), '[]'::jsonb));
end $function$;
commit;
