# CTP Core — Internal Part Identity & Naming Convention

**Version 1.0 · June 2026 · Internal / Supply-Chain Confidential**

Every part in CTP Core carries **three identifiers**, each with one job. Staff
never have to memorise OEM numbers, and customers never see them.

| # | Identifier | Audience | Example | Job |
|---|------------|----------|---------|-----|
| 1 | **Public SKU** | Customers (invoices, website, quotes) | `CTP-FND-001-L` | Sell the part without exposing the supply chain |
| 2 | **Internal Locator** | Staff (sales, admin, stock-take) | `FAW-JH6-D314-033` | Instantly find the part on its exploded diagram |
| 3 | **Catalogue PN** | Supplier ordering | `2803035B1063` | Reorder stock from the OEM |

> The Public SKU rules are unchanged (see `China_Truck_Parts_Naming_Convention`).
> This document defines identifiers **2** and **3** — the internal side.

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
Locator      FAW-JH6-D314-033     ← what staff search / read off the shelf label
Public SKU   CTP-FND-001-L        ← what the customer sees
Catalogue PN 2803035B1063         ← what you order more of
Inventory PN 2803035B1063-DQ      ← the exact variant actually received (-DQ grade)
```

### Why Make-Model-Drawing-Item?
- **Self-locating.** A staffer holding the part, or looking at a customer's
  truck, reads the diagram and finds the exact balloon number — no lookup table.
- **Globally unique.** Within a model, the (drawing, item) pair is unique, so the
  full locator never collides.
- **Sorts naturally.** Zero-padded items keep `…-009` before `…-010`.
- **Survives re-pricing / re-SKUing.** The locator is tied to the physical part
  and its drawing, not to commercial decisions.

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

- Public SKU, Internal Locator, name, side, category
- `catalogue_pn` / `inventory_pn` (admin & reordering)
- `qty_on_hand` (live from the append-only `stock_movement` ledger)
- `primary_image` — the cleaned product photo
- `diagram_image` + `diagram_item` — the exploded view and the balloon number to circle
- `model_3d` — optional `.glb` for the 3D viewer

A part is findable by **any** of its numbers — public SKU, locator, OEM
catalogue PN, the exact `-DQ` variant, MPN, or any cross-reference — through the
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
