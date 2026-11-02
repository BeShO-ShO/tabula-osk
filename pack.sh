#!/usr/bin/env bash
# Builds the installable zip for extensions.gnome.org / GitHub releases.
# Output: dist/apropos-osk@besho-sho.shell-extension.zip
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist
extra=(--extra-source=input.js --extra-source=keyboard.js --extra-source=layouts.js
       --extra-source=words-en.txt --extra-source=LICENSE)
[ -d fonts ] && extra+=(--extra-source=fonts)
gnome-extensions pack --force --out-dir=dist --schema=schemas/org.gnome.shell.extensions.apropos-osk.gschema.xml "${extra[@]}" .
echo "Built: $(ls dist/*.zip)"
unzip -l dist/*.zip
