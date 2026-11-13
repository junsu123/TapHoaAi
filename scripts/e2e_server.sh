#!/usr/bin/env bash
# Starts a fresh seeded backend (serving frontend/dist) for Playwright on 127.0.0.1:${CHIBI_PORT:-8686}.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export CHIBI_DATA_DIR="${CHIBI_DATA_DIR:-$(mktemp -d)/data}"
PY="$ROOT/backend/.venv/bin/python"
[ -x "$PY" ] || PY=python3
"$PY" "$ROOT/scripts/seed_demo.py" --admin chu_shop --password "mat-khau-demo-123"
cd "$ROOT/backend"
exec "$PY" -m app --host 127.0.0.1 --port "${CHIBI_PORT:-8686}"
