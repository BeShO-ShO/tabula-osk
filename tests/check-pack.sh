#!/usr/bin/env bash
# Fails when a module or data file the code uses is missing from pack.sh (it would be left
# out of the release zip). Run from anywhere: tests/check-pack.sh
set -euo pipefail
cd "$(dirname "$0")/.."
missing=0
# extension.js, prefs.js, metadata.json, stylesheet.css and schemas are packed automatically
auto='^(extension|prefs)\.js$'
need=$( { grep -ohE "from '\./[A-Za-z0-9_-]+\.js'" ./*.js | sed -E "s/.*'\.\/(.*)'/\1/";
          grep -ohE "_extension\.path, '[A-Za-z0-9_.-]+\.txt'" ./*.js | sed -E "s/.*'(.*)'/\1/"; } | sort -u)
for f in $need; do
    [[ $f =~ $auto ]] && continue
    if ! grep -q -- "--extra-source=$f\b" pack.sh; then
        echo "pack.sh does not ship $f"
        missing=1
    fi
    [ -e "$f" ] || { echo "$f is imported but does not exist"; missing=1; }
done
[ $missing -eq 0 ] && echo "pack.sh ships all $(echo "$need" | wc -w) imported files"
exit $missing
