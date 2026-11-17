#!/usr/bin/env bash
# Starts a fresh seeded backend (serving frontend/dist) for Playwright on 127.0.0.1:${CHIBI_PORT:-8686}.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export CHIBI_DATA_DIR="${CHIBI_DATA_DIR:-$(mktemp -d)/data}"
# offline stand-ins for Claude and Vbee: the e2e suite must not call paid APIs
export CHIBI_FAKE_AI="${CHIBI_FAKE_AI:-1}"
# every demo restart is a new LIVE (khách quen across LIVEs without waiting 20 minutes)
export CHIBI_LIVE_CONTINUE_S="${CHIBI_LIVE_CONTINUE_S:-0}"
PY="$ROOT/backend/.venv/bin/python"
[ -x "$PY" ] || PY=python3
"$PY" "$ROOT/scripts/seed_demo.py" --admin chu_shop --password "mat-khau-demo-123"
cd "$ROOT/backend"
exec "$PY" -m app --host 127.0.0.1 --port "${CHIBI_PORT:-8686}"
