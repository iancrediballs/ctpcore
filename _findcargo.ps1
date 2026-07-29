$ErrorActionPreference = 'SilentlyContinue'
$paths = (([Environment]::GetEnvironmentVariable('Path','User')) + ';' + ([Environment]::GetEnvironmentVariable('Path','Machine'))) -split ';'
$hit = $paths | Where-Object { $_ -like '*cargo*' -or $_ -like '*rust*' }
if ($hit) { Write-Output 'PATH_ENTRIES:'; $hit | ForEach-Object { Write-Output ('  ' + $_) } } else { Write-Output 'NO_CARGO_IN_PATH_ENV' }

$cands = @(
  "$env:USERPROFILE\.cargo\bin\cargo.exe",
  "$env:CARGO_HOME\bin\cargo.exe",
  "$env:LOCALAPPDATA\.cargo\bin\cargo.exe",
  "C:\Users\Rick\.rustup\toolchains\stable-x86_64-pc-windows-msvc\bin\cargo.exe"
)
Write-Output 'CANDIDATES:'
foreach ($c in $cands) { if (Test-Path $c) { Write-Output ('  FOUND ' + $c) } }

# bounded search
$found = Get-ChildItem -Path 'C:\Users\Rick' -Filter cargo.exe -Recurse -Depth 4 -ErrorAction SilentlyContinue | Select-Object -First 3
if ($found) { Write-Output 'FS_SEARCH:'; $found | ForEach-Object { Write-Output ('  ' + $_.FullName) } } else { Write-Output 'FS_SEARCH_NONE' }
