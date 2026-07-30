$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

$platformRoot = $PSScriptRoot
$venvDir = Join-Path $platformRoot ".venv"
$venvPython = Join-Path $venvDir "Scripts\python.exe"
$requirements = Join-Path $platformRoot "requirements.txt"

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Label,
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [string[]]$Arguments = @()
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Label 失败（退出码 $LASTEXITCODE）。请查看上方错误信息。"
    }
}

function Resolve-SupportedPython {
    $launcher = Get-Command py -ErrorAction SilentlyContinue
    if ($launcher) {
        foreach ($version in @("3.12", "3.11")) {
            & $launcher.Source "-$version" -c "import sys; assert sys.version_info[:2] in ((3,11),(3,12))" 2>$null
            if ($LASTEXITCODE -eq 0) {
                return @{
                    File = $launcher.Source
                    Prefix = @("-$version")
                    Label = "Python $version (py launcher)"
                }
            }
        }
    }

    foreach ($commandName in @("python3.12", "python3.11", "python")) {
        $command = Get-Command $commandName -ErrorAction SilentlyContinue
        if (-not $command) { continue }
        $version = & $command.Source -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null
        if ($LASTEXITCODE -eq 0 -and $version -in @("3.11", "3.12")) {
            return @{
                File = $command.Source
                Prefix = @()
                Label = "$($command.Source) ($version)"
            }
        }
    }

    throw "未找到 Python 3.12 或 3.11。为避免 MediaPipe 兼容问题，安装脚本不会使用 Python 3.13 创建默认环境。"
}

Write-Host "正在准备羽光智教 v1.1.0..." -ForegroundColor Cyan
$pythonCommand = Resolve-SupportedPython
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$npmCommand = Get-Command npm -ErrorAction SilentlyContinue
if (-not $nodeCommand -or -not $npmCommand) {
    throw "未找到 Node.js 与 npm。请先安装 Node.js 22 LTS，重新打开 install.cmd 后继续。"
}
$nodeExe = $nodeCommand.Source
$npmExe = $npmCommand.Source
Write-Host "Python: $($pythonCommand.Label)"
Write-Host "Node:   $nodeExe"

if (Test-Path -LiteralPath $venvPython) {
    $venvVersion = & $venvPython -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
    if ($venvVersion -notin @("3.11", "3.12")) {
        throw "现有 .venv 使用 Python $venvVersion。请先备份需要的数据后删除 platform\.venv，再重新运行安装。"
    }
} else {
    Write-Host "正在创建 Python 虚拟环境..." -ForegroundColor Yellow
    $venvArgs = @($pythonCommand.Prefix) + @("-m", "venv", $venvDir)
    Invoke-CheckedCommand -Label "创建 Python 虚拟环境" -FilePath $pythonCommand.File -Arguments $venvArgs
}

Write-Host "正在安装 Python 锁定依赖..." -ForegroundColor Yellow
Invoke-CheckedCommand -Label "升级 pip" -FilePath $venvPython -Arguments @("-m", "pip", "install", "--upgrade", "pip")
Invoke-CheckedCommand -Label "安装 Python 依赖" -FilePath $venvPython -Arguments @("-m", "pip", "install", "-r", $requirements)

Write-Host "正在安装前端锁定依赖..." -ForegroundColor Yellow
Push-Location $platformRoot
try {
    Invoke-CheckedCommand -Label "安装前端依赖" -FilePath $npmExe -Arguments @("ci")

    $vinextCli = Join-Path $platformRoot "node_modules\vinext\dist\cli.js"
    if (-not (Test-Path -LiteralPath $vinextCli -PathType Leaf)) {
        throw "前端依赖安装不完整：未找到 Vinext CLI。请关闭仍在运行的羽光智教窗口后重新运行 install.cmd。"
    }

    Invoke-CheckedCommand `
        -Label "检查 Vinext Windows 兼容性" `
        -FilePath $nodeExe `
        -Arguments @((Join-Path $platformRoot "scripts\fix-vinext-windows.mjs"))

    Write-Host "正在执行后端与姿态资源自检..." -ForegroundColor Yellow
    Invoke-CheckedCommand `
        -Label "后端与姿态资源自检" `
        -FilePath $venvPython `
        -Arguments @("-c", "from backend.main import health; h=health(); assert h['status']=='ok'; assert h['pose_available'], h['pose_error']; print('Pose self-check:', h['resource_dir'])")
} finally {
    Pop-Location
}

Write-Host "安装与自检完成。请把授权 MP4 放入 ..\video，然后运行 .\start.ps1。" -ForegroundColor Green
