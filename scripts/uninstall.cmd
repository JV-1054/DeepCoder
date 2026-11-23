@echo off
setlocal
title DeepCoder - Uninstall

rem Removes the boot task and the sign-in entry. The bridge keeps running
rem until it is stopped, because the bridge never stops another process.

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" >nul 2>&1
if errorlevel 1 (
  echo   Node.js 22 or newer must be installed and available on PATH.
  pause
  exit /b 1
)

node "%~dp0..\deepcoder.cjs" --uninstall-startup
echo.
echo   The harness route is left in place. Remove it by hand from:
echo     %USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml
echo   (delete the "deepcoder:" provider block).
echo.
pause
exit /b 0
