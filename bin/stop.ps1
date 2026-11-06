param(
  [switch]$Quiet
)

# 停掉 Study Notes 的后台进程：笔记服务 + 捕获助手。
#
# 两条铁律：
#   1. 只杀「真的在跑我们脚本」的进程：命令行必须是 `-File <...>bin\capture.ps1`
#      或 `node server/main.ts`。光在命令行里"提到"这些字样不算，否则会误杀
#      调用它的终端 / 工具进程。
#   2. 绝不杀自己和自己的祖先进程。
# 为了让本脚本自己的命令行里不出现完整的匹配串（否则会匹配到自己），
# 匹配串一律用拼接生成。

$ErrorActionPreference = 'Continue'
$port = if ($env:STUDY_PORT) { $env:STUDY_PORT } else { '7777' }

$scriptName = 'capture' + '.ps1'
$serverArg = 'server' + '/' + 'main.ts'
$serverArgWin = 'server' + '\' + 'main.ts'
$assistantArg = '捕获' + '助手' + '.vbs'

$selfId = $PID
$ancestors = New-Object System.Collections.Generic.HashSet[int]
try {
  $cursor = $selfId
  for ($i = 0; $i -lt 8; $i++) {
    $null = $ancestors.Add($cursor)
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$cursor" -ErrorAction Stop
    if (-not $p -or -not $p.ParentProcessId) { break }
    $cursor = [int]$p.ParentProcessId
  }
} catch {
  $null = $ancestors.Add($selfId)
}

function Stop-Matching([string]$namePattern, [string[]]$commandPatterns) {
  $hits = @()
  try {
    $hits = @(Get-CimInstance Win32_Process -Filter "Name='$namePattern'" -ErrorAction Stop |
      Where-Object {
        # 注意：内层再嵌套 Where-Object 时 $_ 会变成「匹配串」，所以先把进程存进 $proc，
        # 否则 $_.CommandLine 取到的是字符串属性（$null），永远匹配不上。
        $proc = $_
        $matched = $false
        foreach ($pat in $commandPatterns) {
          if ($pat -and $proc.CommandLine -and ($proc.CommandLine -like $pat)) { $matched = $true; break }
        }
        $matched -and -not $ancestors.Contains([int]$proc.ProcessId)
      })
  } catch {
    return 0
  }
  $n = 0
  foreach ($h in $hits) {
    try {
      Stop-Process -Id $h.ProcessId -Force -ErrorAction Stop
      $n++
    } catch { }
  }
  return $n
}

$killed = 0
$killed += Stop-Matching 'node.exe' @("*$serverArg*", "*$serverArgWin*")
$killed += Stop-Matching 'powershell.exe' @("*-File*$scriptName*")
$killed += Stop-Matching 'wscript.exe' @("*$assistantArg*")

# 兜底：CIM 被限制时按端口找持有者（仍排除自己）
if ($killed -eq 0) {
  try {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop
    foreach ($c in $conn) {
      if ($ancestors.Contains([int]$c.OwningProcess)) { continue }
      Stop-Process -Id $c.OwningProcess -Force -ErrorAction Stop
      $killed++
    }
  } catch { }
}

Start-Sleep -Milliseconds 300
$stillUp = $false
try {
  $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri "http://127.0.0.1:$port/api/health"
  $stillUp = $true
} catch { }

if (-not $Quiet) {
  if ($killed -gt 0) { Write-Output "[=] 已停止 $killed 个进程。" }
  else { Write-Output '[=] 没发现正在运行的进程。' }
  if ($stillUp) { Write-Output "[!] 端口 $port 还有响应，可能有别的实例占着。" }
  else { Write-Output "[=] 服务已停（$port 无响应）。笔记都在 data\notes，随时再启动。" }
}
exit 0
