@echo off
REM ============================================================
REM  FleetView ERP - dev launcher
REM  Double-click this file (or run it in a terminal) to start
REM  the desktop app with hot reload.
REM ============================================================
setlocal
cd /d "%~dp0app"

echo.
echo  FleetView ERP - starting dev build...
echo  (first run compiles the Rust backend - this can take a few minutes)
echo.

REM install JS deps only if they're missing
if not exist "node_modules" (
  echo  Installing dependencies for the first time...
  call npm install
  if errorlevel 1 goto error
)

REM make sure Rust has a default toolchain selected (first-run safeguard).
REM Harmless/instant if one is already set; downloads stable if not.
where rustup >nul 2>&1
if not errorlevel 1 (
  rustup default stable
)

call npm run tauri dev
if errorlevel 1 goto error

goto end

:error
echo.
echo  ============================================================
echo   Something went wrong. Common causes:
echo     - Rust not installed        ^(https://rustup.rs^)
echo     - MS C++ Build Tools missing
echo     - WebView2 runtime missing
echo   See https://tauri.app/start/prerequisites/
echo  ============================================================
echo.

:end
pause
endlocal
