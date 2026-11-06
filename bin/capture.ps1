#Requires -Version 5.1
<#
.SYNOPSIS
    study-notes 快速捕获助手：常驻内存的预热 WPF 小窗 + 系统级热键。

.DESCRIPTION
    「记 idea 快到感觉不到延迟」的落点：
      * 进程启动时只创建一次 WPF 窗口并 Hide()，之后每次热键只做
        Show + Activate + Focus —— 不启动浏览器、不加载页面、不重建控件树。
      * 预热后单次「热键 -> 窗口可见」实测在个位数到几十毫秒（见 -SelfTest 输出），
        预算是 300ms。

    快捷键：
      Ctrl+Alt+Space   唤起小窗（可用 -Hotkey 'ctrl+alt+f9' 覆盖）
      Ctrl+Enter       提交到 POST /api/capture
      Esc              丢弃并隐藏
      窗口失焦         自动隐藏

    日志：%TEMP%\capture-timing.log
      每次热键唤起追加一行：   2026-10-30T15:20:01.123 show=42ms
      热键注册失败写一行：     RegisterHotKey failed (1409)

    参数：
      -Hotkey  <string>  默认 ctrl+alt+space（设计稿里说的 data/config.json 覆盖项这次没有接，
                         要改热键就改 .vbs / 快捷方式的命令行参数，或在这里加一段读 config 的代码）
      -BaseUrl <string>  默认 http://127.0.0.1:7777
      -KeepDraft         唤起时保留上次没发出去的内容（默认清空）
      -SelfTest          自检模式：注册热键 + 预热 + 连续 10 次调用显示函数并打印每次耗时，
                         再用 PostMessage 注入 WM_HOTKEY 走一遍真实消息路径，打印完退出

    ── 人工验收步骤（需要真实桌面会话；自动化环境里没法按物理热键）──
      1) 双击 bin\捕获助手.vbs（无窗口常驻），或：
         powershell -NoProfile -ExecutionPolicy Bypass -File bin\capture.ps1
      2) 在任意程序里按 Ctrl+Alt+Space：小窗立刻出现在鼠标所在屏幕中央，光标已在输入框
      3) 输入一句话 -> Ctrl+Enter：状态行显示「已收进 inbox」，约 600ms 后淡出；
         打开笔记应用确认 inbox 里多了这条 idea
      4) 看 %TEMP%\capture-timing.log：每次唤起都有一行 show=xxms
      5) 按 Esc：窗口消失、内容丢弃；写一半点了别的窗口：自动隐藏
      6) 把服务停掉（关掉 node 进程）-> 唤起 -> 输入 -> Ctrl+Enter：
         状态行先显示「服务未启动，正在拉起…」，最多 8 秒后自动拉起 bin\start.ps1 并重试提交；
         若 bin\start.ps1 不存在或起不来 -> 窗口内红字「保存失败：服务未响应」
      7) 热键被别的程序占用：进程退出码 2，日志出现 RegisterHotKey failed (1409)
      8) 重复双击 .vbs：第二个实例注册热键失败后自己退出，不会双开窗口

    实现要点（给后续维护者）：
      * P/Invoke 只做最小集合：RegisterHotKey / UnregisterHotKey / PostMessage / PeekMessage /
        TranslateMessage / DispatchMessage / GetCursorPos / MonitorFromPoint / GetMonitorInfo /
        SetForegroundWindow。
      * 消息泵不是手写的 GetMessage 循环，而是 WPF 的 Dispatcher 消息循环（Application.Run）：
        它内部就是 GetMessage / TranslateMessage / DispatchMessage 的等价 Win32 泵。
        热键挂在独立的 message-only 窗口（HWND_MESSAGE，HwndSource）上，经 hook 收 WM_HOTKEY，
        与可见窗口的生命周期解耦；手写 GetMessage 循环会跟 WPF 渲染泵抢同一个线程队列，得不偿失。
      * 热键窗口与可见窗口都在同一个 STA 线程上，热键回调直接同步显示窗口，没有跨线程排队。
      * 零第三方模块：WPF / PresentationFramework 是 Windows 自带（.NET Framework 或
        Windows 桌面运行时）。PowerShell 5.1 默认 STA；pwsh 7 默认 MTA，脚本会自己带 -STA 重启。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File bin\capture.ps1 -SelfTest

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File bin\capture.ps1 -Hotkey "ctrl+alt+F9"
#>
[CmdletBinding()]
param(
    [string]$Hotkey = 'ctrl+alt+space',
    [string]$BaseUrl = 'http://127.0.0.1:7777',
    [switch]$KeepDraft,
    [switch]$SelfTest
)

$ErrorActionPreference = 'Continue'
Set-StrictMode -Off

# ------------------------------------------------------------------ 单实例
# 重复启动时第二个进程抢 RegisterHotKey 会失败（错误 1409）并弹冲突提示框，
# 所以用全局互斥量挡掉：已有常驻实例就安静退出。SelfTest 不受影响。
if (-not $SelfTest) {
    $script:SingletonMutex = [System.Threading.Mutex]::new($false, 'Local\study-notes-capture-v1')
    $acquired = $false
    try {
        $acquired = $script:SingletonMutex.WaitOne(0)
    } catch [System.Threading.AbandonedMutexException] {
        $acquired = $true
    }
    if (-not $acquired) { exit 0 }
}

# ------------------------------------------------------------------ 基础状态
$script:GivenParams    = @{}
foreach ($k in $PSBoundParameters.Keys) { $script:GivenParams[$k] = $PSBoundParameters[$k] }

$script:ScriptPath = $PSCommandPath
if (-not $script:ScriptPath) { $script:ScriptPath = $MyInvocation.MyCommand.Path }
$script:BinDir = Split-Path -Parent $script:ScriptPath
$script:BaseUrl = $BaseUrl.TrimEnd('/')

$script:SelfTestMode   = [bool]$SelfTest
$script:KeepDraft      = [bool]$KeepDraft
$script:LogTiming      = $true      # SelfTest 里关掉，免得污染真实热键日志
$script:Submitting     = $false     # 提交中：别让「失焦隐藏」把窗口吞掉
$script:SuppressHide   = $false     # SelfTest 用
$script:ShowGeneration = 0          # 每次唤起 +1，用来丢弃过期的淡出计时器
$script:FadeGeneration = 0
$script:LastShowMs     = $null
$script:DpiScale       = 0.0
$script:HotkeyRegistered = $false
$script:HotkeyError      = 0
$script:HotkeySpec       = $null
$script:WarmupMs         = 0.0

$script:LogPath     = Join-Path ([IO.Path]::GetTempPath()) 'capture-timing.log'
$script:LogEncoding = [System.Text.UTF8Encoding]::new($false)

# 热键优先级：命令行 -Hotkey > data/config.json 的 capture.hotkey > 默认 ctrl+alt+space。
# 这样热键被占用时用户有官方出路，不用改脚本。
function Resolve-CaptureHotkey {
    param([string]$Current)
    if ($script:GivenParams.ContainsKey('Hotkey') -and $Current) { return $Current }
    $root = Split-Path -Parent $script:BinDir
    $candidates = @()
    if ($env:STUDY_DATA) { $candidates += (Join-Path $env:STUDY_DATA 'config.json') }
    $candidates += (Join-Path $root 'data\config.json')
    foreach ($file in $candidates) {
        if (-not (Test-Path -LiteralPath $file)) { continue }
        try {
            $cfg = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
            $names = @($cfg.PSObject.Properties.Name)
            $spec = $null
            if ($names -contains 'capture' -and $cfg.capture) { $spec = $cfg.capture.hotkey }
            if (-not $spec -and ($names -contains 'captureHotkey')) { $spec = $cfg.captureHotkey }
            if ($spec -is [string] -and $spec.Trim()) { return $spec.Trim() }
        } catch { }
    }
    return $Current
}

# 热键注册失败时给出看得见的反馈（.vbs 是隐藏启动的，只写日志等于静默失效）
function Show-HotkeyConflictDialog {
    param([int]$Code, [string]$Spec)
    $why = if ($Code -eq 1409) { "热键 $Spec 已被其它程序占用。" } else { "热键 $Spec 注册失败（错误码 $Code）。" }
    $msg = @"
$why

捕获助手这次没有启动，所以按热键不会有反应。

换一个没被占用的热键：
1) 打开 data\config.json（没有就新建），写入：
   { "capture": { "hotkey": "ctrl+alt+f9" } }
2) 关掉可能占用热键的程序，再双击 bin\捕获助手.vbs

也可以临时用命令行指定：
powershell -NoProfile -ExecutionPolicy Bypass -File bin\capture.ps1 -Hotkey "ctrl+alt+f9"

日志：%TEMP%\capture-timing.log
"@
    try {
        [void][System.Windows.MessageBox]::Show($msg, 'Study Notes 捕获助手', 'OK', 'Warning')
    } catch {
        Write-Host $msg
    }
}

# ------------------------------------------------------------------ 通用小工具
function Write-LogLine {
    param([string]$Line)
    try {
        [IO.File]::AppendAllText($script:LogPath, $Line + "`r`n", $script:LogEncoding)
    } catch {
        # 日志写不进去不该影响捕获
    }
}

function Write-TimingLogLine {
    param([double]$Milliseconds)
    $stamp = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss.fff', [Globalization.CultureInfo]::InvariantCulture)
    Write-LogLine ('{0} show={1}ms' -f $stamp, [int][math]::Round($Milliseconds))
}

function ConvertTo-Brush {
    param([string]$Hex)
    return [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.ColorConverter]::ConvertFromString($Hex))
}

# ------------------------------------------------------------------ STA 保证
# WPF 必须跑在 STA 线程上。PowerShell 5.1 默认 STA、pwsh 7 默认 MTA，
# 所以这里自己带 -STA 重启一次（不改变任何命令行参数）。
if ([Threading.Thread]::CurrentThread.GetApartmentState() -ne [Threading.ApartmentState]::STA) {
    $exe = $null
    try { $exe = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName } catch { }
    if (-not $exe) { $exe = 'powershell.exe' }

    $childArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', ('"' + $script:ScriptPath + '"'))
    if ($script:GivenParams.ContainsKey('Hotkey'))  { $childArgs += @('-Hotkey',  ('"' + [string]$script:GivenParams['Hotkey']  + '"')) }
    if ($script:GivenParams.ContainsKey('BaseUrl')) { $childArgs += @('-BaseUrl', ('"' + [string]$script:GivenParams['BaseUrl'] + '"')) }
    if ($script:KeepDraft) { $childArgs += '-KeepDraft' }

    if ($script:SelfTestMode) {
        $childArgs += '-SelfTest'
        # 自检：等子进程跑完并把控制台输出交还给父进程，父进程返回子进程退出码
        $child = Start-Process -FilePath $exe -ArgumentList $childArgs -NoNewWindow -Wait -PassThru
        exit $child.ExitCode
    }
    # 常驻：无窗口后台拉起后立刻退出（VBS 走的就是这条路）
    Start-Process -FilePath $exe -ArgumentList $childArgs -WindowStyle Hidden | Out-Null
    exit 0
}

# ------------------------------------------------------------------ 原生互操作
# 只声明真正用到的 Win32 入口，避免一大坨没用到的 P/Invoke。
if (-not ('StudyNotesCapture.Native' -as [type])) {
    $nativeSource = @'
using System;
using System.Runtime.InteropServices;

namespace StudyNotesCapture
{
    public static class Native
    {
        public const int WM_HOTKEY = 0x0312;

        public const uint MOD_ALT = 0x0001;
        public const uint MOD_CONTROL = 0x0002;
        public const uint MOD_SHIFT = 0x0004;
        public const uint MOD_WIN = 0x0008;
        public const uint MOD_NOREPEAT = 0x4000;

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT { public int X; public int Y; }

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        public struct MONITORINFO
        {
            public int cbSize;
            public RECT rcMonitor;
            public RECT rcWork;
            public uint dwFlags;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MSG
        {
            public IntPtr hwnd;
            public uint message;
            public IntPtr wParam;
            public IntPtr lParam;
            public uint time;
            public int x;
            public int y;
        }

        public struct WorkArea
        {
            public int Left;
            public int Top;
            public int Width;
            public int Height;
        }

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool PostMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool PeekMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax, uint wRemoveMsg);

        [DllImport("user32.dll")]
        private static extern bool TranslateMessage(ref MSG lpMsg);

        [DllImport("user32.dll")]
        private static extern IntPtr DispatchMessage(ref MSG lpMsg);

        [DllImport("user32.dll")]
        private static extern bool GetCursorPos(out POINT lpPoint);

        [DllImport("user32.dll")]
        private static extern IntPtr MonitorFromPoint(POINT pt, uint dwFlags);

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);

        // 仅 -SelfTest 用：把一条 WM_HOTKEY 投给热键窗口，走真实的窗口消息分发路径
        // （自动化环境里按不了物理热键，这是唯一能端到端验证 hook -> 显示 的办法）
        public static bool PostHotkey(IntPtr hwnd, int id)
        {
            return PostMessage(hwnd, WM_HOTKEY, new IntPtr(id), IntPtr.Zero);
        }

        // 仅 -SelfTest 用：同步泵完该窗口当前队列里的消息（等价 GetMessage/DispatchMessage 循环）
        public static int PumpMessages(IntPtr hwnd)
        {
            MSG msg;
            int count = 0;
            while (PeekMessage(out msg, hwnd, 0, 0, 1))
            {
                TranslateMessage(ref msg);
                DispatchMessage(ref msg);
                count++;
            }
            return count;
        }

        // 跟随鼠标所在显示器的「可用区」（扣掉任务栏），用于把小窗居中
        public static WorkArea GetCursorWorkArea()
        {
            WorkArea wa = new WorkArea();
            POINT pt;
            if (!GetCursorPos(out pt)) return wa;

            IntPtr mon = MonitorFromPoint(pt, 2); // MONITOR_DEFAULTTONEAREST
            if (mon == IntPtr.Zero) return wa;

            MONITORINFO mi = new MONITORINFO();
            mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
            if (!GetMonitorInfo(mon, ref mi)) return wa;

            wa.Left   = mi.rcWork.Left;
            wa.Top    = mi.rcWork.Top;
            wa.Width  = mi.rcWork.Right - mi.rcWork.Left;
            wa.Height = mi.rcWork.Bottom - mi.rcWork.Top;
            return wa;
        }
    }
}
'@
    Add-Type -TypeDefinition $nativeSource -Language CSharp -ErrorAction Stop
}

# ------------------------------------------------------------------ WPF 程序集
try {
    Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase -ErrorAction Stop
} catch {
    Write-Host ('FATAL: 加载 WPF 程序集失败：' + $_.Exception.Message)
    exit 3
}

# ------------------------------------------------------------------ 热键解析
# 支持形如 ctrl+alt+space / Ctrl+Shift+F9 / win+alt+n 的写法
function ConvertTo-VirtualKey {
    param([string]$Name)

    $map = @{
        'space' = 0x20; 'spacebar' = 0x20
        'enter' = 0x0D; 'return' = 0x0D
        'tab' = 0x09
        'esc' = 0x1B; 'escape' = 0x1B
        'backspace' = 0x08
        'delete' = 0x2E; 'del' = 0x2E
        'insert' = 0x2D; 'ins' = 0x2D
        'home' = 0x24; 'end' = 0x23
        'pageup' = 0x21; 'pagedown' = 0x22
        'up' = 0x26; 'down' = 0x28; 'left' = 0x25; 'right' = 0x27
        'capslock' = 0x14; 'numlock' = 0x90; 'scrolllock' = 0x91
        'pause' = 0x13; 'printscreen' = 0x2C
    }
    if ($map.ContainsKey($Name)) { return [uint32]$map[$Name] }

    if ($Name -match '^f([1-9]|1[0-9]|2[0-4])$') {
        return [uint32](0x70 + [int]$matches[1] - 1)
    }
    if ($Name.Length -eq 1) {
        $code = [int]([char]::ToUpperInvariant($Name[0]))
        if (($code -ge 0x30 -and $code -le 0x39) -or ($code -ge 0x41 -and $code -le 0x5A)) {
            return [uint32]$code
        }
    }
    throw ('不支持的热键主键：' + $Name)
}

function ConvertTo-HotkeySpec {
    param([string]$Spec)

    if ([string]::IsNullOrWhiteSpace($Spec)) { throw '热键不能为空' }

    $modMap = @{ ctrl = 2; control = 2; alt = 1; shift = 4; win = 8; windows = 8; meta = 8; super = 8 }
    $mods = [uint32]0
    $keyName = $null

    foreach ($raw in $Spec.Split('+')) {
        $token = $raw.Trim().ToLowerInvariant()
        if ($token -eq '') { continue }
        if ($modMap.ContainsKey($token)) {
            $mods = $mods -bor [uint32]$modMap[$token]
        } else {
            $keyName = $token
        }
    }
    if (-not $keyName) { throw ('热键缺少主键：' + $Spec) }

    return [pscustomobject]@{
        Modifiers = [uint32]($mods -bor 0x4000)   # MOD_NOREPEAT：按住不连发
        VK        = (ConvertTo-VirtualKey $keyName)
        Text      = $Spec
    }
}

# ------------------------------------------------------------------ 窗口构建（只做一次）
function New-CaptureWindow {
    $brushBg     = ConvertTo-Brush '#161A21'
    $brushBorder = ConvertTo-Brush '#2B3340'
    $brushText   = ConvertTo-Brush '#E9EDF3'
    $brushMuted  = ConvertTo-Brush '#7E889B'
    $brushError  = ConvertTo-Brush '#FF6B6B'
    $brushOk     = ConvertTo-Brush '#7BD88F'
    $brushCaret  = ConvertTo-Brush '#6EA8FE'
    $fontFamily  = [System.Windows.Media.FontFamily]::new('Microsoft YaHei UI, Segoe UI, Consolas')

    $win = New-Object System.Windows.Window
    $win.Title                 = '快速捕获'
    $win.Width                 = 520
    $win.Height                = 160
    $win.WindowStyle           = [System.Windows.WindowStyle]::None
    $win.ResizeMode            = [System.Windows.ResizeMode]::NoResize
    $win.Topmost               = $true
    $win.ShowInTaskbar         = $false
    $win.ShowActivated         = $true
    $win.WindowStartupLocation = [System.Windows.WindowStartupLocation]::Manual
    # 圆角要靠 AllowsTransparency + 透明窗口背景；窗口常驻预热，这点合成开销可以忽略
    $win.AllowsTransparency    = $true
    $win.Background            = [System.Windows.Media.Brushes]::Transparent
    [System.Windows.Media.TextOptions]::SetTextFormattingMode($win, [System.Windows.Media.TextFormattingMode]::Display)

    $border = New-Object System.Windows.Controls.Border
    $border.CornerRadius    = [System.Windows.CornerRadius]::new(10)
    $border.BorderThickness = [System.Windows.Thickness]::new(1)
    $border.BorderBrush     = $brushBorder
    $border.Background      = $brushBg
    $border.Padding         = [System.Windows.Thickness]::new(14, 11, 14, 9)

    $grid = New-Object System.Windows.Controls.Grid
    $rowHint   = New-Object System.Windows.Controls.RowDefinition
    $rowHint.Height   = [System.Windows.GridLength]::new(0, [System.Windows.GridUnitType]::Auto)
    $rowInput  = New-Object System.Windows.Controls.RowDefinition
    $rowInput.Height  = [System.Windows.GridLength]::new(1, [System.Windows.GridUnitType]::Star)
    $rowStatus = New-Object System.Windows.Controls.RowDefinition
    $rowStatus.Height = [System.Windows.GridLength]::new(0, [System.Windows.GridUnitType]::Auto)
    [void]$grid.RowDefinitions.Add($rowHint)
    [void]$grid.RowDefinitions.Add($rowInput)
    [void]$grid.RowDefinitions.Add($rowStatus)

    $hint = New-Object System.Windows.Controls.TextBlock
    $hint.Text       = '想法 / Ctrl+Enter 收进 inbox，Esc 丢弃'
    $hint.FontFamily = $fontFamily
    $hint.FontSize   = 12
    $hint.Foreground = $brushMuted
    $hint.Margin     = [System.Windows.Thickness]::new(0, 0, 0, 7)
    [System.Windows.Controls.Grid]::SetRow($hint, 0)

    $textBox = New-Object System.Windows.Controls.TextBox
    $textBox.Background                  = [System.Windows.Media.Brushes]::Transparent
    $textBox.BorderThickness             = [System.Windows.Thickness]::new(0)
    $textBox.Foreground                  = $brushText
    $textBox.CaretBrush                  = $brushCaret
    $textBox.SelectionBrush              = ConvertTo-Brush '#2F4A78'
    $textBox.FontFamily                  = $fontFamily
    $textBox.FontSize                    = 15
    $textBox.TextWrapping                = [System.Windows.TextWrapping]::Wrap
    $textBox.AcceptsReturn               = $true
    $textBox.AcceptsTab                  = $false
    $textBox.VerticalScrollBarVisibility = [System.Windows.Controls.ScrollBarVisibility]::Auto
    $textBox.HorizontalScrollBarVisibility = [System.Windows.Controls.ScrollBarVisibility]::Disabled
    $textBox.Padding                     = [System.Windows.Thickness]::new(0)
    $textBox.Margin                      = [System.Windows.Thickness]::new(0, 0, 0, 6)
    [System.Windows.Controls.Grid]::SetRow($textBox, 1)

    $status = New-Object System.Windows.Controls.TextBlock
    $status.Text       = ''
    $status.FontFamily = $fontFamily
    $status.FontSize   = 12
    $status.Foreground = $brushMuted
    $status.TextTrimming = [System.Windows.TextTrimming]::CharacterEllipsis
    [System.Windows.Controls.Grid]::SetRow($status, 2)

    [void]$grid.Children.Add($hint)
    [void]$grid.Children.Add($textBox)
    [void]$grid.Children.Add($status)

    $border.Child = $grid
    $win.Content  = $border

    # 提前拿到 HWND：热键、DWM、SetForegroundWindow 都要用它，且不必等 Show
    $helper = New-Object System.Windows.Interop.WindowInteropHelper($win)
    $hwnd = $helper.EnsureHandle()

    return [pscustomobject]@{
        Window   = $win
        TextBox  = $textBox
        Hint     = $hint
        Status   = $status
        Hwnd     = $hwnd
        BrushMuted = $brushMuted
        BrushError = $brushError
        BrushOk    = $brushOk
    }
}

# ------------------------------------------------------------------ 热键通道（message-only 窗口）
function New-HotkeySink {
    $params = New-Object System.Windows.Interop.HwndSourceParameters 'StudyNotesCaptureHotkeySink'
    $params.Width        = 0
    $params.Height       = 0
    $params.WindowStyle  = 0
    $params.ParentWindow = [IntPtr](-3)   # HWND_MESSAGE：message-only，不显示、不进任务栏
    return New-Object System.Windows.Interop.HwndSource $params
}

function Register-CaptureHotkey {
    param([string]$Spec)

    # 注意：PowerShell 变量名大小写不敏感，param 上的 [string] 类型约束会一路作用于同名局部变量，
    # 所以这里绝不能再写 $spec = ...（那会把 PSCustomObject 静默强转成字符串）。
    $hotkey = ConvertTo-HotkeySpec $Spec
    $sink   = $script:Sink.Handle
    $id     = 1

    $ok  = [StudyNotesCapture.Native]::RegisterHotKey($sink, $id, $hotkey.Modifiers, $hotkey.VK)
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()

    if (-not $ok -and ($hotkey.Modifiers -band 0x4000)) {
        # Windows XP / 老系统不认 MOD_NOREPEAT，退一步再试一次
        $ok  = [StudyNotesCapture.Native]::RegisterHotKey($sink, $id, [uint32]($hotkey.Modifiers -band (-bnot 0x4000)), $hotkey.VK)
        $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    }

    if (-not $ok) {
        $script:HotkeyError = $err
        Write-LogLine ('RegisterHotKey failed ({0})' -f $err)
        return $null
    }
    $script:HotkeyError      = 0
    $script:HotkeyRegistered = $true
    return $hotkey
}

# ------------------------------------------------------------------ 显示 / 隐藏
function Get-DpiScale {
    if ($script:DpiScale -gt 0) { return $script:DpiScale }
    try {
        $d = [System.Windows.Media.VisualTreeHelper]::GetDpi($script:Window)
        if ($d.DpiScaleX -gt 0) { $script:DpiScale = [double]$d.DpiScaleX; return $script:DpiScale }
    } catch { }
    $script:DpiScale = 1.0
    return $script:DpiScale
}

function Set-CaptureWindowPosition {
    $wa = [StudyNotesCapture.Native]::GetCursorWorkArea()
    if ($wa.Width -le 0 -or $wa.Height -le 0) {
        # 拿不到显示器信息就退回主屏可用区
        $area = [System.Windows.SystemParameters]::WorkArea
        $wa = [pscustomobject]@{
            Left = [int]$area.Left; Top = [int]$area.Top
            Width = [int]$area.Width; Height = [int]$area.Height
        }
    }
    $scale = Get-DpiScale
    $w = $script:Window.Width
    $h = $script:Window.Height
    $script:Window.Left = ($wa.Left / $scale) + [math]::Max(0, (($wa.Width / $scale) - $w) / 2)
    $script:Window.Top  = ($wa.Top  / $scale) + [math]::Max(0, (($wa.Height / $scale) - $h) / 2 - 40)
}

function Show-CaptureWindow {
    <# 热键路径和 -SelfTest 路径共用这一个入口；返回「从开始到窗口可见」的毫秒数 #>
    param([System.Diagnostics.Stopwatch]$Stopwatch)

    if ($null -eq $Stopwatch) { $Stopwatch = [System.Diagnostics.Stopwatch]::StartNew() }

    $script:ShowGeneration++

    # 1) 复位上一次淡出留下的状态
    try { $script:Window.BeginAnimation([System.Windows.Window]::OpacityProperty, $null) } catch { }
    $script:Window.Opacity = 1.0
    if ($script:PendingTimer) { try { $script:PendingTimer.Stop() } catch { }; $script:PendingTimer = $null }

    # 2) 清空上次内容（-KeepDraft 时保留草稿）
    if (-not $script:KeepDraft) { $script:TextBox.Text = '' }
    $script:Status.Text       = ''
    $script:Status.Foreground = $script:BrushMuted

    # 3) 摆到鼠标所在屏幕中央，然后才 Show
    Set-CaptureWindowPosition

    [void]$script:Window.Show()
    [void]$script:Window.Activate()

    # 进程在后台时 Activate() 会被前台锁挡住；按热键触发的这次前台权限通常已放开
    if (-not $script:Window.IsActive) {
        [void][StudyNotesCapture.Native]::SetForegroundWindow($script:Ui.Hwnd)
    }

    # 4) 光标落到输入框
    $script:TextBox.CaretIndex = $script:TextBox.Text.Length
    [void]$script:TextBox.Focus()
    [void][System.Windows.Input.Keyboard]::Focus($script:TextBox)

    # 5) 把布局 + 渲染推完，这样测出来的才是「真的能看见」
    [void]$script:Window.UpdateLayout()
    try {
        [void]$script:Window.Dispatcher.Invoke(
            [System.Windows.Threading.DispatcherPriority]::Render,
            [Action]{ })
    } catch { }

    $Stopwatch.Stop()
    return [double]$Stopwatch.Elapsed.TotalMilliseconds
}

function Hide-CaptureWindow {
    try {
        if ($script:PendingTimer) { $script:PendingTimer.Stop(); $script:PendingTimer = $null }
        [void]$script:Window.Hide()
        try { $script:Window.BeginAnimation([System.Windows.Window]::OpacityProperty, $null) } catch { }
        $script:Window.Opacity = 1.0
    } catch { }
}

function Invoke-HotkeyShow {
    # 热键一响就走这里：唯一的开销就是 Show/Activate/Focus 三件套
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $ms = Show-CaptureWindow -Stopwatch $sw
    } catch {
        Write-LogLine ('show failed: ' + $_.Exception.Message)
        return
    }
    $script:LastShowMs = $ms
    if ($script:LogTiming) { Write-TimingLogLine $ms }
}

function Set-CaptureStatus {
    param([string]$Text, [System.Windows.Media.Brush]$Brush)
    $script:Status.Text = $Text
    $script:Status.Foreground = $Brush
    try {
        [void]$script:Window.Dispatcher.Invoke(
            [System.Windows.Threading.DispatcherPriority]::Render,
            [Action]{ })
    } catch { }
}

function Start-CaptureFade {
    $anim = New-Object System.Windows.Media.Animation.DoubleAnimation
    $anim.From     = 1.0
    $anim.To       = 0.0
    $anim.Duration = [System.Windows.Duration]::new([TimeSpan]::FromMilliseconds(220))
    # 淡出这 220ms 里如果又被热键唤起，这轮回调不能把新窗口藏掉
    $fadeGen = $script:ShowGeneration
    $anim.Add_Completed([EventHandler]{
        param($sender, $evt)
        if ($fadeGen -ne $script:ShowGeneration) { return }
        Hide-CaptureWindow
    })
    $script:FadeAnim = $anim
    $script:Window.BeginAnimation([System.Windows.Window]::OpacityProperty, $anim)
}

function Start-CaptureSuccessSequence {
    # 「已收进 inbox」先亮 600ms，再 220ms 淡出，然后隐藏
    $script:FadeGeneration = $script:ShowGeneration
    $timer = New-Object System.Windows.Threading.DispatcherTimer
    $timer.Interval = [TimeSpan]::FromMilliseconds(600)
    $timer.Add_Tick([EventHandler]{
        param($sender, $evt)
        $sender.Stop()
        if ($script:FadeGeneration -ne $script:ShowGeneration) { return }  # 期间又被热键唤起过
        Start-CaptureFade
    })
    $script:PendingTimer = $timer
    $timer.Start()
}

# ------------------------------------------------------------------ 提交
function Test-ServiceReachable {
    param([int]$TimeoutSeconds = 2)
    try {
        $resp = Invoke-WebRequest -Uri ($script:BaseUrl + '/api/health') -UseBasicParsing -TimeoutSec $TimeoutSeconds -ErrorAction Stop
        return ($null -ne $resp -and [int]$resp.StatusCode -ge 200 -and [int]$resp.StatusCode -lt 500)
    } catch {
        return $false
    }
}

function Start-CaptureService {
    <# 尝试拉起 bin\start.ps1，最多等 8 秒；返回服务是否真的起来了 #>
    $startScript = Join-Path $script:BinDir 'start.ps1'
    if (-not (Test-Path -LiteralPath $startScript)) { return $false }
    try {
        $root = Split-Path -Parent $script:BinDir
        Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $startScript + '"')) -WorkingDirectory $root -WindowStyle Hidden | Out-Null
    } catch {
        return $false
    }
    $deadline = [DateTime]::UtcNow.AddMilliseconds(8000)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-ServiceReachable -TimeoutSeconds 1) { return $true }
        Start-Sleep -Milliseconds 250
    }
    return $false
}

function Get-ErrorSummary {
    param($ErrorRecord)
    $ex = $ErrorRecord.Exception
    try {
        if ($ex.Response -and $ex.Response.StatusCode) {
            return ('HTTP ' + [int]$ex.Response.StatusCode)
        }
    } catch { }
    if ($ex.InnerException -and -not [string]::IsNullOrWhiteSpace($ex.InnerException.Message) -and $ex.Message -notmatch 'connect') {
        return $ex.InnerException.Message
    }
    return $ex.Message
}

function Send-CaptureRequest {
    param([string]$Text)
    $json  = @{ text = $Text; tags = @() } | ConvertTo-Json -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)   # 显式 UTF-8，PS 5.1 不会替你猜
    return Invoke-RestMethod -Method Post -Uri ($script:BaseUrl + '/api/capture') `
        -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec 6 -ErrorAction Stop
}

function Submit-Capture {
    param([string]$Text)

    if ([string]::IsNullOrWhiteSpace($Text)) {
        Hide-CaptureWindow
        return
    }

    $script:Submitting = $true
    try {
        Set-CaptureStatus '保存中…' $script:BrushMuted
        $sent = $false
        $lastError = $null

        try {
            [void](Send-CaptureRequest -Text $Text)
            $sent = $true
        } catch {
            $lastError = $_

            # 连接不上 = 服务没起：拉起来再重试一次；服务在跑但不是 404/500 之类就别乱拉
            if (-not (Test-ServiceReachable -TimeoutSeconds 2)) {
                Set-CaptureStatus '服务未启动，正在拉起…' $script:BrushMuted
                $started = Start-CaptureService
                if (-not $started) {
                    Set-CaptureStatus '保存失败：服务未响应' $script:BrushError
                    return
                }
                try {
                    [void](Send-CaptureRequest -Text $Text)
                    $sent = $true
                } catch {
                    $lastError = $_
                }
            }
        }

        if ($sent) {
            $script:TextBox.Text = ''
            Set-CaptureStatus '已收进 inbox' $script:BrushOk
            Start-CaptureSuccessSequence
        } else {
            $summary = Get-ErrorSummary $lastError
            if ([string]::IsNullOrWhiteSpace($summary)) { $summary = '服务未响应' }
            Set-CaptureStatus ('保存失败：' + $summary) $script:BrushError
            Write-LogLine ('capture failed: ' + $summary)
        }
    } finally {
        $script:Submitting = $false
    }
}

# ------------------------------------------------------------------ 键盘事件
function Set-CaptureEventHandlers {
    $windowKeyDown = [System.Windows.Input.KeyEventHandler]{
        param($sender, $e)

        if ($e.Key -eq [System.Windows.Input.Key]::Escape) {
            $script:TextBox.Text = ''
            Hide-CaptureWindow
            $e.Handled = $true
            return
        }

        if ($e.Key -eq [System.Windows.Input.Key]::Enter) {
            $ctrl = ([System.Windows.Input.Keyboard]::Modifiers -band [System.Windows.Input.ModifierKeys]::Control) -ne 0
            if ($ctrl) {
                $e.Handled = $true
                Submit-Capture -Text $script:TextBox.Text
            }
        }
    }
    $script:WindowKeyDown = $windowKeyDown
    $script:Window.Add_PreviewKeyDown($windowKeyDown)

    # 特征性的一步：失焦就藏起来（提完 idea 马上回去干活）
    $deactivated = [EventHandler]{
        param($sender, $e)
        if ($script:SelfTestMode -or $script:SuppressHide -or $script:Submitting) { return }
        Hide-CaptureWindow
    }
    $script:WindowDeactivated = $deactivated
    $script:Window.Add_Deactivated($deactivated)
}

# ------------------------------------------------------------------ 清理
function Clear-CaptureResources {
    try {
        if ($script:HotkeyRegistered -and $script:Sink) {
            [void][StudyNotesCapture.Native]::UnregisterHotKey($script:Sink.Handle, 1)
            $script:HotkeyRegistered = $false
        }
    } catch { }
    try { if ($script:Window) { $script:Window.Hide() } } catch { }
    try { if ($script:Sink) { $script:Sink.Dispose() } } catch { }
}

# ------------------------------------------------------------------ 自检
function Invoke-CaptureSelfTest {
    $script:SuppressHide = $true
    $script:LogTiming    = $false     # 别把自检写进真实热键日志

    Write-Host 'capture.ps1 -SelfTest'
    Write-Host ('  powershell={0}  apartment={1}  win={2}' -f $PSVersionTable.PSVersion, [Threading.Thread]::CurrentThread.GetApartmentState(), [Environment]::OSVersion.Version)

    if (-not $script:HotkeyRegistered) {
        Write-Host ('  register=FAILED ({0})' -f $script:HotkeyError)
        Clear-CaptureResources
        return 2
    }
    Write-Host ('  register=OK  hotkey={0}  sink=0x{1:X}' -f $script:HotkeySpec.Text, [int64]$script:Sink.Handle)
    Write-Host ('  warmup={0:N1}ms (one-time window warm-up, not counted below)' -f $script:WarmupMs)

    $samples  = New-Object System.Collections.Generic.List[double]
    $focusOk  = $false
    for ($i = 1; $i -le 10; $i++) {
        $ms = Show-CaptureWindow
        $samples.Add($ms)
        if ($i -eq 1) { try { $focusOk = [bool]$script:TextBox.IsFocused } catch { $focusOk = $false } }
        Write-Host ('  [{0:D2}] show={1:N2}ms' -f $i, $ms)
        Hide-CaptureWindow
    }
    Write-Host ('  textbox.focused={0}' -f $focusOk)

    $stat  = $samples | Measure-Object -Average -Minimum -Maximum
    $allOk = ($stat.Maximum -lt 300)
    Write-Host ('  avg={0:N2}ms  min={1:N2}ms  max={2:N2}ms  target<300ms -> {3}' -f `
            $stat.Average, $stat.Minimum, $stat.Maximum, $(if ($allOk) { 'PASS' } else { 'FAIL' }))

    # 真实消息路径：PostMessage(WM_HOTKEY) -> 窗口消息 -> hook -> Show
    Write-Host '  hotkey message path (injected WM_HOTKEY, no physical key needed):'
    $injectOk = 0
    for ($j = 1; $j -le 3; $j++) {
        $script:LastShowMs = $null
        $posted = [StudyNotesCapture.Native]::PostHotkey($script:Sink.Handle, 1)
        $pumped = [StudyNotesCapture.Native]::PumpMessages($script:Sink.Handle)
        $shown  = $script:LastShowMs
        if ($null -ne $shown) { $injectOk++ }
        Write-Host ('  [inject{0}] posted={1} pumped={2} hook_show={3}' -f $j, $posted, $pumped, $(if ($null -ne $shown) { ('{0:N2}ms' -f $shown) } else { 'MISSED' }))
        Hide-CaptureWindow
    }

    Clear-CaptureResources

    if (-not $allOk) { return 3 }
    if ($injectOk -lt 3) { return 4 }
    Write-Host '  result=PASS'
    return 0
}

# ------------------------------------------------------------------ 常驻主循环
function Start-CaptureDaemon {
    $app = New-Object System.Windows.Application
    $app.ShutdownMode = [System.Windows.ShutdownMode]::OnExplicitShutdown

    # WPF 的 Dispatcher 消息循环就是等价的 Win32 消息泵：
    # 它负责泵 WM_HOTKEY 到热键窗口的 hook，也负责渲染。
    try {
        [void]$app.Run()
    } finally {
        Clear-CaptureResources
    }
}

# ================================================================== 启动
$exitCode = 0

try {
    $script:Ui       = New-CaptureWindow
    $script:Window   = $script:Ui.Window
    $script:TextBox  = $script:Ui.TextBox
    $script:Hint     = $script:Ui.Hint
    $script:Status   = $script:Ui.Status
    $script:BrushMuted = $script:Ui.BrushMuted
    $script:BrushError = $script:Ui.BrushError
    $script:BrushOk    = $script:Ui.BrushOk

    $script:Sink = New-HotkeySink
    $sinkHook = [System.Windows.Interop.HwndSourceHook]{
        param($hwnd, $msg, $wParam, $lParam, $handled)
        if ($msg -eq 0x0312) {   # WM_HOTKEY
            Invoke-HotkeyShow
        }
        return [IntPtr]::Zero
    }
    $script:SinkHook = $sinkHook
    $script:Sink.AddHook($sinkHook)

    Set-CaptureEventHandlers

    # 预热：先 Show/Hide 一次，把 WPF 首帧的初始化成本（~100ms）挪到进程启动阶段，
    # 这样第一次按热键也是「秒开」。这次耗时不计入热键日志。
    $warmSw = [System.Diagnostics.Stopwatch]::StartNew()
    [void](Show-CaptureWindow -Stopwatch $warmSw)
    Hide-CaptureWindow
    $script:WarmupMs = [double]$warmSw.Elapsed.TotalMilliseconds

    $Hotkey = Resolve-CaptureHotkey -Current $Hotkey
    $script:HotkeySpec = Register-CaptureHotkey $Hotkey

    if ($script:SelfTestMode) {
        $exitCode = Invoke-CaptureSelfTest
    } elseif (-not $script:HotkeyRegistered) {
        Write-Host ('RegisterHotKey failed ({0})  hotkey={1}' -f $script:HotkeyError, $Hotkey)
        Show-HotkeyConflictDialog -Code $script:HotkeyError -Spec $Hotkey
        Clear-CaptureResources
        $exitCode = 2
    } else {
        Start-CaptureDaemon
        $exitCode = 0
    }
} catch {
    try { Write-LogLine ('fatal: ' + $_.Exception.Message) } catch { }
    Write-Host ('FATAL: ' + $_.Exception.Message)
    Clear-CaptureResources
    $exitCode = 3
}

exit $exitCode
