-- ============================================================================
--  CTP Core — COMPANY IDENTITY (migration 0014)
--
--  0005 seeded a placeholder seller: "China Truck Parts Co., Ltd.", an address
--  in Jinan, Shandong, a +86 phone number, a Chinese tax ID ending XXXXXXXX,
--  and USD. None of it was ever replaced, so every quote and every tax invoice
--  this system has printed carried a fictitious Chinese company and a dollar
--  sign, for a South African business trading in rand.
--
--  This sets the real identity, taken from the letterhead on the account
--  statements already issued to customers.
--
--  DELIBERATELY LEFT BLANK: tax_id and the phone number. A wrong VAT number on
--  a tax invoice is worse than an absent one — SARS requires it to be correct,
--  and a customer's own VAT claim depends on it. Fill both in via the gear icon
--  → Settings before issuing anything. The app prints nothing where these are
--  empty rather than printing something false.
--
--  Idempotent: an UPDATE against the single pinned row, safe to re-run.
-- ============================================================================
PRAGMA foreign_keys = ON;

UPDATE company SET
  name     = 'China Truck Parts (Pty) Ltd',
  address  = '6 Daae Park, Imbonini Industrial Park, Shakas Head, KwaZulu-Natal',
  phone    = NULL,
  email    = NULL,
  tax_id   = NULL,
  currency = 'ZAR',
  terms    = 'Payment due within 30 days. Parts carry a 12-month manufacturer '
             || 'warranty against defects. All prices exclude VAT at 15%.',
  rev        = rev + 1,
  updated_at = datetime('now')
WHERE id = 1;
