#!/usr/bin/env bash
#
# Deploy the Landfall oracle.
#
#   ./scripts/deploy-contract.sh                    # local Quickstart
#   ./scripts/deploy-contract.sh testnet            # public testnet
#   ./scripts/deploy-contract.sh mainnet            # you had better mean it
#
# Writes the contract id to .contract-id and appends ORACLE_CONTRACT_ID to
# .env. Refuses to run twice against the same network without --force, because
# a second deploy silently orphans the first contract and every consumer that
# still points at it.
#
set -euo pipefail

NETWORK="${1:-local}"
FORCE="${2:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# soroban-sdk 27 refuses wasm32-unknown-unknown: Rust 1.82+ turns on
# reference-types and multi-value for that target, which the Soroban
# environment does not accept, and the SDK's build script panics rather than
# emit a wasm the network will reject. wasm32v1-none is the supported target.
TARGET="wasm32v1-none"
WASM="packages/contracts/target/$TARGET/release/landfall_oracle.wasm"
ID_FILE=".contract-id"
IDENTITY="landfall-deployer"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------------ preflight

command -v stellar >/dev/null 2>&1 || fail \
"The 'stellar' CLI is not on PATH.

  cargo install --locked stellar-cli

(Older installs call it 'soroban'. This script needs the stellar-named CLI,
which is the one that speaks Protocol 23.)"

command -v cargo >/dev/null 2>&1 || fail "Rust is not installed. See https://rustup.rs"

rustup target list --installed 2>/dev/null | grep -qx "$TARGET" || fail \
"The $TARGET target is missing.

  rustup target add $TARGET

If you have wasm32-unknown-unknown, that is the wrong one: soroban-sdk 27
rejects it because Rust 1.82+ enables reference-types and multi-value there,
which the Soroban environment does not support. Needs Rust 1.84+."

# A host C linker. Counter-intuitive but required: the output is wasm, yet
# cargo compiles proc-macro crates and build scripts for the HOST, and those
# need a native linker. Usually present here; the check costs nothing and the
# failure it prevents ("linker `cc` not found", 194 crates in) looks like a
# Rust problem and is not.
command -v cc >/dev/null 2>&1 || command -v gcc >/dev/null 2>&1 || fail \
"No C compiler on PATH (cc or gcc).

Proc-macros and build scripts compile for this machine even though the
contract targets wasm, and they need a native linker.

  Debian/Ubuntu   sudo apt-get install build-essential
  Fedora          sudo dnf install gcc
  macOS           xcode-select --install"

case "$NETWORK" in
  local)   RPC="${SOROBAN_RPC_URL:-http://localhost:8001}"
           PASSPHRASE="Standalone Network ; February 2017"
           FRIENDBOT="${FRIENDBOT_URL:-http://localhost:8000/friendbot}" ;;
  testnet) RPC="https://soroban-testnet.stellar.org"
           PASSPHRASE="Test SDF Network ; September 2015"
           FRIENDBOT="https://friendbot.stellar.org" ;;
  mainnet) RPC="https://mainnet.sorobanrpc.com"
           PASSPHRASE="Public Global Stellar Network ; September 2015"
           FRIENDBOT="" ;;
  *)       fail "Unknown network '$NETWORK'. Use local, testnet or mainnet." ;;
esac

if [ -f "$ID_FILE" ] && [ "$FORCE" != "--force" ]; then
  fail "$ID_FILE already exists:

  $(cat "$ID_FILE")

Deploying again would orphan it. Delete the file, or pass --force if that is
genuinely what you want."
fi

# ------------------------------------------------------------------ build

say "1/5  Building wasm"
(cd packages/contracts && cargo build --target "$TARGET" --release)
[ -f "$WASM" ] || fail "Build reported success but $WASM is not there."

# The oracle is a few hundred lines; anything over ~64 KiB means an accidental
# std dependency crept in and the deploy will cost far more than it should.
SIZE=$(wc -c < "$WASM" | tr -d ' ')
printf '     %s bytes\n' "$SIZE"
[ "$SIZE" -lt 200000 ] || say "     WARNING: that is large for this contract. Check for a std dependency."

say "2/5  Optimising"
if stellar contract optimize --wasm "$WASM" >/dev/null 2>&1; then
  OPT="${WASM%.wasm}.optimized.wasm"
  [ -f "$OPT" ] && WASM="$OPT" && printf '     %s bytes after optimise\n' "$(wc -c < "$WASM" | tr -d ' ')"
else
  printf '     optimizer unavailable, deploying the unoptimised build\n'
fi

# ------------------------------------------------------------------ identity

say "3/5  Identity"
if stellar keys address "$IDENTITY" >/dev/null 2>&1; then
  printf '     reusing %s\n' "$IDENTITY"
else
  # No --global (that is --config-dir) and no --no-fund: funding is opt-in via
  # --fund and off by default. Friendbot below does the funding, so a friendbot
  # outage cannot leave you without a key and no explanation.
  stellar keys generate "$IDENTITY"
  printf '     generated %s\n' "$IDENTITY"
fi
ADDRESS="$(stellar keys address "$IDENTITY")"
printf '     %s\n' "$ADDRESS"

if [ -n "$FRIENDBOT" ]; then
  curl -fsS "$FRIENDBOT?addr=$ADDRESS" >/dev/null 2>&1 \
    && printf '     funded via friendbot\n' \
    || printf '     friendbot declined (already funded, most likely)\n'
else
  printf '     mainnet: fund %s yourself before continuing\n' "$ADDRESS"
  read -r -p "     Funded? [y/N] " ok
  [ "$ok" = "y" ] || fail "Stopped."
fi

# ------------------------------------------------------------------ deploy

say "4/5  Deploying to $NETWORK"
CONTRACT_ID="$(stellar contract deploy \
  --wasm "$WASM" \
  --source-account "$IDENTITY" \
  --rpc-url "$RPC" \
  --network-passphrase "$PASSPHRASE")"

[ -n "$CONTRACT_ID" ] || fail "Deploy returned no contract id."
printf '     %s\n' "$CONTRACT_ID"
printf '%s\n' "$CONTRACT_ID" > "$ID_FILE"

# ------------------------------------------------------------------ initialise

say "5/5  Initialising (admin = $ADDRESS)"
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source-account "$IDENTITY" \
  --rpc-url "$RPC" \
  --network-passphrase "$PASSPHRASE" \
  -- initialise --admin "$ADDRESS"

# `initialise` is guarded against a second call, so verifying it took is a real
# check rather than a formality: a silent no-op here means the deploy reused an
# existing instance.
if EPOCH="$(stellar contract invoke \
  --id "$CONTRACT_ID" --source-account "$IDENTITY" \
  --rpc-url "$RPC" --network-passphrase "$PASSPHRASE" \
  -- epoch 2>/dev/null)"; then
  printf '     epoch reads back as %s\n' "$EPOCH"
else
  # Say the check did not run rather than printing a placeholder. The
  # Initialised event in the transaction above is on the ledger; this is a
  # local read that can fail for network reasons alone.
  printf '     could not read epoch back; rely on the Initialised event above\n'
fi

# ------------------------------------------------------------------ record it

if [ -f .env ] && ! grep -q '^ORACLE_CONTRACT_ID=' .env; then
  {
    printf '\n# written by scripts/deploy-contract.sh (%s)\n' "$NETWORK"
    printf 'ORACLE_CONTRACT_ID=%s\n' "$CONTRACT_ID"
    printf 'SOROBAN_RPC_URL=%s\n' "$RPC"
  } >> .env
  printf '\n     appended to .env\n'
fi

cat <<EOF

Deployed.

  network      $NETWORK
  contract     $CONTRACT_ID
  admin        $ADDRESS
  rpc          $RPC

The admin secret lives in the stellar CLI keystore under the identity
'$IDENTITY'. It is not in this repo and must not be. To publish scores from a
server, export it into that server's secret store:

  stellar keys show $IDENTITY

EOF

if [ "$NETWORK" != "local" ]; then
  echo "  Explorer: https://stellar.expert/explorer/${NETWORK}/contract/${CONTRACT_ID}"
  echo
fi
