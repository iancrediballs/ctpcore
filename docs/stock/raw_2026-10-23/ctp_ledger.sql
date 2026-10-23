select p.id as part_id, p.sku, p.name, p.deleted_at is not null as deleted, z.zoho_item_id, z.status as zoho_status,
       coalesce(sum(m.units) filter (where m.reason not in ('reserve','release')), 0) as ctp_on_hand,
       coalesce(-sum(m.units) filter (where m.reason in ('reserve','release')), 0) as ctp_held,
       coalesce(sum(m.units), 0) as ctp_available,
       coalesce(jsonb_object_agg(m.reason, m.units) filter (where m.reason is not null), '{}'::jsonb) as by_reason,
       min(m.first_at) as first_move, max(m.last_at) as last_move
  from part p
  left join zoho_item z on z.part_id = p.id
  left join lateral (select reason, sum(delta) as units, min(created_at) as first_at, max(created_at) as last_at
                       from stock_movement where part_id = p.id group by reason) m on true
 group by p.id, p.sku, p.name, p.deleted_at, z.zoho_item_id, z.status
 order by p.sku;
