<#
  Probe V8 flag combinations against the Windows 7 startup abort.

  The shell now starts and shows its window, then dies 1-2 seconds later with exception
  0x80000003 inside v8::base::EmulatedVirtualAddressSubspace::FreePages — the fallback V8 uses on
  Windows when it cannot reserve the address space it wanted for its pointer-compression cage. That
  path's page accounting aborts the process, and the combination that avoids it cannot be found on a
  machine that does not reproduce it.

  This script tries each candidate on THIS machine: it starts the application with
  DSH_DESKTOP_V8_FLAGS set to one combination, waits, reports whether the process survived, closes
  it, and moves on. Nothing is installed or modified, and no flags change any stored data.

  Windows 7 ships Windows PowerShell 2.0, so this avoids every cmdlet that arrived later. It takes
  about two minutes for all combinations.

  Usage:
    run-probe-v8-flags.cmd                                  (double-click; finds the app itself)
    powershell -NoProfile -ExecutionPolicy Bypass -File probe-v8-flags.ps1 -InstallDir "D:\DSH"
#>

param(
  [string]$InstallDir = '',
  [int]$HoldSeconds = 14,
  [string]$OutFile = ''
)

$ErrorActionPreference = 'Continue'
if ($OutFile -eq '') { $OutFile = Join-Path ([Environment]::GetFolderPath('Desktop')) 'dsh-v8-probe-results.txt' }

function Find-InstallDir {
  foreach ($root in @((Join-Path $env:LOCALAPPDATA 'Programs'), $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if (-not $root -or -not (Test-Path $root)) { continue }
    foreach ($full in [System.IO.Directory]::GetDirectories($root)) {
      if ([System.IO.Path]::GetFileName($full) -notlike '*DSH*') { continue }
      foreach ($file in [System.IO.Directory]::GetFiles($full, '*.exe')) {
        $leaf = [System.IO.Path]::GetFileName($file)
        if ($leaf -like 'DSH Desktop*' -and $leaf -notlike '*uninstall*') { return $full }
      }
    }
  }
  return ''
}

function Find-Executable {
  param([string]$Directory)
  foreach ($file in [System.IO.Directory]::GetFiles($Directory, 'DSH Desktop*.exe')) {
    $leaf = [System.IO.Path]::GetFileName($file)
    if ($leaf -notlike '*uninstall*') { return $file }
  }
  return ''
}

if ($InstallDir -eq '') { $InstallDir = Find-InstallDir }
$exe = ''
if ($InstallDir -ne '') { $exe = Find-Executable -Directory $InstallDir }
if ($exe -eq '') {
  Write-Host 'Cannot find DSH Desktop. Pass -InstallDir "C:\path\to\folder".' -ForegroundColor Yellow
  exit 2
}

Write-Host ''
Write-Host "executable : $exe"
Write-Host "holding    : $HoldSeconds seconds per combination"
Write-Host "results    : $OutFile"
Write-Host ''

# The candidate flags. `--jitless` is the decisive one: if the abort comes from allocating and
# releasing JIT code space, disabling the JIT entirely is the only thing that will show it — and the
# shell is only a shell, because the Host runs the application logic in its own Node process, so the
# cost lands on window management rather than on the product's work.
$combos = @(
  @{ Label = 'jitless (decisive test)'; Flags = '--jitless' },
  @{ Label = 'jitless + wasm off'; Flags = '--jitless --no-expose-wasm' },
  @{ Label = 'no-opt'; Flags = '--no-opt' },
  @{ Label = 'no-opt + wasm off'; Flags = '--no-opt --no-expose-wasm' },
  @{ Label = 'wasm off + tiny heap'; Flags = '--no-expose-wasm --max-old-space-size=512 --max-semi-space-size=4' },
  @{ Label = 'no-incremental-marking + wasm off'; Flags = '--no-incremental-marking --no-expose-wasm' },
  @{ Label = 'single-threaded'; Flags = '--single-threaded' },
  @{ Label = 'default'; Flags = '' }
)

$lines = @()
$lines += "DSH Desktop V8 flag probe"
$lines += "executable: $exe"
$lines += "hold: ${HoldSeconds}s per combination"
$lines += ""

$winner = ''

foreach ($combo in $combos) {
  Get-Process -Name 'DSH Desktop Beta' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  if ($combo.Flags -eq '') { Remove-Item Env:\DSH_DESKTOP_V8_FLAGS -ErrorAction SilentlyContinue }
  else { $env:DSH_DESKTOP_V8_FLAGS = $combo.Flags }

  Write-Host ("=== " + $combo.Label + " ===") -ForegroundColor Cyan
  if ($combo.Flags -ne '') { Write-Host ("    flags: " + $combo.Flags) }
  Start-Process -FilePath $exe | Out-Null
  Start-Sleep -Seconds $HoldSeconds

  $alive = @(Get-Process -Name 'DSH Desktop Beta' -ErrorAction SilentlyContinue).Count
  if ($alive -gt 0) {
    $titles = @()
    foreach ($process in (Get-Process -Name 'DSH Desktop Beta' -ErrorAction SilentlyContinue)) {
      if ($process.MainWindowTitle -ne '') { $titles += $process.MainWindowTitle }
    }
    $titleText = if ($titles.Count -gt 0) { $titles -join ', ' } else { '(no titled window)' }
    Write-Host ("    SURVIVED ${HoldSeconds}s   window: " + $titleText) -ForegroundColor Green
    $lines += ($combo.Label + ": SURVIVED " + $HoldSeconds + "s   window: " + $titleText)
    if ($combo.Flags -ne '' -and $winner -eq '') { $winner = $combo.Flags }
  } else {
    Write-Host ("    CRASHED within " + $HoldSeconds + "s") -ForegroundColor Red
    $lines += ($combo.Label + ": CRASHED within " + $HoldSeconds + "s")
  }
  Get-Process -Name 'DSH Desktop Beta' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}

Remove-Item Env:\DSH_DESKTOP_V8_FLAGS -ErrorAction SilentlyContinue

$lines += ""
if ($winner -ne '') { $lines += "WINNER: $winner" } else { $lines += "WINNER: none survived" }

Set-Content -Path $OutFile -Value $lines -Encoding UTF8

Write-Host ''
if ($winner -ne '') {
  Write-Host ("A surviving combination: " + $winner) -ForegroundColor Green
} else {
  Write-Host 'None of the candidates survived. Send the results anyway - the pattern still narrows it down.' -ForegroundColor Yellow
}
Write-Host "Results written to: $OutFile"
Write-Host 'Send that file back.'
