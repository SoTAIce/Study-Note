param(
  [switch]$Remove,
  [string]$Profile = 'desktop',
  [string]$DshHome = ''
)

# 把 Study Notes 的 MCP 服务器注册进 DSH 的用户 patch 层（默认 desktop profile）。
# 用户层 cordis.patch.yml 会在每个 bundle 层之后应用，改完重启 DSH 生效。
# 幂等：已有 study-notes 条目就跳过；所有改动前先备份。

$ErrorActionPreference = 'Stop'

if (-not $DshHome) {
  if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME } else { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
}
$patchFile = Join-Path $DshHome (Join-Path 'profiles' (Join-Path $Profile 'cordis.patch.yml'))
$mcpServer = 'D:\work\study-notes\dsh-mcp\server.mjs'
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { throw '找不到 node，请先确保 node 在 PATH 里' }

$beginMark = '# >>> study-notes MCP（由 bin\install-mcp.ps1 写入，勿手改）'
$endMark = '# <<< study-notes MCP'

function Read-PatchText {
  if (-not (Test-Path -LiteralPath $patchFile)) { return '' }
  return [System.IO.File]::ReadAllText($patchFile, [System.Text.Encoding]::UTF8)
}

function Get-Block {
  $q = "'" + $nodeExe + "'"
  $a = "'" + $mcpServer + "'"
  $repo = Split-Path -Parent $PSScriptRoot
  $root = "'" + $repo + "'"
  $data = "'" + (Join-Path $repo 'data') + "'"
  return @"
$beginMark
- insert:
    - id: mcp-study-notes
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: study-notes
        transport: stdio
        command: $q
        args:
          - $a
        env:
          STUDY_NOTES_DIR: $root
          STUDY_DATA: $data
        toolCallTimeoutMs: 60000
        failOnStartupError: false
$endMark
"@
}

if (-not (Test-Path -LiteralPath $patchFile)) {
  throw "找不到 $patchFile。请确认 DSH 装过 $Profile profile。"
}

$current = Read-PatchText

if ($Remove) {
  if ($current -notmatch [regex]::Escape($beginMark)) {
    Write-Host "[=] 没找到 study-notes MCP 配置，无需撤回。"
    exit 0
  }
  $pattern = "(?s)\r?\n?" + [regex]::Escape($beginMark) + ".*?" + [regex]::Escape($endMark) + "\r?\n?"
  $next = [regex]::Replace($current, $pattern, "`n")
  Copy-Item -LiteralPath $patchFile -Destination "$patchFile.bak-$(Get-Date -Format yyyyMMddHHmmss)" -Force
  [System.IO.File]::WriteAllText($patchFile, $next, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "[=] 已撤回。重启 DSH 后生效。"
  exit 0
}

if ($current -match [regex]::Escape($beginMark) -or $current -match 'mcp-study-notes') {
  Write-Host "[=] 已经注册过 study-notes MCP，跳过（要重写就先用 -Remove）。"
  exit 0
}

Copy-Item -LiteralPath $patchFile -Destination "$patchFile.bak-$(Get-Date -Format yyyyMMddHHmmss)" -Force
$separator = if ($current.TrimEnd().Length -eq 0) { '' } else { "`n" }
$next = $current.TrimEnd() + $separator + "`n" + (Get-Block) + "`n"
[System.IO.File]::WriteAllText($patchFile, $next, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "[=] 已写入 $patchFile"
Write-Host '    重启 DSH 后，模型侧会出现这些工具：'
Write-Host '      mcp__study-notes__notes_search / notes_read / notes_create / notes_append / notes_capture'
Write-Host '    验证：让 DSH 调一次 mcp__study-notes__notes_search；再调 notes_capture，看 data\notes\inbox\ 是否多一条。'
Write-Host '    撤回：bin\install-mcp.ps1 -Remove'
