// Swipe (glide) typing decoder for Tabula OSK.
//
// Ported from FlorisBoard's StatisticalGlideTypingClassifier
// (https://github.com/florisboard/florisboard, ime/text/gestures/), which is
// Copyright (C) 2025 The FlorisBoard Contributors and licensed under the
// Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0).
// That code follows Étienne Desticourt's write-up in AnySoftKeyboard PR #1870.
//
// Changes from the original: plain JavaScript with no GNOME imports (so it can
// be tested with `gjs -m`); scores added as logarithms instead of multiplying
// probabilities; resampling places exactly SAMPLES points; the shape and
// location spreads are rescaled to the number of samples; an optional
// per-word bonus (e.g. next-word context); ideal path lengths cached per layout;
// tuned for Tabula OSK: frequency weighted down (FREQ_WEIGHT), candidate first and
// last letters taken from every key within END_REACH key widths of the swipe's
// ends (not only the two nearest), and an extra penalty for ends far from the
// word's first and last keys (END_STD).
//
// Method: the swipe and each candidate word's ideal path (straight lines between
// key centres) are resampled to the same number of points and compared twice:
// by shape (both scaled to a unit box) and by location (in screen units).
// Each distance is turned into a Gaussian log-likelihood and added to the
// word's (weighted) log frequency. Candidates are first narrowed to words whose
// first and last letters are on keys near the swipe's ends, and whose ideal path
// length is close to the swipe's.

const SAMPLES = 64;
// FlorisBoard: SHAPE_STD 22.08 for a sum over 200 points of unit-box distances
const SHAPE_STD = 22.08 / 200;
// FlorisBoard: LOCATION_STD 0.5109 in units of the key's shorter side
const LOCATION_STD = 0.5109;
// FlorisBoard: PRUNING_LENGTH_THRESHOLD, in key sides
const LENGTH_SLACK = 8.42;
// How much word frequency counts against the path match (log counts are much
// wider than FlorisBoard's 0-255 dictionary frequencies)
const FREQ_WEIGHT = 0.1;
// Swipe ends: candidate first/last letters are keys this many key widths away
const END_REACH = 1.3;
// Extra Gaussian penalty on how far the swipe's first and last points are from
// the word's first and last keys, in key widths (0 = off). People aim the ends
// of a swipe more carefully than the middle.
const END_STD = 0.9;

function baseChar(ch) {
    return ch.normalize('NFD')[0].toLowerCase();
}

function pathLength(xs, ys) {
    let len = 0;
    for (let i = 1; i < xs.length; i++)
        len += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
    return len;
}

// Exactly n points evenly spaced along the path
export function resample(xs, ys, n = SAMPLES) {
    const ox = new Float64Array(n), oy = new Float64Array(n);
    const total = pathLength(xs, ys);
    if (xs.length < 2 || total === 0) {
        ox.fill(xs[0] ?? 0);
        oy.fill(ys[0] ?? 0);
        return [ox, oy];
    }
    const step = total / (n - 1);
    let seg = 1, segStart = 0;
    let segLen = Math.hypot(xs[1] - xs[0], ys[1] - ys[0]);
    for (let i = 0; i < n; i++) {
        const d = Math.min(i * step, total);
        while (seg < xs.length - 1 && segStart + segLen < d) {
            segStart += segLen;
            seg++;
            segLen = Math.hypot(xs[seg] - xs[seg - 1], ys[seg] - ys[seg - 1]);
        }
        const t = segLen > 0 ? Math.min(1, (d - segStart) / segLen) : 0;
        ox[i] = xs[seg - 1] + (xs[seg] - xs[seg - 1]) * t;
        oy[i] = ys[seg - 1] + (ys[seg] - ys[seg - 1]) * t;
    }
    return [ox, oy];
}

// Scaled so the longer side of the bounding box is 1, centred on the box centre
function normalize(xs, ys) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < xs.length; i++) {
        minX = Math.min(minX, xs[i]); maxX = Math.max(maxX, xs[i]);
        minY = Math.min(minY, ys[i]); maxY = Math.max(maxY, ys[i]);
    }
    const side = Math.max(maxX - minX, maxY - minY, 1e-5);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const nx = new Float64Array(xs.length), ny = new Float64Array(ys.length);
    for (let i = 0; i < xs.length; i++) {
        nx[i] = (xs[i] - cx) / side;
        ny[i] = (ys[i] - cy) / side;
    }
    return [nx, ny];
}

export class SwipeDecoder {
    // entries: [word, count] pairs (any order); only words of 2+ letters are used
    constructor(entries) {
        this._words = [];
        let max = 1;
        for (const [w, c] of entries)
            max = Math.max(max, c);
        this._logMax = Math.log(max);
        this._logFreq = new Map();
        for (const [w, c] of entries) {
            if ([...w].filter(ch => /\p{L}/u.test(ch)).length < 2 || this._logFreq.has(w))
                continue;
            this._words.push(w);
            this._logFreq.set(w, Math.log(Math.max(c, 1)) - this._logMax);
        }
        this._keys = [];
        this.freqWeight = FREQ_WEIGHT;
        this.endReach = END_REACH;
        this.endStd = END_STD;
    }

    // keys: [{ ch: 'a', x, y, w, h }] with x, y the key centre (any consistent unit)
    setKeys(keys) {
        this._keys = keys.filter(k => k.ch && k.w > 0 && k.h > 0);
        this._byChar = new Map(this._keys.map(k => [k.ch.toLowerCase(), k]));
        this._side = Math.min(...this._keys.map(k => Math.min(k.w, k.h)));
        this._kw = Math.max(...this._keys.map(k => k.w));
        this._byEnds = new Map();
        this._idealLen = new Map();
        for (const w of this._words) {
            const pts = this._idealPoints(w, false);
            if (!pts)
                continue;
            const chars = [...w].map(baseChar).filter(c => this._byChar.has(c));
            const key = chars[0] + chars[chars.length - 1];
            if (!this._byEnds.has(key))
                this._byEnds.set(key, []);
            this._byEnds.get(key).push(w);
            this._idealLen.set(w, pathLength(pts[0], pts[1]));
        }
    }

    get ready() {
        return this._keys.length > 0;
    }

    // Key centres along the word; with loops, a small square on doubled letters
    // (FlorisBoard's trick to tell "pool" from "poll")
    _idealPoints(word, loops) {
        const xs = [], ys = [];
        let prev = null, n = 0;
        for (const ch of word) {
            const c = baseChar(ch);
            const k = this._byChar.get(c);
            if (!k)
                continue;
            n++;
            if (loops && prev === c) {
                const dx = k.w / 4, dy = k.h / 4;
                xs.push(k.x + dx, k.x + dx, k.x - dx, k.x - dx);
                ys.push(k.y + dy, k.y - dy, k.y - dy, k.y + dy);
            } else {
                xs.push(k.x);
                ys.push(k.y);
            }
            prev = c;
        }
        return n >= 2 ? [xs, ys] : null;
    }

    // The n nearest keys, plus any other key whose centre is within `reach` key
    // widths (FlorisBoard: always the 2 nearest, which drops many sloppy swipes)
    _nearestKeys(x, y, n, reach = this.endReach) {
        return this._keys
            .map(k => [k, Math.hypot(k.x - x, k.y - y)])
            .sort((a, b) => a[1] - b[1])
            .filter(([, d], i) => i < n || d < reach * this._kw)
            .map(([k]) => k.ch.toLowerCase());
    }

    _candidates(xs, ys) {
        const last = xs.length - 1;
        const starts = this._nearestKeys(xs[0], ys[0], 2);
        const ends = this._nearestKeys(xs[last], ys[last], 2);
        const userLen = pathLength(xs, ys);
        const slack = LENGTH_SLACK * this._side;
        const out = [];
        for (const s of starts) {
            for (const e of ends) {
                for (const w of this._byEnds.get(s + e) ?? []) {
                    if (Math.abs(this._idealLen.get(w) - userLen) < slack)
                        out.push(w);
                }
            }
        }
        return out;
    }

    // points: [[x, y], ...] in the same unit as the keys.
    // bonus(word): optional extra log-score (e.g. from next-word context).
    // Returns up to n { word, score } best first (higher score = better).
    decode(points, n = 4, bonus = null) {
        if (!this.ready || points.length < 2)
            return [];
        const rawX = points.map(p => p[0]), rawY = points.map(p => p[1]);
        const [ux, uy] = resample(rawX, rawY);
        const [nux, nuy] = normalize(ux, uy);
        const locStd = LOCATION_STD * this._side;
        const best = new Map();
        for (const w of this._candidates(rawX, rawY)) {
            const variants = [this._idealPoints(w, false)];
            const looped = this._idealPoints(w, true);
            if (looped[0].length !== variants[0][0].length)
                variants.push(looped);
            let top = -Infinity;
            for (const [ix, iy] of variants) {
                const [wx, wy] = resample(ix, iy);
                const [nwx, nwy] = normalize(wx, wy);
                let shape = 0, loc = 0;
                for (let i = 0; i < SAMPLES; i++) {
                    shape += Math.hypot(nwx[i] - nux[i], nwy[i] - nuy[i]);
                    loc += (Math.abs(wx[i] - ux[i]) + Math.abs(wy[i] - uy[i])) / 2;
                }
                shape /= SAMPLES;
                loc /= SAMPLES;
                const s = -0.5 * (shape / SHAPE_STD) ** 2 - 0.5 * (loc / locStd) ** 2;
                top = Math.max(top, s);
            }
            let score = top + this.freqWeight * this._logFreq.get(w);
            if (this.endStd > 0) {
                const [ix, iy] = variants[0];
                const n = ix.length - 1, es = this.endStd * this._kw;
                const d0 = Math.hypot(ix[0] - rawX[0], iy[0] - rawY[0]);
                const d1 = Math.hypot(ix[n] - rawX[rawX.length - 1], iy[n] - rawY[rawY.length - 1]);
                score -= 0.5 * ((d0 / es) ** 2 + (d1 / es) ** 2);
            }
            if (bonus)
                score += bonus(w) || 0;
            best.set(w, score);
        }
        return [...best.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, n)
            .map(([word, score]) => ({ word, score }));
    }
}
