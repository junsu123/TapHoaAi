# Chibi AI TikTok Live Shop — one-click local start on Windows (PowerShell 5+).
# Requirements: Python 3.12+ and Node.js 20+ on PATH.
# Usage (from the repo root):
#   powershell -ExecutionPolicy Bypass -File scripts\dev_windows.ps1                # cài + chạy, cổng 8686
#   powershell -ExecutionPolicy Bypass -File scripts\dev_windows.ps1 -Port 9090     # chọn cổng
#   powershell -ExecutionPolicy Bypass -File scripts\dev_windows.ps1 -SkipInstall   # chỉ chạy
# If the chosen port is busy, the next free port is used and printed.

param(
    [int]$Port = 0,
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$Py = Join-Path $Root "backend\.venv\Scripts\python.exe"

if ($Port -eq 0) {
    if ($env:CHIBI_PORT) { $Port = [int]$env:CHIBI_PORT } else { $Port = 8686 }
}

function Test-PortFree([int]$p) {
    try {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse("127.0.0.1"), $p)
        $listener.Start(); $listener.Stop(); return $true
    } catch { return $false }
}

$start = $Port
while (-not (Test-PortFree $Port)) {
    Write-Host "Cổng $Port đang bận, thử cổng $($Port + 1)..." -ForegroundColor Yellow
    $Port++
    if ($Port -gt $start + 50) { throw "Không tìm được cổng trống từ $start đến $Port." }
}
$env:CHIBI_PORT = "$Port"

if (-not $SkipInstall) {
    Write-Host "== 1/3 Python venv + backend packages" -ForegroundColor Cyan
    if (-not (Test-Path "backend\.venv")) { python -m venv backend\.venv }
    & $Py -m pip install --upgrade pip | Out-Null
    & $Py -m pip install -e "backend[dev,tiktok]"

    Write-Host "== 2/3 Frontend build" -ForegroundColor Cyan
    Push-Location frontend
    npm install
    npm run build
    Pop-Location
}

Write-Host "== 3/3 Database migrations + demo store" -ForegroundColor Cyan
& $Py scripts\seed_demo.py

Write-Host ""
Write-Host "Server: http://127.0.0.1:$Port" -ForegroundColor Green
Write-Host "   Dashboard: http://127.0.0.1:$Port/dashboard  (lần đầu sẽ tạo tài khoản quản trị)"
Write-Host "   Game/OBS : http://127.0.0.1:$Port/game/live"
Set-Location backend
& $Py -m app --host 127.0.0.1 --port $Port
