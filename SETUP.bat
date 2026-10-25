@echo off
setlocal
title PC Bridge - first-time setup
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js 20 or newer is required.
  echo   Opening https://nodejs.org/ - install the LTS version,
  echo   then run SETUP.bat again.
  echo.
  start "" "https://nodejs.org/"
  pause
  exit /b 1
)

echo.
echo   [1/3] Starting the local bridge server...
start "PC Bridge Server" "%~dp0START-BRIDGE.bat"
timeout /t 2 >nul

echo   [2/3] Opening the browser's extension page...
where chrome >nul 2>nul
if not errorlevel 1 (
  start "" chrome "chrome://extensions"
) else (
  where msedge >nul 2>nul
  if not errorlevel 1 (
    start "" msedge "edge://extensions"
  ) else (
    echo         Chrome/Edge not found. Open chrome://extensions manually.
  )
)
timeout /t 1 >nul

echo   [3/3] Opening the extension folder...
explorer "%~dp0extension"

echo.
echo   Finish in the extension page:
echo     1. Turn ON "Developer mode" (top right)
echo     2. Click "Load unpacked"
echo     3. Select the "extension" folder that just opened
echo     4. Open your AI chat, click the bridge bubble,
echo        paste the token from the dashboard, and press Connect
echo.
pause
