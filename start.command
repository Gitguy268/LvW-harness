#!/bin/sh
# Double-click in Finder: starts the LvW web UI and opens it in your browser.
cd "$(dirname "$0")" || exit 1
PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v bun >/dev/null 2>&1; then
  echo "LvW needs Bun. Install it from https://bun.sh, then double-click this file again."
  read -r _
  exit 1
fi
[ -d node_modules ] || bun install --frozen-lockfile
(sleep 2 && open "http://127.0.0.1:7878") &
exec bun src/cli/main.ts serve
