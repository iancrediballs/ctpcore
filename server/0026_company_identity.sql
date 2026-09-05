-- 0026 — real seller identity on the letterhead.
--
-- The company row was still the placeholder seeded long ago: "China Truck Parts
-- Co., Ltd.", an address in Jinan, Shandong, a +86 phone number and a Chinese
-- tax ID ending in XXXXXXXX. Currency read "Rand", which no symbol table
-- recognised, so printed documents fell back to rendering the literal word.
--
-- Set to the identity already appearing on the account statements issued to
-- customers. Phone, email and tax_id are deliberately NULLed rather than
-- guessed: a wrong VAT number on a tax invoice is worse than a missing one,
-- because the customer's own VAT claim depends on it. These are to be filled in
-- from the desktop app's Settings screen.

update public.company
   set name     = 'China Truck Parts (Pty) Ltd',
       address  = '6 Daae Park, Imbonini Industrial Park, Shakas Head, KwaZulu-Natal',
       phone    = null,
       email    = null,
       tax_id   = null,
       currency = 'ZAR',
       terms    = 'Payment due within 30 days. Parts carry a 12-month '
                  || 'manufacturer warranty against defects. All prices '
                  || 'exclude VAT at 15%.',
       rev        = rev + 1,
       updated_at = now()
 where id = 1;
