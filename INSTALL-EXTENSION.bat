@echo off
setlocal
title PC Bridge - install extension
cd /d "%~dp0"

echo.
echo   Opening the extension page and the extension folder.
echo.
echo   In the page that opens:
echo     1. Turn ON "Developer mode"
echo     2. Click "Load unpacked"
echo     3. Choose this folder:  %~dp0extension
echo.
echo   Other Chromium browsers: use their own extensions page
echo   (brave://extensions, opera://extensions, vivaldi://extensions).
echo.

where chrome >nul 2>nul
if not errorlevel 1 (
  start "" chrome "chrome://extensions"
) else (
  where msedge >nul 2>nul
  if not errorlevel 1 (
    start "" msedge "edge://extensions"
  ) else (
    echo   Chrome/Edge not found. Open your browser's extensions page manually.
  )
)
timeout /t 1 >nul
explorer "%~dp0extension"
