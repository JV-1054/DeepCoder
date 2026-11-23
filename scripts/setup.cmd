@echo off
setlocal
title DeepCoder - Setup

echo.
echo   DeepCoder 1.0.3 - local gateway for the DeepSeek Harness
echo   ---------------------------------------------------
echo.
echo   This sets everything up: the configuration, the harness route, the
echo   autostart and the bridge itself. It can be run again at any time.
echo.

rem --- Node.js -------------------------------------------------------------
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" >nul 2>&1
if errorlevel 1 (
  echo   Node.js 22 or newer must be installed and available on PATH.
  echo   Install Node.js from https://nodejs.org/ and reopen this launcher.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do set "NODE_VERSION=%%v"
echo   Node.js      %NODE_VERSION%
for /f "delims=" %%v in ('node -p "process.execPath"') do set "NODE_PATH=%%v"
echo   Node path    %NODE_PATH%
echo.

if not exist "%~dp0..\deepcoder.cjs" goto incomplete
set "PACKAGE=%~dp0.."
set "DEEPCODER_CONFIG=%PACKAGE%\config\deepcoder-config.json"

rem --- The provider key ----------------------------------------------------
rem The key is typed with the echo off, so it never appears on the screen and
rem it does not stay in the scrollback of the console. It is handed over to
rem node through a pipe, so it is not on a command line either.
if defined AGENTROUTER_API_KEY (
  echo   A key is already set for this user: %AGENTROUTER_API_KEY:~0,7%...
  echo   Press Enter to keep it, or paste a new key to replace it.
) else (
  echo   The key is stored in your Windows user environment, never in this package.
)
powershell -NoProfile -Command "if ([Console]::IsInputRedirected) { $v=[Console]::ReadLine() } else { $p=Read-Host '   Paste the provider key (Enter to skip)' -AsSecureString; $b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($p); $v=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) }; Write-Output $v" | node "%PACKAGE%\deepcoder.cjs" --set-key
rem The bridge that is started below inherits the key from this session.
for /f "tokens=2,* delims= " %%a in ('reg query HKCU\Environment /v AGENTROUTER_API_KEY 2^>nul') do set "AGENTROUTER_API_KEY=%%b"
echo.

rem --- Everything else ------------------------------------------------------
node "%PACKAGE%\deepcoder.cjs" --setup
if errorlevel 1 (
  echo.
  echo   The setup reported a problem. The lines above say what to fix.
  echo   Running it again is safe.
  pause
  exit /b 1
)

echo   Next steps
echo   -----------
echo   1. Close the DeepSeek Harness completely and start it again.
echo   2. Open Settings ^> Models and pick "DeepCoder".
echo   3. Restart Windows once to see the bridge come up by itself.
echo.
echo   The bridge runs without a window. To remove the autostarts, run uninstall.cmd.
echo.
pause
exit /b 0

:incomplete
echo   Incomplete package. Use Extract All on the ZIP before running setup.cmd.
pause
exit /b 1
