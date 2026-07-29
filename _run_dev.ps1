$env:PATH = 'C:\Users\Rick\.cargo\bin;' + $env:PATH
Set-Location 'C:\Users\Rick\Claude\Projects\China Truck Parts ERP\app'
npm run tauri dev 2>&1
