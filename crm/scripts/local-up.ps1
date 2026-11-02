# Starts the whole local stack: Supabase (Docker), the CRM dev server and checks
# the Bitrix auto-sync cron. Usage (from crm/):  npm run local:up
# Safe to run again: anything already running is left as it is.
# 'Continue': native tools (supabase, docker) write warnings to stderr, which
# Windows PowerShell 5.1 would otherwise turn into terminating errors.
$ErrorActionPreference = 'Continue'
Set-Location (Split-Path -Parent $PSScriptRoot)

function Say($text) { Write-Host "local:up  $text" }

# 1. Docker Desktop
cmd /c "docker info >nul 2>&1"
if ($LASTEXITCODE -ne 0) {
  Say 'Docker is not running. Starting Docker Desktop...'
  $docker = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
  if (Test-Path $docker) { Start-Process $docker } else { throw 'Docker Desktop is not installed.' }
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 3
    cmd /c "docker info >nul 2>&1"
    if ($LASTEXITCODE -eq 0) { break }
  }
  if ($LASTEXITCODE -ne 0) { throw 'Docker did not start within 3 minutes.' }
}
Say 'Docker is running.'

# 2. Supabase (starting an already running stack is a no-op)
Say 'Starting Supabase (first start can take a few minutes)...'
cmd /c "supabase start >nul 2>&1"
for ($i = 0; $i -lt 60; $i++) {
  try {
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 'http://127.0.0.1:54321/auth/v1/health' *> $null
    break
  } catch { Start-Sleep -Seconds 2 }
}
Say 'Supabase is up: API http://127.0.0.1:54321, Studio http://127.0.0.1:54323, Mailpit http://127.0.0.1:54324'

# 3. CRM dev server on port 3000 (own window, so its log stays visible)
# The scheduler reaches the CRM through host.docker.internal:3000, which arrives
# on this PC's loopback: ANY other server on 127.0.0.1:3000 answers instead of
# `next dev` (5 Oct 2026: a leftover `next start` refused every call with 401).
# A leftover `next start` from this project is stopped; anything else stops here.
function Get-NextKind($procId) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
  if (-not $p) { return 'gone' }
  $lines = @($p.CommandLine)
  $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" -ErrorAction SilentlyContinue
  if ($parent) { $lines += $parent.CommandLine }
  $text = ($lines -join ' ')
  if ($text -notmatch [regex]::Escape($PWD.Path)) { return 'foreign' }
  if ($text -match 'next["\s]+start') { return 'start' }
  if ($text -match 'next["\s]+dev' -or $text -match 'start-server\.js') { return 'dev' }
  return 'foreign'
}
foreach ($l in @(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)) {
  $kind = Get-NextKind $l.OwningProcess
  if ($kind -eq 'start') {
    Say "Stopping a leftover 'next start' (PID $($l.OwningProcess)) that holds port 3000 instead of the dev server."
    Stop-Process -Id $l.OwningProcess -Force -ErrorAction SilentlyContinue
  } elseif ($kind -eq 'foreign') {
    throw "Port 3000 is used by another program (PID $($l.OwningProcess), $($l.LocalAddress)). The automatic sync would reach that program instead of the CRM. Stop it, then run npm run local:up again."
  }
}
Start-Sleep -Seconds 1
$listening = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
  Say 'Starting the CRM dev server in a new window...'
  Start-Process powershell -ArgumentList '-NoExit', '-Command', "Set-Location '$PWD'; npm run dev"
}
for ($i = 0; $i -lt 90; $i++) {
  try {
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 'http://127.0.0.1:3000/sign-in' *> $null
    break
  } catch { Start-Sleep -Seconds 2 }
}
Say 'CRM is up: http://127.0.0.1:3000'

# 4. Bitrix auto-sync (pg_cron inside Supabase calls the CRM every 30 s):
# re-create / re-activate the cron job, check the Vault URL and secret against
# .env.local, then wait for one successful scheduled call and show the last 5.
node scripts/local-sync-doctor.mjs --wait 75
if ($LASTEXITCODE -ne 0) { Say 'Automatic sync needs attention (see above, and http://127.0.0.1:3000/app/admin/integration).' }
Say 'Done.'
