-- 0075 (24 Oct 2026): 0049 (part.in_stock, approved by Ian 20 Sep) was never applied on live, though
-- the customer PowerSync stream and the app read it. Applied on live today; under 0073's column
-- grants a new part column is not readable over the Data API until granted. in_stock is the one
-- stock fact a customer may see (yes/no), so it is granted.
begin;
grant select (in_stock) on public.part to authenticated;
commit;
