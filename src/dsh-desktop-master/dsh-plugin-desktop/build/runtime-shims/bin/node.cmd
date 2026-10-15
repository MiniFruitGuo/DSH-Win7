@echo off
setlocal DisableDelayedExpansion
"%~dp0..\primary-runtime\dependencies\node\bin\node.exe" %*
exit /b %errorlevel%
