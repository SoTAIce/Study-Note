# 把当前提交导出成源码快照并推送到公开仓库。
#
# 为什么不用 `git push`：这个仓库的本地历史里有过个人笔记与聊天记录，
# 直接推会把它们一起带出去。这里改用 `git archive` 导出一个没有历史的快照，
# 再剔掉 data/ 下的个人数据，单独提交、单独推送。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File bin\publish.ps1            # 推送到默认远端与分支
#   powershell -ExecutionPolicy Bypass -File bin\publish.ps1 -DryRun    # 只导出并自检，不推送
#   powershell -ExecutionPolicy Bypass -File bin\publish.ps1 -Message "release: v0.2.0"
param(
  [string]$Remote = "https://github.com/SoTAIce/Study-Note.git",
  [string]$Branch = "main",
  [string]$Message = "",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("study-notes-publish-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$status = 0

try {
  New-Item -ItemType Directory -Path $tmp | Out-Null
  Write-Host "导出 HEAD 到 $tmp ..."
  # 用 zip 而不是 tar：git archive 的 tar 里中文文件名带 UTF-8 标记，
  # Windows 自带 bsdtar 会按本地代码页解析，报 "Invalid empty pathname"。.NET 的 zip 解压认 UTF-8 标记。
  # archive 只导出「已提交」的内容，工作区里没提交的笔记不会混进来。
  $archive = Join-Path $tmp "snapshot.zip"
  git -C $root archive --format=zip -o $archive HEAD
  if ($LASTEXITCODE -ne 0) { throw "git archive 失败" }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::ExtractToDirectory($archive, $tmp)
  Remove-Item $archive -Force

  # 白名单式清理 data/：只留 notes/.gitkeep，其余（笔记、分组、索引、配置、聊天、历史、回收站）全删
  $dataDir = Join-Path $tmp "data"
  if (Test-Path $dataDir) {
    Get-ChildItem $dataDir -Force | Where-Object { $_.Name -ne "notes" } | Remove-Item -Recurse -Force
    $notesDir = Join-Path $dataDir "notes"
    if (Test-Path $notesDir) {
      Get-ChildItem $notesDir -Force | Where-Object { $_.Name -ne ".gitkeep" } | Remove-Item -Recurse -Force
    }
  }

  # 兜底自检：任何看起来像凭据或本地笔记的东西都不许出现
  $forbidden = @(
    "data/config.json",
    "data/groups.json",
    "data/index.db",
    "data/chats",
    "data/.history",
    "data/.trash"
  )
  foreach ($rel in $forbidden) {
    if (Test-Path (Join-Path $tmp $rel)) { throw "自检失败：快照里不该有 $rel" }
  }

  $notesLeft = @(Get-ChildItem (Join-Path $tmp "data\notes") -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne ".gitkeep" })
  if ($notesLeft.Count -gt 0) { throw "自检失败：data/notes 里还有 $($notesLeft.Count) 个文件" }

  # 兜底自检：任何看起来像凭据的东西都不许出现在快照里
  $textExts = @(".ts", ".tsx", ".js", ".mjs", ".json", ".md", ".ps1", ".bat", ".vbs", ".css", ".html")
  $secretHits = @()
  $files = Get-ChildItem $tmp -Recurse -File | Where-Object { $textExts -contains $_.Extension.ToLower() }
  foreach ($file in $files) {
    $lineNo = 0
    foreach ($line in Get-Content $file.FullName -Encoding UTF8) {
      $lineNo++
      if ($line -match "sk_[A-Za-z0-9]{16,}") { $secretHits += "${file}:$lineNo" }
    }
  }
  if ($secretHits.Count -gt 0) {
    $secretHits | ForEach-Object { Write-Host ("  " + $_) }
    throw "自检失败：快照里疑似有 API key（见上面文件与行号）"
  }

  # 提交信息写得像正常发布，别在公开历史里自我说明「剔除了什么」
  if (-not $Message) {
    $version = "0.0.0"
    $pkgPath = Join-Path $tmp "package.json"
    if (Test-Path $pkgPath) {
      try { $version = (Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch { }
    }
    $Message = "release: study-notes v$version"
  }

  git -C $tmp init -q -b $Branch
  git -C $tmp add -A
  git -C $tmp -c user.name="SoTAIce" -c user.email="SoTAIce@users.noreply.github.com" `
    commit -q -m $Message
  if ($LASTEXITCODE -ne 0) { throw "提交快照失败" }
  Write-Host "提交信息：$Message"

  $count = (git -C $tmp ls-files | Measure-Object).Count
  Write-Host "快照就绪：$count 个文件，分支 $Branch"
  if ($DryRun) {
    Write-Host "DryRun：没有推送。快照留在 $tmp"
    $status = 2
    return
  }

  git -C $tmp remote add origin $Remote
  # 远端只是这份快照的镜像，每次都是单提交，所以用 force 覆盖
  git -C $tmp push -q --force origin "${Branch}:${Branch}"
  if ($LASTEXITCODE -ne 0) { throw "推送失败（检查凭据：gh auth setup-git）" }
  Write-Host "已推送：$Remote ($Branch)"
  $sha = git -C $tmp rev-parse --short HEAD
  Write-Host "提交：$sha"
}
finally {
  if ($status -ne 2 -and (Test-Path $tmp)) {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}
