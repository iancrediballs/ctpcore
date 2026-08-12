-- 0020_client_requests.sql — let a signed-in customer ASK for parts.
--
-- WHY AN RPC AND NOT A SYNCED WRITE
--   PowerSync does not reconcile a client-generated id with a server-assigned
--   one — their own docs say the mapping "must occur wherever the UUIDs are
--   referenced, including for every foreign key column". A request is an order
--   PLUS its lines, and the lines carry order_id, so an offline-written request
--   would need exactly that mapping, in the client, at the moment of upload.
--   That is a lot of machinery guarding a case that barely exists: a customer
--   asking for parts has signal (they are browsing a catalogue whose images
--   stream from the CDN). So a request goes through this function instead —
--   one call, one transaction, real ids, nothing to reconcile.
--
--   The stock counter is the opposite case (a warehouse dead-zone is normal),
--   which is why THAT one stays a local offline write.
--
-- WHY SECURITY DEFINER
--   A customer must be able to create an order without holding INSERT on
--   sales_order. If they held INSERT, they could also choose their own prices,
--   their own status, or another customer's id, and RLS would have to be
--   perfect forever. Here they hold nothing: this function is the only door,
--   it decides customer_id from the JWT, and it hard-codes status and price.
--
-- Customers already READ their own orders through the existing so_self /
-- sl_self policies, so a submitted request appears in their app by the normal
-- sync path once `ctp_client_orders` is enabled in sync-streams.yaml.

BEGIN;

CREATE OR REPLACE FUNCTION public.request_parts(items jsonb, note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_customer bigint;
  v_location bigint;
  v_currency text;
  v_order    bigint;
  v_number   text;
  v_lines    jsonb;
  v_bad      int;
BEGIN
  -- 1. who is asking. my_customer_id() maps auth.uid() -> customer.auth_user_id.
  v_customer := my_customer_id();
  IF v_customer IS NULL THEN
    RAISE EXCEPTION 'This login is not linked to a customer account.'
      USING ERRCODE = '42501';
  END IF;

  IF items IS NULL OR jsonb_typeof(items) <> 'array' OR jsonb_array_length(items) = 0 THEN
    RAISE EXCEPTION 'Nothing to request.' USING ERRCODE = '22023';
  END IF;

  -- 2. normalise the basket ONCE: one line per part, quantities merged (so a
  -- double-tap cannot ask for the same thing twice), each clamped to 1..999.
  -- Done as a value rather than a temp table on purpose — a TEMP ... ON COMMIT
  -- DROP would collide with itself if two requests ran in one transaction.
  SELECT jsonb_agg(jsonb_build_object('part_id', part_id, 'qty', qty))
    INTO v_lines
    FROM (
      SELECT (i->>'part_id')::bigint AS part_id,
             SUM(GREATEST(1, LEAST(999, COALESCE((i->>'qty')::int, 1))))::int AS qty
        FROM jsonb_array_elements(items) AS i
       -- Grouped by the EXPRESSION, not `GROUP BY 1`. A positional group-by is
       -- one stray keystroke away from pointing at the SUM instead of the id,
       -- and the failure ("aggregate functions are not allowed in GROUP BY")
       -- surfaces at request time, not at deploy time. It happened once here;
       -- spelling it out costs nothing and cannot drift.
       GROUP BY (i->>'part_id')::bigint
    ) t;

  IF jsonb_array_length(v_lines) > 50 THEN
    RAISE EXCEPTION 'A single request is limited to 50 different parts.'
      USING ERRCODE = '22023';
  END IF;

  -- every part must actually exist; checked before anything is written
  SELECT count(*) INTO v_bad
    FROM jsonb_array_elements(v_lines) AS l
   WHERE NOT EXISTS (
     SELECT 1 FROM part p
      WHERE p.id = (l->>'part_id')::bigint AND p.deleted_at IS NULL);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Request contains % part(s) that do not exist.', v_bad
      USING ERRCODE = '23503';
  END IF;

  -- 3. header. The number is derived from the row id, so it cannot collide
  -- with the staff SO-* / INV-* series, and (unlike a random suffix) cannot
  -- collide with itself under two simultaneous submissions.
  SELECT id INTO v_location FROM location
   WHERE deleted_at IS NULL ORDER BY id LIMIT 1;

  -- company.currency currently reads 'Rand', which is a label, not a code;
  -- live orders are ZAR. Take the code the orders use.
  v_currency := 'ZAR';

  v_order  := nextval(pg_get_serial_sequence('sales_order', 'id'));
  v_number := 'RQ-' || to_char(now() AT TIME ZONE 'Africa/Johannesburg', 'YYMMDD')
              || '-' || v_order::text;

  INSERT INTO sales_order (id, number, customer_id, location_id, status, currency, notes)
  VALUES (v_order, v_number, v_customer, v_location, 'quote', v_currency,
          NULLIF(btrim(COALESCE(note, '')), ''));

  -- 4. lines. Price is ZERO on purpose: the customer never sets a price, and a
  -- request is not a quote until staff have priced it.
  INSERT INTO sales_line (order_id, part_id, qty, unit_price_minor, tier_at_add)
  SELECT v_order, (l->>'part_id')::bigint, (l->>'qty')::int, 0, 'list'
    FROM jsonb_array_elements(v_lines) AS l;

  RETURN jsonb_build_object('order_id', v_order,
                            'number',   v_number,
                            'lines',    jsonb_array_length(v_lines));
END;
$$;

-- Signed-in users only. anon must never reach it: it writes rows, so an
-- unauthenticated caller could fill the sales table with junk.
REVOKE ALL ON FUNCTION public.request_parts(jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_parts(jsonb, text) TO authenticated;

COMMIT;

-- ── verify ──────────────────────────────────────────────────────────────────
-- 1. anon cannot call it, authenticated can:
--      SELECT has_function_privilege('anon','public.request_parts(jsonb,text)','EXECUTE')           AS anon_can,
--             has_function_privilege('authenticated','public.request_parts(jsonb,text)','EXECUTE')  AS auth_can;
--      expect false, true
--
-- 2. your own (staff) login has no customer row, so it should REFUSE cleanly:
--      SELECT public.request_parts('[{"part_id":1152,"qty":2}]'::jsonb, 'test');
--      -> ERROR: This login is not linked to a customer account.
--    That error is the function working, not failing.
--
-- 3. with a linked customer login it returns
--      {"order_id": 9, "number": "RQ-260812-9", "lines": 1}
--    and the request appears in the desktop Sales screen as a quote at R0,
--    ready to be priced.
--
-- ── linking a customer login (per client, AFTER the 0019 streams are live) ──
--   a. Dashboard -> Authentication -> Users -> Add user (email + password).
--   b. give the login a role, so its token carries user_role = 'customer':
--        INSERT INTO app_user (id, role, display_name)
--        VALUES ('<auth uid>', 'customer', 'Denver @ Hermans');
--   c. point the customer record at that login:
--        UPDATE customer SET auth_user_id = '<auth uid>' WHERE code = 'HER001';
--
--   Do NOT do (a) before the role-gated streams from 0019 are deployed in
--   PowerSync — an ungated client login syncs landed cost to their phone.
