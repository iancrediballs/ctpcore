/* ==========================================================================
   JEFREY — the brain.  CTP Core's offline parts assistant.
   --------------------------------------------------------------------------
   No model, no network, no training step. Text is resolved against the local
   catalogue by rules you can read, and every operator correction is persisted
   as an alias so the same phrase is free forever after.

   Everything in this file is pure: give it the same catalogue and the same
   text and it returns the same answer, which is what makes it safe to put in
   front of an invoice.
   ========================================================================== */
const SIDES = ["L/H", "R/H", "CENTRE", "BOTH"];
/** Normalise the Rust rows into what the matcher wants. Side codes in the DB
 *  are single letters; money arrives in minor units. */
export function fromRust(rows) {
    const SIDE_MAP = { L: "L/H", R: "R/H", C: "CENTRE", B: "BOTH" };
    return rows.map((r) => {
        const rawSide = (r.side || "").toUpperCase();
        const side = SIDE_MAP[rawSide] || (SIDES.indexOf(rawSide) >= 0 ? rawSide : "-");
        const name = (r.name || "").trim();
        const notes = r.notes || "";
        return {
            id: r.id,
            sku: r.sku,
            name: name || "(unnamed — gap in master data)",
            side,
            inv_pn: r.inv_pn || "",
            cat_pn: r.cat_pn || r.inv_pn || "",
            locator: r.locator || "",
            section: r.section || "",
            loc: r.loc || "",
            qty: r.qty,
            cost: (r.cost_minor || 0) / 100,
            list: (r.list_minor || 0) / 100,
            dwg: r.dwg || "",
            photo: !!r.has_photo,
            notes,
            refs: (notes.match(/Ref\.?\s*([0-9A-Za-z-]{6,})/g) || []).map((m) => m.replace(/Ref\.?\s*/i, "")),
            flag: name ? null : "no_name",
        };
    });
}
/* ---------- 1. normalisation ------------------------------------------- */
export const normalise = (s) => (s || "")
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/[^a-z0-9/\-\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
export const canonPN = (s) => (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
/** The base number is the PN minus its grade/finish suffix. This catalogue is
 *  full of them: "-DQ suffix not in catalogue; base PN matches." */
export const basePN = (s) => {
    const c = canonPN(s);
    const m = c.match(/^(\d{6,8}[A-Z]\d{3,4})/);
    return m ? m[1] : c;
};
/** Same part when identical, sharing a FAW base number, or one is a prefix of
 *  the other. Real case: 5103121-H02 ordered, 5103121-H02-G stocked. */
export const samePart = (a, b) => {
    const x = canonPN(a), y = canonPN(b);
    if (!x || !y)
        return false;
    if (x === y)
        return true;
    if (basePN(x) === basePN(y) && basePN(x).length >= 7)
        return true;
    const [s, l] = x.length <= y.length ? [x, y] : [y, x];
    return s.length >= 7 && l.startsWith(s);
};
/* A space-separated suffix must start with a letter. Without that guard,
   "0445120215 2" on a packing list reads as one 11-digit part number and the
   quantity vanishes into it — while "2803035 B1063" still parses correctly. */
const PN_RE = /\b[0-9]{4,}[A-Z0-9]*(?:-[A-Z0-9]{1,6}|\s[A-Z][A-Z0-9]{0,5})?\b/gi;
/* ---------- 2. vernacular ---------------------------------------------- */
const ALIASES = [
    [["lh", "l/h", "left", "left hand", "lefthand", "driver side", "drivers side", "near side", "ns"], "l/h", "side"],
    [["rh", "r/h", "right", "right hand", "righthand", "passenger side", "off side", "os"], "r/h", "side"],
    [["bull bar", "bullbar", "nudge bar", "front bar", "bumper bar"], "front bumper", "term"],
    [["wing", "guard", "wheel arch", "quarter panel"], "fender", "term"],
    [["spoiler", "wind deflector", "air deflector", "sun visor", "sunvisor", "roof spoiler", "cab spoiler"], "roof deflector", "term"],
    [["mud flap", "mudflap", "flap", "spray guard", "splash guard"], "mudguard", "term"],
    [["grille", "grill", "front grill", "radiator grill", "front panel", "front mask"], "front wall", "term"],
    [["door skin", "door shell", "cab door", "drivers door"], "front door", "term"],
    [["wing mirror", "side mirror", "rear view mirror", "mirror arm", "mirror bracket"], "mirror", "term"],
    [["foot step", "footstep", "entry step", "cab step", "side step"], "steps", "term"],
    [["tool box", "toolbox", "side box", "battery box"], "side toolbox", "term"],
    [["cab shock", "cab airbag", "air bag", "cab mount", "cab bush"], "cab suspension", "term"],
    [["headlamp", "headlight", "head light", "indicator", "blinker", "fog lamp", "fog light", "marker light"], "lamp", "term"],
    [["windscreen wiper", "wiper blade", "wiper arm", "screen wiper"], "wiper", "term"],
    [["aircon", "a/c", "air con", "climate"], "air conditioning", "term"],
    [["chassis rail", "frame rail", "cross member"], "chassis", "term"],
    [["assy", "assey", "ass y", "asm", "asy"], "assembly", "abbrev"],
    [["brkt", "brac", "brckt", "bkt"], "bracket", "abbrev"],
    [["lwr"], "lower", "abbrev"],
    [["upr"], "upper", "abbrev"],
    [["ctr", "cent", "mid", "middle"], "center", "abbrev"],
    [["cvr", "cov"], "cover", "abbrev"],
    [["cpl", "complete", "comp"], "assembly", "abbrev"],
    [["o/s", "outer"], "outer", "abbrev"],
    [["i/s", "inner"], "inner", "abbrev"],
    [["jh6", "j6", "faw jh6", "faw j6", "faw"], "jh6", "vehicle"],
];
const ALIAS_INDEX = ALIASES.flatMap(([phrases, canon, kind]) => phrases.map((p) => ({ p, canon, kind, len: p.length }))).sort((a, b) => b.len - a.len);
/** Expand shop vernacular into catalogue language and report what fired. */
export function expand(text) {
    let t = ` ${normalise(text)} `;
    const fired = [];
    for (const { p, canon, kind } of ALIAS_INDEX) {
        if (kind === "side")
            continue;
        const re = new RegExp(`(?<=\\s)${p.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?=\\s)`, "g");
        if (re.test(t)) {
            t = t.replace(re, ` ${canon} `);
            fired.push(`${p} → ${canon}`);
        }
    }
    return { text: t.replace(/\s+/g, " ").trim(), fired };
}
export class Memory {
    constructor() {
        this.positive = new Map();
        this.negative = new Set();
    }
    load(rows) {
        this.positive.clear();
        this.negative.clear();
        rows.forEach((r) => {
            if (r.polarity < 0)
                this.negative.add(`${r.phrase}::${r.part_id}`);
            else
                this.positive.set(r.phrase, { partId: r.part_id, hits: r.hits });
        });
    }
    learn(phrase, partId) {
        const k = normalise(phrase);
        if (!k)
            return;
        const prev = this.positive.get(k);
        this.positive.set(k, { partId, hits: (prev?.hits || 0) + 1 });
        this.negative.delete(`${k}::${partId}`);
    }
    reject(phrase, partId) {
        this.negative.add(`${normalise(phrase)}::${partId}`);
    }
    recall(phrase) {
        return this.positive.get(normalise(phrase)) || null;
    }
    isRejected(phrase, partId) {
        return this.negative.has(`${normalise(phrase)}::${partId}`);
    }
    get size() {
        return this.positive.size;
    }
}
export const memory = new Memory();
/* ---------- 4. similarity ----------------------------------------------- */
export const trigrams = (s) => {
    const t = `  ${normalise(s)} `;
    const out = new Set();
    for (let i = 0; i < t.length - 2; i++)
        out.add(t.slice(i, i + 3));
    return out;
};
export const dice = (a, b) => {
    if (!a.size || !b.size)
        return 0;
    let hit = 0;
    a.forEach((g) => { if (b.has(g))
        hit++; });
    return (2 * hit) / (a.size + b.size);
};
/** Dice is symmetric, which punishes a short query against a long part name.
 *  Coverage asks the question search actually cares about: how much of what
 *  you typed did I find? */
export const coverage = (req, cand) => {
    if (!req.size)
        return 0;
    let hit = 0;
    req.forEach((g) => { if (cand.has(g))
        hit++; });
    return hit / req.size;
};
export const relevance = (req, cand) => Math.max(dice(req, cand), coverage(req, cand) * 0.92);
/* ---------- 5. segmentation --------------------------------------------- */
const WORD_NUM = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12,
};
const CHATTER = /^(hi|hii|hello|hey|dear|thanks|thank you|regards|kind regards|cheers|morning|good (morning|day|afternoon|evening)|please|pls|urgent|asap|see below|as discussed|quote|quotation)\b/i;
export function isChatter(line) {
    const t = line.trim();
    if (/[:：]\s*$/.test(t))
        return true;
    if (CHATTER.test(t) && !/\d/.test(t))
        return true;
    if (CHATTER.test(t) && /^[a-z\s,.!'-]+$/i.test(t))
        return true;
    if (/^[\W_]+$/.test(t))
        return true;
    return false;
}
export function segment(raw) {
    return raw
        .split(/\r?\n|(?:^|\s)[•·▪]\s*|;\s*/g)
        .map((l) => l.replace(/^\s*(?:[-*–—]|\d{1,2}[.)])\s*/, "").trim())
        .filter((l) => l.length > 1)
        .filter((l) => !isChatter(l));
}
export function extractQty(line) {
    const lead = [
        /^\s*(\d{1,4})\s*(?:x|×|\*|pcs?|pieces?|off|nos?)\b\s*/i,
        /^\s*(?:qty|quantity)\s*[:=]?\s*(\d{1,4})\b\s*/i,
        /^\s*(\d{1,4})\s+(?=[a-z])/i,
    ];
    for (const re of lead) {
        const m = line.match(re);
        if (m)
            return { qty: parseInt(m[1], 10), rest: line.replace(re, "").trim() };
    }
    const trail = [
        /[\s\-–(]\s*(?:x\s*)?(\d{1,4})\s*(?:x|pcs?|pieces?|off|nos?|units?)\s*\)?\s*$/i,
        /\s+[x×*]\s*(\d{1,4})\s*$/i,
        /\s+(?:qty|quantity)\s*[:=]?\s*(\d{1,4})\s*$/i,
        /\s*\(\s*(\d{1,4})\s*\)\s*$/,
    ];
    for (const re of trail) {
        const m = line.match(re);
        if (m && m.index !== undefined)
            return { qty: parseInt(m[1], 10), rest: line.slice(0, m.index).trim() };
    }
    const w = line.match(/^\s*(one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+(?=[a-z])/i);
    if (w)
        return { qty: WORD_NUM[w[1].toLowerCase()], rest: line.replace(w[0], "").trim() };
    return { qty: 1, rest: line.trim() };
}
/** Side is the most expensive thing to get wrong — an L/H panel against an
 *  R/H order is a return, freight both ways and a lost customer. So it is
 *  detected explicitly and enforced, never left to fuzzy text. */
export function detectSide(text) {
    const t = ` ${normalise(text)} `;
    const L = /\b(lh|l\/h|left|left hand|drivers? side|near ?side|ns)\b/.test(t);
    const R = /\b(rh|r\/h|right|right hand|passenger side|off ?side|os)\b/.test(t);
    const C = /\b(cn|c\/n|centre|center|central|middle|mid)\b/.test(t);
    if (L && !R)
        return "L/H";
    if (R && !L)
        return "R/H";
    if (C && !L && !R)
        return "CENTRE";
    return null;
}
function sideConflict(want, have) {
    if (!want || !have || have === "-" || have === "BOTH")
        return 0;
    if (want === have)
        return 10;
    const opposed = (want === "L/H" && have === "R/H") || (want === "R/H" && have === "L/H");
    return opposed ? -45 : -8;
}
/* ---------- 6. the matcher ---------------------------------------------- */
export function band(score) {
    if (score >= 85)
        return "confirmed";
    if (score >= 60)
        return "probable";
    if (score >= 40)
        return "uncertain";
    return "unmatched";
}
export function matchLine(rawLine, catalogue) {
    const { qty, rest } = extractQty(rawLine);
    const side = detectSide(rest);
    const { text: expanded, fired } = expand(rest);
    const trace = [];
    trace.push({ step: "segment", detail: `qty ${qty} · "${rest}"` });
    if (side)
        trace.push({ step: "side lock", detail: `${side} — enforced as a hard gate` });
    if (fired.length)
        trace.push({ step: "vernacular", detail: fired.join("  ·  ") });
    // Learned memory beats everything. If the operator has taught this phrase,
    // the answer is not up for debate.
    const learned = memory.recall(rest);
    if (learned) {
        const part = catalogue.find((p) => p.id === learned.partId);
        if (part) {
            trace.push({ step: "learned", detail: `you taught Jefrey this phrase (${learned.hits}×)` });
            return { raw: rawLine, qty, phrase: rest, side, trace, candidates: [{ part, score: 100, why: "learned from your correction" }] };
        }
    }
    const pnHits = (rest.match(PN_RE) || []).map(canonPN).filter((x) => x.length >= 5);
    if (pnHits.length)
        trace.push({ step: "part numbers", detail: pnHits.join(", ") });
    const reqTri = trigrams(expanded);
    const scored = catalogue.map((part) => {
        let score = 0;
        let why = "";
        for (const pn of pnHits) {
            const inv = canonPN(part.inv_pn), cat = canonPN(part.cat_pn), sku = canonPN(part.sku);
            if (pn === inv || pn === cat) {
                score = Math.max(score, 100);
                why = `exact PN ${part.inv_pn}`;
            }
            else if (pn === sku) {
                score = Math.max(score, 99);
                why = `SKU ${part.sku}`;
            }
            else if (basePN(pn) && basePN(pn) === basePN(inv)) {
                score = Math.max(score, 93);
                why = `base PN ${basePN(inv)} (suffix differs)`;
            }
            else if (pn.length >= 6 && (inv.includes(pn) || cat.includes(pn))) {
                score = Math.max(score, 82);
                why = `partial PN in ${part.inv_pn}`;
            }
            else if (inv.length >= 6 && pn.includes(inv)) {
                score = Math.max(score, 80);
                why = `PN contains ${part.inv_pn}`;
            }
        }
        const nameTri = trigrams(`${part.name} ${part.section}`);
        const textScore = Math.round(dice(reqTri, nameTri) * 100);
        if (textScore > score) {
            score = textScore;
            why = `text match on "${part.name}"`;
        }
        else if (textScore > 30 && score < 100)
            score = Math.min(100, score + Math.round(textScore * 0.06));
        const secNorm = normalise(part.section);
        if (secNorm && expanded.includes(secNorm)) {
            score += 12;
            why = why || `section "${part.section}"`;
        }
        score += sideConflict(side, part.side);
        if (memory.isRejected(rest, part.id))
            score -= 60;
        return { part, score: Math.max(0, Math.min(100, Math.round(score))), why: why || "weak text overlap" };
    });
    const candidates = scored.filter((c) => c.score >= 25).sort((a, b) => b.score - a.score).slice(0, 6);
    if (candidates.length) {
        trace.push({ step: "rank", detail: `${candidates.length} candidate(s) above threshold · top ${candidates[0].score}%` });
        // A high score statistically tied with the runner-up is not a confident
        // answer however good it looks. Say so instead of quietly picking one.
        if (candidates[1] && candidates[0].score < 95 && candidates[0].score - candidates[1].score < 8) {
            trace.push({ step: "ambiguity", detail: "top two are within 8 points — needs your eyes" });
            candidates[0].contested = true;
        }
    }
    else {
        trace.push({ step: "rank", detail: "nothing clears the threshold — flag for sourcing" });
    }
    return { raw: rawLine, qty, phrase: rest, side, trace, candidates };
}
export function identify(text, catalogue) {
    return segment(text).map((line, i) => {
        const r = matchLine(line, catalogue);
        const status = !r.candidates.length
            ? "unmatched"
            : r.candidates[0].contested
                ? "contested"
                : band(r.candidates[0].score);
        return { ...r, key: `r${i}_${line.length}_${r.qty}`, chosen: 0, status };
    });
}
