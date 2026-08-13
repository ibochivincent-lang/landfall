# Deploy the Landfall oracle. Windows PowerShell port of deploy-contract.sh.
#
#   .\scripts\deploy-contract.ps1                    # local Quickstart
#   .\scripts\deploy-contract.ps1 -Network testnet   # public testnet
#   .\scripts\deploy-contract.ps1 -Network mainnet   # you had better mean it
#
#   .\scripts\deploy-contract.ps1 -Network testnet -Preflight
#       Check the toolchain and stop. Run this first - the two installs it
#       checks for take about fifteen minutes between them, and finding that
#       out after a successful build is a waste of your afternoon.
#
# Writes the contract id to .contract-id and appends ORACLE_CONTRACT_ID to
# .env. Refuses to run twice without -Force, because a second deploy silently
# orphans the first contract and every consumer still pointing at it.
#
# Pure ASCII on purpose. Windows PowerShell 5.1 reads a UTF-8 file without a
# BOM as ANSI, and a stray em dash becomes an UnexpectedToken parse error.

[CmdletBinding()]
param(
  [ValidateSet('local','testnet','mainnet')]
  [string]$Network = 'local',
  [switch]$Force,
  [switch]$Preflight
)

# NOT 'Stop'. This script shells out on almost every line, and with 'Stop'
# PowerShell promotes anything a native command writes to stderr into a
# TERMINATING error - even when that command succeeded and exited 0.
#
# It cost a deploy already: `stellar contract optimize` prints a deprecation
# notice to stderr, exits 0, and under 'Stop' killed the run between a
# successful build and the deploy. `rustup` and `cargo` write progress and
# update notices to stderr too, so preflight was exposed to the same thing.
#
# stderr is not an error signal. Exit codes are. Every native call below is
# followed by an explicit $LASTEXITCODE check, and every result that matters
# is verified for itself - the wasm exists, the address parsed, the contract
# id looks like a contract id.
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# soroban-sdk 27 refuses wasm32-unknown-unknown: Rust 1.82+ turns on
# reference-types and multi-value for that target, which the Soroban
# environment does not accept, and the SDK's build script panics rather than
# emit a wasm the network will reject. wasm32v1-none is the supported target.
$Target   = 'wasm32v1-none'
$Wasm     = Join-Path $root "packages\contracts\target\$Target\release\landfall_oracle.wasm"
$IdFile   = Join-Path $root '.contract-id'
$Identity = 'landfall-deployer'

function Say  ($m) { Write-Host ""; Write-Host $m -ForegroundColor Cyan }
function Note ($m) { Write-Host "     $m" }
function Die  ($m) { Write-Host ""; Write-Host $m -ForegroundColor Red; exit 1 }

# ------------------------------------------------------------------ network

switch ($Network) {
  'local' {
    $Rpc        = if ($env:SOROBAN_RPC_URL) { $env:SOROBAN_RPC_URL } else { 'http://localhost:8001' }
    $Passphrase = 'Standalone Network ; February 2017'
    $Friendbot  = 'http://localhost:8000/friendbot'
    $Explorer   = $null
  }
  'testnet' {
    $Rpc        = 'https://soroban-testnet.stellar.org'
    $Passphrase = 'Test SDF Network ; September 2015'
    $Friendbot  = 'https://friendbot.stellar.org'
    $Explorer   = 'testnet'
  }
  'mainnet' {
    $Rpc        = 'https://mainnet.sorobanrpc.com'
    $Passphrase = 'Public Global Stellar Network ; September 2015'
    $Friendbot  = $null
    $Explorer   = 'public'
  }
}

# ------------------------------------------------------------------ preflight

Say "Preflight"

$missing = @()

if (Get-Command cargo -ErrorAction SilentlyContinue) {
  Note ("cargo    " + (& cargo --version))
} else {
  $missing += @{
    what = 'Rust'
    how  = 'winget install Rustlang.Rustup     (then reopen PowerShell)'
    why  = 'The contract is Rust. Nothing else here can build it.'
  }
}

$hasTarget = $false
$installedTargets = @()
if (Get-Command rustup -ErrorAction SilentlyContinue) {
  $installedTargets = & rustup target list --installed
  $hasTarget = $installedTargets -contains $Target
}
if ($hasTarget) {
  Note "$Target  installed"
} else {
  $why = 'Soroban contracts compile to WebAssembly. Without this the build fails with "can''t find crate for core", which reads like a broken toolchain and is not.'
  if ($installedTargets -contains 'wasm32-unknown-unknown') {
    $why = 'You have wasm32-unknown-unknown, which is the WRONG one. soroban-sdk 27 rejects it outright: Rust 1.82+ enables reference-types and multi-value on that target and the Soroban environment does not support them, so the SDK build script panics rather than emit a wasm the network would refuse. wasm32v1-none is the supported target and needs Rust 1.84+.'
  }
  $missing += @{
    what = "the $Target target"
    how  = "rustup target add $Target"
    why  = $why
  }
}

if (Get-Command stellar -ErrorAction SilentlyContinue) {
  Note ("stellar  " + (& stellar --version | Select-Object -First 1))
} else {
  $missing += @{
    what = 'the stellar CLI'
    how  = 'winget install --id Stellar.StellarCLI       (prebuilt, fast)'
    why  = 'Deploys and invokes the contract. Older installs call it "soroban"; this script needs the stellar-named one, which speaks Protocol 23. Check "stellar --version" reports 23 or higher afterwards - the winget package has lagged releases before. If it is older, uninstall and use: cargo install --locked stellar-cli'
  }
}

# The host C toolchain. Non-obvious and the reason this check exists:
# the OUTPUT here is WebAssembly, but cargo still compiles proc-macro crates
# and build scripts FOR THE HOST - they execute on this machine during the
# build. On an msvc toolchain that needs link.exe, which only ships with
# Visual Studio's C++ tools. Without it the build downloads 194 crates, starts
# compiling, and dies on "linker `link.exe` not found", which looks like a
# Rust problem and is not.
$hostTriple = ''
if (Get-Command rustc -ErrorAction SilentlyContinue) {
  $hostTriple = (((& rustc -vV) | Where-Object { $_ -like 'host:*' }) -replace '^host:\s*', '').Trim()
}
if ($hostTriple -like '*windows-msvc*') {
  # link.exe is usually NOT on PATH outside a developer prompt; cargo locates
  # it through the VS installer's registry entries. So ask vswhere, which is
  # what cargo effectively does, and only fall back to PATH.
  $hasCTools = $false
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (Test-Path $vswhere) {
    $found = & $vswhere -latest -products * `
      -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
      -property installationPath 2>$null
    if ($found) { $hasCTools = $true }
  }
  if (-not $hasCTools -and (Get-Command link.exe -ErrorAction SilentlyContinue)) { $hasCTools = $true }

  if ($hasCTools) {
    Note "C tools  present (msvc)"
  } else {
    $missing += @{
      what = 'a C linker for the host toolchain'
      why  = 'Your Rust host target is windows-msvc. Even a wasm build compiles proc-macros and build scripts for the host first, and those need link.exe. Two ways out - the second is much smaller.'
      how  = @'
EITHER install Microsoft's C++ build tools (~3 GB, 15-20 min):
       winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--wait --quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

     OR switch Rust to the GNU toolchain, which brings its own linker (~400 MB):
       rustup toolchain install stable-x86_64-pc-windows-gnu
       rustup default stable-x86_64-pc-windows-gnu
       rustup target add wasm32v1-none

     If you take the GNU route, re-add the wasm target as shown - targets are
     installed per toolchain, so the one you added earlier does not carry over.
'@
    }
  }
}

if ($missing.Count -gt 0) {
  Write-Host ""
  Write-Host "Not ready. Missing:" -ForegroundColor Yellow
  foreach ($m in $missing) {
    Write-Host ""
    Write-Host ("  " + $m.what) -ForegroundColor Yellow
    Write-Host ("    " + $m.why)
    # A single-line fix gets the "> " prompt marker. A multi-line one is
    # already formatted; prefixing every line would just add noise.
    if ($m.how -match "`n") {
      foreach ($line in ($m.how -split "`r?`n")) { Write-Host ("    " + $line) -ForegroundColor White }
    } else {
      Write-Host ("    > " + $m.how) -ForegroundColor White
    }
  }
  Write-Host ""
  Write-Host "Install those, reopen PowerShell, and run this again."
  Write-Host ""
  exit 1
}

if ($Preflight) {
  Write-Host ""
  Write-Host "Toolchain is ready. Re-run without -Preflight to deploy." -ForegroundColor Green
  Write-Host ""
  exit 0
}

if ((Test-Path $IdFile) -and (-not $Force)) {
  Die @"
.contract-id already exists:

  $(Get-Content $IdFile -Raw)
Deploying again would orphan it. Delete the file, or pass -Force if that is
genuinely what you want.
"@
}

# ------------------------------------------------------------------ build

Say "1/5  Building wasm"
Push-Location (Join-Path $root 'packages\contracts')
try {
  & cargo build --target $Target --release
  if ($LASTEXITCODE -ne 0) { Die "cargo build failed." }
} finally { Pop-Location }

if (-not (Test-Path $Wasm)) { Die "Build reported success but $Wasm is not there." }

$size = (Get-Item $Wasm).Length
Note "$size bytes"
# The oracle is a few hundred lines. Much over 200 KB means an accidental std
# dependency crept in, and the deploy will cost far more than it should.
if ($size -gt 200000) {
  Write-Host "     WARNING: large for this contract. Check for a std dependency." -ForegroundColor Yellow
}

Say "2/5  Optimising"
# Deliberately best-effort. Optimising shrinks the upload and the rent; it does
# not change what the contract does. `stellar contract optimize` is deprecated
# as of CLI 27 and will be removed, so this must degrade to "deploy the
# unoptimised build" rather than fail, both now and after it disappears.
# 2>&1 folds the deprecation notice into stdout, where Out-Null eats it.
& stellar contract optimize --wasm $Wasm 2>&1 | Out-Null
$opt = $Wasm -replace '\.wasm$', '.optimized.wasm'
if (Test-Path $opt) {
  $before = (Get-Item $Wasm).Length
  $Wasm = $opt
  $after = (Get-Item $Wasm).Length
  Note "$after bytes after optimise (was $before)"
} else {
  Note "optimizer unavailable or declined; deploying the unoptimised build"
}

# ------------------------------------------------------------------ identity

Say "3/5  Identity"
& stellar keys address $Identity 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
  Note "reusing $Identity"
} else {
  # Flags verified against the CLI 27 reference, not assumed. There is no
  # --global (config location is --config-dir) and no --no-fund: funding is
  # opt-in via --fund and off by default, which is what we want. We fund
  # through friendbot below so key creation and funding stay separable - a
  # friendbot outage should not leave you without a key and no idea why.
  & stellar keys generate $Identity
  if ($LASTEXITCODE -ne 0) { Die "Could not create the identity '$Identity'." }
  Note "generated $Identity"
}

$Address = (& stellar keys address $Identity).Trim()
if (-not $Address) { Die "Could not read the address for '$Identity'." }
Note $Address

if ($Friendbot) {
  try {
    Invoke-WebRequest -Uri "$Friendbot`?addr=$Address" -UseBasicParsing -TimeoutSec 30 | Out-Null
    Note "funded via friendbot"
  } catch {
    Note "friendbot declined (already funded, most likely)"
  }
} else {
  Write-Host ""
  Write-Host "     MAINNET. Fund this account yourself before continuing:" -ForegroundColor Yellow
  Write-Host "     $Address"
  $ok = Read-Host "     Funded? [y/N]"
  if ($ok -ne 'y') { Die "Stopped." }
}

# ------------------------------------------------------------------ deploy

Say "4/5  Deploying to $Network"
$ContractId = (& stellar contract deploy `
  --wasm $Wasm `
  --source-account $Identity `
  --rpc-url $Rpc `
  --network-passphrase $Passphrase)
if ($LASTEXITCODE -ne 0) { Die "Deploy failed." }

$ContractId = ($ContractId | Where-Object { $_ -match '^C[A-Z2-7]{55}$' } | Select-Object -First 1)
if (-not $ContractId) { Die "Deploy returned no contract id." }
Note $ContractId
Set-Content -Path $IdFile -Value $ContractId -Encoding ASCII

# ------------------------------------------------------------------ initialise

Say "5/5  Initialising (admin = $Address)"
& stellar contract invoke `
  --id $ContractId `
  --source-account $Identity `
  --rpc-url $Rpc `
  --network-passphrase $Passphrase `
  -- initialise --admin $Address
if ($LASTEXITCODE -ne 0) { Die "initialise failed. The contract is deployed but unusable; see $IdFile." }

# initialise is guarded against a second call, so reading epoch back is a real
# check rather than a formality: a silent no-op means the deploy reused an
# existing instance.
$epoch = & stellar contract invoke `
  --id $ContractId --source-account $Identity `
  --rpc-url $Rpc --network-passphrase $Passphrase `
  -- epoch
if ($LASTEXITCODE -eq 0 -and $null -ne $epoch) {
  Note ("epoch reads back as " + ($epoch | Select-Object -Last 1))
} else {
  # Do not print "?" and move on as though nothing happened. Either say what
  # was confirmed or say the check did not run. The Initialised event in the
  # transaction above is the stronger evidence anyway - it is on the ledger,
  # whereas this is a local read that can fail for network reasons alone.
  Note "could not read epoch back; rely on the Initialised event above"
}

# ------------------------------------------------------------------ record it

$envFile = Join-Path $root '.env'
if ((Test-Path $envFile) -and -not (Select-String -Path $envFile -Pattern '^ORACLE_CONTRACT_ID=' -Quiet)) {
  Add-Content -Path $envFile -Value ""
  Add-Content -Path $envFile -Value "# written by scripts\deploy-contract.ps1 ($Network)"
  Add-Content -Path $envFile -Value "ORACLE_CONTRACT_ID=$ContractId"
  Add-Content -Path $envFile -Value "SOROBAN_RPC_URL=$Rpc"
  Note "appended to .env"
}

Write-Host ""
Write-Host "Deployed." -ForegroundColor Green
Write-Host ""
Write-Host "  network      $Network"
Write-Host "  contract     $ContractId"
Write-Host "  admin        $Address"
Write-Host "  rpc          $Rpc"
Write-Host ""
Write-Host "The admin secret lives in the stellar CLI keystore under the identity"
Write-Host "'$Identity'. It is not in this repo and must not be. To publish scores"
Write-Host "from a server, export it into that server's secret store:"
Write-Host ""
Write-Host "  stellar keys show $Identity"
Write-Host ""
if ($Explorer) {
  Write-Host "  Explorer: https://stellar.expert/explorer/$Explorer/contract/$ContractId"
  Write-Host ""
}
Write-Host "Next: put the contract id in the README so the 'not yet deployed' line"
Write-Host "stops being true."
Write-Host ""
