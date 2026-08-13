# Apply every migration in packages/db/migrations, in filename order.
#
#   .\scripts\migrate.ps1
#   .\scripts\migrate.ps1 -ConnectionString "postgresql://..."
#
# Uses MIGRATE_DATABASE_URL if set, otherwise DATABASE_URL. On Supabase those
# differ: migrations want the DIRECT connection on port 5432, because the
# transaction pooler on 6543 does not keep a session across statements and a
# multi-statement migration can end up half applied.
#
# Pure ASCII on purpose. Windows PowerShell 5.1 reads a UTF-8 file without a
# BOM as ANSI, and a stray em dash becomes an UnexpectedToken parse error.

[CmdletBinding()]
param(
  [string]$ConnectionString = $null,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dir  = Join-Path $root 'packages\db\migrations'

if (-not $ConnectionString) {
  $ConnectionString = $env:MIGRATE_DATABASE_URL
}
if (-not $ConnectionString) {
  $ConnectionString = $env:DATABASE_URL
}
if (-not $ConnectionString) {
  Write-Host ""
  Write-Host "No connection string." -ForegroundColor Red
  Write-Host "Set MIGRATE_DATABASE_URL or DATABASE_URL, or pass -ConnectionString."
  Write-Host ""
  Write-Host "  `$env:MIGRATE_DATABASE_URL = 'postgresql://postgres:PASSWORD@db.REF.supabase.co:5432/postgres?sslmode=require'"
  Write-Host ""
  exit 1
}

if ($ConnectionString -match ':6543/') {
  Write-Host ""
  Write-Host "WARNING: that looks like the Supabase transaction pooler (port 6543)." -ForegroundColor Yellow
  Write-Host "Migrations should use the direct connection on port 5432."
  Write-Host "Continuing anyway; stop with Ctrl+C if that was not deliberate."
  Write-Host ""
  Start-Sleep -Seconds 3
}

if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
  Write-Host ""
  Write-Host "psql is not on PATH." -ForegroundColor Red
  Write-Host "Install the PostgreSQL client tools:"
  Write-Host "  winget install PostgreSQL.PostgreSQL.16"
  Write-Host "then reopen the terminal."
  Write-Host ""
  exit 1
}

$files = Get-ChildItem -Path $dir -Filter '*.sql' | Sort-Object Name
if ($files.Count -eq 0) { Write-Host "No migrations found in $dir"; exit 1 }

# Redact the password before anything is printed.
$safe = $ConnectionString -replace '(://[^:]+:)[^@]+(@)', '$1********$2'
Write-Host ""
Write-Host "Target: $safe"
Write-Host "Found $($files.Count) migration(s)."
Write-Host ""

foreach ($f in $files) {
  Write-Host ("  -> " + $f.Name)
  if ($DryRun) { continue }
  # ON_ERROR_STOP makes psql exit non-zero on the first failure. Without it a
  # broken migration prints an error and psql still reports success, which is
  # how a half-applied schema reaches production.
  & psql $ConnectionString -v ON_ERROR_STOP=1 -q -f $f.FullName
  if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host ("FAILED on " + $f.Name) -ForegroundColor Red
    exit $LASTEXITCODE
  }
}

if ($DryRun) { Write-Host ""; Write-Host "Dry run: nothing applied."; exit 0 }

Write-Host ""
& psql $ConnectionString -c "SELECT version, applied_at FROM schema_version ORDER BY version;"
Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host ""
