@echo off
setlocal
title CTP Core - finish the pricing reset
cd /d "%~dp0"

echo.
echo   CTP Core - pricing reset (migration 0013)
echo   ------------------------------------------------------------
echo   This checks the Rust compiles, then commits. It will NOT
echo   commit if the check fails.
echo.

where cargo >nul 2>nul
if errorlevel 1 (
  echo   [X] cargo is not on PATH. Open a new terminal, or run:
  echo       "%USERPROFILE%\.cargo\bin\cargo" check --manifest-path app\src-tauri\Cargo.toml
  goto :done
)

echo   [1/3] cargo check  ^(first run pulls crates, can take a few minutes^)
echo.
cargo check --manifest-path app\src-tauri\Cargo.toml
if errorlevel 1 (
  echo.
  echo   ------------------------------------------------------------
  echo   [X] The Rust did NOT compile. Nothing has been committed.
  echo.
  echo   Copy the first error above and send it to Claude. The only
  echo   hand-edited Rust is snapshot_price^(^) and the init_db block
  echo   near the top of app\src-tauri\src\main.rs, so it will be one
  echo   of those. To undo just that file:
  echo       git checkout -- app/src-tauri/src/main.rs
  goto :done
)

echo.
echo   [2/3] committing
git add app/src app/src-tauri
if not exist ".git\COMMIT_MSG_0013.txt" (
  echo   [X] .git\COMMIT_MSG_0013.txt is missing - commit by hand.
  goto :done
)
git commit -F .git\COMMIT_MSG_0013.txt
if errorlevel 1 (
  echo   [X] Commit failed. If it mentions index.lock, delete
  echo       .git\index.lock and run this again.
  goto :done
)

echo.
echo   [3/3] done
git --no-pager log --oneline -4
echo.
echo   ------------------------------------------------------------
echo   Now launch the app. Migration 0013 applies on first start.
echo   Then check the prices are right:
echo     - Front Bumper L/H        should read R6,360.62
echo     - Front Bumper L/H Spoiler should read R1,074.67
echo   46 parts will show no price. That is deliberate - they are
echo   waiting on sign-off, see CTP_Proposed_Prices_44.xlsx.
echo.
echo   There is also app\src-tauri\migrations\0013_verify.sql if you
echo   want to check the database directly.

:done
echo.
pause
endlocal
