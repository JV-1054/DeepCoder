@echo off
setlocal
title DeepCoder
rem Starts the bridge without a window. Use setup.cmd for the full setup.
set "PACKAGE=%~dp0.."
set "DEEPCODER_CONFIG=%PACKAGE%\config\deepcoder-config.json"
if not exist "%DEEPCODER_CONFIG%" (
  echo No config\deepcoder-config.json found in the package.
  echo Run setup.cmd first.
  pause
  exit /b 1
)
node "%PACKAGE%\deepcoder.cjs" --start-background
"%SystemRoot%\System32\timeout.exe" /t 2 /nobreak >nul
node "%PACKAGE%\deepcoder.cjs" --status
exit /b %ERRORLEVEL%
