/* ==========================================================================
   JEFREY — capabilities beyond identification.
   --------------------------------------------------------------------------
   Nothing here invents a number. Each skill reads the catalogue, reads the
   ledger, or does arithmetic you could check by hand. Where a skill makes an
   assumption (VAT, sea-freight lead time) it prints it rather than burying it.
   ========================================================================== */
import { canonPN, samePart, normalise, expand, trigrams, relevance, extractQty, isChatter, } from "./brain";
export const VAT_RATE = 0.15; // South Africa
export const LEAD_STOCK = "same day";
export const LEAD_BACKORDER = "6–8 weeks (sea)";
export const LOW_STOCK = 3;
export const money = (n) => "R" + (n || 0).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (n) => (n * 100).toFixed(1) + "%";
/* A space-separated suffix must start with a letter. Without that guard,
   "0445120215 2" on a packing list reads as one 11-digit part number and the
   quantity vanishes into it — while "2803035 B1063" still parses correctly. */
const PN_RE = /\b[0-9]{4,}[A-Z0-9]*(?:-[A-Z0-9]{1,6}|\s[A-Z][A-Z0-9]{0,5})?\b/gi;
/** Rows Jefrey resolved, paired with the operator's chosen candidate. */
export function resolved(rows) {
    return rows
        .map((row) => ({ row, cand: row.candidates[row.chosen] }))
        .filter((x) => !!x.cand)
        .map((x) => ({ row: x.row, part: x.cand.part }));
}
export function buildQuote(rows) {
    const lines = resolved(rows).map(({ row, part }) => {
        const avail = Math.min(row.qty, Math.max(0, part.qty));
        const back = row.qty - avail;
        const ext = part.list * row.qty;
        const cost = part.cost * row.qty;
        return {
            qty: row.qty, part, unit: part.list, ext, cost,
            margin: ext > 0 ? (ext - cost) / ext : 0,
            avail, back,
            lead: back > 0 ? (avail > 0 ? "part now, part " + LEAD_BACKORDER : LEAD_BACKORDER) : LEAD_STOCK,
            negative: part.cost >= part.list && part.list > 0,
        };
    });
    const sub = lines.reduce((s, l) => s + l.ext, 0);
    const cost = lines.reduce((s, l) => s + l.cost, 0);
    return {
        lines, sub, cost, vat: sub * VAT_RATE, total: sub * (1 + VAT_RATE),
        margin: sub > 0 ? (sub - cost) / sub : 0,
        unresolved: rows.length - lines.length,
        backordered: lines.filter((l) => l.back > 0).length,
        // The one thing a quoting tool must never do quietly: sell below cost.
        negativeLines: lines.filter((l) => l.negative),
        assumptions: [
            `VAT at ${pct(VAT_RATE)}`,
            `In-stock lines ${LEAD_STOCK}; shortfalls ${LEAD_BACKORDER}`,
            "List prices as held in the catalogue — not re-checked with the supplier",
        ],
    };
}
export function buildRFQ(rows) {
    const need = [];
    rows.forEach((r) => {
        const cand = r.candidates[r.chosen];
        if (!cand) {
            need.push({ kind: "unknown", qty: r.qty, phrase: r.phrase, part: null });
            return;
        }
        const short = r.qty - Math.max(0, cand.part.qty);
        if (short > 0)
            need.push({ kind: "shortfall", qty: short, phrase: r.phrase, part: cand.part });
    });
    const groups = {};
    need.forEach((n) => {
        const k = n.part ? n.part.section || "UNSECTIONED" : "UNIDENTIFIED";
        (groups[k] = groups[k] || []).push(n);
    });
    const out = ["REQUEST FOR QUOTATION — FAW JH6", ""];
    Object.keys(groups).sort().forEach((sec) => {
        out.push(`## ${sec}`);
        groups[sec].forEach((n) => {
            out.push(n.part
                ? `  ${String(n.qty).padStart(4)} × ${(n.part.cat_pn || n.part.inv_pn).padEnd(20)} ${n.part.name}${n.part.dwg ? `   [dwg ${n.part.dwg}]` : ""}`
                : `  ${String(n.qty).padStart(4)} × ???                  "${n.phrase}"  — not in our catalogue, please identify`);
        });
        out.push("");
    });
    return {
        groups, need,
        unknown: need.filter((n) => n.kind === "unknown").length,
        shortfall: need.filter((n) => n.kind === "shortfall").length,
        estCost: need.reduce((s, n) => s + (n.part ? n.part.cost * n.qty : 0), 0),
        text: out.join("\n"),
    };
}
function parsePackingList(text) {
    return text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 2 && !isChatter(l))
        .map((line) => {
        const pn = (line.match(PN_RE) || []).map(canonPN).filter((x) => x.length >= 5)[0] || null;
        let { qty } = extractQty(line);
        const tail = line.match(/(\d{1,4})\s*$/);
        if (tail && pn && canonPN(tail[1]) !== pn)
            qty = parseInt(tail[1], 10);
        return { raw: line, pn, qty };
    })
        .filter((x) => !!x.pn);
}
export function reconcile(packingText, expectedRaw, catalogue) {
    const got = parsePackingList(packingText);
    // The same part can appear on two order lines; the shipment has one row for
    // it. Merge before comparing or every duplicate reads as a short.
    const byId = new Map();
    expectedRaw.forEach((e) => {
        const prev = byId.get(e.part.id);
        if (prev)
            prev.qty += e.qty;
        else
            byId.set(e.part.id, { part: e.part, qty: e.qty });
    });
    const findings = [];
    const seen = new Set();
    byId.forEach((e) => {
        const want = canonPN(e.part.inv_pn);
        const exact = got.find((g) => g.pn === want);
        const near = got.find((g) => !seen.has(g) && g.pn !== want && samePart(g.pn, want));
        const hit = exact || near;
        if (hit)
            seen.add(hit);
        if (!hit)
            findings.push({ sev: "short", part: e.part, want: e.qty, got: 0, note: "line missing from the shipment entirely" });
        else if (hit.qty < e.qty)
            findings.push({ sev: "short", part: e.part, want: e.qty, got: hit.qty, note: `${e.qty - hit.qty} short` });
        else if (hit.qty > e.qty)
            findings.push({ sev: "over", part: e.part, want: e.qty, got: hit.qty, note: `${hit.qty - e.qty} over — check before booking it in` });
        else
            findings.push({ sev: "ok", part: e.part, want: e.qty, got: hit.qty, note: "matches" });
        if (hit && !exact)
            findings.push({
                sev: "suffix", part: e.part, want: e.qty, got: hit.qty,
                note: `sent as ${hit.pn}, ordered ${e.part.inv_pn} — same base number, different grade suffix`,
            });
    });
    got.filter((g) => !seen.has(g)).forEach((g) => {
        const known = catalogue.find((p) => samePart(p.inv_pn, g.pn)) || null;
        findings.push({
            sev: known ? "unexpected" : "unknown", part: known, want: 0, got: g.qty,
            note: known ? `not on this order — ${known.name}` : `${g.pn} is not in the catalogue at all`,
        });
    });
    const tally = {};
    findings.forEach((f) => { tally[f.sev] = (tally[f.sev] || 0) + 1; });
    return { findings, tally, parsed: got.length };
}
/** Bins read as "A1-a": aisle letter, bay number, level letter. Sorting on
 *  that gives one walk down the racking instead of a zig-zag. */
export function locKey(loc) {
    const m = (loc || "").match(/^([A-Z]+)(\d+)[-\s]?([a-z])?/i);
    if (!m)
        return { aisle: "ZZ", bay: 999, level: "z", txt: loc || "—" };
    return { aisle: m[1].toUpperCase(), bay: parseInt(m[2], 10), level: (m[3] || "a").toLowerCase(), txt: loc };
}
export function buildPickList(rows) {
    const items = resolved(rows).map(({ row, part }) => ({
        qty: row.qty, part, loc: locKey(part.loc),
        pick: Math.min(row.qty, Math.max(0, part.qty)),
        short: Math.max(0, row.qty - Math.max(0, part.qty)),
    }));
    items.sort((a, b) => a.loc.aisle.localeCompare(b.loc.aisle) || a.loc.bay - b.loc.bay || a.loc.level.localeCompare(b.loc.level));
    const aisles = Array.from(new Set(items.map((i) => i.loc.aisle)));
    return {
        items, aisles,
        units: items.reduce((s, i) => s + i.pick, 0),
        shorts: items.filter((i) => i.short > 0),
        route: aisles.join(" → "),
    };
}
/** Ranked by what costs money, not by what is easiest to detect. */
export function auditCatalogue(catalogue) {
    const f = [];
    const push = (sev, code, part, detail, cost = 0) => f.push({ sev, code, part, detail, cost });
    const byPN = new Map();
    catalogue.forEach((p) => {
        if (!p.inv_pn)
            return;
        const list = byPN.get(p.inv_pn) || [];
        list.push(p);
        byPN.set(p.inv_pn, list);
    });
    byPN.forEach((list, pn) => {
        if (list.length > 1)
            push("critical", "DUPLICATE_PN", list[0], `${list.length} rows share inventory PN ${pn} (${list.map((x) => x.sku).join(", ")}) — stock counts will disagree`);
    });
    catalogue.forEach((p) => {
        if (p.flag === "no_name")
            push("critical", "NO_NAME", p, "no part name — invisible to every text search and unquotable");
        if (p.list > 0 && p.cost >= p.list)
            push("critical", "NEGATIVE_MARGIN", p, `list ${money(p.list)} is at or below landed cost ${money(p.cost)} — you lose ${money(p.cost - p.list)} a unit`, (p.cost - p.list) * Math.max(p.qty, 0));
        if (!p.list)
            push("high", "NO_PRICE", p, "no list price — cannot be quoted");
        if (!p.loc)
            push("high", "NO_LOCATION", p, "no warehouse bin — cannot be picked");
        if (p.qty === 0)
            push("medium", "OUT_OF_STOCK", p, "on the catalogue, none on the shelf");
        else if (p.qty <= LOW_STOCK)
            push("low", "LOW_STOCK", p, `only ${p.qty} left`);
        if (!p.photo)
            push("medium", "NO_PHOTO", p, "no photo — sells worse without an image");
        if (p.cat_pn && canonPN(p.inv_pn) !== canonPN(p.cat_pn) && samePart(p.inv_pn, p.cat_pn))
            push("low", "SUFFIX_DRIFT", p, `stocked as ${p.inv_pn}, catalogued as ${p.cat_pn} — grade suffix differs`);
    });
    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    f.sort((a, b) => order[a.sev] - order[b.sev] || b.cost - a.cost);
    const tally = {};
    f.forEach((x) => { tally[x.sev] = (tally[x.sev] || 0) + 1; });
    return { findings: f, tally, exposure: f.reduce((s, x) => s + x.cost, 0), scanned: catalogue.length };
}
/** Counter English is plural ("how many doors"), catalogue English is singular
 *  ("Front Door Assembly"). One line of stemming closes the gap. */
const singularise = (s) => s.split(" ").map((w) => (w.length > 4 && /[^s]s$/.test(w) ? w.slice(0, -1) : w)).join(" ");
const search = (q, c, min, fields) => {
    const tri = trigrams(expand(q).text);
    return c
        .map((p) => ({ p, s: relevance(tri, trigrams(fields(p))) }))
        .filter((x) => x.s > min)
        .sort((a, b) => b.s - a.s)
        .slice(0, 200)
        .map((x) => x.p);
};
const RULES = [
    {
        id: "stock_value",
        test: (q) => /(stock|inventory)\s+(value|worth)|total value/.test(q),
        run: (_q, c) => ({
            answer: `${money(c.reduce((s, p) => s + p.cost * p.qty, 0))} at landed cost across ${c.reduce((s, p) => s + p.qty, 0)} units — ${money(c.reduce((s, p) => s + p.list * p.qty, 0))} at list.`,
            sql: "SELECT SUM(cost*on_hand), SUM(list*on_hand) FROM part_detail",
            table: null,
        }),
    },
    {
        id: "out_of_stock",
        test: (q) => /out of stock|nothing left|zero stock|stocked out/.test(q),
        run: (_q, c) => {
            const t = c.filter((p) => p.qty === 0);
            return { answer: `${t.length} part${t.length === 1 ? "" : "s"} with nothing on the shelf.`, sql: "SELECT * FROM part_detail WHERE qty_on_hand = 0", table: t };
        },
    },
    {
        id: "low_stock",
        test: (q) => /low\s+(on\s+)?stock|stock.{0,6}\blow\b|running low|below reorder|reorder|nearly out|short on|almost out/.test(q),
        run: (_q, c) => {
            const t = c.filter((p) => p.qty > 0 && p.qty <= LOW_STOCK).sort((a, b) => a.qty - b.qty);
            return { answer: `${t.length} part${t.length === 1 ? "" : "s"} at or below ${LOW_STOCK} on hand.`, sql: `SELECT * FROM part_detail WHERE qty_on_hand BETWEEN 1 AND ${LOW_STOCK} ORDER BY qty_on_hand`, table: t };
        },
    },
    {
        id: "no_photo",
        test: (q) => /photo|photograph|picture|image/.test(q),
        run: (_q, c) => {
            const t = c.filter((p) => !p.photo);
            return { answer: `${t.length} part${t.length === 1 ? "" : "s"} still need a photo.`, sql: "SELECT * FROM part_detail WHERE primary_image IS NULL", table: t };
        },
    },
    {
        id: "margin",
        test: (q) => /margin|profit|markup|losing money|below cost|underwater/.test(q),
        run: (_q, c) => {
            const t = c.filter((p) => p.list > 0 && p.cost >= p.list).sort((a, b) => (b.cost - b.list) * b.qty - (a.cost - a.list) * a.qty);
            const exp = t.reduce((s, p) => s + (p.cost - p.list) * p.qty, 0);
            return { answer: `${t.length} parts are priced at or below landed cost. Selling the lot at list puts you ${money(exp)} down.`, sql: "SELECT * FROM part_detail WHERE price_zar_minor >= list_price_minor ORDER BY (price_zar_minor-list_price_minor)*qty_on_hand DESC", table: t };
        },
    },
    {
        id: "bin",
        test: (q) => /\b(bin|shelf|rack|aisle|location|where is|where are|stored)\b/.test(q),
        run: (q, c) => {
            const m = q.match(/\b([a-z]\d+(?:-[a-z])?)\b/i);
            if (!m) {
                const byA = {};
                c.forEach((p) => { const a = locKey(p.loc).aisle; byA[a] = (byA[a] || 0) + p.qty; });
                return { answer: "Units by aisle: " + Object.entries(byA).sort().map(([a, n]) => `${a} ${n}`).join(" · "), sql: "SELECT aisle, SUM(qty_on_hand) FROM part_detail GROUP BY aisle", table: null };
            }
            const want = m[1].toLowerCase();
            const t = c.filter((p) => (p.loc || "").toLowerCase().startsWith(want));
            return { answer: `${t.length} part${t.length === 1 ? "" : "s"} in ${want.toUpperCase()} — ${t.reduce((s, p) => s + p.qty, 0)} units, ${money(t.reduce((s, p) => s + p.cost * p.qty, 0))} at cost.`, sql: `SELECT * FROM part_detail WHERE bin LIKE '${want}%'`, table: t };
        },
    },
    {
        id: "count_of",
        test: (q) => /how many|count of|do we have|got any/.test(q),
        run: (q, c) => {
            const cleaned = q.replace(/how many|count of|do we have|have we got|got any|in stock|left|\?/g, " ").trim();
            const t = search(cleaned, c, 0.5, (p) => `${p.name} ${p.section}`);
            const units = t.reduce((s, p) => s + p.qty, 0);
            return {
                answer: t.length ? `${units} unit${units === 1 ? "" : "s"} across ${t.length} matching part${t.length === 1 ? "" : "s"}.` : "Nothing in the catalogue reads like that.",
                sql: `SELECT SUM(qty_on_hand) FROM part_search WHERE part_search MATCH '${cleaned}'`,
                table: t,
            };
        },
    },
    {
        id: "search",
        test: () => true,
        run: (q, c) => {
            const t = search(q, c, 0.5, (p) => `${p.name} ${p.section} ${p.inv_pn} ${p.sku}`);
            return {
                answer: t.length ? `${t.length} part${t.length === 1 ? "" : "s"} look like that.` : "No idea — try naming a part, a bin, or ask about stock, photos or margin.",
                sql: `SELECT * FROM part_search WHERE part_search MATCH '${q}' ORDER BY bm25(part_search)`,
                table: t,
            };
        },
    },
];
export function ask(question, catalogue) {
    const q = singularise(normalise(question));
    const rule = RULES.find((r) => r.test(q));
    return { ...rule.run(q, catalogue), rule: rule.id };
}
/* ========================================================================== */
/* 7. CUSTOMER REPLY DRAFTER                                                  */
/* ========================================================================== */
export function draftReply(rows, quote) {
    const inStock = [];
    const partial = [];
    resolved(rows).forEach(({ row, part }) => {
        const avail = Math.min(row.qty, Math.max(0, part.qty));
        if (avail === row.qty)
            inStock.push({ row, part });
        else
            partial.push({ row, part, avail });
    });
    const sourcing = rows.filter((r) => !r.candidates[r.chosen]);
    const L = ["Hi,", "", "Thanks for the list — here's where we stand:", ""];
    if (inStock.length) {
        L.push("IN STOCK, ready to collect or ship today:");
        inStock.forEach(({ row, part }) => L.push(`  ${row.qty} × ${part.name} (${part.inv_pn}) — ${money(part.list)} ea`));
        L.push("");
    }
    if (partial.length) {
        L.push(`PARTIALLY AVAILABLE — balance on ${LEAD_BACKORDER}:`);
        partial.forEach(({ row, part, avail }) => L.push(`  ${row.qty} × ${part.name} (${part.inv_pn}) — ${avail} now, ${row.qty - avail} to follow — ${money(part.list)} ea`));
        L.push("");
    }
    if (sourcing.length) {
        L.push("NEED A LITTLE MORE DETAIL — I couldn't pin these down:");
        sourcing.forEach((r) => L.push(`  ${r.qty} × "${r.phrase}" — can you send a photo or the number off the old part?`));
        L.push("");
    }
    if (quote && quote.sub > 0) {
        L.push(`Total for the identified lines: ${money(quote.sub)} excl. VAT, ${money(quote.total)} incl.`);
        L.push("");
    }
    L.push("Prices hold for 7 days. Shout if you want it invoiced.", "", "Regards");
    return L.join("\n");
}
/** The catalogue's own notes carry real cross-references ("Ref. 2803035B1063")
 *  and suffix advisories. Jefrey reads them so the counter sees the link
 *  instead of having to already know it. */
export function crossRefs(part, catalogue) {
    const out = [];
    (part.refs || []).forEach((r) => {
        const t = catalogue.find((p) => samePart(p.inv_pn, r) && p.id !== part.id);
        if (t)
            out.push({ kind: "pair", part: t, note: `paired with ${t.side !== "-" ? t.side + " " : ""}${t.name}` });
        else
            out.push({ kind: "ref", part: null, note: `references ${r}, which isn't in the catalogue` });
    });
    if (/suffix not in catalogue/i.test(part.notes || ""))
        out.push({ kind: "suffix", part: null, note: `stocked as ${part.inv_pn} but catalogued as ${part.cat_pn} — confirm the grade with the supplier before quoting` });
    // Opposite hand: the single most common counter follow-up.
    if (part.side === "L/H" || part.side === "R/H") {
        const want = part.side === "L/H" ? "R/H" : "L/H";
        const strip = (s) => normalise(s).replace(/l\/h|r\/h/g, "").replace(/\s+/g, " ").trim();
        const sib = catalogue.find((p) => p.side === want && p.section === part.section && strip(p.name) === strip(part.name));
        if (sib)
            out.push({ kind: "hand", part: sib, note: `opposite hand: ${sib.inv_pn} (${sib.qty} on hand)` });
    }
    return out;
}
