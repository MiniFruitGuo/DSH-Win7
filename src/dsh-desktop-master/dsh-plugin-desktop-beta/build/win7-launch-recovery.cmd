@echo off
setlocal
rem ---------------------------------------------------------------------------
rem DSH Desktop launch wrapper.
rem
rem The shell can abort natively during startup on Windows 7: V8's emulated virtual
rem address subspace fails a page-accounting assertion and raises 0x80000003, which
rem Windows reports as exit code -2147483645. Nothing is logged, no window appears, and
rem a plain shortcut looks broken. Because the trigger is an address-space layout that
rem differs between runs, a bounded retry turns a dead shortcut into a slightly slower
rem start.
rem
rem Set DSH_DESKTOP_RECOVERY_ATTEMPTS to change the retry limit (default 3).
rem ---------------------------------------------------------------------------

set "DSH_ATTEMPTS=3"
if not "%DSH_DESKTOP_RECOVERY_ATTEMPTS%"=="" set "DSH_ATTEMPTS=%DSH_DESKTOP_RECOVERY_ATTEMPTS%"

rem The executable name carries the channel (Beta or Stable), so locate it rather than hard-coding
rem it: the same wrapper ships in both editions and has to stay byte-identical between them.
rem `DSH Desktop*.exe` matches only the shell, never `Uninstall DSH Desktop ....exe` or `elevate.exe`,
rem because the pattern is prefix-anchored.
set "DSH_EXE="
for /f "delims=" %%F in ('dir /b /a-d "%~dp0DSH Desktop*.exe" 2^>nul') do set "DSH_EXE=%~dp0%%F"

if not defined DSH_EXE (
  echo DSH Desktop: cannot find the application next to this launcher.
  pause
  exit /b 1
)

set /a DSH_TRY=0

:ds_retry
set /a DSH_TRY+=1
"%DSH_EXE%" %*
set DSH_CODE=%ERRORLEVEL%

rem A user-quit or a clean shutdown: nothing to recover from.
if "%DSH_CODE%"=="0" exit /b 0

rem Retry only on the abort codes a fresh attempt can plausibly survive:
rem   0x80000003 breakpoint       -> -2147483645
rem   0xC0000005 access violation -> -1073741819
rem   0xC0000409 stack overrun    -> -1073740791
rem   0xC0000374 heap corruption  -> -1073740940
set DSH_RETRYABLE=0
if "%DSH_CODE%"=="-2147483645" set DSH_RETRYABLE=1
if "%DSH_CODE%"=="-1073741819" set DSH_RETRYABLE=1
if "%DSH_CODE%"=="-1073740791" set DSH_RETRYABLE=1
if "%DSH_CODE%"=="-1073740940" set DSH_RETRYABLE=1
if "%DSH_RETRYABLE%"=="0" exit /b %DSH_CODE%

if %DSH_TRY% GEQ %DSH_ATTEMPTS% (
  echo.
  echo DSH Desktop stopped while starting, after %DSH_TRY% attempts ^(exit code %DSH_CODE%^).
  echo The system may be missing a Windows 7 update this build needs. They are in
  echo   "%~dp0resources\win7-prerequisites"
  echo Run the crash-evidence collector and report the exit code above.
  pause
  exit /b %DSH_CODE%
)

echo DSH Desktop stopped while starting ^(exit code %DSH_CODE%^); retrying, attempt %DSH_TRY% of %DSH_ATTEMPTS%...
rem Win7's timeout refuses to run when stdin is redirected, so poll with ping instead.
ping -n 3 127.0.0.1 >nul 2>&1
goto ds_retry
