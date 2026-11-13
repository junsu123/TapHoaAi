# Chibi AI TikTok Live Shop — one-click local start on Windows (PowerShell 5+).
# Requirements: Python 3.12+ and Node.js 20+ on PATH.
# Usage (from the repo root):  powershell -ExecutionPolicy Bypass -File scripts\dev_windows.ps1
# Then open http://127.0.0.1:8000/dashboard  (game window: http://127.0.0.1:8000/game/live)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

Write-Host "== 1/4 Python venv + backend packages" -ForegroundColor Cyan
if (-not (Test-Path "backend\.venv")) { python -m venv backend\.venv }
$Py = Join-Path $Root "backend\.venv\Scripts\python.exe"
& $Py -m pip install --upgrade pip | Out-Null
& $Py -m pip install -e "backend[dev]"

Write-Host "== 2/4 Frontend build" -ForegroundColor Cyan
Push-Location frontend
npm install
npm run build
Pop-Location

Write-Host "== 3/4 Database migrations + demo store" -ForegroundColor Cyan
& $Py scripts\seed_demo.py

Write-Host "== 4/4 Start server on http://127.0.0.1:8000" -ForegroundColor Cyan
Write-Host "   Dashboard: http://127.0.0.1:8000/dashboard  (first visit creates the operator account)"
Write-Host "   Game/OBS : http://127.0.0.1:8000/game/live"
Set-Location backend
& $Py -m uvicorn app.main:app --host 127.0.0.1 --port 8000
