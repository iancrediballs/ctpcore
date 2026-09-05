-- 0025 — close the price-list read hole.
--
-- `price_read` was USING (true) for every authenticated user, so any logged-in
-- account — including a customer — could read the entire price list, every tier,
-- straight off the Data API. Today that leaks only the 'list' tier because no
-- trade or wholesale rows exist yet, but the day one is inserted it is exposed
-- with no further change.
--
-- Staff-only is the intent already written down everywhere else in this system:
--   * sync-streams.yaml excludes price/part_cost/price_tier from ctp_client,
--     with the note "Ian quotes per customer";
--   * price_tier_read is already is_staff();
--   * part_cost_staff is already is_staff().
-- This makes the table agree with them.
--
-- Nothing customer-facing reads `price` directly: quoting goes through the
-- SECURITY DEFINER functions price_quote / fill_quote_from_list, which run with
-- the definer's rights and are themselves gated on is_staff(). PowerSync
-- replicates as powersync_role (BYPASSRLS), so device sync is untouched.
-- price_write (FOR ALL, is_staff()) still supplies row visibility for staff
-- writes, so the upload path is unaffected.

drop policy if exists price_read on public.price;

create policy price_read on public.price
  for select
  to authenticated
  using (is_staff());
