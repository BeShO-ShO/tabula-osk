// Pure text helpers for auto-capitalization, double-space period and autocorrect.
// No GNOME Shell imports, so this file can be unit-tested with plain gjs.

// QWERTY neighbours, used to make "fat finger" substitutions cheaper.
const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const POS = new Map();
ROWS.forEach((row, r) => [...row].forEach((ch, c) => POS.set(ch, [r, c + r * 0.5])));

function adjacent(a, b) {
    const pa = POS.get(a);
    const pb = POS.get(b);
    if (!pa || !pb)
        return false;
    return Math.abs(pa[0] - pb[0]) <= 1 && Math.abs(pa[1] - pb[1]) <= 1.01;
}

// Words that are always fixed the same way (Gboard does these too).
export const SPECIAL = {
    i: 'I',
    im: "I'm",
    ive: "I've",
    dont: "don't",
    cant: "can't",
    wont: "won't",
    isnt: "isn't",
    doesnt: "doesn't",
    didnt: "didn't",
    wasnt: "wasn't",
    couldnt: "couldn't",
    shouldnt: "shouldn't",
    wouldnt: "wouldn't",
    arent: "aren't",
    werent: "weren't",
    hasnt: "hasn't",
    havent: "haven't",
    youre: "you're",
    theyre: "they're",
    thats: "that's",
    whats: "what's",
    theres: "there's",
};

// Weighted Damerau-Levenshtein (optimal string alignment).
// Neighbouring-key substitutions, swapped letters and doubled letters cost less.
export function editCost(a, b) {
    const n = a.length;
    const m = b.length;
    if (Math.abs(n - m) > 3)
        return 99;
    const d = [];
    for (let i = 0; i <= n; i++) {
        d.push(new Array(m + 1).fill(0));
        d[i][0] = i;
    }
    for (let j = 0; j <= m; j++)
        d[0][j] = j;
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            const ca = a[i - 1];
            const cb = b[j - 1];
            let sub = 0;
            if (ca !== cb)
                sub = adjacent(ca, cb) ? 0.6 : 1;
            // Inserting/deleting a doubled letter ("hapy" -> "happy") or an apostrophe is cheap
            const del = (i > 1 && a[i - 2] === ca) || ca === "'" ? 0.5 : 1;
            const ins = (j > 1 && b[j - 2] === cb) || cb === "'" ? 0.5 : 1;
            let v = Math.min(d[i - 1][j] + del, d[i][j - 1] + ins, d[i - 1][j - 1] + sub);
            if (i > 1 && j > 1 && ca === b[j - 2] && a[i - 2] === cb)
                v = Math.min(v, d[i - 2][j - 2] + 0.6);
            d[i][j] = v;
        }
    }
    return d[n][m];
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz'";

// All strings one edit away (Norvig).
export function edits1(word) {
    const out = new Set();
    for (let i = 0; i <= word.length; i++) {
        const L = word.slice(0, i);
        const R = word.slice(i);
        if (R)
            out.add(L + R.slice(1));
        if (R.length > 1)
            out.add(L + R[1] + R[0] + R.slice(2));
        for (const c of ALPHABET) {
            if (R)
                out.add(L + c + R.slice(1));
            out.add(L + c + R);
        }
    }
    out.delete(word);
    return out;
}

export class WordFreq {
    constructor(text) {
        this._f = new Map();
        for (const line of (text || '').split('\n')) {
            if (!line || line[0] === '#')
                continue;
            const sp = line.indexOf(' ');
            const w = sp > 0 ? line.slice(0, sp) : line;
            const c = sp > 0 ? parseInt(line.slice(sp + 1)) || 1 : 1;
            if (!this._f.has(w))
                this._f.set(w, c);
        }
    }

    get size() {
        return this._f.size;
    }

    has(w) {
        return this._f.has(w);
    }

    freq(w) {
        return this._f.get(w) || 0;
    }

    // Words in frequency order (most common first)
    words() {
        return [...this._f.keys()];
    }
}

// Make the replacement follow how the user typed the word.
export function mimicCase(typed, word) {
    if (word === 'I' || word.startsWith("I'"))
        return word;
    const first = typed.charAt(0);
    if (first && first !== first.toLowerCase())
        return word.charAt(0).toUpperCase() + word.slice(1);
    return word;
}

// Words we never touch: acronyms, mixed case, digits, very short, very long.
export function correctable(typed) {
    if (!/^\p{L}+(?:'\p{L}+)?$/u.test(typed))
        return false;
    if (typed.length < 2 || typed.length > 20)
        return false;
    const rest = typed.slice(1);
    if (rest !== rest.toLowerCase())
        return false;   // "iPhone", "NASA", "McDonald"
    return true;
}

/**
 * Pick an autocorrect replacement for a word that the spell checker rejected.
 * @param {string} typed     word as typed
 * @param {WordFreq} freq    frequency list
 * @param {string[]} extra   more candidates (e.g. from the spell checker)
 * @returns {string|null}    replacement in the typed case, or null to leave it alone
 */
export function chooseCorrection(typed, freq, extra = [], isValid = null) {
    if (!correctable(typed))
        return null;
    const low = typed.toLowerCase();
    if (SPECIAL[low])
        return mimicCase(typed, SPECIAL[low]);
    const ranked = rankCorrections(typed, freq, extra).filter(it => !isValid || isValid(it.c));
    return pickConfident(typed, ranked);
}

// Candidates for a misspelled word, best first: [{ c, cost, score }]
export function rankCorrections(typed, freq, extra = []) {
    if (!correctable(typed))
        return [];
    const low = typed.toLowerCase();
    const cands = new Set();
    for (const e of edits1(low)) {
        if (freq.has(e))
            cands.add(e);
    }
    for (const e of extra) {
        const w = String(e).toLowerCase();
        if (freq.has(w) && !w.includes(' ') && !w.includes('-'))
            cands.add(w);
    }

    const maxCost = low.length <= 3 ? 1 : (low.length <= 5 ? 1.6 : 2.2);
    const out = [];
    for (const c of cands) {
        if (c === low)
            continue;
        const cost = editCost(low, c);
        if (cost > maxCost)
            continue;
        out.push({ c, cost, score: Math.log10(freq.freq(c) + 1) - 2.2 * cost });
    }
    return out.sort((a, b) => b.score - a.score);
}

// The fix to apply from ranked (already validated) candidates, or null when not sure
export function pickConfident(typed, ranked) {
    const best = ranked[0];
    const second = ranked[1];
    if (!best)
        return null;
    // Only replace when we are reasonably sure: common enough, and clearly ahead of the runner-up
    if (best.score < 1.2)
        return null;
    if (second && best.score - second.score < 0.25 && best.cost >= second.cost)
        return null;
    return mimicCase(typed, best.c);
}

// Should the next letter be a capital? textBefore = text left of the cursor.
export function wantsCapital(textBefore) {
    if (textBefore === null || textBefore === undefined)
        return null;    // unknown
    if (textBefore.length === 0)
        return true;
    if (/\n\s*$/.test(textBefore))
        return true;
    const t = textBefore.replace(/[ \t ]+$/, '');
    if (t.length === 0)
        return true;
    if (t.length === textBefore.length)
        return false;   // no space after the last character: mid-word
    return /[.!?…]['"’”)]*$/.test(t);
}

// The word (letters and inner apostrophes) that ends right before `pos` in `text`.
export function wordBefore(text) {
    const m = /(\p{L}+(?:['’]\p{L}+)?)$/u.exec(text);
    return m ? m[1] : '';
}

// ----------------------------------------------------------------------
// Next-word prediction. Context key: the previous word (lower case), or
// SENTENCE_START. Sources, strongest first: what the user typed with this
// keyboard (learned), Typing Booster's own user database (tb), and a small
// hand-written list of common pairs (seed).
// ----------------------------------------------------------------------
export const SENTENCE_START = '<s>';
const WORD_RE = "\\p{L}+(?:['’]\\p{L}+)*";

// Context for predicting the word after `textBefore`: null (do not predict),
// SENTENCE_START, or the previous word in lower case. Only right after a space.
export function predictionContext(textBefore) {
    if (textBefore === null || textBefore === undefined)
        return null;
    if (wantsCapital(textBefore) === true)
        return SENTENCE_START;
    if (!/ $/.test(textBefore))
        return null;
    const m = new RegExp(`(${WORD_RE})[,;:]? +$`, 'u').exec(textBefore);
    if (!m)
        return null;
    const start = m.index;
    if (start > 0 && /[\p{L}\p{N}_@/\\.-]/u.test(textBefore[start - 1]))
        return null;   // part of an address, path or number
    return m[1].replace(/’/g, "'").toLowerCase();
}

// The pair completed by the word that ends `textBefore` (just before a terminator):
// [context, word] or null.
export function pairBefore(textBefore) {
    if (!textBefore)
        return null;
    const m = new RegExp(`(?:^|[^\\p{L}\\p{N}'’])(${WORD_RE})$`, 'u').exec(textBefore);
    if (!m)
        return null;
    const word = m[1].replace(/’/g, "'").toLowerCase();
    const head = textBefore.slice(0, textBefore.length - m[1].length);
    const ctx = predictionContext(head);
    if (ctx === null)
        return null;
    return [ctx, word];
}

export class NextWords {
    constructor() {
        this.learned = {};   // ctx -> { word: count }
        this.tb = {};        // ctx -> { word: count }
        this.seed = {};      // ctx -> [word, ...] best first
    }

    // Lines "ctx: w1 w2 w3"; ctx "<s>" = sentence start; '#' starts a comment
    loadSeed(text) {
        this.seed = {};
        for (const line of text.split('\n')) {
            const l = line.replace(/#.*/, '').trim();
            const i = l.indexOf(':');
            if (i <= 0)
                continue;
            const ctx = l.slice(0, i).trim().toLowerCase();
            const words = l.slice(i + 1).trim().split(/\s+/).filter(Boolean);
            if (words.length)
                this.seed[ctx] = words;
        }
    }

    learn(ctx, word, inc = 1) {
        if (!ctx || !word)
            return;
        const m = this.learned[ctx] || (this.learned[ctx] = {});
        m[word] = Math.min(1000, (m[word] || 0) + inc);
        if (m[word] <= 0)
            delete m[word];
        if (!Object.keys(m).length)
            delete this.learned[ctx];
    }

    // Keep the file small: drop single uses, then the rarest contexts
    prune(maxPairs = 6000) {
        let n = 0;
        for (const c in this.learned)
            n += Object.keys(this.learned[c]).length;
        if (n <= maxPairs)
            return false;
        for (const c in this.learned) {
            for (const w in this.learned[c]) {
                if (this.learned[c][w] <= 1) {
                    delete this.learned[c][w];
                    n--;
                }
            }
            if (!Object.keys(this.learned[c]).length)
                delete this.learned[c];
        }
        return true;
    }

    predict(ctx, n = 3, accept = null) {
        if (!ctx)
            return [];
        const score = new Map();
        const add = (w, s) => score.set(w, (score.get(w) || 0) + s);
        const learned = this.learned[ctx] || {};
        for (const w in learned)
            add(w, 100 * Math.min(learned[w], 50));
        const tb = this.tb[ctx] || {};
        for (const w in tb)
            add(w, 60 * Math.min(tb[w], 50));
        const seed = this.seed[ctx] || [];
        seed.forEach((w, i) => add(w, Math.max(10, 90 - 15 * i)));
        return [...score.entries()]
            .filter(([w]) => w !== ctx && (!accept || accept(w)))
            .sort((a, b) => b[1] - a[1])
            .slice(0, n)
            .map(e => e[0]);
    }
}

// Typing for a predicted word: "I"/"I'm" always capital, capital at sentence start
export function casePrediction(word, ctx) {
    if (/^i(?:'|$)/.test(word))
        return 'I' + word.slice(1);
    if (ctx === SENTENCE_START)
        return word.charAt(0).toUpperCase() + word.slice(1);
    return word;
}
