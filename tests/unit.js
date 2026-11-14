// Unit tests for the modules that don't need GNOME Shell. Run: gjs -m tests/unit.js
import GLib from 'gi://GLib';
import System from 'system';
import * as TL from '../textlogic.js';
import { SwipeDecoder, resample } from '../swipe.js';
import { parseEmojiData, pageCount, pageSlice, pushRecent, RECENT_MAX } from '../emojidata.js';

const root = GLib.path_get_dirname(GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]));
const read = name => new TextDecoder().decode(GLib.file_get_contents(GLib.build_filenamev([root, name]))[1]);

let failed = 0, passed = 0;
function eq(name, got, want) {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) {
        passed++;
    } else {
        failed++;
        print(`FAIL ${name}: got ${g}, want ${w}`);
    }
}
const ok = (name, cond) => eq(name, !!cond, true);

// ---- textlogic: capitals, corrections
eq('capital: empty field', TL.wantsCapital(''), true);
eq('capital: after a sentence', TL.wantsCapital('Hello. '), true);
eq('capital: mid sentence', TL.wantsCapital('hi '), false);
eq('wordBefore', TL.wordBefore('see you tomorrow'), 'tomorrow');
eq('mimicCase', TL.mimicCase('Hel', 'hello'), 'Hello');
const freq = new TL.WordFreq(read('words-freq-en.txt'));
ok('word list loaded', freq.size > 30000);
eq('correct teh', TL.chooseCorrection('teh', freq), 'the');
eq('correct recieve', TL.chooseCorrection('recieve', freq), 'receive');
ok('known word left alone', freq.has('keyboard'));

// ---- emoji data
const groups = parseEmojiData(read('emoji-data.txt'));
eq('emoji: nine groups', groups.length, 9);
eq('emoji: first group', groups[0].name, 'Smileys & Emotion');
eq('emoji: first emoji', groups[0].list[0], '😀');
ok('emoji: every group has a tab icon and entries', groups.every(g => g.icon && g.list.length > 50));
ok('emoji: no skin-tone variants', groups.every(g => g.list.every(e => !/[\u{1F3FB}-\u{1F3FF}]/u.test(e))));
ok('emoji: no duplicates', groups.every(g => new Set(g.list).size === g.list.length));
eq('emoji: comments and bad lines skipped', parseEmojiData('# c\nnotab\nA\tx y\n\n').map(g => g.list), [['x', 'y']]);
eq('pages: empty list still has one page', pageCount(0, 40), 1);
eq('pages: exact fit', pageCount(80, 40), 2);
eq('pages: remainder', pageCount(81, 40), 3);
eq('pages: slice of last page', pageSlice([1, 2, 3, 4, 5], 2, 2), [5]);
eq('recent: newest first, no duplicate', pushRecent(['a', 'b', 'c'], 'c'), ['c', 'a', 'b']);
eq('recent: capped', pushRecent(Array.from({ length: RECENT_MAX }, (_, i) => 'e' + i), 'new').length, RECENT_MAX);

// ---- swipe decoder: a straight pass over the keys of a word finds it
const rows = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const keys = [];
rows.forEach((row, r) => Array.from(row).forEach((ch, i) => keys.push({ ch, x: i * 100 + r * 50 + 50, y: r * 80 + 40, w: 100, h: 80 })));
eq('resample length', resample([0, 100], [0, 0], 8)[0].length, 8);
try {
    const dec = new SwipeDecoder([...freq._f.entries()]);
    dec.setKeys(keys);
    ok('swipe decoder ready', dec.ready);
    const at = ch => keys.find(k => k.ch === ch);
    for (const word of ['hello', 'the', 'keyboard']) {
        const res = dec.decode(Array.from(word).map(ch => [at(ch).x, at(ch).y]));
        const top = res.length ? (res[0].word ?? res[0][0] ?? res[0]) : null;
        eq('swipe ' + word, top, word);
    }
} catch (e) {
    failed++;
    print('FAIL swipe decoder threw: ' + e);
}

print(`${passed} passed, ${failed} failed`);
System.exit(failed ? 1 : 0);
