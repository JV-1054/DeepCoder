@echo off
setlocal
title DeepCoder
set "PACKAGE=%~dp0.."
set "DEEPCODER_CONFIG=%PACKAGE%\config\deepcoder-config.json"
if not exist "%DEEPCODER_CONFIG%" (
  echo No config\deepcoder-config.json found in the package.
  echo Run setup.cmd first.
  pause
  exit /b 1
)
node "%PACKAGE%\deepcoder.cjs"
pause
exit /b %ERRORLEVEL%
