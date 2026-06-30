@echo off
REM ===========================================================================
REM  Pairwise Audio Ranker - start script for Windows.
REM  Launches the local server and opens the app in your default browser.
REM ===========================================================================

setlocal

REM Run from the folder this script lives in, no matter where it's called from.
cd /d "%~dp0"

REM Port the server listens on (must match server.js default / PORT env var).
if "%PORT%"=="" set PORT=4000

REM Make sure Node.js is installed and on the PATH.
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  ERROR: Node.js was not found on your PATH.
  echo  Install it from https://nodejs.org/ ^(version 18 or newer^) and try again.
  echo.
  pause
  exit /b 1
)

echo.
echo  Starting Pairwise Audio Ranker on http://localhost:%PORT%
echo  A separate window will show the server log; close it to stop the app.
echo.

REM Start the server in its own window so its log stays visible.
start "Pairwise Audio Ranker" cmd /k "node server.js"

REM Give the server a moment to come up, then open the app in the browser.
timeout /t 2 /nobreak >nul
start "" "http://localhost:%PORT%"

endlocal
