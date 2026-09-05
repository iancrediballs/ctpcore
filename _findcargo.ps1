# Locate a usable cargo.exe on this machine. Diagnostic only — prints, changes nothing.
# Rewritten 2026-09-05: the old version searched C:\Users\Rick, a user that does
# not exist here.

$ErrorActionPreference = 'SilentlyContinue'

$paths = (([Environment]::GetEnvironmentVariable('Path','User')) + ';' +
          ([Environment]::GetEnvironmentVariable('Path','Machine'))) -split ';'
$hit = $paths | Where-Object { $_ -like '*cargo*' -or $_ -like '*rust*' }
if ($hit) { Write-Output 'PATH_ENTRIES:'; $hit | ForEach-Object { Write-Output ('  ' + $_) } }
else      { Write-Output 'NO_CARGO_IN_PATH_ENV' }

$cands = @(
  "$env:USERPROFILE\.cargo\bin\cargo.exe",
  "$env:CARGO_HOME\bin\cargo.exe",
  "$env:LOCALAPPDATA\.cargo\bin\cargo.exe",
  'D:\ctpbuild\cargo\bin\cargo.exe'
)
Write-Output 'CANDIDATES:'
foreach ($c in $cands) { if (Test-Path $c) { Write-Output ('  FOUND ' + $c) } }

Write-Output 'LINKER:'
$link = Get-ChildItem -Path 'D:\ctpbuild\BuildTools','C:\Program Files (x86)\Microsoft Visual Studio' `
        -Filter link.exe -Recurse -Depth 6 -ErrorAction SilentlyContinue | Select-Object -First 1
if ($link) { Write-Output ('  FOUND ' + $link.FullName) } else { Write-Output '  NO_MSVC_LINKER' }
