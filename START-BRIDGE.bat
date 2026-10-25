@echo off
setlocal
title PC Bridge Server
cd /d "%~dp0server"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found on this PC.
  echo   Install it from https://nodejs.org  ^(LTS version^), then run this again.
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting PC Bridge...
echo.
node server.js --open

echo.
echo   The bridge server has stopped.
echo   Close this window when you are done reading any errors.
echo.
pause
