@echo off
setlocal
title PC Bridge - install extension
cd /d "%~dp0"

echo.
echo   Opening Chrome's extensions page and the extension folder.
echo.
echo   1. Turn ON "Developer mode" (top-right of the extensions page)
echo   2. Click "Load unpacked"
echo   3. Choose this folder:  %~dp0extension
echo.

start "" chrome "chrome://extensions"
timeout /t 1 >nul
explorer "%~dp0extension"
