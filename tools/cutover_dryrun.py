"""CTP Core — cut-over DRY RUN (docs/09). Read-only: builds the plan, changes nothing.

Input:  zoho_transactions.json from zoho-auth {action:"cutover_dryrun"} (list endpoints only).
Output: <out>.xlsx and <out>.json with
  1. Delete plan  — every Zoho transaction, in the order the wipe must run
     (payments → credit notes → invoices → sales orders → estimates →
      vendor payments → bills → purchase orders; Inventory documents once readable).
  2. Opening invoices — Michelle (23 Oct): Hermans' opening receivables go in
     ITEMISED, one opening invoice per open original. Each keeps the original
     number, date, due date and amount in its reference/notes; the amount is the
     open BALANCE; the new invoice number comes from the restarted series.
  3. Open supplier bills — re-entered the same way (original bill no. kept as
     the bill number / reference, open balance).
  4. Number series — every series restarts at 00001 (Michelle, 23 Oct).
  5. Checks — totals that must agree before and after.

Usage: python tools/cutover_dryrun.py <zoho_transactions.json> <out prefix>
"""
import json, sys
from collections import Counter, defaultdict

src, out = sys.argv[1], sys.argv[2]
d = json.load(open(src, encoding="utf-8-sig"))
docs = d["docs"]
f = lambda x: float(x or 0)

ORDER = ["customerpayment", "creditnote", "invoice", "salesorder", "estimate", "vendorpayment", "bill", "purchaseorder"]
WHY = {
    "customerpayment": "payments first: an invoice with a payment applied cannot be deleted",
    "creditnote": "credit notes next: applied credits block the invoice delete (refunds/applications removed with them)",
    "invoice": "invoices after their payments/credits; before the sales orders they came from",
    "salesorder": "sales orders after their invoices (and packages/shipments, Inventory)",
    "estimate": "estimates after the sales orders converted from them",
    "vendorpayment": "supplier payments before the bills they pay",
    "bill": "bills after their payments (and purchase receives, Inventory)",
    "purchaseorder": "purchase orders last, after their bills/receives",
}
plan = []
for step, kind in enumerate(ORDER, 1):
    for x in sorted([x for x in docs if x["kind"] == kind], key=lambda x: (x.get("date") or "", x.get("number") or "")):
        plan.append({"step": step, "kind": kind, "number": x["number"], "status": x["status"], "date": x["date"],
                     "contact": x["contact"], "total": f(x["total"]), "balance": f(x["balance"]), "reference": x["reference"],
                     "zoho_id": x["id"], "why_here": WHY[kind]})
inv_steps = {"packages / shipments": "before sales orders (step 4)", "purchase receives": "before bills (step 7)",
             "inventory adjustments, transfer orders": "after everything else; stock must read 0"}

# 2. itemised opening invoices (any customer with an open balance; Hermans today)
open_inv = [x for x in docs if x["kind"] == "invoice" and f(x["balance"]) > 0.004 and x["status"] not in ("void", "draft")]
opening = []
for i, x in enumerate(sorted(open_inv, key=lambda x: (x["contact"] or "", x["date"] or "", x["number"] or "")), 1):
    opening.append({
        "new_number": f"INV-{i:06d}",                       # the restarted series (Zoho assigns it; shown for the check)
        "customer": x["contact"], "customer_id": x["contact_id"],
        "invoice_date": x["date"], "due_date": x["due_date"],  # original dates kept, so ageing and statements stay true
        "reference": f"Opening balance — {x['number']}",      # original number carried as the reference
        "line": f"Opening balance: {x['number']} dated {x['date']} (original total R{f(x['total']):,.2f}, open R{f(x['balance']):,.2f})",
        "amount": round(f(x["balance"]), 2), "original_total": f(x["total"]),
        "tax": "none — VAT was accounted on the original", "account": "Opening balance (Michelle to confirm the account)",
        "original_number": x["number"], "original_status": x["status"]})

# 3. open supplier bills
open_bills = [x for x in docs if x["kind"] == "bill" and f(x["balance"]) > 0.004 and x["status"] not in ("void", "draft")]
bills = [{"vendor": x["contact"], "vendor_id": x["contact_id"], "bill_number": x["number"], "bill_date": x["date"],
          "due_date": x["due_date"], "reference": f"Opening balance — {x['number']}", "amount": round(f(x["balance"]), 2),
          "original_total": f(x["total"]), "tax": "none — VAT claimed on the original", "status_before": x["status"]}
         for x in sorted(open_bills, key=lambda x: (x["contact"] or "", x["date"] or ""))]

# 4. number series, all restart at 00001
series = [{"series": s, "restart_at": "00001", "where": "Zoho Settings → Preferences → <module> → transaction number series",
           "by": "Michelle (UI), after the wipe and before the opening invoices"} for s in
          ["Invoices (INV-)", "Estimates / quotes (QT-)", "Sales orders (SO-)", "Credit notes (CN-)", "Customer payments",
           "Purchase orders (PO-)", "Bills (supplier numbers are kept as entered)", "Vendor payments",
           "Packages (PKG-)", "Shipments (SH-)", "Purchase receives (PR-)", "Inventory adjustments", "Transfer orders"]]

ar = defaultdict(float)
for x in open_inv: ar[x["contact"]] += f(x["balance"])
checks = {
    "documents_to_delete": len(plan), "by_kind": dict(Counter(p["kind"] for p in plan)),
    "receivables_open_total": round(sum(f(x["balance"]) for x in open_inv), 2),
    "receivables_by_customer": {k: round(v, 2) for k, v in ar.items()},
    "opening_invoices": len(opening), "opening_invoices_total": round(sum(o["amount"] for o in opening), 2),
    "payables_open_total": round(sum(f(x["balance"]) for x in open_bills), 2), "opening_bills": len(bills),
    "unapplied_credit_notes": [p["number"] for p in plan if p["kind"] == "creditnote" and p["balance"] > 0.004],
    "inventory_documents": d.get("inventory", {}), "unreadable": d.get("unreadable", {}),
    "rule": "after the wipe + re-import: customer balances and supplier balances must equal these totals to the cent",
}
json.dump({"read_at": d.get("read_at"), "checks": checks, "delete_plan": plan, "opening_invoices": opening,
           "opening_bills": bills, "number_series": series}, open(f"{out}.json", "w"), indent=1, default=str)

from openpyxl import Workbook
from openpyxl.styles import Font
wb = Workbook(); ws = wb.active; ws.title = "Read me"
for line in ["CTP Core cut-over — DRY RUN (read-only; nothing was changed)", f"Zoho read at {d.get('read_at')}",
             "Nothing in this file runs without Ian's explicit go on the day.", "",
             "Michelle 23 Oct: no VAT returns filed (deletes allowed); opening receivables ITEMISED; number series restart at 00001.", ""]:
    ws.append([line])
ws["A1"].font = Font(bold=True, size=13)
for k, v in checks.items(): ws.append([k.replace("_", " "), json.dumps(v) if isinstance(v, (dict, list)) else v])
for title, rows in [("1 Delete plan", plan), ("2 Opening invoices", opening), ("3 Open supplier bills", bills), ("4 Number series", series)]:
    sh = wb.create_sheet(title)
    if not rows: sh.append(["(none)"]); continue
    cols = list(rows[0].keys()); sh.append(cols)
    for c in sh[1]: c.font = Font(bold=True)
    for r in rows: sh.append([r[c] for c in cols])
    sh.freeze_panes = "A2"
sh = wb.create_sheet("Inventory docs (order)")
sh.append(["documents", "delete when"]); [sh.append([k, v]) for k, v in inv_steps.items()]
wb.save(f"{out}.xlsx")
print(json.dumps(checks, indent=1, default=str))
