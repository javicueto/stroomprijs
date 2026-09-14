#!/usr/bin/env bash
# Home-screen icons for the web page: the ⚡ emoji on a plain blue tile,
# rendered by headless Chrome (so the emoji uses the system emoji font),
# then scaled with sips. Re-run only if the tile should change.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/web/icons"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$OUT"
cat > "$TMP/icon.html" <<'HTML'
<!doctype html>
<html><body style="margin:0;width:512px;height:512px;background:#2a78d6;display:grid;place-items:center">
<span style="font-size:260px;line-height:1;font-family:'Apple Color Emoji',sans-serif">⚡</span>
</body></html>
HTML

"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=512,512 --screenshot="$OUT/icon-512.png" "file://$TMP/icon.html" >/dev/null 2>&1

sips -z 192 192 "$OUT/icon-512.png" --out "$OUT/icon-192.png" >/dev/null
sips -z 180 180 "$OUT/icon-512.png" --out "$OUT/apple-touch-icon.png" >/dev/null
ls -la "$OUT"
