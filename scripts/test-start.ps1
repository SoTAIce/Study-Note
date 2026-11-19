# 一键启动的 Windows 冒烟测试（repo-003），CI 在 Windows 上跑：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-start.ps1
#
# 用真实的 bin/start.ps1 走三遍（不开浏览器、不拉捕获助手，换端口和数据目录，不碰真实数据）：
#   1. 第一次启动：服务起来，健康检查里的代码指纹和刚构建的一致；
#   2. 什么都没改再启动：不重新构建、不重启（同一个进程）；
#   3. 改一个前端源文件再启动（模拟 git pull）：重新构建，旧服务被换成新的（进程变了、指纹变了）。
# 结束时还原改动的文件并停掉服务。

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$port = '7790'
$env:STUDY_PORT = $port
$env:STUDY_DATA = Join-Path ([IO.Path]::GetTempPath()) ('study-start-test-' + [Guid]::NewGuid().ToString('N'))
$probe = Join-Path $root 'web\src\main.tsx'
$original = [IO.File]::ReadAllText($probe)
$failed = $false

function Health {
  try { return Invoke-RestMethod -TimeoutSec 3 -Uri "http://127.0.0.1:$port/api/health" } catch { return $null }
}
function ServerPid {
  try { return @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop)[0].OwningProcess } catch { return $null }
}
function BuildStamp {
  return ([IO.File]::ReadAllText((Join-Path $root 'dist\.study-build-stamp'))).Trim()
}
function BuildTime {
  return (Get-Item (Join-Path $root 'dist\index.html')).LastWriteTimeUtc
}
# 启动脚本的输出直接显示（Out-Host），函数只返回退出码；否则输出会混进返回值
function Start-App {
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'bin\start.ps1') -NoBrowser -NoAssistant | Out-Host
  return [int]$LASTEXITCODE
}
function Check([bool]$ok, [string]$message) {
  if ($ok) { Write-Host "[ok] $message" } else { Write-Host "[x] $message"; $script:failed = $true }
}

try {
  # 1. 第一次
  Check ((Start-App) -eq 0) '第一次启动成功'
  $h1 = Health
  $pid1 = ServerPid
  Check ($null -ne $h1) '服务有响应'
  Check ($h1.stamp -eq (BuildStamp)) "服务的代码指纹和构建时一致（$($h1.stamp)）"
  $built1 = BuildTime

  # 2. 没改动再启动
  Start-Sleep -Seconds 1
  Check ((Start-App) -eq 0) '第二次启动成功'
  Check ((BuildTime) -eq $built1) '没改代码时不重新构建'
  Check ((ServerPid) -eq $pid1) '没改代码时不重启服务（同一个进程）'

  # 3. 模拟 git pull：改一个前端源文件
  [IO.File]::WriteAllText($probe, $original + "`n// start-test $(Get-Date -Format o)`n")
  Check ((Start-App) -eq 0) '代码更新后启动成功'
  $h3 = Health
  $pid3 = ServerPid
  Check ((BuildTime) -gt $built1) '代码更新后重新构建了前端'
  Check ($h3.stamp -ne $h1.stamp) '服务的代码指纹变了'
  Check ($h3.stamp -eq (BuildStamp)) '新服务的指纹和新构建一致'
  Check ($pid3 -ne $pid1) "旧服务被换掉了（进程 $pid1 -> $pid3）"
  Check ($null -eq (Get-Process -Id $pid1 -ErrorAction SilentlyContinue)) '旧进程已经退出'
} catch {
  # 测试脚本自己出错也算失败，不能悄悄跳过后面的检查
  Write-Host "[x] 测试脚本出错：$_"
  $failed = $true
} finally {
  [IO.File]::WriteAllText($probe, $original)
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'bin\stop.ps1') -Quiet
  Remove-Item -Recurse -Force $env:STUDY_DATA -ErrorAction SilentlyContinue
}

if ($script:failed) { Write-Host '[x] 一键启动测试失败'; exit 1 }
Write-Host '[=] 一键启动测试通过'
exit 0
