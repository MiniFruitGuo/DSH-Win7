@echo off
setlocal DisableDelayedExpansion
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\..\..\DSH Desktop Beta.exe" --expose-internals "%~dp0..\..\app\lib\desktop-cli.js" %*
exit /b %errorlevel%
