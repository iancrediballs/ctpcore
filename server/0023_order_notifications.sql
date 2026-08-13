-- 0023_order_notifications.sql — email when an order needs a human.
-- APPLIED 2026-08-12 (via MCP). Kept for the record / fresh-project rebuilds.
--
-- Three events, one relay:
--   request_received  — a client submitted a request (RQ-* INSERT)
--   quote_accepted    — client_response flipped to accepted
--   quote_declined    — client_response flipped to declined
--
-- The trigger does NOT send email. It queues one async HTTP call (pg_net) to
-- the `notify` Edge Function, which holds the Resend key in its secrets. So:
--   * a slow or dead mail service can never slow down or fail an order write —
--     pg_net's worker sends after COMMIT, fire-and-forget;
--   * no mail credential exists anywhere in the database or the repo;
--   * the function authenticates its caller via x-notify-token, minted into
--     Supabase Vault as 'notify_token' and mirrored into the function's
--     secrets. verify_jwt is off (the caller is Postgres, not a person) but
--     the function FAILS CLOSED: no token configured -> 401 for everyone.
--
-- Staff-created orders do not notify (NEW.number NOT LIKE 'RQ-%') — telling
-- Ian about the order Ian just made is noise.
--
-- ⚠ The INSERT trigger is a DEFERRED CONSTRAINT TRIGGER on purpose.
-- request_parts inserts the order header FIRST, lines after, in one
-- transaction. An ordinary AFTER INSERT trigger builds its payload while the
-- order still has no lines and emails "0 line(s)". Deferred = fires at commit.
--
-- Setup after applying (dashboard, once):
--   Project Settings -> Edge Functions -> Secrets:
--     NOTIFY_TOKEN    = (SELECT decrypted_secret FROM vault.decrypted_secrets
--                         WHERE name='notify_token')
--     RESEND_API_KEY  = key from resend.com
--     NOTIFY_TO       = where alerts go (defaults to Ian's gmail)
--     NOTIFY_FROM     = verified sender (defaults to Resend's onboarding
--                       sender, which may only deliver to the Resend account
--                       owner's own address — fine for internal alerts)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- One-time (already done): mint the shared secret.
--   SELECT vault.create_secret(encode(extensions.gen_random_bytes(24),'hex'),
--          'notify_token', 'Shared secret: order triggers -> notify function');

CREATE OR REPLACE FUNCTION public.notify_order_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_kind    text;
  v_token   text;
  v_cust    record;
  v_lines   int;
  v_total   text;
  v_payload jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.number NOT LIKE 'RQ-%' THEN RETURN NEW; END IF;
    v_kind := 'request_received';
  ELSE
    IF NEW.client_response IS NOT DISTINCT FROM OLD.client_response
       OR NEW.client_response IS NULL THEN RETURN NEW; END IF;
    v_kind := CASE NEW.client_response WHEN 'accepted' THEN 'quote_accepted'
                                       ELSE 'quote_declined' END;
  END IF;

  SELECT decrypted_secret INTO v_token
    FROM vault.decrypted_secrets WHERE name = 'notify_token';
  IF v_token IS NULL THEN RETURN NEW; END IF;  -- unconfigured: silent, never blocks the order

  SELECT c.name, c.contact INTO v_cust FROM customer c WHERE c.id = NEW.customer_id;
  SELECT count(*), to_char(COALESCE(sum(sl.qty * sl.unit_price_minor),0)/100.0, 'FM999G999G999D00')
    INTO v_lines, v_total
    FROM sales_line sl WHERE sl.order_id = NEW.id AND sl.deleted_at IS NULL;

  v_payload := jsonb_build_object(
    'kind', v_kind,
    'number', NEW.number,
    'customer', COALESCE(v_cust.name, 'Unknown customer'),
    'contact', v_cust.contact,
    'lines', v_lines,
    'total_zar', CASE WHEN v_kind = 'request_received' THEN NULL ELSE v_total END,
    'note', NEW.notes);

  PERFORM net.http_post(
    url := 'https://hkzmydowyiajkbakxfkj.supabase.co/functions/v1/notify',
    body := v_payload,
    headers := jsonb_build_object('Content-Type','application/json','x-notify-token', v_token),
    timeout_milliseconds := 5000);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS order_request_notify ON sales_order;
CREATE CONSTRAINT TRIGGER order_request_notify
  AFTER INSERT ON sales_order
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.notify_order_event();

DROP TRIGGER IF EXISTS order_response_notify ON sales_order;
CREATE TRIGGER order_response_notify
  AFTER UPDATE OF client_response ON sales_order
  FOR EACH ROW EXECUTE FUNCTION public.notify_order_event();

COMMIT;

-- ── debugging ───────────────────────────────────────────────────────────────
-- pg_net records outcomes; if an email never arrives, look here first:
--   SELECT id, status_code, content, created FROM net._http_response
--    ORDER BY created DESC LIMIT 5;
-- 401 = function secrets not set / token mismatch. 200 with {"ok":false,
-- "reason":"no api key"} = RESEND_API_KEY missing. Function logs are in the
-- dashboard under Edge Functions -> notify -> Logs.
