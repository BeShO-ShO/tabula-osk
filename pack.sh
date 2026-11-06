#!/usr/bin/env bash
# Builds the installable zip for extensions.gnome.org / GitHub releases.
# Output: dist/tabula-osk@besho-sho.shell-extension.zip
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist
extra=(--extra-source=input.js --extra-source=migrate.js --extra-source=keyboard.js --extra-source=layouts.js
       --extra-source=textlogic.js --extra-source=spell.js --extra-source=words-freq-en.txt
       --extra-source=words-en.txt --extra-source=next-words-en.txt --extra-source=LICENSE)
[ -d fonts ] && extra+=(--extra-source=fonts)
gnome-extensions pack --force --out-dir=dist --schema=schemas/org.gnome.shell.extensions.tabula-osk.gschema.xml "${extra[@]}" .
echo "Built: $(ls dist/*.zip)"
unzip -l dist/*.zip
