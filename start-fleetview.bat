@echo off
REM ============================================================
REM  CTP Core - desktop app dev launcher
REM  Double-click to start the desktop app with hot reload.
REM ============================================================
setlocal
cd /d "%~dp0app"

echo.
echo  CTP Core - starting desktop build...
echo  (the first run compiles the Rust backend - allow 10-20 minutes)
echo.

REM --- Rust toolchain -----------------------------------------------------
REM On this machine Rust was installed to D: because C: was short on space.
REM Pick it up automatically so nothing has to be on the system PATH.
if exist "D:\ctpbuild\cargo\bin\cargo.exe" (
  set "CARGO_HOME=D:\ctpbuild\cargo"
  set "RUSTUP_HOME=D:\ctpbuild\rustup"
  set "PATH=D:\ctpbuild\cargo\bin;%PATH%"
)

REM --- npm dev dependencies ----------------------------------------------
REM This machine has NODE_ENV=production set system-wide. npm honours that by
REM skipping devDependencies, so vite and typescript never install and the
REM build fails claiming they are missing. Override it for this window only.
set "NODE_ENV=development"

if not exist "node_modules\vite" (
  echo  Installing dependencies for the first time...
  call npm install --include=dev --no-audit --no-fund
  if errorlevel 1 goto error
)

REM --- catalogue images ---------------------------------------------------
REM The 116 MB of part photos and diagrams are not in the repo; they live in
REM the Supabase bucket. Pull them once, or every part shows a broken image.
if not exist "public\assets\photos" (
  echo  Fetching catalogue images from the cloud ^(about 116 MB, one time^)...
  call node "..\tools\pull_assets.mjs"
)

where rustup >nul 2>&1
if not errorlevel 1 rustup default stable >nul 2>&1

call npm run tauri dev
if errorlevel 1 goto error
goto end

:error
echo.
echo  ============================================================
echo   Something went wrong. Common causes:
echo     - Rust not installed          ^(https://rustup.rs^)
echo     - MS C++ Build Tools missing  ^(run INSTALL BUILD TOOLS.bat^)
echo     - WebView2 runtime missing
echo   See https://tauri.app/start/prerequisites/
echo  ============================================================
echo.

:end
pause
endlocal
