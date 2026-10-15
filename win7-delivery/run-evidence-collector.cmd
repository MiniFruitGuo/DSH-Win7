@echo off
rem ---------------------------------------------------------------------------
rem Double-click this to collect DSH Desktop startup evidence on a test machine.
rem
rem It runs the PowerShell collector next to this file, which starts the application
rem once with stdout/stderr captured, watches the window, then packs the application
rem logs, lifecycle events and Crashpad dumps into one zip on the desktop.
rem
rem Optional arguments pass straight through, for example:
rem   run-evidence-collector.cmd -InstallDir "D:\DSH"
rem   run-evidence-collector.cmd -HoldSeconds 120
rem   run-evidence-collector.cmd -SkipLaunch
rem ---------------------------------------------------------------------------

setlocal
set "DSH_SCRIPT=%~dp0collect-desktop-startup-evidence.ps1"

if not exist "%DSH_SCRIPT%" (
  echo Cannot find collect-desktop-startup-evidence.ps1 next to this file.
  echo Keep both files in the same folder and run this again.
  pause
  exit /b 1
)

echo Collecting DSH Desktop startup evidence. This starts the application once.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%DSH_SCRIPT%" %*

echo.
echo Finished. Send the dsh-desktop-evidence-*.zip file from the desktop back to the developer.
echo The important part inside it is Crashpad\reports\*.dmp.
pause
