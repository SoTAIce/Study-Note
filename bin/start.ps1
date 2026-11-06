param(
  [switch]$InstallAutostart,
  [switch]$UninstallAutostart
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$port = if ($env:STUDY_PORT) { $env:STUDY_PORT } else { '7777' }
$url = "http://127.0.0.1:$port/"
$assistantVbs = Join-Path $PSScriptRoot '捕获助手.vbs'
$startupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Study Notes 捕获助手.lnk'

function Test-Health {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri "${url}api/health"
    return ($r.StatusCode -eq 200)
  } catch {
    return $false
  }
}

if ($InstallAutostart) {
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($startupLnk)
  $lnk.TargetPath = 'wscript.exe'
  $lnk.Arguments = '"' + $assistantVbs + '"'
  $lnk.WorkingDirectory = $root
  $lnk.Description = 'Study Notes 全局热键捕获助手'
  $lnk.Save()
  Write-Host "[=] 已加入开机启动：$startupLnk"
  exit 0
}

if ($UninstallAutostart) {
  if (Test-Path $startupLnk) {
    Remove-Item $startupLnk -Force
    Write-Host '[=] 已移除开机启动'
  } else {
    Write-Host '[=] 本来就没装开机启动'
  }
  exit 0
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host '[x] 没找到 node，请先安装 Node.js 24 或更高版本。'
  exit 1
}

# 包管理器：优先 pnpm（仓库带 pnpm-lock.yaml），没有就退回 npm。
$pm = if (Get-Command pnpm -ErrorAction SilentlyContinue) { 'pnpm' } elseif (Get-Command npm -ErrorAction SilentlyContinue) { 'npm' } else { $null }

if (-not (Test-Path 'node_modules')) {
  if (-not $pm) {
    Write-Host '[x] 没找到 pnpm 或 npm，无法安装依赖。'
    exit 1
  }
  Write-Host "[*] 首次运行：用 $pm 安装依赖..."
  & $pm install
  if ($LASTEXITCODE -ne 0) { Write-Host '[x] 依赖安装失败。'; exit 1 }
}

if (-not (Test-Path 'dist/index.html')) {
  if (-not $pm) {
    Write-Host '[x] 没找到 pnpm 或 npm，无法构建前端。'
    exit 1
  }
  Write-Host "[*] 构建前端（$pm build）..."
  & $pm run build
  if ($LASTEXITCODE -ne 0) { Write-Host '[x] 前端构建失败。'; exit 1 }
}

if (Test-Health) {
  Write-Host '[=] 服务已在运行。'
} else {
  Write-Host '[*] 启动服务...'
  Start-Process -FilePath 'node' -ArgumentList 'server/main.ts' -WorkingDirectory $root -WindowStyle Minimized
  $ok = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 250
    if (Test-Health) { $ok = $true; break }
  }
  if (-not $ok) {
    Write-Host '[x] 服务没能起来，请手动运行 node server/main.ts 看报错。'
    exit 1
  }
  Write-Host '[=] 服务已启动。'
}

$assistant = @()
try {
  $assistant = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction Stop |
    Where-Object { $_.CommandLine -like '*capture.ps1*' })
} catch {
  $assistant = @()
}
if ($assistant.Count -eq 0) {
  if (Test-Path $assistantVbs) {
    Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $assistantVbs + '"') -WindowStyle Hidden
    Write-Host '[*] 捕获助手已拉起：Ctrl+Alt+Space 记录想法。'
  } else {
    Write-Host '[!] 没找到捕获助手，跳过（不影响笔记功能）。'
  }
} else {
  Write-Host '[=] 捕获助手已在运行。'
}

try { Start-Process $url } catch { Write-Host "[!] 自动打开浏览器失败，请手动访问 $url" }
Write-Host "[=] 已打开 $url"
exit 0
