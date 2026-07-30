$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

$platformRoot = $PSScriptRoot
$projectRoot = Split-Path -Parent $platformRoot
$videoRoot = Join-Path $projectRoot "video"
$runRoot = Join-Path $platformRoot ".run"
$logRoot = Join-Path $platformRoot "logs"
$pidPath = Join-Path $runRoot "services.json"
$backendUrl = "http://127.0.0.1:8000/api/health"
$frontendUrl = "http://localhost:3000"
$venvPython = Join-Path $platformRoot ".venv\Scripts\python.exe"

New-Item -ItemType Directory -Force -Path $runRoot, $logRoot, $videoRoot | Out-Null

function Test-HttpReady([string]$url, [switch]$RequireOkStatus) {
    try {
        $response = Invoke-WebRequest -Uri $url -TimeoutSec 2 -UseBasicParsing
        if ($response.StatusCode -ne 200) { return $false }
        if ($RequireOkStatus) {
            $bytes = $response.RawContentStream.ToArray()
            $json = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
            return $json.status -eq "ok"
        }
        return $true
    } catch {
        return $false
    }
}

function Test-PortInUse([int]$port) {
    return $null -ne (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1)
}

if (-not (Test-Path -LiteralPath $venvPython)) {
    throw "缺少 platform\.venv。请先运行 install.cmd 或 platform\setup.ps1。"
}
if (-not (Test-Path -LiteralPath (Join-Path $platformRoot "node_modules"))) {
    throw "缺少前端依赖。请先运行 install.cmd 或 platform\setup.ps1。"
}

$backendReady = Test-HttpReady $backendUrl -RequireOkStatus
$frontendReady = Test-HttpReady $frontendUrl
if (-not $backendReady -and (Test-PortInUse 8000)) {
    throw "端口 8000 已被其他程序占用，且未返回羽光健康状态。"
}
if (-not $frontendReady -and (Test-PortInUse 3000)) {
    throw "端口 3000 已被其他程序占用，且未返回羽光页面。"
}

$services = [ordered]@{}
function Save-ServicePids {
    if ($services.Count -gt 0) {
        $services | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $pidPath -Encoding UTF8
    }
}

if (-not $backendReady) {
    $backend = Start-Process -FilePath $venvPython `
        -ArgumentList "-m", "uvicorn", "backend.main:app", "--host", "127.0.0.1", "--port", "8000" `
        -WorkingDirectory $platformRoot `
        -RedirectStandardOutput (Join-Path $logRoot "backend.stdout.log") `
        -RedirectStandardError (Join-Path $logRoot "backend.stderr.log") `
        -WindowStyle Hidden `
        -PassThru
    $services.backend = [ordered]@{ pid = $backend.Id; started_at = $backend.StartTime.ToUniversalTime().ToString("o") }
    Save-ServicePids
}

if (-not $frontendReady) {
    $nodeExe = (Get-Command node -ErrorAction Stop).Source
    $vinextCli = "node_modules\vinext\dist\cli.js"
    if (-not (Test-Path -LiteralPath (Join-Path $platformRoot $vinextCli) -PathType Leaf)) {
        throw "前端依赖安装不完整（缺少 Vinext CLI）。请先关闭仍在运行的羽光智教窗口，再运行 install.cmd。"
    }
    $env:WRANGLER_LOG_PATH = ".wrangler/wrangler.log"
    $frontend = Start-Process -FilePath $nodeExe `
        -ArgumentList $vinextCli, "dev", "--host", "127.0.0.1" `
        -WorkingDirectory $platformRoot `
        -RedirectStandardOutput (Join-Path $logRoot "frontend.stdout.log") `
        -RedirectStandardError (Join-Path $logRoot "frontend.stderr.log") `
        -WindowStyle Hidden `
        -PassThru
    $services.frontend = [ordered]@{ pid = $frontend.Id; started_at = $frontend.StartTime.ToUniversalTime().ToString("o") }
    Save-ServicePids
}

for ($attempt = 0; $attempt -lt 90; $attempt++) {
    $backendReady = Test-HttpReady $backendUrl -RequireOkStatus
    $frontendReady = Test-HttpReady $frontendUrl
    if ($backendReady -and $frontendReady) { break }
    Start-Sleep -Milliseconds 650
}

if (-not $backendReady -or -not $frontendReady) {
    Write-Host "服务未能就绪。" -ForegroundColor Red
    Write-Host "后端日志: $(Join-Path $logRoot 'backend.stderr.log')" -ForegroundColor Yellow
    Write-Host "前端日志: $(Join-Path $logRoot 'frontend.stderr.log')" -ForegroundColor Yellow
    throw "启动失败，请查看上述日志。"
}

Write-Host "平台已就绪: $frontendUrl" -ForegroundColor Green
Write-Host "分析 API: $backendUrl" -ForegroundColor Green
Write-Host "停止服务: .\stop.ps1" -ForegroundColor Cyan
Start-Process $frontendUrl
