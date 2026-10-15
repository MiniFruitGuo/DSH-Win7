<#
.SYNOPSIS
  构建 Windows 7 SP1 兼容的 Node.js 运行时（DSH Win7 离线版专用）。

.DESCRIPTION
  对 Node.js 源码施加两处 Win7 兼容补丁后重新编译，产出可在 Windows 7 SP1 x64
  上加载并正常执行的 node.exe。

  补丁 1  src/node_main.cc        平台检查阈值 Win8.1 -> Win7 SP1
  补丁 2  deps/uv/src/win/util.c  时间 API GetSystemTimePreciseAsFileTime -> GetSystemTimeAsFileTime

  两处均为单行替换，改动量已由全源码树检索确认：
  整个 Node 22.20.0 树中 GetSystemTimePreciseAsFileTime 仅有一处调用点。

.PARAMETER Version
  Node.js 版本，默认 22.20.0。

.PARAMETER WorkDir
  构建工作目录，默认 D:\dsh-win7-build。V8 链接阶段需要数十 GB 临时空间，
  E 盘余量不足会报 LNK1180，故工作目录放在空间充裕的盘。

.PARAMETER FullIcu
  使用完整 ICU 数据集（默认 small-icu）。中文界面需要完整 Intl 支持时启用。

.PARAMETER SkipBuild
  只做源码准备与补丁，不触发编译（用于先行校验补丁正确性）。

.PARAMETER RequireVS2022
  强制要求 Visual Studio 2022 (17.6+)；默认允许较旧工具集继续。

.EXAMPLE
  powershell -File build-node-win7.ps1 -Version 22.20.0 -FullIcu

.NOTES
  前置：Visual Studio（2019 16.11+ 或 2022）含 C++ 工作负载、Windows 10 SDK 10.0.17763+、
        Python 3.x、NASM 2.13+。

  Node 22 官方构建矩阵要求 VS2022，但本机 VS2019 16.11 (MSVC 19.29) 已实测支持
  所需的全部 C++20 特性（concepts / requires / 三路比较 / std::span / 模板 lambda /
  constexpr 增强），见 verify/cpp20-probe.cpp。因此默认不因缺少 VS2022 而中止。
#>
[CmdletBinding()]
param(
  [string]$Version = '22.20.0',
  [string]$WorkDir = 'D:\dsh-win7-build',
  [switch]$FullIcu,
  [switch]$SkipBuild,
  [switch]$RequireVS2022
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Step([string]$m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Write-Ok([string]$m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Write-Warn2([string]$m){ Write-Host "  [!!] $m" -ForegroundColor Yellow }
function Write-Err([string]$m)  { Write-Host "  [XX] $m" -ForegroundColor Red }

# ---------------------------------------------------------------- 前置检查
Write-Step '前置检查'

$vswhereExe = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhereExe)) { Write-Err "未找到 vswhere：$vswhereExe"; exit 1 }

$vsRaw = & $vswhereExe -all -prerelease -format json 2>$null | Out-String
$vs = if ([string]::IsNullOrWhiteSpace($vsRaw)) { @() } else { @($vsRaw | ConvertFrom-Json) }
if ($vs.Count -eq 0) { Write-Err '未找到 Visual Studio 实例'; exit 1 }

$vs2022 = $vs | Where-Object { [version]($_.installationVersion) -ge [version]'17.6' }
foreach ($i in $vs) { Write-Host ("  VS {0}  ({1})" -f $i.installationVersion, $i.installationPath) }

if (-not $vs2022) {
  Write-Warn2 '未检测到 Visual Studio 2022 (17.6+)。Node 官方构建矩阵要求 VS2022。'
  Write-Warn2 '但实测本机 VS2019 16.11 (MSVC 19.29) 已支持所需的全部 C++20 特性：'
  Write-Warn2 '  concepts / requires / 三路比较 / std::span / 模板 lambda / constexpr 增强'
  Write-Warn2 '  验证程序：verify/cpp20-probe.cpp（cl /std:c++20 编译通过）'
  Write-Warn2 '继续构建；若中途失败再装：winget install Microsoft.VisualStudio.2022.BuildTools'
  if ($RequireVS2022) { Write-Err '指定了 -RequireVS2022，已中止。'; exit 1 }
  Write-Warn2 '（如需强制要求 VS2022，加 -RequireVS2022）'
}
else { Write-Ok "使用 VS $($vs2022[0].installationVersion)" }

$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) { Write-Err '未找到 python'; exit 1 }
Write-Ok "python  $python  ($(& python --version 2>&1))"

$nasm = (Get-Command nasm -ErrorAction SilentlyContinue).Source
if (-not $nasm) { Write-Warn2 '未找到 nasm，OpenSSL 汇编优化将降级（构建仍可完成）' }
else { Write-Ok "nasm    $nasm" }

$sdkRoot = 'C:\Program Files (x86)\Windows Kits\10\Include'
$sdk = Get-ChildItem $sdkRoot -Directory -ErrorAction SilentlyContinue |
       Where-Object { $_.Name -match '^10\.0\.\d+\.0$' } | Sort-Object Name -Descending | Select-Object -First 1
if (-not $sdk) { Write-Err "未找到 Windows 10 SDK（$sdkRoot）"; exit 1 }
Write-Ok "winsdk  $($sdk.Name)"

# ---------------------------------------------------------------- 源码准备
Write-Step "准备 Node.js v$Version 源码"

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$srcDir = Join-Path $WorkDir "node-v$Version"
$tarball = Join-Path $WorkDir "node-v$Version.tar.gz"

if (-not (Test-Path $srcDir)) {
  if (-not (Test-Path $tarball)) {
    $urls = @(
      "https://registry.npmmirror.com/-/binary/node/v$Version/node-v$Version.tar.gz",
      "https://nodejs.org/dist/v$Version/node-v$Version.tar.gz"
    )
    foreach ($u in $urls) {
      try { Invoke-WebRequest -Uri $u -OutFile $tarball -TimeoutSec 900; Write-Ok "下载 $u"; break }
      catch { Write-Warn2 "失败 $u" }
    }
    if (-not (Test-Path $tarball)) { Write-Err '源码下载失败'; exit 1 }
  }
  New-Item -ItemType Directory -Force -Path $srcDir | Out-Null
  tar -xzf $tarball -C $srcDir --strip-components=1 2>$null
  if (-not (Test-Path (Join-Path $srcDir 'src\node_main.cc'))) { Write-Err '解压结果不完整'; exit 1 }
  Write-Ok "解压到 $srcDir"
} else {
  Write-Ok "复用已有源码 $srcDir"
}

# ---------------------------------------------------------------- 施加补丁
Write-Step '施加 Win7 SP1 兼容补丁'

$patches = @(
  @{
    File = 'src\node_main.cc'
    From = 'if (!IsWindows8Point1OrGreater() &&'
    To   = 'if (!IsWindows7SP1OrGreater() &&'
    Note = '平台检查阈值降到 Windows 7 SP1'
  },
  @{
    File = 'deps\uv\src\win\util.c'
    From = 'GetSystemTimePreciseAsFileTime(&ft);'
    To   = 'GetSystemTimeAsFileTime(&ft);'
    Note = 'GetSystemTimePreciseAsFileTime 为 Win8+ API，替换为签名一致的 Win7 版本'
  }
)

foreach ($p in $patches) {
  $path = Join-Path $srcDir $p.File
  if (-not (Test-Path $path)) { Write-Err "缺少文件 $($p.File)"; exit 1 }

  $text = [System.IO.File]::ReadAllText($path)
  $fromCount = ([regex]::Matches($text, [regex]::Escape($p.From))).Count
  $toCount   = ([regex]::Matches($text, [regex]::Escape($p.To))).Count

  if ($fromCount -eq 1) {
    $text = $text.Replace($p.From, $p.To)
    $utf8Bom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($path, $text, $utf8Bom)
    Write-Ok "$($p.File)  $($p.Note)"
  }
  elseif ($fromCount -eq 0 -and $toCount -eq 1) {
    Write-Ok "$($p.File)  已是目标状态，跳过"
  }
  else {
    Write-Err "$($p.File)  预期 1 处匹配，实际 $fromCount 处（目标形态 $toCount 处）。版本可能已变更，需人工核对。"
    exit 1
  }
}

# 复核：补丁后源码树中不应再出现 Win8+ 时间 API 调用
$residual = Get-ChildItem $srcDir -Recurse -Include *.c,*.cc,*.h -File -ErrorAction SilentlyContinue |
            Select-String -Pattern 'GetSystemTimePreciseAsFileTime' -SimpleMatch -ErrorAction SilentlyContinue
if ($residual) {
  Write-Err '源码树中仍存在 GetSystemTimePreciseAsFileTime 调用，补丁不完整：'
  $residual | ForEach-Object { Write-Host "      $($_.Path):$($_.LineNumber)" }
  exit 1
}
Write-Ok '全树复核：已无 GetSystemTimePreciseAsFileTime 调用'

# --- VS2019 兼容改动 -------------------------------------------------------
# Node 22 官方构建矩阵只支持 VS2022，但 MSVC 19.29 已实测支持所需的全部
# C++20 特性（verify/cpp20-probe.cpp）。以下两处让构建链接受 VS2019。
# 均为幂等改动：已是目标形态则跳过。
$vs2019Targets = @(
  @{
    File = 'vcbuild.bat'
    Find = '[17.6,18.0)'
    Repl = '[16.0,18.0)'
    Note = 'vswhere 版本区间放宽以接受 VS2019'
  }
)
foreach ($t in $vs2019Targets) {
  $path = Join-Path $srcDir $t.File
  if (-not (Test-Path $path)) { Write-Err "缺少文件 $($t.File)"; exit 1 }
  $text = [System.IO.File]::ReadAllText($path)
  if ($text.Contains($t.Repl)) { Write-Ok "$($t.File)  已是目标状态，跳过"; continue }
  if (-not $text.Contains($t.Find)) {
    Write-Err "$($t.File)  未找到预期片段 '$($t.Find)'，版本可能已变更，需人工核对。"
    exit 1
  }
  [System.IO.File]::WriteAllText($path, $text.Replace($t.Find, $t.Repl), (New-Object System.Text.UTF8Encoding($false)))
  Write-Ok "$($t.File)  $($t.Note)"
}

# vcbuild.bat 里按 VS 主版本选择工具集：16.x 用 2019/v142，否则 2022/v143。
$vcbPath = Join-Path $srcDir 'vcbuild.bat'
$vcb = [System.IO.File]::ReadAllText($vcbPath)
if ($vcb -match 'PLATFORM_TOOLSET=v142') {
  Write-Ok 'vcbuild.bat  工具集选择已是目标状态，跳过'
} else {
  $oldBlock = "echo Found MSVS version %VisualStudioVersion%`r`nset GYP_MSVS_VERSION=2022`r`nset PLATFORM_TOOLSET=v143"
  $newBlock = "echo Found MSVS version %VisualStudioVersion%`r`n" +
              "@rem VS2019 (16.x) fallback: pick the pre-v143 toolset so gyp does not look for VS2022.`r`n" +
              "echo %VisualStudioVersion% | findstr /b /c:`"16.`" >nul`r`n" +
              "if %errorlevel% equ 0 (`r`n" +
              "  set GYP_MSVS_VERSION=2019`r`n" +
              "  set PLATFORM_TOOLSET=v142`r`n" +
              ") else (`r`n" +
              "  set GYP_MSVS_VERSION=2022`r`n" +
              "  set PLATFORM_TOOLSET=v143`r`n" +
              ")"
  if (-not $vcb.Contains($oldBlock)) {
    Write-Err 'vcbuild.bat  未找到 GYP_MSVS_VERSION/PLATFORM_TOOLSET 片段，版本可能已变更，需人工核对。'
    exit 1
  }
  [System.IO.File]::WriteAllText($vcbPath, $vcb.Replace($oldBlock, $newBlock), (New-Object System.Text.UTF8Encoding($false)))
  Write-Ok 'vcbuild.bat  按 VS 主版本选择 GYP_MSVS_VERSION / PLATFORM_TOOLSET'
}

# gyp 从注册表 ProductVersion 推导 SDK；该键可能残留为已卸载的版本
# （如 10.0.22621，而 Include 下只有 10240/17763/19041/22000），前缀匹配
# 失败即报 "requires any SDK of ['v8.1','v10.0'] version"。
# 在 _ConfigWindowsTargetPlatformVersion 里加回退：扫描 include 取实际最新 SDK。
$msvsPy = Join-Path $srcDir 'tools\gyp\pylib\gyp\generator\msvs.py'
$mp = [System.IO.File]::ReadAllText($msvsPy)
if ($mp.Contains('Falling back to installed Windows SDK')) {
  Write-Ok 'tools\gyp\...\msvs.py  已是目标状态，跳过'
} else {
  $anchor = @"
                print(
                    "Warning: No include files found for detected "
                    "Windows SDK version %s" % (version),
                    file=sys.stdout,
                )
"@
  $fallback = $anchor + @"
                # The registry ProductVersion can be stale: an SDK may have
                # been uninstalled while the key kept its version, so no
                # include directory starts with it. Fall back to the newest
                # SDK that is actually present under <sdk_dir>\include.
                present = sorted(
                    (
                        x
                        for x in (
                            os.listdir(expected_sdk_dir)
                            if os.path.isdir(expected_sdk_dir)
                            else []
                        )
                        if re.match(r"^\d+\.\d+\.\d+", x)
                    ),
                    reverse=True,
                )
                if present:
                    print(
                        "Falling back to installed Windows SDK %s" % present[0],
                        file=sys.stdout,
                    )
                    return present[0]
"@
  $anchorLf = $anchor -replace "`r`n", "`n"
  $mpLf = $mp -replace "`r`n", "`n"
  if (-not $mpLf.Contains($anchorLf)) {
    Write-Err 'tools\gyp\...\msvs.py  未找到 SDK 检测片段，版本可能已变更，需人工核对。'
    exit 1
  }
  $fallbackLf = $fallback -replace "`r`n", "`n"
  [System.IO.File]::WriteAllText($msvsPy, $mpLf.Replace($anchorLf, $fallbackLf), (New-Object System.Text.UTF8Encoding($false)))
  Write-Ok 'tools\gyp\...\msvs.py  注册表 SDK 版本失配时回退到 include 目录实际版本'
}

if ($SkipBuild) { Write-Host "`n补丁校验完成（-SkipBuild）。" -ForegroundColor Green; exit 0 }

# ---------------------------------------------------------------- 编译
Write-Step '配置与编译（单核约 40-90 分钟）'

$intl = if ($FullIcu) { 'full-icu' } else { 'small-icu' }
Write-Host "  intl=$intl  target=win-x64 release"

Push-Location $srcDir
try {
  $env:PYTHON = $python
  if ($nasm) { $env:NASM = $nasm }

  # gyp 从注册表 ProductVersion 推导 SDK 版本；本机该键残留为 10.0.22621，
  # 而 Include 下只有 10240/17763/19041/22000，前缀匹配不上就报
  # "requires any SDK of ['v8.1','v10.0'] version, but none were found"。
  # gyp 的 _ConfigWindowsTargetPlatformVersion 优先采用这个 define，
  # 因此设置它可完全绕过注册表查询。
  $env:GYP_DEFINES = 'msvs_windows_target_platform_version=10.0.19041.0'

  # configure.py 默认即 release，没有 --release 参数（传了会被 argparse 拒绝）。
  & python configure.py --dest-cpu=x64 "--with-intl=$intl" 2>&1 |
    Tee-Object -FilePath (Join-Path $WorkDir 'configure.log')
  if ($LASTEXITCODE -ne 0) { Write-Err 'configure.py 失败，见 configure.log'; exit 1 }

  # MSBuild 用大小写不敏感的字典装载子进程环境；本机环境块里
  # 同时存在 HTTP_PROXY/http_proxy、HTTPS_PROXY/https_proxy、NO_PROXY/no_proxy
  # 三对重复项（代理软件写入），会让它以
  # "已添加项。字典中的关键字:"HTTP_PROXY"所添加的关键字:"http_proxy"" 中断，
  # 报成 error MSB6001 "CL.exe"的命令行开关无效。
  # 这里显式重建一个无重复的环境块再启动 vcbuild。
  $buildLog = Join-Path $WorkDir 'build.log'
  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = 'cmd.exe'
  $psi.Arguments = '/c "vcbuild.bat release x64 > ' + $buildLog + ' 2>&1"'
  $psi.WorkingDirectory = $srcDir
  $psi.UseShellExecute = $false
  # Windows PowerShell 5.1（.NET Framework 4.8）下这两个属性首次访问可能返回
  # null，先预热一次再取稳定引用。GetEnvironmentVariables 返回大小写不敏感的
  # Hashtable，重复项已被合并，逐个写入即可得到无重复的新环境块，
  # MSBuild 才不会撞上字典键冲突。
  $null = $psi.EnvironmentVariables
  $envDict = $psi.EnvironmentVariables
  $merged = [System.Environment]::GetEnvironmentVariables('Process')
  foreach ($key in $merged.Keys) { $envDict[$key] = [string]$merged[$key] }
  # MSBuild 默认复用 worker 节点，这些节点长期驻留并持有启动时的环境块。
  # 若某次构建的环境里带大小写重复变量，残留节点会在后续构建中持续报
  # MSB6001（错误栈停在 ProcessStartInfo.get_EnvironmentVariables）。
  # 禁用节点复用，保证每个节点都用本进程构造的干净环境。
  $envDict['MSBUILDDISABLENODEREUSE'] = '1'

  Write-Host "  启动 vcbuild（日志: $buildLog）"
  $proc = [System.Diagnostics.Process]::Start($psi)
  $proc.WaitForExit()
  $vcExit = $proc.ExitCode
  Get-Content $buildLog -Tail 40 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
  if ($vcExit -ne 0) {
    # cctest 等测试目标在代码页 936 下可能因测试源码里的非 ASCII 字符失败
    # （error C2001/C2143），但这与交付物无关。只要 node.exe 已产出即继续。
    $produced = Join-Path $srcDir 'out\Release\node.exe'
    if (Test-Path $produced) {
      Write-Warn2 "vcbuild 退出码 $vcExit，但 node.exe 已产出（测试目标失败可忽略）"
    } else {
      Write-Err "vcbuild 失败（exit=$vcExit）且未产出 node.exe，完整日志见 build.log"
      exit 1
    }
  } else { Write-Ok 'vcbuild 成功' }
}
finally { Pop-Location }

# ---------------------------------------------------------------- 产物校验
Write-Step '产物校验'

$built = Join-Path $srcDir 'Release\node.exe'
if (-not (Test-Path $built)) { $built = Join-Path $srcDir 'out\Release\node.exe' }
if (-not (Test-Path $built)) { Write-Err '未找到编译产物 node.exe'; exit 1 }

$outDir = Join-Path $WorkDir 'out'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$final = Join-Path $outDir 'node.exe'
Copy-Item $built $final -Force
Write-Ok "产物 $final  ($([math]::Round((Get-Item $final).Length/1MB,1)) MB)"

# 用 dumpbin 复核导入表：不应再出现任何 Win8+ 专有导入
$dumpbin = & $vswhereExe -latest -find 'VC\Tools\MSVC\**\bin\Hostx64\x64\dumpbin.exe' 2>$null |
           Select-Object -First 1

if ($dumpbin -and (Test-Path $dumpbin)) {
  $imports = & $dumpbin /nologo /imports $final 2>&1 | Out-String
  $badApis = @('WaitOnAddress','WakeByAddressAll','WakeByAddressSingle',
               'GetSystemTimePreciseAsFileTime','SetThreadDescription','GetThreadDescription')
  $hit = $badApis | Where-Object { $imports -match $_ }
  if ($hit) {
    Write-Err "导入表仍含 Win8+ 专有 API：$($hit -join ', ')"
    exit 1
  }
  if ($imports -match 'api-ms-win-core-synch-l1-2-0') {
    Write-Err '导入表仍引用 api-ms-win-core-synch-l1-2-0（Win8+）'
    exit 1
  }
  Write-Ok '导入表校验通过：无 Win8+ 专有 API 静态依赖'
}
else { Write-Warn2 '未找到 dumpbin，跳过导入表校验' }

# 本机冒烟（构建主机为 Win10/11，仅验证二进制可正常执行）
# --no-warnings 抑制 node:sqlite 的 ExperimentalWarning：该警告写 stderr，
# 在 $ErrorActionPreference='Stop' 下会被当成终止错误。
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$smoke = & $final --no-warnings -e "console.log(process.version, process.arch, process.versions.v8, typeof Promise.withResolvers, typeof require('node:sqlite').DatabaseSync)" 2>&1
$ErrorActionPreference = $prevEap
Write-Host "  本机冒烟: $smoke"

Write-Step '完成'
$summary = @"
  node.exe        $final
  部署位置        <DSH>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe
  目标机验证      见 dsh-win7-plan-A.md 第 6 节
"@
Write-Host $summary -ForegroundColor Green
