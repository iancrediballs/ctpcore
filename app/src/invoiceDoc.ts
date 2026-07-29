// Pure builder: turn an order + company profile into a print-ready HTML document.
// No React, no app deps — so it's trivially testable and reusable. The app opens
// the returned HTML in a window and calls print(); the OS "Save as PDF" does the
// rest (zero PDF dependencies in the bundle).

export type DocCompany = {
  name: string; address: string | null; phone: string | null;
  email: string | null; tax_id: string | null; currency: string; terms: string | null;
};
export type DocLine = {
  sku: string; name: string; qty: number; unit_price_minor: number; line_total_minor: number;
};
export type DocOrder = {
  number: string; status: string; created_at: string; fulfilled_at: string | null;
  customer_name: string; customer_contact: string | null;
  customer_phone: string | null; customer_email: string | null;
  location_code: string;
  lines: DocLine[];
  subtotal_minor: number; tax_rate_bps: number; tax_minor: number; total_minor: number;
};

const SYMBOLS: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", CNY: "¥", AED: "AED " };

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

function docType(status: string, hasTax: boolean): string {
  if (status === "quote" || status === "confirmed") return "Quotation";
  if (status === "cancelled") return "Quotation (Cancelled)";
  return hasTax ? "Tax Invoice" : "Invoice";
}

export function buildDocHTML(order: DocOrder, company: DocCompany): string {
  const sym = SYMBOLS[company.currency] ?? company.currency + " ";
  const m = (c: number) => sym + (c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const date = (order.fulfilled_at ?? order.created_at).slice(0, 10);
  const title = docType(order.status, order.tax_rate_bps > 0);

  const rows = order.lines.map((l, i) => `
    <tr>
      <td class="c">${i + 1}</td>
      <td class="mono">${esc(l.sku)}</td>
      <td>${esc(l.name)}</td>
      <td class="r">${l.qty}</td>
      <td class="r mono">${m(l.unit_price_minor)}</td>
      <td class="r mono">${m(l.line_total_minor)}</td>
    </tr>`).join("");

  const billLines = [
    order.customer_contact, order.customer_phone, order.customer_email,
  ].filter(Boolean).map((x) => `<div>${esc(x as string)}</div>`).join("");

  const compLines = [company.address, company.phone, company.email, company.tax_id ? "Tax ID: " + company.tax_id : null]
    .filter(Boolean).map((x) => `<div>${esc(x as string)}</div>`).join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(order.number)} — ${title}</title>
<style>
  @page { size: A4; margin: 16mm; }
  * { box-sizing: border-box; }
  body { font: 13px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; color: #16202b; margin: 0; }
  .mono { font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #0d1219; padding-bottom: 16px; }
  .co .name { font-weight: 800; font-size: 19px; letter-spacing: .01em; }
  .co .name b { color: #11a06a; }
  .co div { color: #54637a; font-size: 11.5px; }
  .doc { text-align: right; }
  .doc .t { font-size: 26px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; color: #0d1219; }
  .doc .num { font-family: "SF Mono", monospace; font-weight: 700; color: #11a06a; margin-top: 4px; }
  .doc .meta { color: #54637a; font-size: 11.5px; margin-top: 6px; }
  .parties { display: flex; justify-content: space-between; margin: 22px 0 8px; }
  .parties .lbl { text-transform: uppercase; letter-spacing: .08em; font-size: 10px; color: #8493a8; margin-bottom: 4px; }
  .parties .who { font-weight: 700; }
  .parties .right { text-align: right; }
  table { width: 100%; border-collapse: collapse; margin-top: 14px; }
  thead th { text-align: left; font-size: 10px; letter-spacing: .07em; text-transform: uppercase; color: #8493a8; border-bottom: 1.5px solid #0d1219; padding: 8px 8px; }
  tbody td { padding: 9px 8px; border-bottom: 1px solid #e6ebf1; }
  th.r, td.r { text-align: right; } th.c, td.c { text-align: center; width: 28px; color: #8493a8; }
  .totals { margin-top: 14px; margin-left: auto; width: 280px; }
  .totals .row { display: flex; justify-content: space-between; padding: 5px 8px; }
  .totals .grand { border-top: 2px solid #0d1219; margin-top: 4px; font-weight: 800; font-size: 16px; }
  .totals .grand .v { color: #11a06a; }
  .terms { margin-top: 30px; padding-top: 14px; border-top: 1px solid #e6ebf1; color: #54637a; font-size: 11.5px; }
  .terms .lbl { text-transform: uppercase; letter-spacing: .08em; font-size: 10px; color: #8493a8; margin-bottom: 4px; }
  .foot { margin-top: 26px; text-align: center; color: #aab6c6; font-size: 10.5px; letter-spacing: .04em; }
  @media print { .noprint { display: none; } body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
  .bar { background: #0d1219; color: #e6edf3; padding: 10px 14px; display: flex; gap: 10px; align-items: center; font-size: 13px; }
  .bar button { background: #11a06a; color: #04140c; border: 0; border-radius: 7px; padding: 7px 14px; font-weight: 700; cursor: pointer; }
  .bar .ghost { background: transparent; color: #e6edf3; border: 1px solid #2b3b4f; }
</style></head>
<body>
  <div style="padding:6px 2px">
  <div class="head">
    <div class="co">
      <div class="name">${esc(company.name)}</div>
      ${compLines}
    </div>
    <div class="doc">
      <div class="t">${title}</div>
      <div class="num">${esc(order.number)}</div>
      <div class="meta">Date: ${date}<br>Fulfilled from: ${esc(order.location_code)}</div>
    </div>
  </div>

  <div class="parties">
    <div>
      <div class="lbl">Bill To</div>
      <div class="who">${esc(order.customer_name)}</div>
      ${billLines}
    </div>
    <div class="right">
      <div class="lbl">Status</div>
      <div class="who" style="text-transform:capitalize">${esc(order.status)}</div>
    </div>
  </div>

  <table>
    <thead><tr>
      <th class="c">#</th><th>SKU</th><th>Description</th>
      <th class="r">Qty</th><th class="r">Unit</th><th class="r">Amount</th>
    </tr></thead>
    <tbody>${rows || `<tr><td colspan="6" style="text-align:center;color:#8493a8;padding:20px">no line items</td></tr>`}</tbody>
  </table>

  <div class="totals">
    <div class="row"><span>Subtotal</span><span class="mono">${m(order.subtotal_minor)}</span></div>
    <div class="row"><span>Tax (${(order.tax_rate_bps / 100).toFixed(2)}%)</span><span class="mono">${m(order.tax_minor)}</span></div>
    <div class="row grand"><span>Total</span><span class="v mono">${m(order.total_minor)}</span></div>
  </div>

  ${company.terms ? `<div class="terms"><div class="lbl">Terms</div>${esc(company.terms)}</div>` : ""}
  <div class="foot">Generated by CTP Core · ${esc(company.name)}</div>
  </div>
</body></html>`;
}

// Tauri/WebView2 blocks window.open("_blank") (returns null), so the old popup
// path silently did nothing — quotes/invoices never displayed or printed. Instead
// we render the document into a full-screen in-app overlay backed by an <iframe>
// (its own document, so the @page A4 + print styles apply), and print THAT frame.
export function openPrintWindow(html: string) {
  document.getElementById("ctp-print-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "ctp-print-overlay";
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:9999;background:rgba(6,10,15,.82);" +
    "display:flex;flex-direction:column;backdrop-filter:blur(2px);";

  const bar = document.createElement("div");
  bar.className = "noprint";
  bar.style.cssText =
    "flex:0 0 auto;display:flex;gap:10px;align-items:center;" +
    "background:#0d1219;color:#e6edf3;padding:10px 14px;font:13px/1.4 -apple-system,'Segoe UI',Roboto,sans-serif;";
  bar.innerHTML =
    "<span style='flex:1'>Preview — use <b>Print / Save as PDF</b> to export.</span>";

  const printBtn = document.createElement("button");
  printBtn.textContent = "Print / Save PDF";
  printBtn.style.cssText =
    "background:#11a06a;color:#04140c;border:0;border-radius:7px;padding:7px 14px;font-weight:700;cursor:pointer;";

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "Close";
  closeBtn.style.cssText =
    "background:transparent;color:#e6edf3;border:1px solid #2b3b4f;border-radius:7px;padding:7px 14px;font-weight:700;cursor:pointer;";

  const frame = document.createElement("iframe");
  frame.style.cssText = "flex:1;width:100%;border:0;background:#fff;";
  frame.setAttribute("title", "Document preview");
  frame.srcdoc = html;

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  const doPrint = () => {
    const win = frame.contentWindow;
    if (!win) return;
    win.focus();
    win.print();
  };

  printBtn.onclick = doPrint;
  closeBtn.onclick = close;
  document.addEventListener("keydown", onKey);

  bar.append(printBtn, closeBtn);
  overlay.append(bar, frame);
  document.body.appendChild(overlay);
  // focus the frame once loaded so Ctrl+P targets the document too
  frame.addEventListener("load", () => frame.contentWindow?.focus());
}
