-- 0021_client_quote_response.sql — the client sees their quote and answers it.
--
-- Two jobs:
--   1. make a client's own order lines REACHABLE by the sync layer, and
--   2. give them exactly one way to respond, which cannot touch anything else.
--
-- ── 1. why sales_line grows a customer_id ────────────────────────────────────
-- PowerSync edition-2 data queries are single-table: no joins. `sales_order`
-- filters on customer_id happily; `sales_line` only knows its order_id, so the
-- customer is one hop away and unreachable. Denormalising the customer onto the
-- line is the smallest honest fix.
--
-- It is maintained by a TRIGGER rather than by each writer. The desktop's
-- add_line, request_parts, and any future importer would each have to remember,
-- and the failure mode of forgetting is silent: the line simply never appears
-- on the customer's device. A trigger cannot forget. It also derives the value
-- rather than accepting one, so a caller cannot put someone else's customer_id
-- on a line.

BEGIN;

ALTER TABLE sales_line ADD COLUMN IF NOT EXISTS customer_id bigint;

-- Derived, never supplied. Runs on INSERT and on any UPDATE of order_id, so a
-- line moved between orders follows its order.
CREATE OR REPLACE FUNCTION public.sales_line_set_customer()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  SELECT so.customer_id INTO NEW.customer_id
    FROM sales_order so WHERE so.id = NEW.order_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sales_line_customer ON sales_line;
CREATE TRIGGER sales_line_customer
  BEFORE INSERT OR UPDATE OF order_id ON sales_line
  FOR EACH ROW EXECUTE FUNCTION public.sales_line_set_customer();

-- Existing rows.
UPDATE sales_line sl
   SET customer_id = so.customer_id
  FROM sales_order so
 WHERE so.id = sl.order_id
   AND sl.customer_id IS DISTINCT FROM so.customer_id;

CREATE INDEX IF NOT EXISTS sales_line_customer_idx ON sales_line (customer_id);

-- If an order is ever reassigned to a different customer, its lines must follow
-- or they would keep syncing to the previous customer's device.
CREATE OR REPLACE FUNCTION public.sales_order_cascade_customer()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
    UPDATE sales_line SET customer_id = NEW.customer_id, updated_at = now()
     WHERE order_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sales_order_customer_cascade ON sales_order;
CREATE TRIGGER sales_order_customer_cascade
  AFTER UPDATE OF customer_id ON sales_order
  FOR EACH ROW EXECUTE FUNCTION public.sales_order_cascade_customer();

-- ── 2. the client's answer ───────────────────────────────────────────────────
-- Recorded separately from `status` on purpose. Status is the business state and
-- staff own it; these two columns say what the CUSTOMER did and when, which is
-- the thing you want when someone later asks "did they actually agree to this?"
ALTER TABLE sales_order ADD COLUMN IF NOT EXISTS client_response    text;
ALTER TABLE sales_order ADD COLUMN IF NOT EXISTS client_responded_at timestamptz;

ALTER TABLE sales_order DROP CONSTRAINT IF EXISTS sales_order_client_response_ck;
ALTER TABLE sales_order ADD CONSTRAINT sales_order_client_response_ck
  CHECK (client_response IS NULL OR client_response IN ('accepted', 'declined'));

-- Same shape as request_parts: the customer holds NO update rights on
-- sales_order. This function is the only way they can change one, it works out
-- who they are from the JWT, and it refuses anything that is not their own
-- order sitting in 'quote'.
CREATE OR REPLACE FUNCTION public.respond_to_quote(order_id bigint, accept boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_customer bigint;
  v_status   text;
  v_owner    bigint;
  v_zero     int;
  v_new      text;
BEGIN
  v_customer := my_customer_id();
  IF v_customer IS NULL THEN
    RAISE EXCEPTION 'This login is not linked to a customer account.' USING ERRCODE = '42501';
  END IF;

  SELECT so.status, so.customer_id INTO v_status, v_owner
    FROM sales_order so
   WHERE so.id = respond_to_quote.order_id AND so.deleted_at IS NULL;

  -- Same message whether the order belongs to someone else or does not exist:
  -- a different error for each would let a customer probe for real order ids.
  IF v_owner IS NULL OR v_owner <> v_customer THEN
    RAISE EXCEPTION 'No such quote.' USING ERRCODE = '42501';
  END IF;

  IF v_status <> 'quote' THEN
    RAISE EXCEPTION 'That order is already %, so it cannot be answered.', v_status
      USING ERRCODE = '22023';
  END IF;

  -- Accepting a quote nobody has priced yet would turn an unpriced request into
  -- a confirmed order. Declining one is fine — that is "never mind".
  IF accept THEN
    SELECT count(*) INTO v_zero FROM sales_line sl
     WHERE sl.order_id = respond_to_quote.order_id
       AND sl.deleted_at IS NULL AND sl.unit_price_minor <= 0;
    IF v_zero > 0 THEN
      RAISE EXCEPTION 'This quote has not been priced yet.' USING ERRCODE = '22023';
    END IF;
  END IF;

  v_new := CASE WHEN accept THEN 'confirmed' ELSE 'cancelled' END;

  UPDATE sales_order
     SET status = v_new,
         client_response = CASE WHEN accept THEN 'accepted' ELSE 'declined' END,
         client_responded_at = now(),
         updated_at = now()
   WHERE id = respond_to_quote.order_id;

  RETURN jsonb_build_object('order_id', respond_to_quote.order_id, 'status', v_new);
END;
$$;

REVOKE ALL ON FUNCTION public.respond_to_quote(bigint, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.respond_to_quote(bigint, boolean) TO authenticated;

COMMIT;

-- ── verify ──────────────────────────────────────────────────────────────────
-- every line carries its order's customer:
--   SELECT count(*) AS mismatched FROM sales_line sl JOIN sales_order so ON so.id = sl.order_id
--    WHERE sl.customer_id IS DISTINCT FROM so.customer_id;      -- expect 0
--
-- the trigger derives it even when a caller supplies rubbish:
--   INSERT INTO sales_line (order_id, part_id, qty, unit_price_minor, customer_id)
--   VALUES (9, 1152, 1, 0, 999999) RETURNING customer_id;       -- expect 6, not 999999
--   (then delete that test row)
--
-- anon cannot call the responder, authenticated can:
--   SELECT has_function_privilege('anon','public.respond_to_quote(bigint,boolean)','EXECUTE'),
--          has_function_privilege('authenticated','public.respond_to_quote(bigint,boolean)','EXECUTE');
--
-- as staff (no customer row) it refuses:
--   SELECT public.respond_to_quote(9, true);   -- ERROR: not linked to a customer account
