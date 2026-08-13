-- 0022_staff_quoting.sql — price a quote from the cloud, not from one PC.
--
-- WHY THIS EXISTS
--   The desktop app writes to its own SQLite on Ian's machine and does not talk
--   to Postgres. So the natural instinct — "price the request in the Sales
--   screen" — cannot reach the customer: their phone syncs from the cloud, and
--   the cloud never hears about the desktop edit. Anything client-facing has to
--   be written server-side. This is that write.
--
-- WHY RPCs AND NOT A PLAIN TABLE UPDATE
--   `sl_staff` already allows staff to UPDATE sales_line, so the app COULD
--   patch rows directly. Two reasons not to:
--     * pricing is a rule, not a field — zero and negative prices must be
--       impossible, and the order must still be a quote. Rules that live in
--       one function cannot be forgotten by a second caller later.
--     * it keeps the client-facing surface uniform: request_parts,
--       respond_to_quote and these are all "one call, one transaction,
--       validated server-side".
--
-- Staff-gated by is_staff() — the same function every RLS policy uses, so
-- there is one definition of "staff" in the system, not two.

BEGIN;

-- ── set prices on a quote's lines ────────────────────────────────────────────
-- lines: [{"line_id": 12, "unit_price_minor": 60159}, ...]
CREATE OR REPLACE FUNCTION public.price_quote(order_id bigint, lines jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status  text;
  v_updated int;
  v_bad     int;
BEGIN
  IF NOT is_staff() THEN
    RAISE EXCEPTION 'Only staff can price a quote.' USING ERRCODE = '42501';
  END IF;

  SELECT so.status INTO v_status
    FROM sales_order so WHERE so.id = price_quote.order_id AND so.deleted_at IS NULL;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'No such order.' USING ERRCODE = '42704';
  END IF;
  -- Repricing something the customer already accepted would change the deal
  -- under them. Staff can still reopen it (status back to quote) deliberately.
  IF v_status <> 'quote' THEN
    RAISE EXCEPTION 'Order is %, so its prices are settled.', v_status USING ERRCODE = '22023';
  END IF;

  IF lines IS NULL OR jsonb_typeof(lines) <> 'array' OR jsonb_array_length(lines) = 0 THEN
    RAISE EXCEPTION 'No prices supplied.' USING ERRCODE = '22023';
  END IF;

  -- A zero price is what an unpriced request looks like, so allowing one here
  -- would quietly hand the customer an acceptable R0 quote.
  SELECT count(*) INTO v_bad
    FROM jsonb_array_elements(lines) AS l
   WHERE COALESCE((l->>'unit_price_minor')::bigint, 0) <= 0;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Every line needs a price above zero (% missing).', v_bad
      USING ERRCODE = '22023';
  END IF;

  WITH input AS (
    SELECT (l->>'line_id')::bigint AS line_id,
           (l->>'unit_price_minor')::int AS price
      FROM jsonb_array_elements(lines) AS l
  )
  UPDATE sales_line sl
     SET unit_price_minor = i.price, updated_at = now()
    FROM input i
   WHERE sl.id = i.line_id
     AND sl.order_id = price_quote.order_id      -- lines from another order are ignored, not applied
     AND sl.deleted_at IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RETURN (
    SELECT jsonb_build_object(
      'order_id', price_quote.order_id,
      'updated', v_updated,
      'unpriced_left', count(*) FILTER (WHERE sl.unit_price_minor <= 0),
      'total_minor', COALESCE(sum(sl.qty * sl.unit_price_minor), 0))
      FROM sales_line sl
     WHERE sl.order_id = price_quote.order_id AND sl.deleted_at IS NULL
  );
END;
$$;

-- ── fill every line from the current list price ──────────────────────────────
-- Server-side on purpose: the price list is staff-only data, and this way the
-- convenience works from any surface without shipping the list anywhere.
CREATE OR REPLACE FUNCTION public.fill_quote_from_list(order_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status text;
  v_filled int;
BEGIN
  IF NOT is_staff() THEN
    RAISE EXCEPTION 'Only staff can price a quote.' USING ERRCODE = '42501';
  END IF;

  SELECT so.status INTO v_status
    FROM sales_order so WHERE so.id = fill_quote_from_list.order_id AND so.deleted_at IS NULL;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'No such order.' USING ERRCODE = '42704';
  END IF;
  IF v_status <> 'quote' THEN
    RAISE EXCEPTION 'Order is %, so its prices are settled.', v_status USING ERRCODE = '22023';
  END IF;

  UPDATE sales_line sl
     SET unit_price_minor = COALESCE((
           SELECT pr.amount_minor FROM price pr
            WHERE pr.part_id = sl.part_id AND pr.tier = 'list' AND pr.deleted_at IS NULL
            ORDER BY pr.valid_from DESC LIMIT 1), sl.unit_price_minor),
         tier_at_add = 'list',
         updated_at = now()
   WHERE sl.order_id = fill_quote_from_list.order_id AND sl.deleted_at IS NULL;
  GET DIAGNOSTICS v_filled = ROW_COUNT;

  -- Parts with no list price stay at zero rather than silently becoming free;
  -- unpriced_left is what the UI should refuse to send on.
  RETURN (
    SELECT jsonb_build_object(
      'order_id', fill_quote_from_list.order_id,
      'lines', v_filled,
      'unpriced_left', count(*) FILTER (WHERE sl.unit_price_minor <= 0),
      'total_minor', COALESCE(sum(sl.qty * sl.unit_price_minor), 0))
      FROM sales_line sl
     WHERE sl.order_id = fill_quote_from_list.order_id AND sl.deleted_at IS NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION public.price_quote(bigint, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fill_quote_from_list(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.price_quote(bigint, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fill_quote_from_list(bigint) TO authenticated;

COMMIT;

-- ── verify ──────────────────────────────────────────────────────────────────
--   SELECT has_function_privilege('anon','public.price_quote(bigint,jsonb)','EXECUTE');  -- false
-- A customer login calling either one gets 'Only staff can price a quote.'
-- (is_staff() is false for role 'customer'), which is the gate, not a bug.
