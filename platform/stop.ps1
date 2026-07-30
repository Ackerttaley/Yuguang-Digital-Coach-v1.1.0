$ErrorActionPreference = "Stop"
$platformRoot = $PSScriptRoot
$pidPath = Join-Path $platformRoot ".run\services.json"

if (-not (Test-Path -LiteralPath $pidPath)) {
    Write-Host "没有找到本次启动保存的服务 PID；未停止任何进程。" -ForegroundColor Yellow
    exit 0
}

$services = Get-Content -Raw -Encoding UTF8 -LiteralPath $pidPath | ConvertFrom-Json
foreach ($name in @("frontend", "backend")) {
    $entry = $services.$name
    if (-not $entry) { continue }
    $process = Get-Process -Id ([int]$entry.pid) -ErrorAction SilentlyContinue
    if (-not $process) { continue }
    $expectedStart = [DateTime]::Parse($entry.started_at).ToUniversalTime()
    $actualStart = $process.StartTime.ToUniversalTime()
    if ([Math]::Abs(($actualStart - $expectedStart).TotalSeconds) -gt 5) {
        Write-Warning "PID $($entry.pid) 已被其他进程复用，跳过停止。"
        continue
    }
    Stop-Process -Id $process.Id -ErrorAction Stop
    Write-Host "已停止 $name 服务（PID $($process.Id)）。" -ForegroundColor Green
}

Remove-Item -LiteralPath $pidPath -Force
