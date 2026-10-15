@echo off
rem ---------------------------------------------------------------------------
rem Double-click this to test which V8 flags keep DSH Desktop alive on this machine.
rem
rem It runs the probe next to this file: the application is started once per candidate
rem flag combination, held for a few seconds, and reported as survived or crashed.
rem Nothing is installed, and no settings or data are changed.
rem
rem Takes about two minutes. Results land on the desktop as dsh-v8-probe-results.txt.
rem
rem To point at a different installation folder:
rem   run-probe-v8-flags.cmd -InstallDir "D:\DSH"
rem ---------------------------------------------------------------------------

setlocal
set "DSH_PROBE=%~dp0probe-v8-flags.ps1"

if not exist "%DSH_PROBE%" (
  echo Cannot find probe-v8-flags.ps1 next to this file.
  echo Keep both files in the same folder and run this again.
  pause
  exit /b 1
)

echo Probing V8 flag combinations. The application will open and close several times.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%DSH_PROBE%" %*

echo.
pause
