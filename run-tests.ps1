npm run test:identity
Get-Process -Name node* -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $PID } | Stop-Process -Force
npm run test:integration
Get-Process -Name node* -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $PID } | Stop-Process -Force
npm run test:recovery
Get-Process -Name node* -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $PID } | Stop-Process -Force
npm run test:startup
Get-Process -Name node* -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $PID } | Stop-Process -Force
npm run build
