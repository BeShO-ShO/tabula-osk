# Changes

## Rename (2026-11-02)
The extension was renamed from its old name to Apropos OSK:
- UUID `apropos-osk@besho-sho`, schema `org.gnome.shell.extensions.apropos-osk`
  (path `/org/gnome/shell/extensions/apropos-osk/`)
- config folder `~/.config/apropos-osk/` (custom layout, learned words)
- log prefix `[AproposOSK]`, CSS classes `apropos-osk-*`, panel/Quick Settings name "Apropos Keyboard"
- backups in `~/apropos-osk-backup/`

Settings were copied over from the old schema path.

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
