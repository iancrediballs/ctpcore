# 13 — Add a new make, model or brand (Sinotruk C7H, "mechanical for all", …)

**Who this is for:** whoever is loading a new range (Ian, Anton, Michelle with help).
**What it does:** turns a set of filled-in sheets into CTP parts, drawings, hotspots, photos, suppliers and
Zoho items, the same way FAW JH6 is set up. It can be repeated safely and undone.

**Rules it enforces:**
- Nothing in Zoho is ever deleted. Undoing a batch **deactivates** the Zoho items that batch created.
- Zoho prices are never changed. If a part number already exists in Zoho, it is only **linked**.
- An existing part of another make is never overwritten. The sheet is refused instead.
- Every step shows what it *would* do first. Nothing changes until you add `--apply`.

---

## 0. One-time setup on the computer that runs it

1. Install Python 3.10+ and run `pip install pillow openpyxl`.
2. In the `ctpcore` folder, run `npx supabase login` once. The tool finds its own key after that.

## 1. Collect the data (the checklist for each new make)

| # | What | Sheet | Must have? |
|---|---|---|---|
| 1 | Make and model names as they should appear. One **profile** row per model. | `profile` | yes |
| 2 | Zoho GL accounts for this make. Michelle creates "Sales - Sinotruk" and "Cost of Goods Sold - Sinotruk", or decides to reuse existing ones. Inventory Asset is `1429405000000034001`. | `profile` | yes, before the Zoho step |
| 3 | Models, variants (cab or wheelbase) and model years | `vehicles` | yes |
| 4 | **Part list**: part number (= SKU), name, section, side (L/R/C/B), OEM / Aftermarket / Universal | `parts` | yes |
| 5 | Selling price excl. VAT for each NEW part | `parts.list_price_zar` | strongly advised (otherwise the Zoho rate is 0) |
| 6 | Which models and years each part fits, if it's not just "the profile's model" | `fitment` | if parts are shared |
| 7 | Suppliers: name, contact, currency, lead time | `suppliers` | yes |
| 8 | Each supplier's code and cost per part, with one **preferred** supplier per part | `part_suppliers` | yes (the cost becomes the Zoho purchase rate) |
| 9 | Cross-references and alternates: OEM numbers, aftermarket equivalents, supersessions | `xrefs` | nice to have |
| 10 | Exploded-view drawings per section, as PNG or JPG files | `diagrams` | for the drawing view |
| 11 | Callout positions on each drawing (pixel x/y of each number) | `hotspots` | for tap-to-part |
| 12 | One photo per part, taken the way it sits on the truck. JPG/PNG, any size. | `images` | strongly advised |
| 13 | Which rebate / price book the parts join (Hermans etc.) | `price_books` | Ian decides |
| 14 | New section names, if the make has sections FAW doesn't (e.g. Filters) | `sections` | only if new |

Templates are in `docs/templates/`. Use either the CSV files or the single workbook
`new_make_template.xlsx`. Hover a header to see what goes in it; required columns are shown in yellow.
Rows that start with `#` are examples and are skipped. Put pictures in a `pictures/` folder next to the
sheets.

**Next make: Sinotruk C7H.** Start from `docs/templates/sinotruk_c7h_template.xlsx`. Its profile
(make settings) and vehicle rows are already filled in: Zoho Manufacturer "Sinotruk", Brand "C7H", Inventory
Asset as for FAW. The two GL account ids are empty on purpose. The placeholders are "Sales - Sinotruk" and
"Cost of Goods Sold - Sinotruk" until Michelle confirms them; the Zoho step refuses until they are filled.
The same entry as SQL, for review only and not applied, is `tools/onboard/profiles/sinotruk_c7h_profile.sql`.
Ian adds the parts, suppliers, drawings and photos.

A complete worked example is in `tools/onboard/sample_zztest/`, and a universal part is in
`tools/onboard/sample_zztest_universal/`.

**Some choices are fixed:**
- **SKU = the maker's part number** (as for FAW since the Zoho-first migration). It must not already
  exist for another make. If two makes share a number, add a suffix such as `-SIN`.
- **Profile code:** capitals, for example `SINOTRUK_C7H`. Drawing keys: `SINOTRUK_C7H-BMP` (never `SEC<number>`,
  which belongs to FAW JH6).
- **"Mechanical for all" parts** use their own profile:
  - make `All makes`, model `All models`, `default_part_type` Universal;
  - `universal = Y` on each part;
  - no fitment rows needed.

  Zoho requires a Brand on every item, so "All models" is used as the Brand.
- **Zoho Manufacturer** must equal the make, and **Zoho Brand** must equal the model. Zoho copies these
  back into CTP every 15 minutes, so the tool refuses a mismatch.
- **Sections are shared across makes.** Sinotruk bumpers go in section BMP. New ones can be added.

## 2. Check the sheets (changes nothing)

    python tools/onboard/onboard.py validate path/to/sinotruk_c7h.xlsx

This checks every rule: required columns, duplicate SKUs, a part number already used by another make,
unknown sections, suppliers or models, a side that isn't L/R/C/B, prices that aren't numbers, missing
picture files, hotspots outside the drawing, more than one preferred supplier, and a Zoho Manufacturer/Brand
that doesn't match. Fix the errors and run it again. Warnings, such as a missing photo or price, are allowed.

## 3. Dry run into CTP (changes nothing)

    python tools/onboard/onboard.py import path/to/sinotruk_c7h.xlsx --batch SINOTRUK-C7H-2026-11-01

The batch name is yours: use the make and a date. CTP does the whole import, reports the counts
(parts created / updated, fitment, drawings …), and then **undoes all of it**.

## 4. Import into CTP

    python tools/onboard/onboard.py import path/to/sinotruk_c7h.xlsx --batch SINOTRUK-C7H-2026-11-01 --apply

- Pictures are uploaded under names that include a content fingerprint. Phones cache pictures forever,
  so a changed photo gets a new name. Photos also get the small web version the app shows.
- Everything goes in **one transaction**: either all of it or none of it.
- Running it again is safe. Unchanged rows are left alone and nothing is doubled.
- A part that already exists (same make) is updated, but its **price is not**, because Zoho owns prices.
  The tool lists any price differences as warnings.
- Every row created or changed is recorded against the batch, which is what makes undo possible.

## 5. Zoho items

    python tools/onboard/onboard.py accounts                                   # GL account ids in use
    python tools/onboard/onboard.py zoho --batch SINOTRUK-C7H-2026-11-01             # preview
    python tools/onboard/onboard.py zoho --batch SINOTRUK-C7H-2026-11-01 --apply

- **A part number not yet in Zoho** gets a new item. It is set up like the FAW items:
  - unit pcs, inventory tracking;
  - Manufacturer/Brand and GL accounts from the profile;
  - the same tax rules as the existing items;
  - description from the profile's template;
  - first rate = CTP list price, purchase rate = preferred supplier's cost.
- **A part number already in Zoho** is linked and nothing in Zoho is written.
- **The preferred supplier becomes the item's Zoho vendor** if that supplier is already a Zoho contact.
  Zoho's vendor is copied back into the part's "supplier" text every 15 minutes. So ask Michelle to add
  new suppliers as Zoho vendors first, and put their Zoho contact id on the CTP supplier. Otherwise the
  text goes blank. The full supplier list (`part_supplier`) is not affected either way.
- Zoho allows about 100 calls a minute, so the tool works through about 25 items per call and repeats
  until it is done.

## 6. Photos onto the Zoho items

    python tools/onboard/onboard.py images --batch SINOTRUK-C7H-2026-11-01 --apply

## 7. Check it

    python tools/onboard/onboard.py verify --batch SINOTRUK-C7H-2026-11-01
    python tools/onboard/onboard.py status --batch SINOTRUK-C7H-2026-11-01

`verify` reads every Zoho item back: SKU, active, Manufacturer, Brand, unit and image. Then open the
app: the parts show up on phones within a minute.

## 8. Price books (Ian decides)

    python tools/onboard/onboard.py pricebook --batch SINOTRUK-C7H-2026-11-01

This is a **preview only**. It shows the rebate each new part would get in the scheme the batch joined.
Building the book changes the prices customers see in Zoho, so the tool never does it. When Ian agrees,
an admin runs zoho-push `rebate_book` with `apply` (as on 24 Oct).

Zoho allows **one price list per customer**. A customer on rebate across several makes therefore needs
one book that holds all of them. Add the Sinotruk SKUs to the same scheme through the `price_books`
sheet. Consider renaming "FAW JH6 – Rebate" to a customer name first, such as "Hermans – Rebate"
(Ian's call; not done).

## 9. Undo a batch

    python tools/onboard/onboard.py rollback --batch SINOTRUK-C7H-2026-11-01           # preview
    python tools/onboard/onboard.py rollback --batch SINOTRUK-C7H-2026-11-01 --apply

1. **Zoho:** the items this batch *created* are made **inactive** (never deleted). Items it only linked
   are left as they were.
2. **CTP:** rows the batch changed get their old values back. Rows it created are hidden (soft-deleted).
3. **TEST batches only:** `--purge` deletes the rows instead and removes the batch's pictures.

Roll back newer batches first if they depend on older ones (for example, a later batch using an earlier
batch's supplier).

---

## How the data fits together (for the technically curious)

| Need | Where it lives |
|---|---|
| Makes and models, config per make | `make_profile`: Zoho Manufacturer/Brand, GL accounts, unit, default part type, rebate scheme, part-number pattern, lookup URL. The `FAWJH6` row holds what used to be hardcoded. |
| Models, variants, years | `vehicle_model` (+ `year_from`/`year_to`/`engine`, 0079) |
| One part fitting many models | `part_fitment` (part × vehicle, with years) |
| OEM / aftermarket / mechanical-for-all | `part.part_type` (+ 'Universal'), `part.universal` (0079) |
| Several suppliers per part | `part_supplier` (0079; cost, lead time, MOQ, one preferred). `part.supplier` stays as the preferred supplier's name. |
| Cross-references / alternates | `part_xref` (+ type 'alternate', 0079) |
| Drawings and sections per make | `diagram` (make, model, drawing_key) + `hotspot`; sections = `category` (shared) |
| Price books per customer | `rebate_scheme` + `rebate_scheme_sku` → Zoho price list; `customer.zoho_pricebook_id` |
| What a batch did | `import_batch`, `import_batch_row` (before-images for undo) |

Server pieces: `server/0079_make_onboarding.sql` (`onboard_import`, `onboard_rollback`), the edge
function `zoho-onboard` (items / deactivate / verify / accounts), and `tools/onboard/onboard.py`.
**No sync-rule change is needed.** The new tables are server-side only, and `part.universal` arrives with
the part rows.

## FAW/JH6 assumptions found in the code (audit, 26 Oct)

**Fixed now (server side; no change for FAW, checked live):**
- `zoho-push catalogue_set` used to stamp **Manufacturer FAW / Brand JH6 on every active Zoho item missing
  them**. That would have mislabelled every Sinotruk and universal item. It now takes the values from each
  item's CTP part and its make profile, and refuses an explicit value without a SKU list. The live preview
  sets 0 items, as before.
- Zoho item reads stopped after 2,000 items (catalogue sync, `catalogue_set`, rebate book). The limit is
  now 10,000.
- The rebate book flagged every active item outside the scheme. It now flags only items of the makes
  whose profile uses the scheme. The live FAW preview is identical: 154 SKUs, 113 in the book, same tiers,
  same 1 flag.
- FAW's Zoho Manufacturer/Brand, GL accounts ("Sales - FAW", "Cost of Goods Sold - FAW"), rebate scheme,
  part-number pattern and rusauto lookup are now recorded in `make_profile` FAWJH6.

**For after the demo (app screens; left alone tonight on purpose):**
Items 1–4 are planned step by step as a ready-to-run task in `docs/14_MULTI_MAKE_APP_TASK.md`.
1. **Drawings per make.**
   - The section drawing is found as `'SEC' || category id` (backend.web.ts:179, :548, MobileShell:495).
     That is FAW's one drawing per section.
   - Sinotruk drawings import fine and their hotspots work, but the section cards will keep opening FAW's
     drawing.
   - Fix: choose the diagram by (section, make/model) using the existing `diagram.make` / `diagram.model`
     columns, and add a make chooser on the home page.
2. **Find filters.**
   - Make=Sinotruk should also show universal parts.
   - The Model list should follow the chosen Make.
   - Search should respect the filters and show the make (MobileShell:1443-1452, 1585; SEARCH_SQL).
   - `part_fitment` is already on every phone, but the app never reads it.
3. **Jefrey.**
   - The quote heading reads "REQUEST FOR QUOTATION — FAW JH6" (skills.ts:107), and the sample text
     says "JH6".
   - It knows only the JH6 vehicle and FAW part-number shapes (brain.ts:100-152).
   - It can pair an L/H with an R/H across makes (skills.ts:462).
   - Make all of this per make.
4. **Part sheet.**
   - The "Brand" row is the parts maker, which is confusing next to Zoho's Brand (= model).
   - The rusauto lookup button is FAW-only (App.tsx:403). It should come from `make_profile.lookup_url`.
   - The edit form finds the category by name (App.tsx:448).
5. **Section locator art** (`assets/sections/<code>_v2.png`) is the JH6 cab line-art. It needs per-make
   art, or should fall back to the drawing.
6. **New Zoho items** created outside this tool arrive as "New from Zoho" with no make or fitment until the
   next catalogue read (0066 / zoho-sync:251). Pass Manufacturer/Brand through.
7. **The public parts list** (0073 `public_parts`) has no make filter.

## Proof run, 26 Oct 2026 (00:20–01:00 SAST)

**The test data:**
- Fictitious make **ZZTEST Trucks T1**: 2 parts and 2 vehicles (one part fits both, one with model
  years), 2 suppliers on one part, an alternate and an OEM cross-reference, a drawing with 2 hotspots,
  photos, and a TEST rebate scheme.
- Separately, a **universal "mechanical for all"** part with its own new section.

**What was run:**
1. `validate` came back clean. A broken copy was caught with 10 errors, including a clash with real FAW
   part 2801070-1063.
2. The dry run wrote nothing; the counts were checked afterwards.
3. Import with `--apply`, then a second run to confirm nothing doubled.
4. **Zoho:** 3 TEST items created (1429405000000514004, …515001, …520004). Photos uploaded. `verify` was
   OK for SKU, active, Manufacturer/Brand, unit pcs and image.
5. Price-book preview: 25% rebate on both parts. Not applied.
6. Zoho's 15-minute catalogue read kept make, model and part type.

**Cleanup:**
- `rollback --purge --apply` on both batches. The Zoho items are **inactive with 0 stock**; nothing was
  deleted in Zoho.
- In CTP, 0 ZZTEST parts, profiles, suppliers, sections, vehicles, drawings or pictures are left. The
  TEST scheme and the batch records were removed.
- Logs are in `docs/onboard_proof/`.

**What the run found and fixed:**
- Identity counters were behind, because old imports used explicit ids. The import now moves them forward
  first.
- Hotspot radius can't be empty. It now defaults to about 3% of the drawing width.
- Zoho's tax automation refuses a tax id on items. New items now copy the tax rules of an existing item.
- Zoho requires a Brand on every item. Universal parts therefore use "All models".
- A missing Zoho vendor blanks the part's supplier text. The tool now sets the vendor when the supplier is
  a Zoho contact.
