# Changes

## 1.1.1 (2026-11-04)
- **GNOME Shell 51** support (Fedora 45): uses `global.stage.context.get_backend()` instead of the removed
  `Clutter.get_default_backend()`, and `orientation` instead of `St.BoxLayout`'s `vertical` property.
- **Next-word prediction fixed after completing a word from Typing Booster's suggestions**: the engine wraps each suggestion
  label in invisible direction marks (U+202A…U+202C) that are not part of the committed text; the keyboard kept them in its
  record of the typed text, so the word was not recognised and no next word appeared (and the pair was not learned).
  The bar also refreshes when the engine finishes the word (commit / preedit cleared), not just right after the tap.
- Bundled next-word list doubled to **3,000 words** (`next-words-en.txt`, ~100 KB).
- Tablet layout: corner hints for long-press keys (↵ shows Tab / Esc, ▲ PgUp, ▼ PgDn; readable on the blue Enter key).
  Long-press ▼ now starts on **PgDn** (popup order unchanged: ⇧PgDn, PgDn); new `lpDefault` key property picks the entry
  highlighted when the popup opens, which stays chosen until the finger slides sideways.

## 1.1.0 (2026-11-03)
- New layout **Tablet (US, Gboard style)** (setting value `phone`): number row; tablet arrangement with Backspace at the end of
  the q row and a wide Enter at the end of the home row (a row apart), Shift on both sides with `,` `.` beside `m`,
  and Ctrl, Super, Space, ▲, ▼ at the bottom. Half-key indent on the home row (new `spacer` key type).
- **Long-press** on the Tablet layout: corner symbol + accents from GNOME's own OSK data
  (`/usr/share/gnome-shell/gnome-shell-osk-layouts.gresource`, read at runtime). Characters without a key are typed like the
  stock keyboard does: through Typing Booster when it is active, as an input-method commit in text fields, or as keyvals.
  A second touch while a key waits for long-press turns it into a normal tap (fast two-thumb typing).
  Double-tap Shift = Caps Lock on the Tablet layout. Settings `long-press`, `long-press-delay`.
- **Material theme** (`theme` = `fluent` | `material`), follows `org.gnome.desktop.interface color-scheme`.
- **Auto-capitalization** (`auto-capitalize`): Shift latches by itself at sentence start / empty field and only shifts
  letters. Uses the text the keyboard typed, else the app's surrounding text.
- **Double-space period** (`double-space-period`).
- **Autocorrect** (`autocorrect`, English; stays off when the system language is not English): `enchant-2 -a` pipe (spell.js) decides, `words-freq-en.txt` ranks
  (textlogic.js), candidates are re-checked with Enchant. Replacement uses delete-surrounding + commit after verifying the
  app's text, else Backspace + retype when the word start is known. Backspace right after a correction reverts it and
  remembers the word.
- Activities search: the overview counts as a shell field even before its search entry has focus, so Typing Booster steps aside
  and auto-capitalization stays off there (the first letter typed on the OSK was lost).
- **Next-word prediction**: after a space (or at the start of a sentence) the suggestion bar offers the likely next word;
  tapping one types it plus a space. Learns word pairs typed with the OSK (`~/.config/apropos-osk/learned-pairs.json`),
  also reads the pairs Typing Booster has learned (its user.db, read-only), and starts from a bundled list of
  common pairs for 1,500 words (`next-words-en.txt`, ~50 KB, built from Tatoeba sentences; nouns are offered after "the", "a", "my"...). Works with and without Typing Booster; never in password/terminal/URL fields or Shell entries.
  Autocorrected words are learned as corrected; tapping a Typing Booster candidate no longer loses the typing context.
- Built-in suggestions use the frequency list for less common words (instead of the alphabetical Hunspell list).
- Tablet layout: separate ▲ / ▼ keys, Left/Right by sliding on the wide space bar; long-press ↵ for Tab / Esc (new `lpKeys`
  key property); Shift shows Caps Lock (lit, ⇪) after a double tap. New `split: [code, code]` key property (one key, top
  half / bottom half) for custom layouts.
- Tablet layout: Super key (❖) next to Ctrl. Tap = Super (Activities; hold it while tapping a key for Super+key);
  long-press = sticky Alt (key lights up and reads "Alt"; tap it to release). New `lpAlt: true` key property for custom layouts.
- Tablet layout: long-press ▲ / ▼ for PgUp, ⇧PgUp / PgDn, ⇧PgDn (Shift+PgUp/PgDn scrolls terminal history, e.g. Ptyxis).
  `lpKeys` entries accept `shift: true`.
- Typing Booster: a slow first engine start (longer than the Shell's 4 s limit) no longer leaves words stuck in
  preedit with an empty suggestion bar. Shell entries (app search, run dialog) use plain xkb so search filters on
  every letter instead of only after Enter/Tab.

## 1.0.1 (2026-11-03)
- Short key-release and auto-pair timers are now cancelled when the extension is
  disabled, and any key still held is released. Needed for extensions.gnome.org review.
- Release workflow updated to the Node 24 versions of its GitHub Actions.

## Typing Booster suggestions (2026-11-02)
New setting `use-typing-booster` (default off), switch "Use Typing Booster for
suggestions" in Settings, under "Word suggestions" (needs word suggestions on).

- No input-source change. GNOME 50 already has an "OSK completion" mode in
  `misc/ibusManager.js` (`setCompletionEnabled`). When the keyboard opens, it switches the IBus
  engine to `typing-booster`. When the keyboard closes, it switches back to the previous xkb
  engine (`xkb:us::eng`). This is the same mechanism the stock GNOME keyboard uses.
- If the current engine is not xkb (e.g. a CJK IBus engine), or typing-booster is missing,
  nothing is switched and the built-in suggestion bar is used.
- Candidates come from the Shell's own candidate popup, which passes each candidate to
  `Main.keyboard.addSuggestion(text, callback)`. Tapping one runs the Shell's callback,
  `panelService.candidate_clicked(i, 1, 0)`.
- Six slots, ordered left to right by rank 6 4 1 2 3 5 (typing-booster's page size is 6).
  The built-in list keeps its three middle slots with the best word in the centre.
- While this is active, the Shell's floating candidate popup is kept closed. The IBus `OSK`
  capability is also set, as the stock keyboard does. With that bit, typing-booster: adds
  a space after a tapped candidate, never commits candidates on digit keys, shows candidates
  without delay, and switches itself off in terminals.
- All hooks are instance overrides and are removed again on close or disable, or when the
  setting is turned off.
- Privacy: no text or candidates are logged. typing-booster switches itself off for
  PASSWORD/PIN fields and records nothing for SENSITIVE_DATA/PRIVATE fields.
  `_tsFieldAllowed()` still hides the bar in password, PIN, terminal, URL, e-mail and number
  fields.

Code: `TypingBoosterBridge` at the top of `keyboard.js`, plus `_tb*` methods and small hooks
in the `_ts*` methods. `prefs.js` has the switch, and the schema has the key.

## Undo
- Typing Booster: turn the switch off. The built-in bar then works exactly as before.
- Everything (the rename included): restore from `~/apropos-osk-backup/`. The pre-rename
  archive holds the old extension folder with all its earlier backup files.

## Fix: Chrome address-bar autocompletion (2026-11-03)
With Typing Booster on, letters typed in Chrome's address bar were held as an IBus preedit
(composition). Chrome's inline completion (the highlighted part) then could not be accepted:
Right/Tab did nothing and Enter only used the typed text.
- typing-booster is now only switched on in fields whose purpose/hints allow it
  (`_fieldTypeAllowed()`): not in URL, e-mail, password, PIN, terminal, number, phone or
  sensitive/hidden fields. Plain xkb is used there, so keys reach the app directly.
- The engine is re-checked on `notify::content-purpose` / `notify::content-hints` of
  `Main.inputMethod`, so moving between a page field and the address bar switches correctly.
- `_tsFieldAllowed()` now reads the Clutter-side `contentPurpose`/`contentHints` instead of
  the IBus copies (`im._hints` uses different bit values, so the old SENSITIVE_DATA check
  never matched).
- Backup: `~/apropos-osk-backup/keyboard.js.pre-urlfield-20261103-000316`
