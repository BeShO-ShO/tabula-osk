# Contributing

Bug reports, ideas and pull requests are welcome. This is a one-person hobby project that follows the GNOME version I
use myself (currently GNOME Shell 50 and 51), so I can't promise to take every request.

## Reporting a bug
Use the bug report form in [Issues](https://github.com/BeShO-ShO/tabula-osk/issues). The most useful things are the exact
steps, the app it happens in, and the log:
```sh
journalctl --user -b -o cat /usr/bin/gnome-shell | grep -i -B2 -A6 tabula
```

## Working on the code
```sh
git clone https://github.com/BeShO-ShO/tabula-osk.git
cd tabula-osk
gjs -m tests/unit.js        # unit tests for the modules that don't need the Shell
tests/check-pack.sh         # every imported file must be listed in pack.sh
./pack.sh                   # builds dist/tabula-osk@besho-sho.shell-extension.zip
gnome-extensions install --force dist/tabula-osk@besho-sho.shell-extension.zip
```
On Wayland the Shell only loads new extension code at login, so log out and back in to try a change
(`prefs.js` is the exception: reopening the settings window is enough).

| File | What it holds |
|---|---|
| `extension.js` | enable/disable, top bar button, when the keyboard opens and closes by itself |
| `keyboard.js` | the keyboard: keys, gestures, long-press, suggestions bar, autocorrect, paste button |
| `layouts.js` | the built-in layouts and the custom-layout file |
| `emoji.js`, `emojidata.js`, `emoji-data.txt` | the emoji panel and its data |
| `swipe.js` | swipe-typing decoder |
| `textlogic.js`, `spell.js` | autocorrect, capitalisation and next-word logic; spell checker bridge |
| `prefs.js` | the settings window and Layout Studio |

A new module or data file must be added to the `--extra-source` list in `pack.sh`, or it is missing from the release
zip (CI checks this).

## Pull requests
- Keep a change to one topic and describe how you tested it (device, GNOME version).
- Match the surrounding style; comments say what the code is for, in plain English.
- Text typed by the user must never be logged or sent anywhere.
- Parts of this extension were written with AI tools, and that is fine for contributions too; you are responsible for
  understanding and testing what you submit.
