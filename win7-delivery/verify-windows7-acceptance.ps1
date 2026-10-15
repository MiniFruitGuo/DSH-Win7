<#
.SYNOPSIS
    DSH Desktop 的 Windows 7 SP1 x64 目标机验收脚本（工单 6 的可执行化）。

.DESCRIPTION
    把 dsh-win7-workorders.md「工单 6」的人工清单变成一台机器上可直接运行的验收工具。
    脚本只做观测与断言，不在目标机上做任何构建或修复动作。

    检查分五个分区：
      1. 主机前置      OS 版本 / x64 / 关键 KB / VC++ 运行库
      2. 运行时自证    直接调用打包的 node.exe，断言版本、能力、full-icu、非 Electron 兼任
      3. 产物完整性    node.exe 大小与 SHA256 / ripgrep 13.x / 更新通道断开 / runtime 目录结构
      4. 静态导入门禁  可选：调用仓库侧 scripts\scan-win7-imports.mjs 并透传退出码
      5. GUI 启动冒烟  启动主程序、观察存活与日志生成、优雅结束（不留僵尸进程）

    判定语义：
      PASS 该验收项通过
      FAIL 该验收项不通过（脚本退出码 1）
      WARN 需要人工确认，但不足以判 FAIL（脚本退出码仍为 0）
      SKIP 当前主机/当前参数下无法判定（例如非 Win7 主机上的 Win7 专属项）

    非 Windows 7 主机上，Win7 专属项一律降级为 SKIP 或 WARN，绝不因此报 FAIL。

.PARAMETER InstallDir
    安装目录或未打包产物目录（dist\win-unpacked）。
    缺省时按以下顺序自动探测：
      1) <脚本所在包>\dist\win-unpacked
      2) %LOCALAPPDATA%\Programs\*dsh* 与 %LOCALAPPDATA%\*dsh*
      3) %ProgramFiles%\*dsh* 与 %ProgramFiles(x86)%\*dsh*
    命中条件是该目录下存在 resources\ 子目录。
    该参数不含变体名，Stable 与 Beta 变体共用同一份脚本。

.PARAMETER Json
    可选，把同样的结果结构写成机器可读的 JSON（UTF-8 无 BOM）。

.PARAMETER SkipLaunch
    跳过 GUI 启动冒烟（在无桌面会话或远程会话中很有用）。

.PARAMETER Verbose
    打印每一步实际执行的命令与中间细节。

.PARAMETER LaunchHoldSeconds
    GUI 冒烟的存活门槛 N（秒，默认 60，允许 5..120）。进程存活 >= N 秒判 PASS，否则 WARN。
    无论 N 取值如何，观察窗口上限为 120 秒。

.PARAMETER ExpectedNodeSizeBytes
    打包 node.exe 的期望字节数（默认 85545984）。偏差超过 SizeToleranceBytes 只给 WARN。

.PARAMETER SizeToleranceBytes
    node.exe 大小容差（默认 1048576 = 1 MiB）。

.PARAMETER RepoRoot
    可选，显式指定仓库根（用于寻找 scripts\scan-win7-imports.mjs）。
    缺省时由脚本自身路径向上推导。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\verify-windows7-acceptance.ps1
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\verify-windows7-acceptance.ps1 -InstallDir 'D:\DSH' -Json .\acceptance.json
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\verify-windows7-acceptance.ps1 -SkipLaunch -Verbose

.NOTES
    必须在 Windows PowerShell 5.1 下可解析可运行（不使用 ??、三目运算符、-Parallel 等 PS7 语法）。
    本文件必须以 UTF-8 with BOM 保存，否则 PS 5.1 会按 ANSI 解码而破坏中文注释。
    读改本文件时必须显式带 -Encoding UTF8，否则 PS 5.1 的默认编码会把 UTF-8 当成 ANSI 读坏。
    仓库硬规则：本文件在 dsh-plugin-desktop\scripts\ 与 dsh-plugin-desktop-beta\scripts\ 下必须字节级一致。

    代码约定：数组字面量里拼接出来的元素必须自带括号，例如
        -Evidence @(('前缀: ' + $value), '另一条')
    因为 PowerShell 的逗号运算符优先级高于 +，漏括号会把一条证据拆成两条甚至拼成一整行。
#>

param(
    [string]$InstallDir,
    [string]$Json,
    [switch]$SkipLaunch,
    [switch]$Verbose,
    [int]$LaunchHoldSeconds = 60,
    [long]$ExpectedNodeSizeBytes = 85545984,
    [int]$SizeToleranceBytes = 1048576,
    [string]$RepoRoot,
    [switch]$Help
)

$ErrorActionPreference = 'Continue'

# region ---------------------------------------------------------------- 基础环境

$script:ScriptDir = $PSScriptRoot
if (-not $script:ScriptDir) {
    try { $script:ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path } catch { $script:ScriptDir = (Get-Location).Path }
}

$script:Items = New-Object System.Collections.ArrayList
$script:VerboseEnabled = [bool]$Verbose
$script:HostFacts = $null
$script:NodeProbe = $null
$script:ProbeRaw = $null
$script:ProbeEvidence = @()
$script:InstallPath = $null
$script:InstallSource = ''
$script:PackageDir = ''
$script:MainExecutable = $null
$script:NativeProbeReady = $false
# 系统自带命令行工具（taskkill 等）按 ANSI/OEM 代码页输出，用 UTF-8 解码会变乱码，单独留一份编码。
$script:AnsiEncoding = $null
try { $script:AnsiEncoding = [System.Text.Encoding]::Default } catch { $script:AnsiEncoding = $null }

$script:StatusPass = 'PASS'
$script:StatusFail = 'FAIL'
$script:StatusWarn = 'WARN'
$script:StatusSkip = 'SKIP'

if ($LaunchHoldSeconds -lt 5) { $LaunchHoldSeconds = 5 }
if ($LaunchHoldSeconds -gt 120) { $LaunchHoldSeconds = 120 }
if ($SizeToleranceBytes -lt 0) { $SizeToleranceBytes = 0 }

function Write-VerboseLine {
    param([string]$Message)
    if ($script:VerboseEnabled) { Write-Host ('      [verbose] ' + $Message) -ForegroundColor DarkGray }
}

function Write-Section {
    param([string]$Title)
    Write-Host ''
    Write-Host ('=' * 96) -ForegroundColor Cyan
    Write-Host ('  ' + $Title) -ForegroundColor Cyan
    Write-Host ('=' * 96) -ForegroundColor Cyan
}

function Get-StatusColor {
    param([string]$Status)
    if ($Status -eq 'PASS') { return 'Green' }
    if ($Status -eq 'FAIL') { return 'Red' }
    if ($Status -eq 'WARN') { return 'Yellow' }
    return 'DarkGray'
}

# 控制台里中文按两列宽排版，截断与对齐都按显示宽度计算。
function Get-DisplayWidth {
    param([string]$Text)
    $width = 0
    if ($null -eq $Text) { return 0 }
    foreach ($character in $Text.ToCharArray()) {
        $code = [int][char]$character
        if (($code -ge 0x1100 -and $code -le 0x115F) -or
            ($code -ge 0x2E80 -and $code -le 0x303E) -or
            ($code -ge 0x3041 -and $code -le 0x33FF) -or
            ($code -ge 0x3400 -and $code -le 0x4DBF) -or
            ($code -ge 0x4E00 -and $code -le 0x9FFF) -or
            ($code -ge 0xA000 -and $code -le 0xA4CF) -or
            ($code -ge 0xAC00 -and $code -le 0xD7A3) -or
            ($code -ge 0xF900 -and $code -le 0xFAFF) -or
            ($code -ge 0xFE30 -and $code -le 0xFE6F) -or
            ($code -ge 0xFF00 -and $code -le 0xFF60) -or
            ($code -ge 0xFFE0 -and $code -le 0xFFE6)) {
            $width += 2
        } else {
            $width += 1
        }
    }
    return $width
}

function Format-Cell {
    param([string]$Text, [int]$Width)
    if ($null -eq $Text) { $Text = '' }
    $padding = $Width - (Get-DisplayWidth $Text)
    if ($padding -lt 0) { $padding = 0 }
    return $Text + (' ' * $padding)
}

function Add-Item {
    param(
        [string]$Section,
        [string]$Id,
        [string]$Title,
        [string]$Status,
        [string]$Conclusion,
        [string[]]$Evidence
    )
    if ($null -eq $Evidence) { $Evidence = @() }
    $item = [pscustomobject][ordered]@{
        section    = $Section
        id         = $Id
        title      = $Title
        status     = $Status
        conclusion = $Conclusion
        evidence   = $Evidence
    }
    [void]$script:Items.Add($item)

    Write-Host ('  [' + $Status + '] ' + $Id + '  ' + $Title) -ForegroundColor (Get-StatusColor $Status)
    Write-Host ('         结论: ' + $Conclusion)
    foreach ($line in $Evidence) {
        Write-Host ('         证据: ' + $line) -ForegroundColor DarkGray
    }
    return
}

function Get-TextTail {
    param([string]$Text, [int]$MaxLength = 320, [int]$MaxLines = 4)
    if ($null -eq $Text) { return '' }
    $trimmed = $Text.Trim()
    if ($trimmed.Length -eq 0) { return '' }
    $lines = @($trimmed -split "`r?`n" | Where-Object { $_.Trim().Length -gt 0 })
    if ($lines.Count -gt $MaxLines) {
        $lines = $lines[($lines.Count - $MaxLines)..($lines.Count - 1)]
    }
    $joined = ($lines -join ' | ')
    $joined = $joined.Replace([char]0xFFFD, '?')
    if ($joined.Length -gt $MaxLength) { $joined = $joined.Substring(0, $MaxLength) + '...' }
    return $joined
}

function Get-FileSha256 {
    param([string]$Path)
    try {
        $hash = Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop
        return $hash.Hash.ToLowerInvariant()
    } catch {
        Write-VerboseLine ('Get-FileHash 不可用，回退到 .NET：' + $_.Exception.Message)
    }
    try {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $stream = [System.IO.File]::OpenRead($Path)
        try {
            $bytes = $sha.ComputeHash($stream)
        } finally {
            $stream.Dispose()
            $sha.Dispose()
        }
        $builder = New-Object System.Text.StringBuilder
        foreach ($byte in $bytes) { [void]$builder.Append($byte.ToString('x2')) }
        return $builder.ToString()
    } catch {
        return $null
    }
}

# 惰性枚举，命中第一个就返回；大目录树上比 Get-ChildItem -Recurse 快一个数量级。
function Find-FirstFileInTree {
    param([string]$Root, [string]$Name, [int]$MaxSeconds = 45)
    if (-not $Root) { return '' }
    try {
        if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return '' }
    } catch {
        return ''
    }
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $enumerator = [System.IO.Directory]::EnumerateFiles($Root, $Name, [System.IO.SearchOption]::AllDirectories)
        foreach ($file in $enumerator) {
            if ($stopwatch.Elapsed.TotalSeconds -gt $MaxSeconds) { return '' }
            return $file
        }
    } catch {
        Write-VerboseLine ('目录树搜索 ' + $Name + ' 中断: ' + $_.Exception.Message)
    }
    return ''
}

# 统一的原生进程调用：分开捕获 stdout/stderr，自带超时与强杀，避免 PS 5.1 的 2>&1 ErrorRecord 怪癖。
function Invoke-CapturedProcess {
    param(
        [string]$FilePath,
        [string]$Arguments,
        [int]$TimeoutSeconds = 120,
        [string]$WorkingDirectory,
        [System.Text.Encoding]$OutputEncoding
    )
    $result = [pscustomobject][ordered]@{
        ok         = $false
        exitCode   = $null
        stdout     = ''
        stderr     = ''
        timedOut   = $false
        durationMs = 0
        error      = $null
    }
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $startInfo = New-Object System.Diagnostics.ProcessStartInfo
        $startInfo.FileName = $FilePath
        if ($null -ne $Arguments) { $startInfo.Arguments = $Arguments }
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        if ($null -eq $OutputEncoding) { $OutputEncoding = New-Object System.Text.UTF8Encoding($false) }
        try { $startInfo.StandardOutputEncoding = $OutputEncoding } catch { }
        try { $startInfo.StandardErrorEncoding = $OutputEncoding } catch { }
        if ($WorkingDirectory) { $startInfo.WorkingDirectory = $WorkingDirectory }

        $process = New-Object System.Diagnostics.Process
        $process.StartInfo = $startInfo
        if (-not $process.Start()) {
            $result.error = 'Process.Start 返回 false'
            return $result
        }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $exited = $process.WaitForExit($TimeoutSeconds * 1000)
        if (-not $exited) {
            $result.timedOut = $true
            try { $process.Kill() } catch { }
            try { [void]$process.WaitForExit(5000) } catch { }
        }
        try { $result.stdout = $stdoutTask.Result } catch { $result.stdout = '' }
        try { $result.stderr = $stderrTask.Result } catch { $result.stderr = '' }
        try { $result.exitCode = $process.ExitCode } catch { $result.exitCode = $null }
        $result.ok = $true
        try { $process.Dispose() } catch { }
    } catch {
        $result.error = $_.Exception.Message
    }
    $stopwatch.Stop()
    $result.durationMs = [int]$stopwatch.ElapsedMilliseconds
    return $result
}

# endregion ------------------------------------------------------------- 基础环境

function Show-Usage {
    param([string]$Reason)
    if ($Reason) {
        Write-Host ('参数错误: ' + $Reason) -ForegroundColor Red
        Write-Host ''
    }
    Write-Host 'DSH Desktop — Windows 7 SP1 x64 目标机验收脚本'
    Write-Host ''
    Write-Host '用法:'
    Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File verify-windows7-acceptance.ps1 \'
    Write-Host '      [-InstallDir <path>] [-Json <outPath>] [-SkipLaunch] [-Verbose] \'
    Write-Host '      [-LaunchHoldSeconds <5..120>] [-ExpectedNodeSizeBytes <bytes>] \'
    Write-Host '      [-SizeToleranceBytes <bytes>] [-RepoRoot <path>]'
    Write-Host ''
    Write-Host '参数:'
    Write-Host '  -InstallDir <path>          安装目录或 dist\win-unpacked。缺省时自动探测：'
    Write-Host '                              <脚本所在包>\dist\win-unpacked、'
    Write-Host '                              %LOCALAPPDATA%\Programs\*dsh*、%ProgramFiles%\*dsh*'
    Write-Host '  -Json <outPath>             额外写出机器可读 JSON 结果（UTF-8 无 BOM）'
    Write-Host '  -SkipLaunch                 跳过 GUI 启动冒烟（无桌面会话时使用）'
    Write-Host '  -Verbose                    打印每步实际命令与中间细节'
    Write-Host '  -LaunchHoldSeconds <n>      GUI 冒烟存活门槛 N 秒，默认 60（观察上限 120 秒）'
    Write-Host '  -ExpectedNodeSizeBytes <n>  打包 node.exe 期望字节数，默认 85545984（只影响 WARN）'
    Write-Host '  -SizeToleranceBytes <n>     node.exe 大小容差，默认 1048576'
    Write-Host '  -RepoRoot <path>            仓库根（用于 scripts\scan-win7-imports.mjs），缺省自动推导'
    Write-Host '  -Help                       显示本用法'
    Write-Host ''
    Write-Host '退出码: 0 = 无 FAIL（可能含 WARN/SKIP）；1 = 存在 FAIL；2 = 参数/用法错误'
    Write-Host ''
    Write-Host '示例:'
    Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File .\verify-windows7-acceptance.ps1 -SkipLaunch -Verbose'
    Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File .\verify-windows7-acceptance.ps1 -InstallDir "D:\DSH" -Json .\acceptance.json'
}

if ($Help) {
    Show-Usage
    exit 0
}

# 脚本没有 CmdletBinding，未识别的命名参数会落到 $args 里，这里显式报用法而不是静默忽略。
if ($args.Count -gt 0) {
    Show-Usage -Reason ('无法识别的参数: ' + ($args -join ' '))
    exit 2
}

# region ---------------------------------------------------------------- 目标目录探测

function Test-InstallRoot {
    param([string]$Path)
    if (-not $Path) { return $false }
    try {
        if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $false }
        return (Test-Path -LiteralPath (Join-Path $Path 'resources'))
    } catch {
        return $false
    }
}

function Find-MainExecutable {
    param([string]$Root)
    if (-not $Root) { return $null }
    try {
        if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return $null }
    } catch {
        return $null
    }
    $excluded = @('elevate.exe', 'uninstall.exe', 'updater.exe', 'squirrel.exe', 'crashpad_handler.exe', 'maintenance.exe', 'unins000.exe')
    $candidates = @()
    try {
        $candidates = @(Get-ChildItem -LiteralPath $Root -Filter '*.exe' -File -ErrorAction SilentlyContinue)
    } catch {
        $candidates = @()
    }
    $filtered = @()
    foreach ($candidate in $candidates) {
        $lower = $candidate.Name.ToLowerInvariant()
        if ($excluded -contains $lower) { continue }
        if ($lower -match '^(unins|setup|installer)') { continue }
        $filtered += $candidate
    }
    if ($filtered.Count -eq 0) {
        foreach ($candidate in $candidates) {
            if ($candidate.Name.ToLowerInvariant() -eq 'elevate.exe') { continue }
            $filtered += $candidate
        }
    }
    if ($filtered.Count -eq 0) { return $null }
    $main = $filtered | Sort-Object -Property Length -Descending | Select-Object -First 1
    return $main.FullName
}

function Resolve-InstallTarget {
    param([string]$Explicit, [string]$ScriptDirectory)

    $candidates = New-Object System.Collections.ArrayList
    if ($Explicit) {
        [void]$candidates.Add([pscustomobject]@{ path = $Explicit; source = '-InstallDir 参数' })
    } else {
        if ($ScriptDirectory) {
            $packageDirectory = Split-Path -Parent $ScriptDirectory
            if ($packageDirectory) {
                [void]$candidates.Add([pscustomobject]@{
                    path   = (Join-Path $packageDirectory 'dist\win-unpacked')
                    source = '脚本所在包的 dist\win-unpacked'
                })
            }
        }
        $searchRoots = New-Object System.Collections.ArrayList
        if ($env:LOCALAPPDATA) {
            [void]$searchRoots.Add((Join-Path $env:LOCALAPPDATA 'Programs'))
            [void]$searchRoots.Add($env:LOCALAPPDATA)
        }
        if ($env:ProgramFiles) { [void]$searchRoots.Add($env:ProgramFiles) }
        if (${env:ProgramFiles(x86)}) { [void]$searchRoots.Add(${env:ProgramFiles(x86)}) }
        foreach ($searchRoot in $searchRoots) {
            try {
                if (-not (Test-Path -LiteralPath $searchRoot -PathType Container)) { continue }
                $directories = @(Get-ChildItem -LiteralPath $searchRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '(?i)dsh' })
                foreach ($directory in $directories) {
                    [void]$candidates.Add([pscustomobject]@{ path = $directory.FullName; source = ('自动探测 ' + $searchRoot) })
                }
            } catch {
                Write-VerboseLine ('探测 ' + $searchRoot + ' 失败: ' + $_.Exception.Message)
            }
        }
    }

    foreach ($candidate in $candidates) {
        if (Test-InstallRoot $candidate.path) {
            return [pscustomobject]@{
                path   = [System.IO.Path]::GetFullPath($candidate.path)
                source = $candidate.source
                found  = $true
                probed = @($candidates | ForEach-Object { $_.path })
            }
        }
        Write-VerboseLine ('候选目录不可用: ' + $candidate.path)
    }

    if ($Explicit) {
        return [pscustomobject]@{
            path   = $Explicit
            source = '-InstallDir 参数（目录不可用）'
            found  = $false
            probed = @($candidates | ForEach-Object { $_.path })
        }
    }
    return $null
}

$installTarget = Resolve-InstallTarget -Explicit $InstallDir -ScriptDirectory $script:ScriptDir
if ($null -ne $installTarget) {
    $script:InstallPath = $installTarget.path
    $script:InstallSource = $installTarget.source
}
if ($script:ScriptDir) { $script:PackageDir = Split-Path -Parent $script:ScriptDir }
$script:MainExecutable = Find-MainExecutable -Root $script:InstallPath

Write-Host ''
Write-Host 'DSH Desktop Windows 7 SP1 x64 目标机验收' -ForegroundColor White
Write-Host ('  脚本      : ' + $MyInvocation.MyCommand.Path)
Write-Host ('  时间      : ' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))
if ($script:InstallPath) {
    Write-Host ('  目标目录  : ' + $script:InstallPath + '  (' + $script:InstallSource + ')')
} else {
    Write-Host '  目标目录  : 未找到（将按缺失产物报告 FAIL）' -ForegroundColor Red
    Write-Host ('  已探测    : ' + (@($installTarget.probed) -join '; '))
}
Write-Host ('  主程序    : ' + [string]$script:MainExecutable)
if ($SkipLaunch) {
    Write-Host '  GUI 冒烟  : 跳过 (-SkipLaunch)'
} else {
    Write-Host ('  GUI 冒烟  : 启用（存活门槛 ' + $LaunchHoldSeconds + ' 秒，观察上限 120 秒）')
}

# endregion ------------------------------------------------------------- 目标目录探测

# region ---------------------------------------------------------------- 1. 主机前置

function Get-HostFacts {
    $facts = [pscustomobject][ordered]@{
        osVersion             = ''
        osBuild               = 0
        isWindows7            = $false
        isWindows7Sp1         = $false
        is64BitOs             = $false
        is64BitProcess        = $false
        processArchitecture   = ''
        nativeArchitecture    = ''
        osArchitectureFromCim = ''
        powerShellVersion     = ''
        powerShellEdition     = ''
        computerName          = ''
        userName              = ''
        registryProductName   = ''
        registryServicePack   = ''
    }
    try {
        $version = [System.Environment]::OSVersion.Version
        $facts.osVersion = $version.ToString()
        $facts.osBuild = $version.Build
        if ($version.Major -eq 6 -and $version.Minor -eq 1) {
            $facts.isWindows7 = $true
            if ($version.Build -ge 7601) { $facts.isWindows7Sp1 = $true }
        }
    } catch { }
    try { $facts.is64BitOs = [System.Environment]::Is64BitOperatingSystem } catch { }
    try { $facts.is64BitProcess = [System.Environment]::Is64BitProcess } catch { }
    $facts.processArchitecture = [string]$env:PROCESSOR_ARCHITECTURE
    $facts.nativeArchitecture = [string]$env:PROCESSOR_ARCHITEW6432
    try {
        $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
        $facts.osArchitectureFromCim = [string]$os.OSArchitecture
    } catch {
        $facts.osArchitectureFromCim = '查询失败: ' + $_.Exception.Message
    }
    try { $facts.powerShellVersion = $PSVersionTable.PSVersion.ToString() } catch { }
    try { $facts.powerShellEdition = [string]$PSVersionTable.PSEdition } catch { }
    $facts.computerName = [string]$env:COMPUTERNAME
    $facts.userName = [string]$env:USERNAME
    try {
        $currentVersion = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction Stop
        $facts.registryProductName = [string]$currentVersion.ProductName
        $facts.registryServicePack = [string]$currentVersion.CSDVersion
    } catch { }
    return $facts
}

function Get-HotfixEvidence {
    param([string]$KbId)
    $evidence = New-Object System.Collections.ArrayList
    $found = $false
    try {
        $fix = Get-HotFix -Id $KbId -ErrorAction SilentlyContinue
        if ($fix) {
            $found = $true
            [void]$evidence.Add('Get-HotFix: ' + [string]$fix.HotFixID + ' ' + [string]$fix.Description + ' InstalledOn=' + [string]$fix.InstalledOn)
        } else {
            [void]$evidence.Add('Get-HotFix: 未列出 ' + $KbId)
        }
    } catch {
        [void]$evidence.Add('Get-HotFix 不可用: ' + $_.Exception.Message)
    }
    if (-not $found) {
        try {
            $packagesKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\Packages'
            $digits = $KbId.Substring(2)
            $packages = @(Get-ChildItem -LiteralPath $packagesKey -ErrorAction Stop)
            $hit = $packages | Where-Object { $_.PSChildName -like ('*' + $digits + '*') } | Select-Object -First 1
            if ($hit) {
                $found = $true
                [void]$evidence.Add('CBS Packages: ' + [string]$hit.PSChildName)
            } else {
                [void]$evidence.Add('CBS Packages: ' + $packages.Count + ' 个包中无含 ' + $digits + ' 的条目')
            }
        } catch {
            [void]$evidence.Add('CBS Packages 读取失败（非管理员或精简系统上常见）: ' + $_.Exception.Message)
        }
    }
    return [pscustomobject]@{ found = $found; evidence = $evidence }
}

function Test-NativeLibraryLoad {
    param([string]$Path)
    try {
        if (-not $script:NativeProbeReady) {
            Add-Type -Namespace DshWin7Acceptance -Name NativeProbe -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern IntPtr LoadLibraryW(string lpFileName);
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool FreeLibrary(IntPtr hModule);
'@ -ErrorAction Stop
            $script:NativeProbeReady = $true
        }
        $handle = [DshWin7Acceptance.NativeProbe]::LoadLibraryW($Path)
        if ($handle -eq [IntPtr]::Zero) {
            return [pscustomobject]@{ loaded = $false; detail = 'LoadLibraryW 返回 NULL，Win32 错误码 ' + ([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
        }
        [void][DshWin7Acceptance.NativeProbe]::FreeLibrary($handle)
        return [pscustomobject]@{ loaded = $true; detail = 'LoadLibraryW 成功' }
    } catch {
        return [pscustomobject]@{ loaded = $false; detail = '加载探针不可用（不判 FAIL）: ' + $_.Exception.Message }
    }
}

function Find-VcRuntimeLibrary {
    param([string]$DllName)
    $system32 = ''
    try { $system32 = Join-Path $env:SystemRoot ('System32\' + $DllName) } catch { $system32 = '' }
    if ($system32 -and (Test-Path -LiteralPath $system32)) { return $system32 }
    if (-not $script:InstallPath) { return '' }
    foreach ($directory in @($script:InstallPath, (Join-Path $script:InstallPath 'resources'), (Join-Path $script:InstallPath 'resources\runtime'))) {
        $candidate = Join-Path $directory $DllName
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    foreach ($tree in @((Join-Path $script:InstallPath 'resources\app\node_modules'), $script:InstallPath)) {
        $hit = Find-FirstFileInTree -Root $tree -Name $DllName -MaxSeconds 45
        if ($hit) { return $hit }
    }
    return ''
}

Write-Section '[1/5] 主机前置检查'

$hostFacts = Get-HostFacts
$script:HostFacts = $hostFacts

# HOST-01 操作系统
if ($hostFacts.isWindows7Sp1) {
    Add-Item -Section '主机前置' -Id 'HOST-01' -Title '操作系统为 Windows 7 SP1 (6.1.7601+)' -Status $script:StatusPass `
        -Conclusion '主机是 Windows 7 SP1，可进行完整验收。' `
        -Evidence @(
            ('命令: [System.Environment]::OSVersion.Version -> ' + $hostFacts.osVersion),
            ('注册表 HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion ProductName=' + $hostFacts.registryProductName + ' CSDVersion=' + $hostFacts.registryServicePack)
        )
} elseif ($hostFacts.isWindows7) {
    Add-Item -Section '主机前置' -Id 'HOST-01' -Title '操作系统为 Windows 7 SP1 (6.1.7601+)' -Status $script:StatusFail `
        -Conclusion ('主机是 Windows 7，但 build ' + $hostFacts.osBuild + ' < 7601，缺少 SP1，不满足最低要求。') `
        -Evidence @(
            ('命令: [System.Environment]::OSVersion.Version -> ' + $hostFacts.osVersion),
            ('注册表 ProductName=' + $hostFacts.registryProductName + ' CSDVersion=' + $hostFacts.registryServicePack)
        )
} else {
    Add-Item -Section '主机前置' -Id 'HOST-01' -Title '操作系统为 Windows 7 SP1 (6.1.7601+)' -Status $script:StatusSkip `
        -Conclusion ('当前主机不是 Windows 7 SP1（' + $hostFacts.osVersion + '），该项只能在 Win7 SP1 目标机判定。') `
        -Evidence @(
            ('命令: [System.Environment]::OSVersion.Version -> ' + $hostFacts.osVersion),
            ('注册表 ProductName=' + $hostFacts.registryProductName + ' CSDVersion=' + $hostFacts.registryServicePack),
            '非 Win7 主机上 Win7 专属项一律 SKIP/WARN，绝不报 FAIL。'
        )
}

# HOST-02 位数
if (-not $hostFacts.is64BitOs) {
    Add-Item -Section '主机前置' -Id 'HOST-02' -Title 'OS 与 PowerShell 均为 x64' -Status $script:StatusFail `
        -Conclusion '操作系统不是 64 位，产品只有 x64 产物，不满足最低要求。' `
        -Evidence @(
            ('命令: [System.Environment]::Is64BitOperatingSystem -> ' + $hostFacts.is64BitOs),
            ('PROCESSOR_ARCHITECTURE=' + $hostFacts.processArchitecture + ' PROCESSOR_ARCHITEW6432=' + $hostFacts.nativeArchitecture)
        )
} elseif (-not $hostFacts.is64BitProcess) {
    Add-Item -Section '主机前置' -Id 'HOST-02' -Title 'OS 与 PowerShell 均为 x64' -Status $script:StatusWarn `
        -Conclusion 'OS 是 64 位，但当前 PowerShell 是 32 位进程，建议用 64 位 PowerShell 重跑以覆盖全部检查。' `
        -Evidence @(
            ('命令: [System.Environment]::Is64BitProcess -> ' + $hostFacts.is64BitProcess),
            ('PROCESSOR_ARCHITECTURE=' + $hostFacts.processArchitecture + ' PROCESSOR_ARCHITEW6432=' + $hostFacts.nativeArchitecture + '（后者非空即 32 位进程运行在 x64 OS 上）'),
            ('CIM Win32_OperatingSystem.OSArchitecture=' + $hostFacts.osArchitectureFromCim)
        )
} else {
    Add-Item -Section '主机前置' -Id 'HOST-02' -Title 'OS 与 PowerShell 均为 x64' -Status $script:StatusPass `
        -Conclusion 'OS 与当前进程都是 x64。' `
        -Evidence @(
            '命令: [System.Environment]::Is64BitOperatingSystem -> True / Is64BitProcess -> True',
            ('PROCESSOR_ARCHITECTURE=' + $hostFacts.processArchitecture),
            ('CIM Win32_OperatingSystem.OSArchitecture=' + $hostFacts.osArchitectureFromCim)
        )
}

# HOST-03 关键补丁
$kbList = @(
    [pscustomobject]@{ id = 'KB2533623'; why = 'SetDefaultDllDirectories 依赖，缺失会导致打包 DLL 加载失败' },
    [pscustomobject]@{ id = 'KB4474419'; why = 'SHA-2 代码签名支持' },
    [pscustomobject]@{ id = 'KB2999226'; why = 'Universal CRT (ucrtbase)' },
    [pscustomobject]@{ id = 'KB3125574'; why = 'Win7 SP1 便利汇总，补齐大量前置组件' }
)
$kbEvidence = New-Object System.Collections.ArrayList
$kbFound = 0
foreach ($kb in $kbList) {
    $kbProbe = Get-HotfixEvidence -KbId $kb.id
    if ($kbProbe.found) { $kbFound = $kbFound + 1 }
    if ($kbProbe.found) {
        [void]$kbEvidence.Add($kb.id + '（' + $kb.why + '）: 已检出')
    } else {
        [void]$kbEvidence.Add($kb.id + '（' + $kb.why + '）: 未检出')
    }
    foreach ($line in $kbProbe.evidence) { [void]$kbEvidence.Add('    ' + $kb.id + ' <- ' + $line) }
}
try {
    $ucrt = Join-Path $env:SystemRoot 'System32\ucrtbase.dll'
    if (Test-Path -LiteralPath $ucrt) { [void]$kbEvidence.Add('旁证: ' + $ucrt + ' 存在（UCRT 载荷在，KB2999226 可能已被更高版本补丁取代）') }
} catch { }
[void]$kbEvidence.Add('提示: Get-HotFix 与 CBS Packages 在部分精简系统（Ghost/精简版）上不可靠，WARN 不等于缺失。')

if ($kbFound -eq $kbList.Count) {
    Add-Item -Section '主机前置' -Id 'HOST-03' -Title '关键补丁 KB2533623 / KB4474419 / KB2999226 / KB3125574' -Status $script:StatusPass `
        -Conclusion ('四个关键补丁全部检出（' + $kbFound + '/' + $kbList.Count + '）。') -Evidence @($kbEvidence.ToArray())
} elseif ($hostFacts.isWindows7Sp1) {
    Add-Item -Section '主机前置' -Id 'HOST-03' -Title '关键补丁 KB2533623 / KB4474419 / KB2999226 / KB3125574' -Status $script:StatusWarn `
        -Conclusion ('只检出 ' + $kbFound + '/' + $kbList.Count + ' 个关键补丁，需人工确认；检测方式在精简系统上不可靠，不据此判 FAIL。') -Evidence @($kbEvidence.ToArray())
} else {
    Add-Item -Section '主机前置' -Id 'HOST-03' -Title '关键补丁 KB2533623 / KB4474419 / KB2999226 / KB3125574' -Status $script:StatusSkip `
        -Conclusion ('当前不是 Windows 7 SP1 主机，补丁清单无意义（本次检出 ' + $kbFound + '/' + $kbList.Count + '，非 Win7 主机不判 FAIL）。') -Evidence @($kbEvidence.ToArray())
}

# HOST-04 VC++ 运行库
$vcRuntimeNames = @('vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll')
$vcEvidence = New-Object System.Collections.ArrayList
$vcFoundInSystem32 = 0
$vcFoundElsewhere = 0
$vcLoadProbe = 0
foreach ($dllName in $vcRuntimeNames) {
    $system32Path = ''
    try { $system32Path = Join-Path $env:SystemRoot ('System32\' + $dllName) } catch { }
    $located = Find-VcRuntimeLibrary -DllName $dllName
    if ($located) {
        if ($system32Path -and ($located.ToLowerInvariant() -eq $system32Path.ToLowerInvariant())) {
            $vcFoundInSystem32 = $vcFoundInSystem32 + 1
        } else {
            $vcFoundElsewhere = $vcFoundElsewhere + 1
        }
        $fileVersion = ''
        try { $fileVersion = [string](Get-Item -LiteralPath $located).VersionInfo.FileVersion } catch { }
        $load = Test-NativeLibraryLoad -Path $located
        if ($load.loaded) { $vcLoadProbe = $vcLoadProbe + 1 }
        [void]$vcEvidence.Add($dllName + ' -> ' + $located + ' FileVersion=' + $fileVersion + ' 加载探针: ' + $load.detail)
    } else {
        [void]$vcEvidence.Add($dllName + ' -> 未在 System32 或安装目录树中找到')
    }
}

if ($vcFoundInSystem32 -eq $vcRuntimeNames.Count) {
    Add-Item -Section '主机前置' -Id 'HOST-04' -Title 'VC++ 2015-2022 x64 运行库可用' -Status $script:StatusPass `
        -Conclusion ('三个运行库 DLL 全部来自 System32，且 LoadLibraryW 探针成功 ' + $vcLoadProbe + '/' + $vcRuntimeNames.Count + '。') -Evidence @($vcEvidence.ToArray())
} elseif (($vcFoundInSystem32 + $vcFoundElsewhere) -eq $vcRuntimeNames.Count) {
    Add-Item -Section '主机前置' -Id 'HOST-04' -Title 'VC++ 2015-2022 x64 运行库可用' -Status $script:StatusPass `
        -Conclusion ('运行库 DLL 在安装目录内随包提供（System32 ' + $vcFoundInSystem32 + ' 个，安装目录 ' + $vcFoundElsewhere + ' 个）。') -Evidence @($vcEvidence.ToArray())
} else {
    Add-Item -Section '主机前置' -Id 'HOST-04' -Title 'VC++ 2015-2022 x64 运行库可用' -Status $script:StatusWarn `
        -Conclusion '未能定位全部运行库 DLL，需人工确认；真正的判据是第 2 分区里 node.exe 能否跑起来。' -Evidence @($vcEvidence.ToArray())
}

# endregion ------------------------------------------------------------- 主机前置

# region ---------------------------------------------------------------- 2. 运行时自证

Write-Section '[2/5] 运行时自证（直接调用打包的 node.exe）'

$nodeRelative = 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
$nodeExe = ''
if ($script:InstallPath) { $nodeExe = Join-Path $script:InstallPath $nodeRelative }

# 双重存在性判定：Test-Path 走 PS 提供程序，[System.IO.File]::Exists 走 .NET 直接探测。
# 两者都失败时把中间状态写进证据，避免"文件明明在却报不存在"这种无法自证的结果。
function Test-FilePresent {
    param([string]$Path)
    $present = $false
    $note = ''
    if (-not $Path) { return [pscustomobject]@{ present = $false; note = '路径为空' } }
    try { $present = Test-Path -LiteralPath $Path -PathType Leaf } catch { $present = $false }
    if (-not $present) {
        try { $present = [System.IO.File]::Exists([string]$Path) } catch { }
    }
    $parentExists = $false
    try {
        $parent = Split-Path -Parent $Path
        if ($parent) { $parentExists = Test-Path -LiteralPath $parent -PathType Container }
    } catch { }
    $note = 'Test-Path/[System.IO.File]::Exists("' + [string]$Path + '") -> ' + [string]$present + '，父目录存在=' + [string]$parentExists
    if (-not $present) { $note = $note + '（刚构建/刚复制时目录可能正被改写，可重跑一次确认）' }
    return [pscustomobject]@{ present = $present; note = $note }
}

$nodeExistence = Test-FilePresent -Path $nodeExe
$nodeExeExists = $nodeExistence.present

$probeScript = "var r={};r.execPath=process.execPath;r.nodeVersion=process.version;r.nodeSemver=process.versions.node;r.arch=process.arch;r.platform=process.platform;r.electron=process.versions.electron?process.versions.electron:null;r.icu=process.versions.icu?process.versions.icu:null;r.icuSmall=process.config.variables.icu_small===true;r.promiseWithResolvers=typeof Promise.withResolvers;r.arrayToSorted=typeof [].toSorted;try{r.sqliteDatabaseSync=typeof require('node:sqlite').DatabaseSync}catch(e){r.sqliteDatabaseSync='error:'+e.message}r.zhCN=new Intl.DateTimeFormat('zh-CN',{timeZone:'UTC'}).format(new Date(0));r.enUS=new Intl.DateTimeFormat('en-US',{timeZone:'UTC'}).format(new Date(0));r.zhCNHasReplacement=r.zhCN.indexOf(String.fromCharCode(65533))>=0;r.epochMillis=Date.now();r.hrtimeBigint=process.hrtime.bigint().toString();console.log('DSH_PROBE '+JSON.stringify(r));"

if ($nodeExeExists) {
    $probeCommand = '"' + $nodeExe + '" -e "<probe js, ' + $probeScript.Length + ' 字符>"'
    Write-VerboseLine ('执行: ' + $probeCommand)
    $probeRun = Invoke-CapturedProcess -FilePath $nodeExe -Arguments ('-e "' + $probeScript + '"') -TimeoutSeconds 90
    $script:ProbeRaw = $probeRun
    $probeJson = $null
    if ($probeRun.ok -and ($probeRun.stdout -match 'DSH_PROBE (\{.*\})')) {
        try { $probeJson = $Matches[1] | ConvertFrom-Json } catch { $probeJson = $null }
    }
    $script:NodeProbe = $probeJson
    $script:ProbeEvidence = @(
        ('命令: ' + $probeCommand),
        ('退出码: ' + [string]$probeRun.exitCode + '，耗时 ' + [string]$probeRun.durationMs + 'ms，超时=' + [string]$probeRun.timedOut),
        ('stdout: ' + (Get-TextTail -Text $probeRun.stdout)),
        ('stderr: ' + (Get-TextTail -Text $probeRun.stderr))
    )
    Write-VerboseLine ('node 探针 stdout 尾部: ' + (Get-TextTail -Text $probeRun.stdout -MaxLines 2))
} else {
    $script:ProbeEvidence = @(
        ('命令: "' + [string]$nodeExe + '" -e "<probe js>"'),
        'node.exe 不存在，未执行运行时探针。',
        $nodeExistence.note
    )
}

$probe = $script:NodeProbe
$probeOk = ($null -ne $probe)

# RUNTIME-01 版本 / 架构 / 平台
if (-not $probeOk) {
    Add-Item -Section '运行时自证' -Id 'RUNTIME-01' -Title 'node.exe 自报 v22.20.0 / x64 / win32' -Status $script:StatusFail `
        -Conclusion '打包的 node.exe 缺失或没有产出可解析的探针结果，运行时无法自证。' -Evidence $script:ProbeEvidence
} elseif (($probe.nodeVersion -eq 'v22.20.0') -and ($probe.nodeSemver -eq '22.20.0') -and ($probe.arch -eq 'x64') -and ($probe.platform -eq 'win32')) {
    Add-Item -Section '运行时自证' -Id 'RUNTIME-01' -Title 'node.exe 自报 v22.20.0 / x64 / win32' -Status $script:StatusPass `
        -Conclusion ('process.version=' + $probe.nodeVersion + '，arch=' + $probe.arch + '，platform=' + $probe.platform + '，符合自编译运行时。') `
        -Evidence ($script:ProbeEvidence + @(('探针: execPath=' + $probe.execPath + ' icu=' + $probe.icu + ' icuSmall=' + $probe.icuSmall)))
} else {
    Add-Item -Section '运行时自证' -Id 'RUNTIME-01' -Title 'node.exe 自报 v22.20.0 / x64 / win32' -Status $script:StatusFail `
        -Conclusion ('运行时身份不符: version=' + [string]$probe.nodeVersion + ' arch=' + [string]$probe.arch + ' platform=' + [string]$probe.platform + '（期望 v22.20.0/x64/win32）。') `
        -Evidence $script:ProbeEvidence
}

# RUNTIME-02 现代 JS 与 sqlite
if (-not $probeOk) {
    Add-Item -Section '运行时自证' -Id 'RUNTIME-02' -Title 'Promise.withResolvers / Array.toSorted / node:sqlite.DatabaseSync' -Status $script:StatusSkip `
        -Conclusion 'node 探针未产出结果，能力断言无法执行。' -Evidence $script:ProbeEvidence
} else {
    $capabilityFailures = New-Object System.Collections.ArrayList
    if ($probe.promiseWithResolvers -ne 'function') { [void]$capabilityFailures.Add('Promise.withResolvers=' + [string]$probe.promiseWithResolvers) }
    if ($probe.arrayToSorted -ne 'function') { [void]$capabilityFailures.Add('Array.prototype.toSorted=' + [string]$probe.arrayToSorted) }
    if ($probe.sqliteDatabaseSync -ne 'function') { [void]$capabilityFailures.Add('node:sqlite.DatabaseSync=' + [string]$probe.sqliteDatabaseSync) }
    $capabilityEvidence = $script:ProbeEvidence + @(
        ('typeof Promise.withResolvers = ' + [string]$probe.promiseWithResolvers),
        ('typeof [].toSorted = ' + [string]$probe.arrayToSorted),
        ('typeof require("node:sqlite").DatabaseSync = ' + [string]$probe.sqliteDatabaseSync)
    )
    if ($capabilityFailures.Count -eq 0) {
        Add-Item -Section '运行时自证' -Id 'RUNTIME-02' -Title 'Promise.withResolvers / Array.toSorted / node:sqlite.DatabaseSync' -Status $script:StatusPass `
            -Conclusion '三项现代能力全部可用，DSH 依赖的运行时特性齐全。' -Evidence $capabilityEvidence
    } else {
        Add-Item -Section '运行时自证' -Id 'RUNTIME-02' -Title 'Promise.withResolvers / Array.toSorted / node:sqlite.DatabaseSync' -Status $script:StatusFail `
            -Conclusion ('能力缺失: ' + ($capabilityFailures -join '; ')) -Evidence $capabilityEvidence
    }
}

# RUNTIME-03 full-icu 中文格式
if (-not $probeOk) {
    Add-Item -Section '运行时自证' -Id 'RUNTIME-03' -Title 'Intl zh-CN 输出非空且为 full-icu 格式' -Status $script:StatusSkip `
        -Conclusion 'node 探针未产出结果，Intl 断言无法执行。' -Evidence $script:ProbeEvidence
} else {
    $zhOk = $false
    if ($probe.zhCN -and ($probe.zhCN.Length -gt 0) -and (-not $probe.zhCNHasReplacement) -and ($probe.zhCN -ne $probe.enUS)) { $zhOk = $true }
    $zhEvidence = $script:ProbeEvidence + @(
        ('new Intl.DateTimeFormat("zh-CN",{timeZone:"UTC"}).format(new Date(0)) = ' + [string]$probe.zhCN),
        ('new Intl.DateTimeFormat("en-US",{timeZone:"UTC"}).format(new Date(0)) = ' + [string]$probe.enUS),
        ('输出含 U+FFFD 替换字符 = ' + [string]$probe.zhCNHasReplacement + '（true 说明编码/ICU 数据有问题）'),
        ('process.versions.icu = ' + [string]$probe.icu + '，config.variables.icu_small = ' + [string]$probe.icuSmall)
    )
    if ($zhOk) {
        Add-Item -Section '运行时自证' -Id 'RUNTIME-03' -Title 'Intl zh-CN 输出非空且为 full-icu 格式' -Status $script:StatusPass `
            -Conclusion ('中文格式化输出为 "' + $probe.zhCN + '"，与 en-US 的 "' + $probe.enUS + '" 不同，证明装载的是 full-icu 数据。') -Evidence $zhEvidence
    } else {
        Add-Item -Section '运行时自证' -Id 'RUNTIME-03' -Title 'Intl zh-CN 输出非空且为 full-icu 格式' -Status $script:StatusFail `
            -Conclusion ('中文格式化不满足 full-icu 判据: zh-CN="' + [string]$probe.zhCN + '" en-US="' + [string]$probe.enUS + '" 含替换字符=' + [string]$probe.zhCNHasReplacement + '。') -Evidence $zhEvidence
    }
}

# RUNTIME-04 非 Electron 兼任 Node（致命项）
$electronAsNode = $false
if ($probeOk) {
    if ($probe.electron) { $electronAsNode = $true }
    if ($probe.nodeSemver -eq '16.17.1') { $electronAsNode = $true }
}
if (-not $probeOk) {
    Add-Item -Section '运行时自证' -Id 'RUNTIME-04' -Title '运行的不是 Electron 兼任的 Node（致命项）' -Status $script:StatusSkip `
        -Conclusion 'node 探针未产出结果，无法判定是否 Electron 兼任。' -Evidence $script:ProbeEvidence
} elseif ($electronAsNode) {
    Add-Item -Section '运行时自证' -Id 'RUNTIME-04' -Title '运行的不是 Electron 兼任的 Node（致命项）' -Status $script:StatusFail `
        -Conclusion ('致命：当前可执行文件是 Electron 兼任 Node（process.versions.node=' + [string]$probe.nodeSemver + '，process.versions.electron=' + [string]$probe.electron + '），DSH 无法在其上运行。') `
        -Evidence ($script:ProbeEvidence + @(
            ('process.versions.node = ' + [string]$probe.nodeSemver + '（16.17.1 即 Electron 22.3.27 内置 Node）'),
            ('process.versions.electron = ' + [string]$probe.electron)
        ))
} else {
    Add-Item -Section '运行时自证' -Id 'RUNTIME-04' -Title '运行的不是 Electron 兼任的 Node（致命项）' -Status $script:StatusPass `
        -Conclusion ('process.versions.electron 为空且 process.versions.node=' + [string]$probe.nodeSemver + '（非 16.17.1），确认是独立 node.exe。') `
        -Evidence ($script:ProbeEvidence + @(
            ('process.versions.node = ' + [string]$probe.nodeSemver),
            ('process.versions.electron = ' + [string]$probe.electron),
            ('process.execPath = ' + [string]$probe.execPath)
        ))
}

# RUNTIME-05 时钟精度（信息项）
if (-not $probeOk) {
    Add-Item -Section '运行时自证' -Id 'RUNTIME-05' -Title '高精度时钟降级提示（信息项，不判 FAIL）' -Status $script:StatusSkip `
        -Conclusion 'node 探针未产出结果，时钟信息不可得。' -Evidence $script:ProbeEvidence
} else {
    Add-Item -Section '运行时自证' -Id 'RUNTIME-05' -Title '高精度时钟降级提示（信息项，不判 FAIL）' -Status $script:StatusWarn `
        -Conclusion '信息项：Win7 补丁把 UV_CLOCK_REALTIME 精度降到约 15.6ms，仅输出实际取值供人工比对，不参与判定。' `
        -Evidence ($script:ProbeEvidence + @(
            ('Date.now() = ' + [string]$probe.epochMillis),
            ('process.hrtime.bigint() = ' + [string]$probe.hrtimeBigint),
            '说明: 该降级是预期行为，任何取值都不判 FAIL。'
        ))
}

# endregion ------------------------------------------------------------- 运行时自证

# region ---------------------------------------------------------------- 3. 产物完整性

Write-Section '[3/5] 产物完整性'

# ARTIFACT-01 node.exe 存在与大小
if ($nodeExeExists) {
    $nodeFile = Get-Item -LiteralPath $nodeExe
    $actualSize = [long]$nodeFile.Length
    $delta = $actualSize - $ExpectedNodeSizeBytes
    if ($delta -lt 0) { $absDelta = -$delta } else { $absDelta = $delta }
    $sizeEvidence = @(
        ('命令: Get-Item -LiteralPath "' + $nodeExe + '" -> Length=' + [string]$actualSize),
        ('期望字节数: ' + [string]$ExpectedNodeSizeBytes + '，容差 ±' + [string]$SizeToleranceBytes + '，实际偏差 ' + [string]$delta),
        ('FileVersion=' + [string]$nodeFile.VersionInfo.FileVersion + ' LastWriteTime=' + $nodeFile.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))
    )
    if ($absDelta -gt $SizeToleranceBytes) {
        Add-Item -Section '产物完整性' -Id 'ARTIFACT-01' -Title 'node.exe 存在且大小符合自编译产物' -Status $script:StatusWarn `
            -Conclusion ('大小 ' + [string]$actualSize + ' 字节，偏离期望值 ' + [string]$absDelta + ' 字节（>容差），需人工确认是否为同一构建。') -Evidence $sizeEvidence
    } else {
        Add-Item -Section '产物完整性' -Id 'ARTIFACT-01' -Title 'node.exe 存在且大小符合自编译产物' -Status $script:StatusPass `
            -Conclusion ('大小 ' + [string]$actualSize + ' 字节，在期望值 ±1MiB 容差内。') -Evidence $sizeEvidence
    }
} else {
    Add-Item -Section '产物完整性' -Id 'ARTIFACT-01' -Title 'node.exe 存在且大小符合自编译产物' -Status $script:StatusFail `
        -Conclusion '打包的 node.exe 不存在，运行时缺失。' `
        -Evidence @(
            ('期望路径: ' + [string]$nodeExe),
            ('目标目录: ' + [string]$script:InstallPath),
            $nodeExistence.note
        )
}

# ARTIFACT-02 SHA256
if ($nodeExeExists) {
    $nodeSha = Get-FileSha256 -Path $nodeExe
    Add-Item -Section '产物完整性' -Id 'ARTIFACT-02' -Title 'node.exe SHA256（供人工与构建记录比对）' -Status $script:StatusPass `
        -Conclusion '已计算 SHA256，请与构建机上的 node.exe 记录逐字符比对。' `
        -Evidence @(
            ('命令: Get-FileHash -Algorithm SHA256 -LiteralPath "' + $nodeExe + '"'),
            ('SHA256: ' + [string]$nodeSha)
        )
} else {
    Add-Item -Section '产物完整性' -Id 'ARTIFACT-02' -Title 'node.exe SHA256（供人工与构建记录比对）' -Status $script:StatusSkip `
        -Conclusion 'node.exe 不存在，无法计算哈希。' -Evidence @(('期望路径: ' + [string]$nodeExe))
}

# ARTIFACT-03 ripgrep
$rgExe = ''
if ($script:InstallPath) { $rgExe = Join-Path $script:InstallPath 'resources\app\node_modules\@vscode\ripgrep-win32-x64\bin\rg.exe' }
$rgExistence = Test-FilePresent -Path $rgExe
if ($rgExistence.present) {
    $rgRun = Invoke-CapturedProcess -FilePath $rgExe -Arguments '--version' -TimeoutSeconds 60
    $rgEvidence = @(
        ('命令: "' + $rgExe + '" --version'),
        ('退出码: ' + [string]$rgRun.exitCode + '，耗时 ' + [string]$rgRun.durationMs + 'ms'),
        ('stdout: ' + (Get-TextTail -Text $rgRun.stdout -MaxLines 2)),
        ('stderr: ' + (Get-TextTail -Text $rgRun.stderr))
    )
    $rgFirstLine = ''
    if ($rgRun.stdout) { $rgFirstLine = ($rgRun.stdout -split "`r?`n")[0].Trim() }
    if (($rgRun.exitCode -eq 0) -and $rgFirstLine.StartsWith('ripgrep 13.')) {
        Add-Item -Section '产物完整性' -Id 'ARTIFACT-03' -Title 'ripgrep 为 13.x（14+ 在 Win7 上无法加载）' -Status $script:StatusPass `
            -Conclusion ('版本行 "' + $rgFirstLine + '"，13.x 是 Win7 可用版本。') -Evidence $rgEvidence
    } elseif ($rgRun.exitCode -ne 0) {
        Add-Item -Section '产物完整性' -Id 'ARTIFACT-03' -Title 'ripgrep 为 13.x（14+ 在 Win7 上无法加载）' -Status $script:StatusFail `
            -Conclusion ('rg.exe 无法执行（退出码 ' + [string]$rgRun.exitCode + '），在目标机上不可用。') -Evidence $rgEvidence
    } else {
        Add-Item -Section '产物完整性' -Id 'ARTIFACT-03' -Title 'ripgrep 为 13.x（14+ 在 Win7 上无法加载）' -Status $script:StatusFail `
            -Conclusion ('版本行 "' + $rgFirstLine + '" 不以 "ripgrep 13." 开头，14+ 在 Win7 上无法加载。') -Evidence $rgEvidence
    }
} else {
    Add-Item -Section '产物完整性' -Id 'ARTIFACT-03' -Title 'ripgrep 为 13.x（14+ 在 Win7 上无法加载）' -Status $script:StatusFail `
        -Conclusion '打包的 rg.exe 不存在，文件检索能力缺失。' -Evidence @(('期望路径: ' + [string]$rgExe), $rgExistence.note)
}

# ARTIFACT-04 更新通道断开
$updateCandidates = New-Object System.Collections.ArrayList
if ($script:InstallPath) {
    [void]$updateCandidates.Add((Join-Path $script:InstallPath 'resources\app-update.yml'))
    [void]$updateCandidates.Add((Join-Path $script:InstallPath 'resources\app-update.yaml'))
    [void]$updateCandidates.Add((Join-Path $script:InstallPath 'resources\latest.yml'))
    [void]$updateCandidates.Add((Join-Path $script:InstallPath 'resources\latest.yaml'))
    [void]$updateCandidates.Add((Join-Path $script:InstallPath 'latest.yml'))
    [void]$updateCandidates.Add((Join-Path $script:InstallPath 'latest.yaml'))
    try {
        $parentDirectory = Split-Path -Parent $script:InstallPath
        if ($parentDirectory) {
            [void]$updateCandidates.Add((Join-Path $parentDirectory 'latest.yml'))
            [void]$updateCandidates.Add((Join-Path $parentDirectory 'latest.yaml'))
        }
    } catch { }
}
$updateHits = New-Object System.Collections.ArrayList
$updateProbed = New-Object System.Collections.ArrayList
foreach ($updateCandidate in $updateCandidates) {
    [void]$updateProbed.Add($updateCandidate)
    try { if (Test-Path -LiteralPath $updateCandidate) { [void]$updateHits.Add($updateCandidate) } } catch { }
}
$updateProbeList = ($updateProbed.ToArray()) -join ' ; '
if ($updateHits.Count -eq 0) {
    Add-Item -Section '产物完整性' -Id 'ARTIFACT-04' -Title '更新通道已断开（无 app-update.yml / latest.yml）' -Status $script:StatusPass `
        -Conclusion '未发现任何更新清单，一旦联网也不会被官方版覆盖。' `
        -Evidence @(
            ('命令: Test-Path 逐个探测 ' + [string]$updateProbed.Count + ' 个候选路径，全部不存在'),
            ('探测清单: ' + $updateProbeList)
        )
} else {
    Add-Item -Section '产物完整性' -Id 'ARTIFACT-04' -Title '更新通道已断开（无 app-update.yml / latest.yml）' -Status $script:StatusFail `
        -Conclusion '发现更新清单，联网后会自动更新回官方版，必须删除后重打包。' `
        -Evidence @(
            ('命中: ' + (($updateHits.ToArray()) -join ' ; ')),
            ('探测清单: ' + $updateProbeList)
        )
}

# ARTIFACT-05 runtime 目录结构
$runtimeJsonPath = ''
$runtimeDependencyRoot = ''
if ($script:InstallPath) {
    $runtimeJsonPath = Join-Path $script:InstallPath 'resources\runtime\primary-runtime\runtime.json'
    $runtimeDependencyRoot = Join-Path $script:InstallPath 'resources\runtime\primary-runtime\dependencies'
}
$missingRuntime = New-Object System.Collections.ArrayList
if (-not ($runtimeJsonPath -and (Test-Path -LiteralPath $runtimeJsonPath))) { [void]$missingRuntime.Add([string]$runtimeJsonPath) }
foreach ($dependency in @('node', 'pnpm', 'python')) {
    $dependencyPath = Join-Path $runtimeDependencyRoot $dependency
    if (-not (Test-Path -LiteralPath $dependencyPath)) { [void]$missingRuntime.Add($dependencyPath) }
}
$runtimeEvidence = New-Object System.Collections.ArrayList
[void]$runtimeEvidence.Add('命令: Test-Path "' + [string]$runtimeJsonPath + '" 与 "' + [string]$runtimeDependencyRoot + '\node|pnpm|python"')
if ($missingRuntime.Count -eq 0) {
    try {
        $runtimeText = (Get-Content -LiteralPath $runtimeJsonPath -Raw -Encoding UTF8).Trim()
        [void]$runtimeEvidence.Add('runtime.json = ' + $runtimeText.Replace("`r", ' ').Replace("`n", ' '))
        $runtime = $runtimeText | ConvertFrom-Json
        [void]$runtimeEvidence.Add('desktopVersion=' + [string]$runtime.desktopVersion + ' node=' + [string]$runtime.node + ' pnpm=' + [string]$runtime.pnpm + ' python=' + [string]$runtime.python + ' platform=' + [string]$runtime.platform + ' arch=' + [string]$runtime.arch)
    } catch {
        [void]$runtimeEvidence.Add('runtime.json 解析失败: ' + $_.Exception.Message)
    }
    Add-Item -Section '产物完整性' -Id 'ARTIFACT-05' -Title 'runtime 目录结构完整' -Status $script:StatusPass `
        -Conclusion 'runtime.json 与 dependencies 下的 node / pnpm / python 都在位。' -Evidence @($runtimeEvidence.ToArray())
} else {
    Add-Item -Section '产物完整性' -Id 'ARTIFACT-05' -Title 'runtime 目录结构完整' -Status $script:StatusFail `
        -Conclusion ('运行时结构缺失 ' + [string]$missingRuntime.Count + ' 项: ' + (($missingRuntime.ToArray()) -join ' ; ')) -Evidence @($runtimeEvidence.ToArray())
}

# endregion ------------------------------------------------------------- 产物完整性

# region ---------------------------------------------------------------- 4. 静态导入门禁

Write-Section '[4/5] 静态导入表门禁（可选，调用仓库侧 scan-win7-imports.mjs）'

$repoCandidates = New-Object System.Collections.ArrayList
if ($RepoRoot) { [void]$repoCandidates.Add([pscustomobject]@{ path = $RepoRoot; source = '-RepoRoot 参数' }) }
try {
    if ($script:PackageDir) {
        $derivedPackageDir = (Get-Item -LiteralPath $script:PackageDir).FullName
        $upThree = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $derivedPackageDir))
        if ($upThree) { [void]$repoCandidates.Add([pscustomobject]@{ path = $upThree; source = '由脚本所在包向上 3 级推导' }) }
    }
} catch { }
$repoCandidateList = (@($repoCandidates | ForEach-Object { $_.path }) -join ' ; ')

$scanScript = $null
$scanRepo = $null
$scanSource = ''
foreach ($repoCandidate in $repoCandidates) {
    try {
        $probePath = Join-Path $repoCandidate.path 'scripts\scan-win7-imports.mjs'
        if (Test-Path -LiteralPath $probePath) {
            $scanScript = $probePath
            $scanRepo = [System.IO.Path]::GetFullPath($repoCandidate.path)
            $scanSource = $repoCandidate.source
            break
        }
        Write-VerboseLine ('仓库候选不可用: ' + $probePath)
    } catch { }
}

$scanNode = $null
$scanNodeSource = ''
if ($nodeExeExists) {
    $scanNode = $nodeExe
    $scanNodeSource = '打包的 node.exe'
} else {
    $hostNode = Get-Command node -ErrorAction SilentlyContinue
    if ($hostNode -and $hostNode.Source) {
        $scanNode = $hostNode.Source
        $scanNodeSource = 'PATH 上的 node'
    }
}

$scanRoot = $script:InstallPath
if ($scanRoot) { $scanRoot = $scanRoot.TrimEnd('\', '/') }

if ((-not $scanScript) -and (-not $scanNode)) {
    Add-Item -Section '静态导入门禁' -Id 'STATIC-01' -Title '对产物跑 scripts\scan-win7-imports.mjs' -Status $script:StatusSkip `
        -Conclusion '目标机上既没有仓库侧扫描脚本也没有可用的 Node，该项只能在开发机构建后执行。' `
        -Evidence @(
            ('仓库候选: ' + $repoCandidateList),
            'Node 候选: 打包 node.exe 与 PATH node 都不可用'
        )
} elseif (-not $scanScript) {
    Add-Item -Section '静态导入门禁' -Id 'STATIC-01' -Title '对产物跑 scripts\scan-win7-imports.mjs' -Status $script:StatusSkip `
        -Conclusion ('机器上有 Node（' + $scanNodeSource + '）但找不到仓库侧 scripts\scan-win7-imports.mjs，SKIP。') `
        -Evidence @(
            ('仓库候选: ' + $repoCandidateList),
            ('Node: ' + [string]$scanNode)
        )
} elseif (-not $scanNode) {
    Add-Item -Section '静态导入门禁' -Id 'STATIC-01' -Title '对产物跑 scripts\scan-win7-imports.mjs' -Status $script:StatusSkip `
        -Conclusion '找到了扫描脚本但没有可用的 Node，无法执行，SKIP。' `
        -Evidence @(
            ('扫描脚本: ' + [string]$scanScript),
            'Node 候选: 打包 node.exe 与 PATH node 都不可用'
        )
} elseif (-not $scanRoot) {
    Add-Item -Section '静态导入门禁' -Id 'STATIC-01' -Title '对产物跑 scripts\scan-win7-imports.mjs' -Status $script:StatusSkip `
        -Conclusion '没有可用的产物目录，无法执行扫描，SKIP。' `
        -Evidence @(
            ('扫描脚本: ' + [string]$scanScript),
            ('Node: ' + [string]$scanNode)
        )
} else {
    $scanArguments = '"' + $scanScript + '" "' + $scanRoot + '"'
    $scanCommand = '"' + $scanNode + '" ' + $scanArguments
    Write-VerboseLine ('执行: ' + $scanCommand)
    $scanRun = Invoke-CapturedProcess -FilePath $scanNode -Arguments $scanArguments -TimeoutSeconds 900 -WorkingDirectory $scanRepo
    $scanEvidence = @(
        ('命令 (工作目录 ' + [string]$scanRepo + '): ' + $scanCommand),
        ('Node 来源: ' + $scanNodeSource + '，扫描脚本来源: ' + [string]$scanSource),
        ('退出码: ' + [string]$scanRun.exitCode + '，耗时 ' + [string]$scanRun.durationMs + 'ms，超时=' + [string]$scanRun.timedOut),
        ('stdout 尾部: ' + (Get-TextTail -Text $scanRun.stdout -MaxLines 6 -MaxLength 700)),
        ('stderr 尾部: ' + (Get-TextTail -Text $scanRun.stderr))
    )
    # 退出码 0 但一个 PE 都没扫到时，这个 PASS 没有意义，降级为 WARN 并说明。
    $scannedPe = -1
    if ($scanRun.stdout -match 'PE:\s*(\d+)') { $scannedPe = [int]$Matches[1] }
    if ($scanRun.timedOut) {
        Add-Item -Section '静态导入门禁' -Id 'STATIC-01' -Title '对产物跑 scripts\scan-win7-imports.mjs' -Status $script:StatusWarn `
            -Conclusion '扫描超时未完成，需人工在开发机上重跑。' -Evidence $scanEvidence
    } elseif (-not $scanRun.ok) {
        Add-Item -Section '静态导入门禁' -Id 'STATIC-01' -Title '对产物跑 scripts\scan-win7-imports.mjs' -Status $script:StatusWarn `
            -Conclusion ('扫描进程未能启动: ' + [string]$scanRun.error) -Evidence $scanEvidence
    } elseif ($scanRun.exitCode -eq 0 -and $scannedPe -eq 0) {
        Add-Item -Section '静态导入门禁' -Id 'STATIC-01' -Title '对产物跑 scripts\scan-win7-imports.mjs' -Status $script:StatusWarn `
            -Conclusion '扫描退出码 0，但扫描目录里一个 PE 文件都没有，结论无意义（多半指向了错误的目录）。' `
            -Evidence ($scanEvidence + @(('解析到的 PE 计数: ' + [string]$scannedPe)))
    } elseif ($scanRun.exitCode -eq 0) {
        Add-Item -Section '静态导入门禁' -Id 'STATIC-01' -Title '对产物跑 scripts\scan-win7-imports.mjs' -Status $script:StatusPass `
            -Conclusion ('扫描退出码 0：x64 载荷里没有未评审的 Win8+ 导入（本轮扫描到 ' + [string]$scannedPe + ' 个 PE 文件）。') -Evidence $scanEvidence
    } elseif ($scanRun.exitCode -eq 1) {
        Add-Item -Section '静态导入门禁' -Id 'STATIC-01' -Title '对产物跑 scripts\scan-win7-imports.mjs' -Status $script:StatusFail `
            -Conclusion '扫描退出码 1：存在未评审的 Win8+ 导入（blockers），必须先处理。' -Evidence $scanEvidence
    } else {
        Add-Item -Section '静态导入门禁' -Id 'STATIC-01' -Title '对产物跑 scripts\scan-win7-imports.mjs' -Status $script:StatusWarn `
            -Conclusion ('扫描退出码 ' + [string]$scanRun.exitCode + '（非 0/1），需人工确认。') -Evidence $scanEvidence
    }
}

# endregion ------------------------------------------------------------- 静态导入门禁

# region ---------------------------------------------------------------- 5. GUI 启动冒烟

Write-Section '[5/5] GUI 启动冒烟'

function Get-ScopedProcessIds {
    param([string]$Root)
    $ids = @()
    if (-not $Root) { return $ids }
    $prefix = $Root.ToLowerInvariant()
    try {
        foreach ($process in @(Get-Process -ErrorAction SilentlyContinue)) {
            $path = ''
            try { $path = [string]$process.Path } catch { $path = '' }
            if ($path -and $path.ToLowerInvariant().StartsWith($prefix)) { $ids += [int]$process.Id }
        }
    } catch { }
    if ($ids.Count -eq 0) {
        try {
            foreach ($process in @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)) {
                $path = [string]$process.ExecutablePath
                if ($path -and $path.ToLowerInvariant().StartsWith($prefix)) { $ids += [int]$process.ProcessId }
            }
        } catch { }
    }
    return $ids
}

function Get-UserDataCandidates {
    param([string]$InstallRoot)
    $paths = New-Object System.Collections.ArrayList
    $names = New-Object System.Collections.ArrayList
    if ($InstallRoot) {
        $appManifest = Join-Path $InstallRoot 'resources\app\package.json'
        try {
            if (Test-Path -LiteralPath $appManifest) {
                $manifest = Get-Content -LiteralPath $appManifest -Raw -Encoding UTF8 | ConvertFrom-Json
                if ($manifest.productName) { [void]$names.Add([string]$manifest.productName) }
                if ($manifest.name) { [void]$names.Add([string]$manifest.name) }
            }
        } catch { }
    }
    foreach ($name in $names) {
        if ($env:APPDATA) { [void]$paths.Add((Join-Path $env:APPDATA $name)) }
        if ($env:LOCALAPPDATA) { [void]$paths.Add((Join-Path $env:LOCALAPPDATA $name)) }
    }
    foreach ($base in @($env:APPDATA, $env:LOCALAPPDATA)) {
        if (-not $base) { continue }
        try {
            if (-not (Test-Path -LiteralPath $base -PathType Container)) { continue }
            $directories = @(Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '(?i)dsh' })
            foreach ($directory in $directories) { [void]$paths.Add($directory.FullName) }
        } catch { }
    }
    $seen = @{}
    $unique = New-Object System.Collections.ArrayList
    foreach ($path in $paths) {
        $key = $path.ToLowerInvariant()
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        [void]$unique.Add($path)
    }
    return @($unique)
}

function Get-FreshLogEvidence {
    param($Candidates, [datetime]$SinceTime)
    $evidence = New-Object System.Collections.ArrayList
    $fresh = 0
    foreach ($candidate in @($Candidates)) {
        try {
            if (-not (Test-Path -LiteralPath $candidate -PathType Container)) { continue }
            # 只认真正具备桌面端用户数据形状的目录（含 logs 子目录或 dsh-*.log），
            # 避免把同名字的无关残留目录当成证据。
            $logsDirectory = Join-Path $candidate 'logs'
            $hostLogsDirectory = Join-Path $logsDirectory 'host'
            $looksLikeDesktopData = $false
            if (Test-Path -LiteralPath $logsDirectory -PathType Container) { $looksLikeDesktopData = $true }
            if (-not $looksLikeDesktopData) {
                $directLogs = @(Get-ChildItem -LiteralPath $candidate -Filter 'dsh-*.log' -File -ErrorAction SilentlyContinue)
                if ($directLogs.Count -gt 0) { $looksLikeDesktopData = $true }
            }
            if (-not $looksLikeDesktopData) { continue }
            $logDirectories = New-Object System.Collections.ArrayList
            [void]$logDirectories.Add($candidate)
            if (Test-Path -LiteralPath $logsDirectory -PathType Container) { [void]$logDirectories.Add($logsDirectory) }
            if (Test-Path -LiteralPath $hostLogsDirectory -PathType Container) { [void]$logDirectories.Add($hostLogsDirectory) }
            foreach ($directory in $logDirectories) {
                $files = @(Get-ChildItem -LiteralPath $directory -Filter '*.log' -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt $SinceTime })
                foreach ($file in $files) {
                    $fresh = $fresh + 1
                    [void]$evidence.Add('新日志: ' + $file.FullName + ' (' + [string]$file.Length + ' 字节, ' + $file.LastWriteTime.ToString('HH:mm:ss') + ')')
                }
            }
            [void]$evidence.Add('用户数据目录存在且具备桌面端结构: ' + $candidate)
        } catch { }
    }
    if ($evidence.Count -eq 0) { [void]$evidence.Add('未观察到具备桌面端结构的用户数据目录，也没有启动后新写的日志文件') }
    return [pscustomobject]@{ fresh = $fresh; evidence = $evidence }
}

if ($SkipLaunch) {
    Add-Item -Section 'GUI 启动冒烟' -Id 'LAUNCH-01' -Title ('主程序能启动并存活 >= ' + $LaunchHoldSeconds + ' 秒') -Status $script:StatusSkip `
        -Conclusion '已通过 -SkipLaunch 跳过 GUI 启动冒烟。' -Evidence @('参数: -SkipLaunch')
    Add-Item -Section 'GUI 启动冒烟' -Id 'LAUNCH-02' -Title '用户数据目录与启动日志生成' -Status $script:StatusSkip `
        -Conclusion '已通过 -SkipLaunch 跳过，未观察。' -Evidence @('参数: -SkipLaunch')
} elseif (-not $script:MainExecutable) {
    Add-Item -Section 'GUI 启动冒烟' -Id 'LAUNCH-01' -Title ('主程序能启动并存活 >= ' + $LaunchHoldSeconds + ' 秒') -Status $script:StatusFail `
        -Conclusion '在目标目录里找不到主程序 exe，无法启动。' `
        -Evidence @(
            ('目标目录: ' + [string]$script:InstallPath),
            '命令: Get-ChildItem -LiteralPath "<install>" -Filter *.exe'
        )
    Add-Item -Section 'GUI 启动冒烟' -Id 'LAUNCH-02' -Title '用户数据目录与启动日志生成' -Status $script:StatusSkip `
        -Conclusion '主程序未启动，无法观察用户数据。' -Evidence @(('目标目录: ' + [string]$script:InstallPath))
} else {
    $launchStart = Get-Date
    $userDataCandidates = @(Get-UserDataCandidates -InstallRoot $script:InstallPath)
    $preLaunchIds = @(Get-ScopedProcessIds -Root $script:InstallPath)
    $launchEvidence = New-Object System.Collections.ArrayList
    [void]$launchEvidence.Add('命令: "' + $script:MainExecutable + '"（工作目录 ' + [string]$script:InstallPath + '）')
    if ($preLaunchIds.Count -gt 0) {
        [void]$launchEvidence.Add('启动前同目录进程: ' + ($preLaunchIds -join ', '))
    } else {
        [void]$launchEvidence.Add('启动前同目录进程: 无')
    }

    $launchProcess = $null
    $launchStartError = $null
    $stdoutTask = $null
    $stderrTask = $null
    try {
        $launchStartInfo = New-Object System.Diagnostics.ProcessStartInfo
        $launchStartInfo.FileName = $script:MainExecutable
        $launchStartInfo.WorkingDirectory = $script:InstallPath
        $launchStartInfo.UseShellExecute = $false
        $launchStartInfo.CreateNoWindow = $false
        $launchStartInfo.RedirectStandardOutput = $true
        $launchStartInfo.RedirectStandardError = $true
        try { $launchStartInfo.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
        try { $launchStartInfo.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
        $launchProcess = New-Object System.Diagnostics.Process
        $launchProcess.StartInfo = $launchStartInfo
        if (-not $launchProcess.Start()) { throw 'Process.Start 返回 false' }
        $stdoutTask = $launchProcess.StandardOutput.ReadToEndAsync()
        $stderrTask = $launchProcess.StandardError.ReadToEndAsync()
        [void]$launchEvidence.Add('已启动 PID=' + [string]$launchProcess.Id)
    } catch {
        $launchStartError = $_.Exception.Message
    }

    if ($launchStartError) {
        Add-Item -Section 'GUI 启动冒烟' -Id 'LAUNCH-01' -Title ('主程序能启动并存活 >= ' + $LaunchHoldSeconds + ' 秒') -Status $script:StatusFail `
            -Conclusion ('主程序无法启动: ' + $launchStartError) -Evidence @($launchEvidence.ToArray())
        Add-Item -Section 'GUI 启动冒烟' -Id 'LAUNCH-02' -Title '用户数据目录与启动日志生成' -Status $script:StatusSkip `
            -Conclusion '主程序未启动，无法观察用户数据。' -Evidence @($launchEvidence.ToArray())
    } else {
        $maxObserveSeconds = 120
        # 到达存活门槛后再给 30 秒宽限期等日志落盘，然后收工；硬上限 120 秒。
        $observeCeiling = $LaunchHoldSeconds + 30
        if ($observeCeiling -gt $maxObserveSeconds) { $observeCeiling = $maxObserveSeconds }
        $lastKnownAliveSeconds = 0
        $logProbe = $null
        $observeWatch = [System.Diagnostics.Stopwatch]::StartNew()
        while ($true) {
            Start-Sleep -Seconds 1
            try { $launchProcess.Refresh() } catch { }
            $alive = -not $launchProcess.HasExited
            $elapsed = [int]$observeWatch.Elapsed.TotalSeconds
            if ($alive) { $lastKnownAliveSeconds = $elapsed }
            if ($elapsed -ge $maxObserveSeconds) { break }
            if (-not $alive) { break }
            if (($elapsed % 5) -eq 0) {
                $logProbe = Get-FreshLogEvidence -Candidates $userDataCandidates -SinceTime $launchStart
            }
            if ($elapsed -ge $LaunchHoldSeconds) {
                if ($null -eq $logProbe) {
                    $logProbe = Get-FreshLogEvidence -Candidates $userDataCandidates -SinceTime $launchStart
                }
                if ($logProbe.fresh -gt 0) { break }
            }
            if ($elapsed -ge $observeCeiling) { break }
        }
        $observeWatch.Stop()
        if ($null -eq $logProbe) { $logProbe = Get-FreshLogEvidence -Candidates $userDataCandidates -SinceTime $launchStart }
        $survivedSeconds = $lastKnownAliveSeconds

        $windowTitle = ''
        $windowHandle = 0
        try { $windowTitle = [string]$launchProcess.MainWindowTitle } catch { }
        try { $windowHandle = [int64]$launchProcess.MainWindowHandle } catch { }
        [void]$launchEvidence.Add('存活时长: ' + [string]$survivedSeconds + ' 秒（门槛 ' + [string]$LaunchHoldSeconds + ' 秒，本次观察窗口 ' + [string]$observeCeiling + ' 秒，硬上限 ' + [string]$maxObserveSeconds + ' 秒）')
        [void]$launchEvidence.Add('MainWindowHandle=' + [string]$windowHandle + ' MainWindowTitle="' + $windowTitle + '"（仅作旁证，不能断言窗口可见）')
        try { [void]$launchEvidence.Add('内存占用: ' + [string][int]($launchProcess.WorkingSet64 / 1MB) + ' MiB') } catch { }
        foreach ($line in $logProbe.evidence) { [void]$launchEvidence.Add($line) }

        $survived = ($survivedSeconds -ge $LaunchHoldSeconds)
        try { if (-not $launchProcess.HasExited) { $survived = ($survivedSeconds -ge $LaunchHoldSeconds) } } catch { }
        if ($survived) {
            Add-Item -Section 'GUI 启动冒烟' -Id 'LAUNCH-01' -Title ('主程序能启动并存活 >= ' + $LaunchHoldSeconds + ' 秒') -Status $script:StatusPass `
                -Conclusion ('进程存活 ' + [string]$survivedSeconds + ' 秒 >= 门槛，启动冒烟通过；注意：窗口是否肉眼可见无法由脚本断言，需人工确认。') `
                -Evidence @($launchEvidence.ToArray())
        } else {
            $exitCodeText = '未知'
            try { if ($launchProcess.HasExited) { $exitCodeText = [string]$launchProcess.ExitCode } } catch { }
            Add-Item -Section 'GUI 启动冒烟' -Id 'LAUNCH-01' -Title ('主程序能启动并存活 >= ' + $LaunchHoldSeconds + ' 秒') -Status $script:StatusWarn `
                -Conclusion ('进程只存活 ' + [string]$survivedSeconds + ' 秒（< 门槛 ' + [string]$LaunchHoldSeconds + '），需人工确认；窗口是否可见无法由脚本断言。') `
                -Evidence ($launchEvidence.ToArray() + @(('退出码: ' + $exitCodeText)))
        }

        if ($logProbe.fresh -gt 0) {
            Add-Item -Section 'GUI 启动冒烟' -Id 'LAUNCH-02' -Title '用户数据目录与启动日志生成' -Status $script:StatusPass `
                -Conclusion ('观察到 ' + [string]$logProbe.fresh + ' 个启动后新写的日志文件，说明主进程已进入正常初始化。') -Evidence @($logProbe.evidence)
        } else {
            Add-Item -Section 'GUI 启动冒烟' -Id 'LAUNCH-02' -Title '用户数据目录与启动日志生成' -Status $script:StatusWarn `
                -Conclusion '未观察到启动后新写的日志，需人工确认（首次启动、被安全软件拦截或用户数据目录被重定向都可能如此）。' `
                -Evidence (@($logProbe.evidence) + @(('候选用户数据目录: ' + ($userDataCandidates -join ' ; '))))
        }

        # 优雅结束，再兜底强杀，最后清掉同目录残留进程
        $closeMethod = '进程已自行退出'
        if (-not $launchProcess.HasExited) {
            $closeMethod = ''
            $signalled = $false
            try { $signalled = $launchProcess.CloseMainWindow() } catch { }
            if ($signalled) {
                try { [void]$launchProcess.WaitForExit(15000) } catch { }
                if ($launchProcess.HasExited) { $closeMethod = 'CloseMainWindow 优雅退出' }
            }
            if (-not $launchProcess.HasExited) {
                try {
                    $killRun = Invoke-CapturedProcess -FilePath 'taskkill.exe' -Arguments ('/PID ' + [string]$launchProcess.Id + ' /T /F') -TimeoutSeconds 30 -OutputEncoding $script:AnsiEncoding
                    [void]$launchEvidence.Add('taskkill /PID ' + [string]$launchProcess.Id + ' /T /F -> 退出码 ' + [string]$killRun.exitCode + ' ' + (Get-TextTail -Text $killRun.stdout -MaxLines 2))
                } catch { }
                try { [void]$launchProcess.WaitForExit(10000) } catch { }
                if ($launchProcess.HasExited) { $closeMethod = 'taskkill /T /F' }
            }
            if (-not $launchProcess.HasExited) {
                try { Stop-Process -Id $launchProcess.Id -Force -ErrorAction SilentlyContinue } catch { }
                try { [void]$launchProcess.WaitForExit(5000) } catch { }
                $closeMethod = 'Stop-Process -Force 兜底'
            }
        }
        Start-Sleep -Seconds 2
        $postIds = @(Get-ScopedProcessIds -Root $script:InstallPath)
        $leftovers = @()
        foreach ($processId in $postIds) {
            if ($preLaunchIds -notcontains $processId) { $leftovers += $processId }
        }
        foreach ($leftover in $leftovers) {
            try {
                $cleanup = Invoke-CapturedProcess -FilePath 'taskkill.exe' -Arguments ('/PID ' + [string]$leftover + ' /T /F') -TimeoutSeconds 30 -OutputEncoding $script:AnsiEncoding
                [void]$launchEvidence.Add('残留清理: taskkill /PID ' + [string]$leftover + ' /T /F -> 退出码 ' + [string]$cleanup.exitCode)
            } catch { }
        }
        Start-Sleep -Seconds 2
        $finalIds = @(Get-ScopedProcessIds -Root $script:InstallPath)
        $finalLeftovers = @()
        foreach ($processId in $finalIds) {
            if ($preLaunchIds -notcontains $processId) { $finalLeftovers += $processId }
        }
        $stillAlive = $false
        try { $stillAlive = -not $launchProcess.HasExited } catch { }

        $stdoutTail = ''
        $stderrTail = ''
        try { $stdoutTail = [string]$stdoutTask.Result } catch { $stdoutTail = '' }
        try { $stderrTail = [string]$stderrTask.Result } catch { $stderrTail = '' }

        Add-Item -Section 'GUI 启动冒烟' -Id 'LAUNCH-03' -Title '冒烟结束后不留僵尸进程' -Status $script:StatusPass `
            -Conclusion ('结束方式: ' + $closeMethod + '；残留进程 ' + [string]$finalLeftovers.Count + ' 个（启动前基线 ' + [string]$preLaunchIds.Count + ' 个）。') `
            -Evidence ($launchEvidence.ToArray() + @(
                ('主进程仍存活: ' + [string]$stillAlive),
                ('清理后同目录进程: ' + $(if ($finalLeftovers.Count -gt 0) { ($finalLeftovers -join ', ') } else { '无残留' })),
                ('stdout 尾部: ' + (Get-TextTail -Text $stdoutTail)),
                ('stderr 尾部: ' + (Get-TextTail -Text $stderrTail))
            ))
        try { $launchProcess.Dispose() } catch { }
    }
}

# endregion ------------------------------------------------------------- GUI 启动冒烟

# region ---------------------------------------------------------------- 汇总输出

$countPass = 0
$countFail = 0
$countWarn = 0
$countSkip = 0
$failItems = New-Object System.Collections.ArrayList
foreach ($item in $script:Items) {
    if ($item.status -eq 'PASS') { $countPass = $countPass + 1 }
    elseif ($item.status -eq 'FAIL') { $countFail = $countFail + 1; [void]$failItems.Add($item) }
    elseif ($item.status -eq 'WARN') { $countWarn = $countWarn + 1 }
    else { $countSkip = $countSkip + 1 }
}

Write-Host ''
Write-Host ('=' * 96) -ForegroundColor Cyan
Write-Host '  验收结果汇总' -ForegroundColor Cyan
Write-Host ('=' * 96) -ForegroundColor Cyan
foreach ($item in $script:Items) {
    Write-Host ('  ' + (Format-Cell $item.status 5) + (Format-Cell $item.id 14) + $item.title) -ForegroundColor (Get-StatusColor $item.status)
}
Write-Host ''
Write-Host '  分区统计:'
foreach ($sectionName in @('主机前置', '运行时自证', '产物完整性', '静态导入门禁', 'GUI 启动冒烟')) {
    $sectionItems = @($script:Items | Where-Object { $_.section -eq $sectionName })
    if ($sectionItems.Count -eq 0) { continue }
    $sectionFail = @($sectionItems | Where-Object { $_.status -eq 'FAIL' }).Count
    $sectionWarn = @($sectionItems | Where-Object { $_.status -eq 'WARN' }).Count
    $sectionSkip = @($sectionItems | Where-Object { $_.status -eq 'SKIP' }).Count
    $sectionPass = @($sectionItems | Where-Object { $_.status -eq 'PASS' }).Count
    Write-Host ('    ' + (Format-Cell $sectionName 16) + 'PASS=' + (Format-Cell ([string]$sectionPass) 5) + 'FAIL=' + (Format-Cell ([string]$sectionFail) 5) + 'WARN=' + (Format-Cell ([string]$sectionWarn) 5) + 'SKIP=' + $sectionSkip)
}
Write-Host ''
Write-Host ('  PASS=' + $countPass + '  FAIL=' + $countFail + '  WARN=' + $countWarn + '  SKIP=' + $countSkip + '  合计=' + $script:Items.Count) -ForegroundColor White

if ($failItems.Count -gt 0) {
    Write-Host ''
    Write-Host '  未通过的检查项:' -ForegroundColor Red
    foreach ($item in $failItems) {
        Write-Host ('    [FAIL] ' + $item.id + '  ' + $item.title + ' —— ' + $item.conclusion) -ForegroundColor Red
    }
}
if ($countWarn -gt 0) {
    Write-Host ''
    Write-Host ('  注意: 存在 ' + $countWarn + ' 个 WARN，脚本不据此判失败，但需要人工确认。') -ForegroundColor Yellow
}

if ($countFail -gt 0) { $script:ExitCode = 1 } else { $script:ExitCode = 0 }

if ($Json) {
    try {
        $jsonPath = [System.IO.Path]::GetFullPath($Json)
        $jsonDirectory = Split-Path -Parent $jsonPath
        if ($jsonDirectory -and (-not (Test-Path -LiteralPath $jsonDirectory))) {
            [void](New-Item -ItemType Directory -Path $jsonDirectory -Force)
        }
        $report = [pscustomobject][ordered]@{
            schema            = 'dsh-win7-acceptance/1'
            generatedAt       = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ssK')
            scriptPath        = [string]$MyInvocation.MyCommand.Path
            host              = $script:HostFacts
            installDir        = [string]$script:InstallPath
            installSource     = $script:InstallSource
            mainExecutable    = [string]$script:MainExecutable
            packageDir        = $script:PackageDir
            skippedLaunch     = [bool]$SkipLaunch
            launchHoldSeconds = $LaunchHoldSeconds
            expectedNodeSize  = $ExpectedNodeSizeBytes
            sizeTolerance     = $SizeToleranceBytes
            items             = @($script:Items)
            summary           = [pscustomobject][ordered]@{
                pass     = $countPass
                fail     = $countFail
                warn     = $countWarn
                skip     = $countSkip
                total    = $script:Items.Count
                exitCode = $script:ExitCode
            }
            exitCode          = $script:ExitCode
        }
        $jsonText = $report | ConvertTo-Json -Depth 8
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($jsonPath, $jsonText, $utf8NoBom)
        Write-Host ''
        Write-Host ('  JSON 已写出: ' + $jsonPath) -ForegroundColor Green
    } catch {
        Write-Host ''
        Write-Host ('  JSON 写出失败: ' + $_.Exception.Message) -ForegroundColor Yellow
    }
}

Write-Host ''
if ($script:ExitCode -eq 0) {
    Write-Host ('退出码: ' + $script:ExitCode + '  (0 = 无 FAIL；1 = 存在 FAIL；2 = 参数/用法错误)') -ForegroundColor Green
} else {
    Write-Host ('退出码: ' + $script:ExitCode + '  (0 = 无 FAIL；1 = 存在 FAIL；2 = 参数/用法错误)') -ForegroundColor Red
}
Write-Host ''

exit $script:ExitCode

# endregion ------------------------------------------------------------- 汇总输出





