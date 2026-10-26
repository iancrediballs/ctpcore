# Zero Zoho: prepared 26 Oct 2026 — DONE 26 Oct (see HANDOFF "ZOHO ZEROED" and ZERO_LOG.txt)

This plan was written read-only before GO. It was carried out on 26 Oct; ctp_reset_RUN.sql and ctp_stock_rebase_RUN.sql are what ran.

## 1. Backup (done, verified)
`C:\Users\iancr\OneDrive\Desktop\CTP Zoho Backup 2026-10-26\` (read 10:20 UTC)

**Zoho** (`zoho\`, JSON + `csv\`; the counts are in `COUNTS.json`):

| Type | Count |
|---|---|
| Estimates | 4 |
| Sales orders | 10 |
| Invoices | 27 |
| Credit notes | 5 |
| Customer payments | 3 |
| Bills | 7 |
| Packages | 7 |
| Shipments | 7 |
| Vendor payments, POs, purchase receives, adjustments, transfer orders, sales receipts | 0 each |

- **Full detail:** all 49 invoices, SOs, bills and credit notes, with lines (0 read errors).
- **Raw Inventory records:** 7 packages, 7 shipments, 10 SOs.
- **Estimates:** in full.
- **Master data:** items 165, contacts 13 (with full detail), price books 2 (with rates), settings (taxes, templates, webhooks, workflows, users, locations), and stock on hand per item.
- **Not readable on our token (401):** **journals** and **expenses**. Michelle must check these in Zoho and export them if there are any. Her own Zoho export (Settings → Data backup) is still recommended as a second copy (docs/09 Q4).

**CTP** (`ctp\tables\*.json`): all 64 public tables, 3,729 rows. Each export's row count was checked against `count(*)`, with 0 mismatches (`ctp\COUNTS.json`).
- Schema = the migrations in the repo (`server/00xx_*.sql`, main 825fb7a).
- `supabase db dump` needs Docker, which this PC doesn't have. Supabase's own daily backup still applies.

## 2. Dry run: what the zero deletes (`delete_plan.csv`, in execution order)
**70 documents: 39 real and 31 test.**

| # | Step | Count | Notes |
|---|---|---|---|
| 1 | Customer payments | 3 | All test (INV-000009/10/12). |
| 2 | Credit notes | 5 | Hermans CN-00001–003 are **closed**, applied to DS000005, DS000012 and DS000017: remove each credit application first, then delete. CN-00004/5 (test rebate) are void: delete. |
| 3 | Shipments | 7 | Before packages. Deleting a delivered shipment puts its physical stock back. |
| 4 | Packages | 7 | Before their sales orders. |
| 5 | Invoices | 27 | 19 Hermans DS (open R1,757,210.30), INV-000005/6 (Hermans SO-00011/12), 6 test. |
| 6 | Sales orders | 10 | SO-00011/12 Hermans, 8 test. Open SO-00022/23: delete. |
| 7 | Estimates | 4 | All test. |
| 8 | Bills | 7 | Supalift PI000001–004, Multicat ×3; open R2,024,950.90. Last, because they carry the stock in; Zoho refuses deleting a bill whose stock is still used. |

The plan **keeps**:
- items, contacts (Hermans' VAT no.), the rebate contacts, and both price books;
- settings, taxes, templates, the location, users, the chart of accounts, workflow rules and webhooks, and the OAuth link.

**Zoho won't allow, or the API can't do:**
- **Number series reset to 00001:** Settings only (Michelle), after the deletes and before any new document.
- **Journals and expenses:** not on our token. Michelle deletes them by hand if any exist.
- **Bank reconciliations or matched payments:** these block deletes. Michelle un-reconciles them first.
- **Sales-rebate offset journals (docs/14):** none yet, because the journals scope isn't on the token.

**Who runs the deletes:**
- There is no bulk-delete action deployed. `inv_fixture` only deletes TEST-marked documents.
- **Scripted:** a reviewed `cutover_delete` action reads `delete_plan.csv`, goes type by type and re-checks after each type. That needs an edge-function deploy, which is blocked by my permission check. Ian has to allow it, or deploy it himself.
- **By hand:** Michelle deletes the 70 in the same order.

## 3. CTP side (`ctp_reset_DRAFT.sql`, not run)
- **Orders:** 31 orders have Zoho links, 14 of them still live.
  - All get `deleted_at` and `zoho_do_not_push`.
  - All estimate, SO, invoice, package and shipment refs are cleared.
  - Each old ref is written into the staff log first, so the history keeps it.
- **Holds:** released, so available = on hand.
- **Read-back state:**
  - `push_from` = go-live;
  - `rebate_doc_seen` is cleared, after one `rebate_accrue` run following the deletes so test accruals reverse to 0. Hermans has no accruals yet; its rebate starts 26 Oct.
- **Stock:** `stock_master` **stays 'ctp'** until the opening stock is posted and checked.
- **Numbering:** Zoho series restart at 00001 (Michelle). CTP's own RQ-yymmdd-N numbers come from the order id and are kept, because history is kept.

**Opening stock (`opening_stock.csv`), 156 lines:**

| | Units |
|---|---|
| CTP on hand now | 808 |
| Zoho physical now | 930 |
| **Recommended opening** | **966**, about **R575,169** at purchase rate |

- **How 966 is reached:** CTP plus the Supalift shipment CTP's opening load missed. Ian confirmed on 23 Oct that both deliveries arrived (docs/08).
- **36 lines are flagged `count_needed`.** The 24 counts and the 12 document checks approved on 23 Oct were **never recorded**: there are no count movements since.
- **One item isn't stock-tracked in Zoho** (CTP-CBY-001-C): turn tracking on first.
- **Michelle checks** that the stock value equals the Inventory Asset opening balance.

## 4. Stock master flip to Zoho (after the re-import)
1. After the wipe, Zoho stock is 0 everywhere (`stock_sync` → every `zoho_item` 0).
2. Post **one opening-stock adjustment**, dated go-live, reason "Opening stock — stock take 27 Oct": quantity = the approved `opening_qty_recommended` (after the counts); value = purchase rate.
   - Either Michelle imports the CSV, or a reviewed API action posts it. `zoho-push adjust` is per item (counted − physical) and would also work, as 155 calls.
3. `stock_sync`, then reconcile: Zoho physical = the opening file on every line, and accounting = physical.
4. Rebase CTP to match:
   - **CTP stock:** add one `cutover` adjustment per part to bring the CTP ledger to the same opening figures.
   - **Freeze switch:** `ctp_ledger_frozen = true`, which refuses everything except origin 'cutover'.
5. Admin: Settings → Zoho → **Stock master = Zoho** (`set_zoho_stock_master('zoho')`). From then on Fulfil ships in Zoho, counts post to Zoho, receiving = purchase receive, and phones read the Zoho cache.
6. Smoke test: one real order end to end, quote → estimate → accept → SO → invoice sent → ship. Stock goes down by 1 in Zoho and in the app.
7. Next day: re-run the reconciliation. It should be all match.

## 5. Risks
1. **Deletes are irreversible.** Rollback = Michelle re-imports from this backup, or Zoho support.
2. **Michelle's re-entry tomorrow:** each Hermans invoice must go in with reference **"Opening balance — DS0000xx"** and as a **non-item line** (opening-balance account, no VAT), as docs/09 §3.5 says.
   - With item lines, every one would take stock out of Zoho's accounting stock and post cost of sales again, so physical and accounting stock would no longer match.
   - Without that reference, the live Hermans rebate accrual would earn rebate on old invoices dated after 26 Oct. The accrual skips "Opening balance" references.
3. **The counts weren't done.** 36 items have an unconfirmed opening quantity. Either count them tonight or accept the recommended figures and correct them later with count adjustments.
4. **Supplier bills:** the 7 bills (R2.02m) must be re-entered as opening bills too, or CTP's payables to Supalift disappear from Zoho.
5. **Journals and expenses** couldn't be checked from here.
6. **Hermans' accrual switch (other session) is live:** run the CTP reset only after the deletes, so the accrual sees the deleted documents and reverses them cleanly.

## 6. Timing (on the day, after GO)

| Step | Scripted | By hand |
|---|---|---|
| Deletes (70 documents) | ~20 min | ~1.5–2 h (Michelle) |
| Michelle: number series, any un-reconciling | ~15 min | |
| CTP reset (SQL) | ~2 min | |
| Opening stock: post + sync + reconcile | ~20 min | |
| Flip + smoke test | ~20 min | |
| **Total** | **~1.5 h** | **~3 h** |

Michelle's invoice re-entry comes on top.
