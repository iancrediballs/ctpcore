@echo off
REM ============================================================
REM  CTP Core ERP - Git setup & snapshot helper
REM  Double-click to save a versioned snapshot of your work.
REM  Safe to run again anytime - each run commits your latest changes.
REM ============================================================
setlocal
cd /d "%~dp0"

REM --- make sure git is installed ---
where git >nul 2>&1
if errorlevel 1 (
  echo.
  echo  Git is not installed. Download it from:
  echo     https://git-scm.com/download/win
  echo  Then run this again.
  echo.
  goto end
)

REM --- set your identity globally the first time (only if missing) ---
git config --global user.email >nul 2>&1 || git config --global user.email "iancrediblemusic@gmail.com"
git config --global user.name  >nul 2>&1 || git config --global user.name  "Ian"

REM --- initialise the repo on first run ---
if not exist ".git" (
  echo  First run - creating the repository...
  git init
  git branch -M main
)

REM --- stage everything (.gitignore keeps out node_modules, build output, scratch) ---
git add -A

REM --- commit with a timestamp ---
git commit -m "Snapshot %DATE% %TIME%"
if errorlevel 1 (
  echo.
  echo  Nothing new to commit - your work is already saved.
) else (
  echo.
  echo  ============================================================
  echo   Snapshot saved. Your work is protected in git.
  echo   To see history:   git log --oneline
  echo   To undo a file:   git checkout -- ^<file^>
  echo  ============================================================
)

echo.
echo  OFFSITE BACKUP (recommended, one-time):
echo    1. Create a PRIVATE repo on github.com (do not initialise it)
echo    2. Run these two lines here:
echo         git remote add origin https://github.com/YOURNAME/ctp-core.git
echo         git push -u origin main
echo    After that, just run:  git push   (or re-run this file, then push)
echo.

:end
pause
endlocal
