try { $v = (& python --version) 2>&1; Write-Output ("PYTHON: " + $v) } catch { Write-Output "PYTHON_NONE" }
$db = Join-Path $env:APPDATA 'net.chinatruckparts.fleetview\fleetview.db'
if (Test-Path $db) {
  Write-Output ("DB_FOUND " + [int]((Get-Item $db).Length/1024) + "KB at " + $db)
  Get-ChildItem (Split-Path $db) | ForEach-Object { Write-Output ("  " + $_.Name + " " + $_.Length + "B") }
} else { Write-Output ("DB_MISSING at " + $db) }
