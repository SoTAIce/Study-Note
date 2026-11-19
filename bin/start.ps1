param(
  [switch]$InstallAutostart,
  [switch]$UninstallAutostart,
  # 测试用（CI）：不打开浏览器、不拉起捕获助手
  [switch]$NoBrowser,
  [switch]$NoAssistant
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

# 正在跑的服务的健康信息（含代码指纹 stamp）；没在跑返回 $null
function Get-Health {
  try {
    return Invoke-RestMethod -TimeoutSec 2 -Uri "${url}api/health"
  } catch {
    return $null
  }
}

# 关掉占着端口的旧服务（repo-003）：只认命令行是 `node server/main.ts` 的进程；
# 拿不到端口信息时退回 stop.ps1（它同样只认我们自己的进程）。
function Stop-OldServer {
  $serverArg = 'server' + '/' + 'main.ts'
  $serverArgWin = 'server' + '\' + 'main.ts'
  $stopped = $false
  try {
    $conns = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop)
    foreach ($c in $conns) {
      $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -ErrorAction Stop
      if ($p -and $p.Name -eq 'node.exe' -and $p.CommandLine -and
          (($p.CommandLine -like "*$serverArg*") -or ($p.CommandLine -like "*$serverArgWin*"))) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
        $stopped = $true
      }
    }
  } catch {
    $stopped = $false
  }
  if (-not $stopped) {
    & (Join-Path $PSScriptRoot 'stop.ps1') -Quiet
  }
  for ($i = 0; $i -lt 40; $i++) {
    if (-not (Test-Health)) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
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

# 准备（repo-003）：依赖清单变了就重装，代码变了就重新构建前端；没变什么都不做。
# 做完在 dist/.study-build-stamp 记下代码指纹，下面拿它和正在跑的服务比。
$pmArg = if ($pm) { $pm } else { 'none' }
& node scripts/prestart.ts --pm $pmArg
if ($LASTEXITCODE -ne 0) { Write-Host '[x] 准备失败，看上面的报错。'; exit 1 }
$stamp = ''
try { $stamp = (Get-Content (Join-Path $root 'dist/.study-build-stamp') -Raw -ErrorAction Stop).Trim() } catch { $stamp = '' }

$health = Get-Health
$needStart = $true
if ($health) {
  if ($stamp -and $health.stamp -eq $stamp) {
    Write-Host '[=] 服务已在运行，已是最新版本。'
    $needStart = $false
  } else {
    # 旧版本的服务还开着（代码更新过、或者是更新前起的）：换成新的。浏览器里开着的页面会提示刷新
    Write-Host '[*] 正在运行的是旧版本的服务，先关掉它再启动新版本...'
    if (-not (Stop-OldServer)) {
      Write-Host "[x] 关不掉占着端口 $port 的进程，请先运行 bin\stop.ps1 或在任务管理器里结束 node.exe。"
      exit 1
    }
  }
}

if ($needStart) {
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

if ($NoAssistant) {
  Write-Host '[=] 跳过捕获助手（-NoAssistant）。'
} else {
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
}

if ($NoBrowser) {
  Write-Host "[=] 服务地址：$url"
} else {
  try { Start-Process $url } catch { Write-Host "[!] 自动打开浏览器失败，请手动访问 $url" }
  Write-Host "[=] 已打开 $url"
}
exit 0
