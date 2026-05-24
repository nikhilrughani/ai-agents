#!/bin/bash
# ─────────────────────────────────────────────────────────────
#  Mini-Talks Dashboard Launcher
#  Double-click this file to start the dashboard.
# ─────────────────────────────────────────────────────────────

# Make sure Node/npm are on the PATH (covers Homebrew on Intel + Apple Silicon)
export PATH="/usr/local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"

# Always run from the folder this script lives in
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

clear
echo "🎙️  Mini-Talks Dashboard"
echo "────────────────────────"

# ── Check Node is available ──────────────────────────────────
if ! command -v node &>/dev/null; then
  echo ""
  echo "❌  Node.js not found."
  echo "    Install it from https://nodejs.org then try again."
  read -p "Press Enter to close..."
  exit 1
fi

# ── Check if already running on port 3000 ───────────────────
if lsof -i :3000 -t &>/dev/null 2>&1; then
  echo ""
  echo "✅  Dashboard is already running."
  echo "    Opening browser..."
  open http://localhost:3000
  echo ""
  echo "    (Close this window any time — the server keeps running.)"
  exit 0
fi

# ── Install dependencies if needed ──────────────────────────
if [ ! -d "node_modules" ]; then
  echo ""
  echo "📦  Installing dependencies (first run only)..."
  npm install --silent
fi

# ── Start the server ─────────────────────────────────────────
echo ""
echo "🚀  Starting server..."
npm start &
SERVER_PID=$!

# ── Wait until the server is accepting connections ───────────
echo "    Waiting for server to be ready..."
for i in $(seq 1 15); do
  sleep 1
  if lsof -i :3000 -t &>/dev/null 2>&1; then
    break
  fi
done

# ── Open the browser ─────────────────────────────────────────
open http://localhost:3000

echo ""
echo "✅  Dashboard running at http://localhost:3000"
echo ""
echo "────────────────────────────────────────────────"
echo "  Keep this window open while using the dashboard."
echo "  Press Ctrl+C (or close this window) to stop."
echo "────────────────────────────────────────────────"
echo ""

# Keep running until server exits
wait $SERVER_PID
