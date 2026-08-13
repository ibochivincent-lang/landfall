# Development guide

Orientation for anyone working in this repository - the architecture, the
commands, and the constraints that are not up for negotiation.

## What this project is

Landfall derives a settlement quality record for Stellar anchors **from public
ledger data only**. The competing approach — probing anchor endpoints, checking
TOML files, reading quote APIs — measures what an anchor says about itself.
Landfall measures what it did.

Hold onto that distinction. It is the reason the project exists, and most
design questions resolve by asking: *are we observing, or are we asking?*

## Commands

```bash
npm install
npm test            # 37 tests, no network required
npm run typecheck   # tsc --noEmit, must stay clean
npm run discover    # resolve domains → accounts
npm run scan        # index and report
```

## Architecture

```
packages/
  contracts/         Rust + Soroban oracle (deployed to testnet)
  db/migrations/     PostgreSQL schema
  api/src/           read-only HTTP API
  web/               the public site and transaction dashboard
  indexer/src/
    types.ts         shared types + DEFAULT_SCAN_OPTIONS
    toml.ts          SEP-1 discovery: domain → declared accounts (zero-dep parser)
    horizon.ts       paginated payment fetch, normalisation, retry/backoff
    metrics.ts       PURE functions — BigInt arithmetic, refund detection
    report.ts        PURE rendering — table + headline
    db.ts            Postgres persistence and resume cursors
    cli.ts           the only place doing I/O orchestration
```

`metrics.ts` and `report.ts` are pure and must stay that way. Every metric is
testable without a network. This is not stylistic — it is why the test suite
runs offline, and offline tests are why contributors can actually contribute.

## Non-negotiables

These are project invariants. Do not relax them to make a feature easier.

1. **No number the code cannot prove.** Every published figure traces to
   indexed ledger records. If you add a stat, add the derivation to
   `docs/methodology.md` in the same change.
2. **Failures are visible.** A domain that will not resolve prints `FAIL`.
   Never swallow an error into a silent skip — a missing anchor is a finding.
3. **Thin data is suppressed, not ranked.** Respect `--min-inbound`. Do not
   publish a rate over a handful of payments.
4. **Heuristics are labelled as heuristics** everywhere they surface.
5. **Money arithmetic is BigInt stroops.** Never `parseFloat` an amount.
   `toStroops` / `fromStroops` in `metrics.ts` are the only conversion path.
6. **Degradation is stale, not broken.** No external probe should be able to
   take the system down. Interrupted work resumes from a cursor.

## Testing conventions

- Unit tests for pure functions, no network
- `test/horizon.test.ts` spins a real local HTTP server that paginates like
  Horizon. Use that pattern for anything network-shaped rather than mocking
  `fetch` — it catches pagination and parsing bugs that stubs hide.
- Every new metric needs a null/empty-input test. Rates must return `null`
  rather than dividing by zero.

## What not to build

- A consumer rate-comparison dashboard. Distribution is the SDK.
- Transaction execution. Landfall reports; it does not move funds.
- Any score component an anchor could fake in ten seconds.

## Where to start

`docs/backlog.md` has scoped issues by complexity tier. **M1 (read SEP-24
memos to correlate legs)** is the highest-value open item — it materially
improves refund detection accuracy, which is the project's core claim.
