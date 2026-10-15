<#
  DSH Desktop startup evidence collector.

  Windows 7 ships Windows PowerShell 2.0, so this script deliberately avoids every
  cmdlet that arrived later: no Get-ChildItem -Directory (3.0), no Get-Content -Tail
  (3.0), no ConvertFrom-Json (3.0), no Get-FileHash (4.0), no Compress-Archive (5.0)
  and no ProcessStartInfo.ReadToEndAsync (.NET 4.5). Where a newer API would be
  convenient, a .NET 2.0 equivalent or a plain-text fallback is used instead.

  It starts the installed application with stdout/stderr captured, watches the
  process and its window title, runs a small payload self-check, then copies the
  application's own logs, lifecycle events and crash evidence into one folder
  (zipped when the machine can do it).

  Nothing here needs a network connection.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File collect-desktop-startup-evidence.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File collect-desktop-startup-evidence.ps1 -InstallDir "D:\DSH"
    powershell -NoProfile -ExecutionPolicy Bypass -File collect-desktop-startup-evidence.ps1 -SkipLaunch
#>

param(
  [string]$InstallDir = '',
  [int]$HoldSeconds = 90,
  [string]$OutDir = '',
  [switch]$SkipLaunch
)

$ErrorActionPreference = 'Continue'
if ($OutDir -eq '') { $OutDir = [Environment]::GetFolderPath('Desktop') }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$work = Join-Path $OutDir ("dsh-desktop-evidence-" + $stamp)
New-Item -ItemType Directory -Force -Path $work | Out-Null
$report = Join-Path $work 'report.txt'

function Write-Report {
  param([string]$Line = '')
  Write-Host $Line
  Add-Content -Path $report -Value $Line -Encoding UTF8
}

function Test-64BitHost {
  if ($env:PROCESSOR_ARCHITEW6432 -eq 'AMD64') { return $true }
  if ($env:PROCESSOR_ARCHITEW6432 -eq 'IA64') { return $true }
  if ($env:PROCESSOR_ARCHITECTURE -eq 'AMD64') { return $true }
  if ($env:PROCESSOR_ARCHITECTURE -eq 'IA64') { return $true }
  return $false
}

function Get-LastLines {
  param([string]$Path, [int]$Count)
  if (-not (Test-Path $Path)) { return @() }
  $all = @(Get-Content $Path -ErrorAction SilentlyContinue)
  if ($all.Count -le $Count) { return $all }
  return $all[($all.Count - $Count)..($all.Count - 1)]
}

Write-Report ("DSH Desktop startup evidence - " + $stamp)
Write-Report ("host        : " + $env:COMPUTERNAME + "  " + [Environment]::OSVersion.VersionString + "  PowerShell " + $PSVersionTable.PSVersion.ToString())
if (Test-64BitHost) { Write-Report 'architecture: 64-bit Windows' } else { Write-Report 'architecture: 32-BIT WINDOWS (this product is x64 only and cannot start here)' }
Write-Report ''

function Find-InstallDir {
  $roots = @()
  if ($env:LOCALAPPDATA) { $roots += (Join-Path $env:LOCALAPPDATA 'Programs') }
  if ($env:ProgramFiles) { $roots += $env:ProgramFiles }
  if ($env:ProgramFiles -ne ${env:ProgramFiles(x86)}) { $roots += ${env:ProgramFiles(x86)} }
  foreach ($root in $roots) {
    if (-not (Test-Path $root)) { continue }
    foreach ($full in [System.IO.Directory]::GetDirectories($root)) {
      $name = [System.IO.Path]::GetFileName($full)
      if ($name -like '*DSH*') {
        foreach ($file in [System.IO.Directory]::GetFiles($full, '*.exe')) {
          $leaf = [System.IO.Path]::GetFileName($file)
          if ($leaf -notlike '*uninstall*' -and $leaf -notlike '*elevate*') { return $full }
        }
      }
    }
  }
  return ''
}

if ($InstallDir -eq '') { $InstallDir = Find-InstallDir }
Write-Report ("install dir : " + $InstallDir)
if ($InstallDir -eq '') {
  Write-Report 'RESULT: no installation found. Pass -InstallDir "C:\path\to\app" explicitly.'
  exit 2
}

$exe = ''
foreach ($file in [System.IO.Directory]::GetFiles($InstallDir, '*.exe')) {
  $leaf = [System.IO.Path]::GetFileName($file)
  if ($leaf -notlike '*uninstall*' -and $leaf -notlike '*elevate*') { $exe = $file; break }
}
if ($exe -eq '') {
  Write-Report 'RESULT: no executable in the install directory.'
  exit 2
}
Write-Report ("executable  : " + $exe)

$runtimeRoot = Join-Path $InstallDir 'resources\runtime\primary-runtime'
$nodeExe = Join-Path $runtimeRoot 'dependencies\node\bin\node.exe'
$versionFile = Join-Path $runtimeRoot 'runtime.json'
if (Test-Path $versionFile) { Write-Report ("runtime.json: " + (Get-Content $versionFile -Raw)) }
Write-Report ''

Write-Report 'payload self-check:'
Write-Report ("  node.exe present          : " + (Test-Path $nodeExe))
if (Test-Path $nodeExe) {
  $probeFile = Join-Path $work 'node-probe.txt'
  $probe = "process.stdout.write(JSON.stringify({version:process.version,arch:process.arch,platform:process.platform,electron:process.versions.electron||null,structuredClone:typeof structuredClone,toSorted:typeof [].toSorted,sqlite:typeof require('node:sqlite').DatabaseSync,zhCN:new Intl.DateTimeFormat('zh-CN').format(new Date(0))}))"
  $command = '"' + $nodeExe + '" -e "' + $probe + '" > "' + $probeFile + '" 2>&1'
  $null = cmd.exe /d /s /c $command
  if (Test-Path $probeFile) { Write-Report ("  node probe                : " + (Get-Content $probeFile -Raw).Trim()) }
} else {
  Write-Report '  node probe                : skipped (node.exe missing)'
}
$rg = Join-Path $InstallDir 'resources\app\node_modules\@vscode\ripgrep-win32-x64\bin\rg.exe'
if (Test-Path $rg) {
  $rgFile = Join-Path $work 'rg-version.txt'
  $command = '"' + $rg + '" --version > "' + $rgFile + '" 2>&1'
  $null = cmd.exe /d /s /c $command
  $rgLine = ''
  if (Test-Path $rgFile) { $rgLine = (@(Get-Content $rgFile))[0] }
  Write-Report ("  ripgrep version           : " + $rgLine)
} else {
  Write-Report '  ripgrep version           : skipped (rg.exe missing)'
}
foreach ($feed in 'resources\app-update.yml', 'latest.yml') {
  $feedPath = Join-Path $InstallDir $feed
  Write-Report ("  update feed " + $feed + " : " + (Test-Path $feedPath))
}
Write-Report ''

if (-not $SkipLaunch) {
  $stdout = Join-Path $work 'stdout.txt'
  $stderr = Join-Path $work 'stderr.txt'
  Write-Report ("starting the application, watching for " + $HoldSeconds + " seconds")
  $started = $false
  $process = $null
  $stderrLines = New-Object System.Collections.ArrayList
  $stdoutLines = New-Object System.Collections.ArrayList
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exe
    $psi.WorkingDirectory = $InstallDir
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    # A duplicate proxy variable in the environment makes the dictionary throw; the
    # fallback launch still produces the application's own logs.
    $null = $psi.EnvironmentVariables
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi
    $process.add_ErrorDataReceived({ param($sender, $event) if ($event.Data -ne $null) { $null = $stderrLines.Add($event.Data) } })
    $process.add_OutputDataReceived({ param($sender, $event) if ($event.Data -ne $null) { $null = $stdoutLines.Add($event.Data) } })
    $started = $process.Start()
    $process.BeginOutputReadLine()
    $process.BeginErrorReadLine()
  } catch {
    Write-Report ("  .NET launch failed (" + $_.Exception.Message + "); falling back to Start-Process")
    try {
      $process = Start-Process -FilePath $exe -WorkingDirectory $InstallDir -PassThru
      $started = $true
    } catch {
      Write-Report ("RESULT: the process could not be created: " + $_.Exception.Message)
      exit 1
    }
  }

  if ($started) {
    $observed = @()
    $elapsed = 0
    while ($elapsed -lt $HoldSeconds) {
      Start-Sleep -Seconds 10
      $elapsed = $elapsed + 10
      if ($process.HasExited) {
        $observed += ("t=" + $elapsed + "s: exited with code " + $process.ExitCode)
        break
      }
      $process.Refresh()
      $title = ''
      try { $title = $process.MainWindowTitle } catch { $title = '' }
      $observed += ("t=" + $elapsed + "s: running, window title='" + $title + "'")
    }
    foreach ($line in $observed) { Write-Report ("  " + $line) }

    if (-not $process.HasExited) {
      Write-Report '  still running at teardown; asking it to close'
      try { $null = $process.CloseMainWindow() } catch { }
      Start-Sleep -Seconds 5
      $process.Refresh()
      if (-not $process.HasExited) { try { $process.Kill() } catch { } }
    }
    Start-Sleep -Seconds 2
    if ($stdoutLines.Count -gt 0) { Set-Content -Path $stdout -Value $stdoutLines -Encoding UTF8 } else { Set-Content -Path $stdout -Value '' }
    if ($stderrLines.Count -gt 0) { Set-Content -Path $stderr -Value $stderrLines -Encoding UTF8 } else { Set-Content -Path $stderr -Value '' }
    Write-Report ''
    Write-Report 'what the application wrote to stderr:'
    if ($stderrLines.Count -eq 0) { Write-Report '  (nothing)' } else { foreach ($line in $stderrLines) { Write-Report ("  " + $line) } }
    Write-Report ''
  }
}

$userData = ''
foreach ($name in 'DSH Desktop Beta', 'DSH Desktop', 'dsh-plugin-desktop-beta', 'dsh-plugin-desktop') {
  $candidate = Join-Path $env:APPDATA $name
  if (Test-Path $candidate) { $userData = $candidate; break }
}
Write-Report ("user data   : " + $userData)
$copied = @()
if ($userData -ne '') {
  # Crashpad dumps are the only trace a native main-process abort leaves behind, and naming the
  # crashing module starts from them. Keep the reports themselves, not just the application's
  # own crash-evidence marker files.
  foreach ($name in 'logs', 'lifecycle-events', 'crash-evidence', 'diagnostics', 'state', 'Crashpad') {
    $source = Join-Path $userData $name
    if (Test-Path $source) {
      Copy-Item -Recurse -Force $source (Join-Path $work $name)
      $copied += $name
    }
  }
  foreach ($file in 'Local State', 'window-state.json') {
    $source = Join-Path $userData $file
    if (Test-Path $source) { Copy-Item -Force $source $work }
  }
}
Write-Report ("copied      : " + ($copied -join ', '))
if ($userData -ne '') {
  $dumpDir = Join-Path $userData 'Crashpad\reports'
  $dumps = @(Get-ChildItem $dumpDir -Filter '*.dmp' -ErrorAction SilentlyContinue)
  Write-Report ("crash dumps : " + $dumps.Count)
  foreach ($dump in $dumps) { Write-Report ("  " + $dump.Name + "  " + $dump.LastWriteTime) }
}
Write-Report ''

Write-Report 'last startup stages recorded by the application (newest last):'
if ($userData -ne '') {
  $lifecycle = Join-Path $userData 'lifecycle-events\startup.jsonl'
  if (Test-Path $lifecycle) {
    foreach ($line in (Get-LastLines -Path $lifecycle -Count 25)) { Write-Report ("  " + $line) }
  } else {
    Write-Report '  (no lifecycle events)'
  }

  Write-Report ''
  Write-Report 'application log (newest files, last 40 lines each):'
  $logDir = Join-Path $userData 'logs'
  if (Test-Path $logDir) {
    $logs = @(Get-ChildItem $logDir -Filter '*.log' | Sort-Object LastWriteTime -Descending | Select-Object -First 2)
    foreach ($log in $logs) {
      Write-Report ("  --- " + $log.Name + " ---")
      foreach ($line in (Get-LastLines -Path $log.FullName -Count 40)) { Write-Report ("  " + $line) }
    }
  }
}

$zip = $work + '.zip'
$zipped = $false
try {
  Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop
  if (Test-Path $zip) { Remove-Item $zip -Force }
  [System.IO.Compression.ZipFile]::CreateFromDirectory($work, $zip)
  $zipped = $true
} catch {
  $zipped = $false
}

Write-Report ''
if ($zipped) {
  Write-Report ("report: " + $zip)
  Write-Host ''
  Write-Host ("Send this file back: " + $zip) -ForegroundColor Cyan
} else {
  Write-Report ("report: " + $work)
  Write-Host ''
  Write-Host ("This machine cannot zip from PowerShell. Send the whole folder: " + $work) -ForegroundColor Yellow
  Write-Host 'Right-click the folder, Send To, Compressed (zipped) Folder.' -ForegroundColor Yellow
}
