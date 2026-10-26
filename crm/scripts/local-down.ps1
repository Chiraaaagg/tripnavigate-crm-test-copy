# Stops the CRM dev server (port 3000) and the local Supabase stack. Data is kept
# (Supabase keeps its Docker volume). Usage (from crm/):  npm run local:down
$ErrorActionPreference = 'Continue'
Set-Location (Split-Path -Parent $PSScriptRoot)

$listening = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
foreach ($c in $listening) {
  Write-Host "local:down  stopping the dev server (process $($c.OwningProcess))"
  Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
}
Write-Host 'local:down  stopping Supabase (data is kept)...'
cmd /c "supabase stop >nul 2>&1"
Write-Host 'local:down  done. Start again with: npm run local:up'
