@echo off
setlocal
title DeepCoder - Check configuration
set "PACKAGE=%~dp0.."
set "DEEPCODER_CONFIG=%PACKAGE%\config\deepcoder-config.json"
if not exist "%DEEPCODER_CONFIG%" (
  echo No config\deepcoder-config.json found in the package.
  echo The built-in defaults will be checked instead.
  echo.
)
node "%PACKAGE%\deepcoder.cjs" --check-config
echo.
pause
exit /b %ERRORLEVEL%
