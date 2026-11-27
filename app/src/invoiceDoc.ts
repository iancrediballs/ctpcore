// Pure builder: turn an order + company profile into a print-ready HTML document.
// No React, no app deps — so it's trivially testable and reusable. The app opens
// the returned HTML in a window and calls print(); the OS "Save as PDF" does the
// rest (zero PDF dependencies in the bundle).
//
// LAYOUT = Zoho Books "Standard Template" (Ian, 27 Nov 2026: "make the quote the
// same layout and look as Zoho, mirror"). Copied from the HTML Zoho itself
// renders for this organisation (GET salesorders/{id}?accept=html, SO-00039):
// logo + bold org name + address top left, big entity title + "Quote# …" top
// right, "Bill To" then the dates/Ref# block, a #2E3A4F item-table header with
// # · Item & Description · Qty · Rate · VAT % · VAT · Amount, a photo and the
// item code under each item name, "pcs" under the qty, Sub Total / Standard
// Rate (15%) / shaded Total, then the VAT Summary table, Notes and Terms.
// Same fonts (Open Sans 9pt), colours and spacings as Zoho's stylesheet.

export type DocCompany = {
  name: string; address: string | null; phone: string | null;
  email: string | null; tax_id: string | null; currency: string; terms: string | null;
  // Optional because the desktop's company row does not carry them. Both are
  // owner-edited settings on the web (Settings → Company); a blank one prints
  // nothing, never a placeholder.
  reg_no?: string | null; bank_details?: string | null;
};
export type DocLine = {
  sku: string; name: string; qty: number; unit_price_minor: number; line_total_minor: number;
  // Optional extras the Zoho layout shows when present: the part's photo (an
  // absolute URL), and a customer-facing line note (e.g. "On order · expected …").
  image?: string | null; image_fallback?: string | null; note?: string | null;
};
export type DocOrder = {
  number: string; status: string; created_at: string; fulfilled_at: string | null;
  // Allocated by the database when the invoice is issued (0042). When present
  // it is THE document number and the order number becomes a reference line.
  invoice_no?: string | null; invoiced_at?: string | null;
  customer_name: string; customer_contact: string | null;
  customer_phone: string | null; customer_email: string | null;
  location_code: string;
  lines: DocLine[];
  subtotal_minor: number; tax_rate_bps: number; tax_minor: number; total_minor: number;
  // Zoho's "Ref#" (the customer's PO number) and "Notes". Both optional.
  reference?: string | null; notes?: string | null;
};

// ZAR is the one that matters — the company trades in rand — but the map is
// keyed loosely because the company row has historically carried "Rand" as
// well as "ZAR", and an unrecognised code used to fall through to the ugly
// "ZAR 1234.56" form on a printed tax invoice.
const SYMBOLS: Record<string, string> = {
  ZAR: "R", RAND: "R", R: "R",
  USD: "$", EUR: "€", GBP: "£", CNY: "¥", AED: "AED ",
};

/** The logo Zoho prints on CTP's documents (Settings → Templates in Zoho). */
export const DOC_LOGO_PATH = "/brand/ctp_logo_doc.png";

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

/** Zoho's names: an estimate prints as "Quote", an invoice as "Tax Invoice". */
function docType(status: string, hasTax: boolean): { title: string; numLabel: string; dateLabel: string } {
  if (status === "quote" || status === "confirmed") return { title: "Quote", numLabel: "Quote#", dateLabel: "Quote Date" };
  if (status === "cancelled") return { title: "Quote (Cancelled)", numLabel: "Quote#", dateLabel: "Quote Date" };
  return { title: hasTax ? "Tax Invoice" : "Invoice", numLabel: "Invoice#", dateLabel: "Invoice Date" };
}

export function buildDocHTML(order: DocOrder, company: DocCompany, opts: { logoUrl?: string | null } = {}): string {
  const sym = SYMBOLS[(company.currency ?? "").trim().toUpperCase()] ?? company.currency + " ";
  // Locale pinned rather than left to the machine: a printed tax invoice must
  // not change its number formatting depending on whose PC produced it.
  // Zoho prints amounts as 2,274.40 (no symbol) and only the Total as R12,210.09.
  const n = (c: number) => (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const m = (c: number) => sym + n(c);
  const invoiced = order.status === "invoiced" && !!order.invoice_no;
  // Zoho's date format for this organisation: 2026/11/24.
  const date = ((invoiced ? order.invoiced_at ?? order.fulfilled_at : order.fulfilled_at ?? order.created_at)
    ?.slice(0, 10) ?? order.created_at.slice(0, 10)).replace(/-/g, "/");
  const t = docType(order.status, order.tax_rate_bps > 0);
  const docNumber = invoiced ? order.invoice_no! : order.number;
  const vatPct = (order.tax_rate_bps / 100).toFixed(2);
  const vatName = `Standard Rate (${Number(vatPct)}%)`;
  // Zoho shows VAT per line, each rounded half-up to the cent, and the order's
  // VAT (entity-level rounding) in the totals — exactly what CTP computes.
  const lineVat = (c: number) => Math.floor((c * order.tax_rate_bps + 5000) / 10000);

  const logo = opts.logoUrl === null ? "" : (opts.logoUrl ?? (typeof location !== "undefined" ? location.origin : "") + DOC_LOGO_PATH);

  const rows = order.lines.map((l, i) => {
    const img = l.image
      ? `<span style="float:left"><img src="${esc(l.image)}"${l.image_fallback ? ` onerror="this.onerror=null;this.src='${esc(l.image_fallback)}'"` : ""} style="width:50px;height:50px" class="fit" alt=""></span>`
      : "";
    return `
      <tr class="breakrow-inside">
        <td class="item-row" style="padding:10px 0 10px 5px;text-align:center" valign="top">${i + 1}</td>
        <td class="item-row" style="padding:10px 0 10px 20px" valign="top">
          <div style="${l.image ? "min-height:50px" : ""}">${img}
            <div style="${l.image ? "margin-left:60px;" : ""}max-width:${l.image ? "70%" : "90%"}">
              <span class="bw">${esc(l.name)}</span><br>
              <span class="item-desc bw">${esc(l.sku)}</span>${l.note ? `<br><span class="item-desc bw">${esc(l.note)}</span>` : ""}
            </div>
          </div>
        </td>
        <td class="item-row r" style="padding:10px 10px 5px 10px" valign="top">${l.qty.toFixed(2)}<div class="item-desc">pcs</div></td>
        <td class="item-row r" style="padding:10px 10px 5px 10px" valign="top">${n(l.unit_price_minor)}</td>
        <td class="item-row r lip" valign="top">${vatPct}</td>
        <td class="item-row r lip" valign="top">${n(lineVat(l.line_total_minor))}</td>
        <td class="item-row r lip" valign="top">${n(l.line_total_minor)}</td>
      </tr>`;
  }).join("");

  const billLines = [order.customer_contact, order.customer_phone, order.customer_email]
    .filter(Boolean).map((x) => "\n" + esc(x as string)).join("");

  // Zoho prints the organisation address block as one pre-wrapped run of lines.
  const orgLines = [
    company.address, company.phone, company.email,
    company.reg_no ? "Reg No " + company.reg_no : null,
    company.tax_id ? "VAT " + company.tax_id : null,
  ].filter((x) => x && String(x).trim()).map((x) => esc(String(x).trim())).join("\n");

  const metaRows = [
    [t.dateLabel, date],
    invoiced ? ["Order#", order.number] : null,
    order.reference ? ["Ref#", order.reference] : null,
  ].filter(Boolean).map((r) => `
        <tr>
          <td style="font-size:10pt" class="r edp"><span class="label">${esc(r![0])} :</span></td>
          <td class="r">${esc(r![1])}</td>
        </tr>`).join("");

  const block = (label: string, body: string | null | undefined) => body && body.trim()
    ? `<div style="clear:both;margin-top:30px;width:100%">
         <label class="label" style="font-size:10pt">${label}</label><br>
         <p class="notes" style="margin-top:7px;white-space:pre-wrap;word-wrap:break-word">${esc(body.trim())}</p>
       </div>`
    : "";

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(docNumber)} — ${t.title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  @page { size: A4; margin: 0.7in 0 0.5in 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #ffffff; }
  body { font-family: "Open Sans", -apple-system, "Segoe UI", Roboto, Arial, sans-serif; font-size: 9pt; color: #333333;
    -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .tpl { max-width: 8.27in; margin: 0 auto; background: #ffffff; }
  .body { padding: 0.7in 0.4in 0 0.55in; }
  @media print { .body { padding-top: 0; } }
  .label { color: #333333; }
  .entity-title { font-size: 28pt; color: #000000; }
  .orgname { font-size: 10pt; color: #333333; }
  .customer-name { font-size: 9pt; color: #333333; }
  .itemtable-header { font-size: 9pt; color: #ffffff; background-color: #2E3A4F; word-wrap: break-word; }
  .item-row { font-size: 9pt; border-bottom: 1px solid #adadad; background-color: #ffffff; color: #000000; word-wrap: break-word; }
  .item-desc { color: #333333; font-size: 8pt; }
  .bw { word-wrap: break-word; white-space: pre-wrap; }
  .fit { object-fit: contain; object-position: top; vertical-align: middle; }
  .balance { background-color: #f5f4f3; font-size: 9pt; color: #000000; }
  .totals { font-size: 9pt; color: #000000; background-color: #ffffff; }
  .notes { font-size: 8pt; }
  .r { text-align: right; }
  .edp { padding: 5px 10px 5px 0; }
  .lip { padding: 10px 10px 10px 5px; }
  .breakrow-inside { page-break-inside: avoid; break-inside: avoid; }
  .vat-summary { margin-top: 50px; clear: both; width: 100%; }
  .vat-summary table { margin-top: 10px; width: 100%; table-layout: fixed; }
  .vat-summary .h { padding: 5px 10px 5px 5px; }
  .vat-summary .h:first-child { padding-left: 10px; }
  .vat-summary .b { padding: 10px 10px 5px 10px; }
  .footer { margin-top: 15px; padding: 0 0.4in 0 0.55in; font-size: 8pt; color: #6C718A; }
  .footer div { border-top: 1px solid #adadad; padding-top: 6px; }
  table { border-collapse: collapse; }
</style></head>
<body>
<div class="tpl">
  <div class="body">
    <table style="width:100%;table-layout:fixed">
      <tbody><tr>
        <td style="vertical-align:top;width:50%">
          ${logo ? `<div><img src="${esc(logo)}" style="width:240px;height:72.8px" class="fit" alt="" onerror="this.style.display='none'"></div>` : ""}
          <span class="orgname"><b>${esc(company.name)}</b></span><br>
          <span class="label"><span style="white-space:pre-wrap;word-wrap:break-word">${orgLines}</span></span>
        </td>
        <td style="vertical-align:top;width:50%" class="r">
          <span class="entity-title">${t.title}</span><br>
          <span class="label" style="font-size:10pt"><b>${t.numLabel} ${esc(docNumber)}</b></span>
        </td>
      </tr></tbody>
    </table>

    <table style="width:100%;margin-top:30px;table-layout:fixed">
      <tr>
        <td style="width:60%;vertical-align:bottom;word-wrap:break-word">
          <label class="label" style="font-size:10pt">Bill To</label><br>
          <span style="white-space:pre-wrap"><strong><span class="customer-name">${esc(order.customer_name)}</span></strong>${billLines}</span>
        </td>
        <td style="vertical-align:bottom;width:40%" class="r">
          <table style="float:right;table-layout:fixed;word-wrap:break-word;width:100%"><tbody>${metaRows}
          </tbody></table>
        </td>
      </tr>
    </table>

    <table style="width:100%;margin-top:20px;table-layout:fixed">
      <thead><tr style="height:32px">
        <td class="itemtable-header" style="padding:5px 0 5px 5px;width:5%;text-align:center">#</td>
        <td class="itemtable-header" style="padding:5px 10px 5px 20px;text-align:left">Item &amp; Description</td>
        <td class="itemtable-header r" style="padding:5px 10px 5px 5px;width:11%">Qty</td>
        <td class="itemtable-header r" style="padding:5px 10px 5px 5px;width:11%">Rate</td>
        <td class="itemtable-header r" style="padding:5px 10px 5px 5px;width:11%">VAT %</td>
        <td class="itemtable-header r" style="padding:5px 10px 5px 5px;width:11%">VAT</td>
        <td class="itemtable-header r" style="padding:5px 10px 5px 5px;width:15%">Amount</td>
      </tr></thead>
      <tbody>${rows || `<tr><td colspan="7" class="item-row" style="text-align:center;color:#6C718A;padding:20px">No line items</td></tr>`}</tbody>
    </table>

    <div style="width:100%;margin-top:1px">
      <div style="width:45%;float:left;padding:0 10px 3px 3px"></div>
      <div style="width:50%;float:right">
        <table width="100%" class="totals"><tbody>
          <tr><td class="r edp" valign="middle">Sub Total</td><td style="width:120px" class="r lip" valign="middle">${n(order.subtotal_minor)}</td></tr>
          ${order.tax_rate_bps > 0 ? `<tr style="height:10px"><td class="r edp" valign="middle">${vatName}</td><td style="width:120px" class="r lip" valign="middle">${n(order.tax_minor)}</td></tr>` : ""}
          <tr class="balance" style="height:40px"><td class="r edp" valign="middle"><b>Total</b></td><td style="width:120px" class="r lip" valign="middle"><b>${m(order.total_minor)}</b></td></tr>
        </tbody></table>
      </div>
      <div style="clear:both"></div>
    </div>

    ${order.tax_rate_bps > 0 ? `<div class="vat-summary">
      <label class="label" style="font-size:10pt">VAT Summary</label>
      <table><thead><tr style="height:32px">
        <td class="itemtable-header h">VAT Details</td>
        <td class="itemtable-header h r" style="width:25%">Taxable Amount (${esc(sym.trim())})</td>
        <td class="itemtable-header h r" style="width:17%">VAT Amount (${esc(sym.trim())})</td>
      </tr></thead><tbody>
        <tr>
          <td class="item-row b" valign="top">${vatName}</td>
          <td class="item-row b r" valign="top">${n(order.subtotal_minor)}</td>
          <td class="item-row b r" valign="top">${n(order.tax_minor)}</td>
        </tr>
        <tr>
          <td class="item-row b" valign="top"><b>Total</b></td>
          <td class="item-row b r" valign="top"><b>${m(order.subtotal_minor)}</b></td>
          <td class="item-row b r" valign="top"><b>${m(order.tax_minor)}</b></td>
        </tr>
      </tbody></table>
    </div>` : ""}

    ${block("Notes", order.notes)}
    ${block("Payment Details", company.bank_details)}
    ${block("Terms &amp; Conditions", company.terms)}
  </div>
  <div class="footer"><div></div></div>
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
