#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "======================================================================"
echo "  X TRACKER (UNFOLLOW MONITOR) - 1-CLICK INSTALLATION HELPER"
echo "======================================================================"
echo ""

if [ ! -f "$DIR/manifest.json" ]; then
  echo "[ERROR] manifest.json was not found in: $DIR"
  echo "Please run install.sh from inside the X-Tracker directory."
  exit 1
fi

echo " [1/3] Extension folder verified:"
echo "       $DIR"
echo ""

# Copy to clipboard
COPIED=false
if command -v pbcopy >/dev/null 2>&1; then
  printf "%s" "$DIR" | pbcopy
  COPIED=true
elif command -v wl-copy >/dev/null 2>&1; then
  printf "%s" "$DIR" | wl-copy
  COPIED=true
elif command -v xclip >/dev/null 2>&1; then
  printf "%s" "$DIR" | xclip -selection clipboard
  COPIED=true
elif command -v xsel >/dev/null 2>&1; then
  printf "%s" "$DIR" | xsel --clipboard --input
  COPIED=true
fi

if [ "$COPIED" = true ]; then
  echo " [2/3] Extension folder path has been COPIED to your clipboard!"
else
  echo " [2/3] Folder path: $DIR (copy this path)"
fi
echo ""

echo " [3/3] Opening browser extensions page..."
if [[ "$OSTYPE" == "darwin"* ]]; then
  open -a "Google Chrome" "chrome://extensions" 2>/dev/null || \
  open -a "Brave Browser" "brave://extensions" 2>/dev/null || \
  open -a "Microsoft Edge" "edge://extensions" 2>/dev/null || \
  open "chrome://extensions" 2>/dev/null || true
else
  google-chrome "chrome://extensions" 2>/dev/null || \
  brave-browser "brave://extensions" 2>/dev/null || \
  microsoft-edge "edge://extensions" 2>/dev/null || \
  xdg-open "chrome://extensions" 2>/dev/null || true
fi

echo ""
echo "======================================================================"
echo "  JUST 3 EASY STEPS TO FINISH (Takes less than 15 seconds):"
echo "======================================================================"
echo ""
echo "  1. In your browser, turn ON 'Developer mode' (toggle in top-right)."
echo ""
echo "  2. Click the 'Load unpacked' button (top-left)."
echo ""
if [ "$COPIED" = true ]; then
  echo "  3. In the folder prompt, paste the path and click 'Select Folder'."
else
  echo "  3. Select this folder: $DIR"
  echo "     and click 'Select Folder'."
fi
echo ""
echo "======================================================================"
echo "  Done! Click the puzzle icon in your toolbar to pin X Tracker."
echo "======================================================================"
echo ""
