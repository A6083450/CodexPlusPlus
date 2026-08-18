#!/usr/bin/env sh
set -eu

PORT="${PORT:-17888}"
HOST="${HOST:-127.0.0.1}"
NODE_BIN="${NODE:-node}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
HELPER="$SCRIPT_DIR/codex-local-usage-helper.cjs"
LOG_DIR="${LOG_DIR:-$HOME/.codex}"
LOG_FILE="$LOG_DIR/codex-token-cost-helper.log"

if [ ! -f "$HELPER" ]; then
  echo "Helper script not found: $HELPER" >&2
  exit 1
fi

if curl -fsS "http://$HOST:$PORT/health" >/dev/null 2>&1; then
  exit 0
fi

if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  exit 0
fi

if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  if [ -z "${NODE:-}" ]; then
    for candidate in \
      "${HOME:-}/.local/bin/node" \
      "/opt/homebrew/bin/node" \
      "/usr/local/bin/node" \
      "/usr/bin/node"; do
      if [ -x "$candidate" ]; then
        NODE_BIN="$candidate"
        break
      fi
    done
  fi
fi

if ! command -v "$NODE_BIN" >/dev/null 2>&1 && [ ! -x "$NODE_BIN" ]; then
  echo "Node.js not found: $NODE_BIN" >&2
  exit 1
fi

mkdir -p "$LOG_DIR"
nohup "$NODE_BIN" "$HELPER" --serve --host "$HOST" --port "$PORT" >>"$LOG_FILE" 2>&1 &
