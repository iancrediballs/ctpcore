@echo off
REM ============================================================
REM  FleetView ERP - one-time prerequisites installer (Windows)
REM  Installs the Rust toolchain + the Microsoft C++ Build Tools
REM  needed to compile the Tauri backend. Uses winget.
REM  Run this ONCE, then close this window and run start-fleetview.bat
REM ============================================================
setlocal

where winget >nul 2>&1
if errorlevel 1 (
  echo  winget not found. Install "App Installer" from the Microsoft Store,
  echo  or install Rust manually from https://rustup.rs
  goto end
)

echo.
echo  [1/2] Installing Rust toolchain (rustup)...
winget install --id Rustlang.Rustup -e --accept-source-agreements --accept-package-agreements

echo.
echo  [2/2] Installing Microsoft C++ Build Tools (needed by Rust on Windows)...
echo        This is a large download - let it finish.
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --accept-source-agreements --accept-package-agreements --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

echo.
echo  ============================================================
echo   Done. IMPORTANT: close this window completely, open a NEW
echo   terminal, then run start-fleetview.bat
echo   (a fresh terminal is needed so 'cargo' is on your PATH)
echo  ============================================================
echo.

:end
pause
endlocal
