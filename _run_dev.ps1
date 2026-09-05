# Start the desktop app in dev mode from anywhere.
#
# Rewritten 2026-09-05: this previously hardcoded C:\Users\Rick\... — the user
# and the project path on the machine this was built on. Both are wrong now and
# the script failed on its first line. Everything below resolves at runtime.

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot 'app')

# Rust may live in the default profile or in the D: install used on this box.
foreach ($c in @("$env:USERPROFILE\.cargo\bin", 'D:\ctpbuild\cargo\bin')) {
  if ((Test-Path (Join-Path $c 'cargo.exe')) -and ($env:PATH -notlike "*$c*")) {
    $env:PATH = "$c;$env:PATH"
  }
}
if (Test-Path 'D:\ctpbuild\cargo')  { $env:CARGO_HOME  = 'D:\ctpbuild\cargo' }
if (Test-Path 'D:\ctpbuild\rustup') { $env:RUSTUP_HOME = 'D:\ctpbuild\rustup' }

# This machine has NODE_ENV=production set system-wide, which makes npm skip
# devDependencies — so vite and tsc never install and the build dies claiming
# they are missing. Force development for this process only.
$env:NODE_ENV = 'development'

if (-not (Test-Path 'node_modules\vite')) {
  Write-Host 'Installing dependencies (including dev)...'
  npm install --include=dev --no-audit --no-fund
}

npm run tauri dev 2>&1
