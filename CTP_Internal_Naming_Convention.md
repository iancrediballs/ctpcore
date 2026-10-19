# CTP Core — Part Identity & Naming Convention

**Version 2.0 · 19 October 2026 · Internal**

> **What changed in 2.0 (Ian's decision, 19 Oct 2026).** CTP Core shows OEM
> numbers. The **OEM / Multicat code is the primary item code everywhere**:
> on screen, on quotes and invoices, in the client portal, and in Zoho, where it
> is the item SKU. The `CTP-xxx` codes (`CTP-FND-001-L` …) are **no longer
> customer-facing codes and no longer hide the supplier number**. They are kept
> only as a **legacy alias**, so old paperwork and habits still find the part.
> Version 1.0's rule that "customers never see OEM numbers" is withdrawn.

Every part in CTP Core carries these identifiers, each with one job:

| # | Identifier | Field | Audience | Example | Job |
|---|------------|-------|----------|---------|-----|
| 1 | **Item code** (= Multicat code = Zoho SKU) | `part.sku` | Everyone: staff, customers, Zoho, Multicat | `5103121-H02-G` | The one code a part is bought, sold, stocked and invoiced under |
| 2 | **Internal Locator** | `part.locator` | Staff (sales, admin, stock-take) | `FAW-JH6-D314-033` | Instantly find the part on its exploded diagram |
| 3 | **Catalogue PN** | `part.catalogue_pn` | Supplier ordering | `2803035B1063` | The base OEM number quoted to the supplier |
| — | *Legacy CTP code* (alias only) | `part_xref` (`xref_brand = 'CTP legacy'`, `xref_type = 'supersession'`) | Nobody new | `CTP-FND-001-L` | Still searchable, so old quotes and labels resolve; never printed on new documents |

### 0. The item code

- **Source of truth: Multicat.** The item code is the Multicat part code
  exactly as Multicat holds it, *including* its variant suffix (`-G`, `-DQ`,
  `-C00`, `-H02` …). Example: `2803035B1063-DQ`, not `2803035B1063`.
- **It is the Zoho SKU.** CTP Core `part.sku`, the Zoho Books/Inventory item SKU
  and the Multicat code are the same string. A Zoho bill or invoice line, a
  Multicat GR/GI document and a CTP Core order line all name the same item.
- **Matching Zoho.** CTP Core links each part to its Zoho item by Zoho Item ID
  (`zoho_item` table). Item name, selling price (Zoho *Rate*) and landed cost
  (Zoho *Purchase Rate* = Multicat landed cost) follow Zoho/Multicat.
- **New parts** get their code in Multicat first, then in Zoho, then in CTP Core.
  No code is invented in CTP Core.
- **One code, one part.** Where Multicat puts two physical parts under one code
  (e.g. `5300010-H02-DQ`), or one code is used on both sides
  (`5407025-B45`), the second part is **flagged** and keeps its legacy code until
  Multicat gives it its own code. It is never silently merged.
- **L/H-or-R/H items.** Where Multicat holds a single item for both sides
  (e.g. `6109015-B45-C00` "Front Door Limiter L/H or R/H"), CTP Core keeps one
  active part and marks the other side's old row `superseded`.

### Legacy CTP codes

The old `CTP-AAA-NNN-S` codes (category · number · side) were the customer-facing
SKU from June to October 2026. On 19 Oct 2026 (migrations `server/0046` and
desktop `0025`) every part was renamed in place to its Multicat code and its old
code was written to `part_xref` as a `CTP legacy` supersession. Part ids did not
change, so order history, photos and diagram markers are unaffected. The full
old → new → Zoho Item ID list is `data/zoho_multicat_items_2026-10-19.csv`.

Rules for legacy codes:
1. Searchable everywhere a part number is (the search covers every xref).
2. Never printed on a new quote, invoice, label or Zoho document.
3. Never reissued: a `CTP-` code is not given to a different part.

---

## 1. The Internal Locator

```
        FAW  -  JH6  -  D314  -  033
        └─┬┘    └┬┘     └─┬┘     └┬┘
         MAKE  MODEL   DRAWING   ITEM
```

| Token | Meaning | Rule | Example |
|-------|---------|------|---------|
| **MAKE** | Truck manufacturer | 3-letter code | `FAW` |
| **MODEL** | Truck model | Short model code, no spaces | `JH6` |
| **DRAWING** | Exploded diagram the part appears on | `D` + drawing number (matches `diagram.drawing_key`) | `D314` |
| **ITEM** | Balloon/callout number on that diagram | 3-digit, zero-padded | `033` |

**Worked example** — Front Fender L/H, item 33 on drawing 314 of the FAW JH6:

```
Item code    5103121-H02-G        ← THE code: screens, quotes, invoices, Zoho SKU, Multicat
Locator      FAW-JH6-D314-033     ← what staff search / read off the shelf label
Catalogue PN 5103121-B45          ← base OEM number quoted to the supplier
Inventory PN 5103121-H02-G        ← the exact variant actually received (H02 cab, -G colour)
Legacy code  CTP-FND-001-L        ← alias only: still finds the part, never printed
```

### Why Make-Model-Drawing-Item?
- **Self-locating.** A staffer holding the part, or looking at a customer's
  truck, reads the diagram and finds the exact balloon number — no lookup table.
- **Globally unique.** Within a model, the (drawing, item) pair is unique, so the
  full locator never collides.
- **Sorts naturally.** Zero-padded items keep `…-009` before `…-010`.
- **Survives re-pricing / re-SKUing.** The locator is tied to the physical part
  and its drawing, not to commercial decisions. (Proved on 19 Oct 2026: every
  SKU changed from `CTP-xxx` to the Multicat code and no locator moved.)

### Rules
1. **MAKE / MODEL come from a controlled list** (`vehicle_model` table). New
   trucks are added there first, never invented ad-hoc.
2. **DRAWING must exist as a `diagram` row** before a part can reference it.
   `part.drawing_no` = `diagram.drawing_key`.
3. **ITEM is the diagram balloon number**, stored in `part_diagram_callout.item_no`.
   It is *not* a free sequence — it must match what's printed on the diagram.
4. **One part may appear on several diagrams** (e.g. a sub-assembly shown in two
   sections). The locator uses its **primary** diagram; the others are still
   linked via `part_diagram_callout` with `is_primary = 0`.
5. **The locator is generated, not hand-typed:**
   `MAKE || '-' || MODEL || '-' || drawing_no || '-' || printf('%03d', diagram_item_no)`.

---

## 2. Reorder reference (the OEM side)

Two OEM numbers are stored against every part so reordering is unambiguous:

| Field | What it is | Use |
|-------|-----------|-----|
| `catalogue_pn` | Base OEM catalogue part number | The number you quote the supplier to reorder |
| `inventory_pn` | The exact variant received, incl. suffix (`-DQ`, `-G`, `_C.3`) | Audit / discrepancy trail; confirms grade actually in stock |

Suffix meanings seen in Shipment 01: `-DQ` (grade/spec variant), `-G`
(colour/trim variant), `_C.3` / `_B` (revision). When `inventory_pn` ≠
`catalogue_pn`, the difference is captured in the discrepancy notes so the
supplier confirms grade before the next order.

---

## 3. How a part is identified visually (sales / admin / stock-take)

`SELECT * FROM part_detail WHERE …` returns, in one row, everything a screen needs:

- Item code (OEM / Multicat code), Internal Locator, name, side, category
- `catalogue_pn` / `inventory_pn` (admin & reordering)
- `qty_on_hand` (live from the append-only `stock_movement` ledger)
- `primary_image` — the cleaned product photo
- `diagram_image` + `diagram_item` — the exploded view and the balloon number to circle
- `model_3d` — optional `.glb` for the 3D viewer

A part is findable by **any** of its numbers — item code, legacy CTP code,
locator, OEM catalogue PN, the exact `-DQ` variant, MPN, or any cross-reference — through the
single FTS5 trigram index (`part_search`). Quote hyphenated queries as a phrase,
e.g. `MATCH '"FAW-JH6-D314"'`.

---

## 4. Data model (added in migration `0006_media_locator.sql`)

```
part            + make, model, drawing_no, diagram_item_no, locator,
                  catalogue_pn, inventory_pn, side
diagram               exploded views / section views (+ optional section .glb)
part_diagram_callout  part ↔ diagram, with the balloon item_no (primary flag)
part_image            photos / renders / raw shots (primary flagged)
part_model            per-part 3D model (.glb)
part_detail (view)    one-row card for sales / admin / stock-take
```

Media are referenced by **relative path** (e.g. `assets/diagrams/Drw_314.png`)
so the install stays self-contained and offline-resilient. The importer maps the
Multi-Cat folder's diagrams, `part_photos`, and `part_models` onto these tables.
