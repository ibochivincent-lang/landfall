# Landfall

**Did the money land?**

Ledger-derived settlement record for Stellar anchors.

**Live: [landfall-ib.vercel.app](https://landfall-ib.vercel.app)** · [Methodology](docs/methodology.md) · [Contributing](CONTRIBUTING.md)

> **Submitted to the Drips Stellar Wave Program.** Issues are labelled by
> complexity — `trivial-100`, `medium-150`, `high-200` — and tagged
> `Stellar Wave`. New contributors should start with `good-first-issue`.
> **Wait to be assigned before you start coding**; an unassigned issue is not
> yours. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Current finding

From the scan of 12 August 2026, across 13 anchor accounts on 5 home domains:

> **6 of 13 anchor accounts have processed no on-chain settlement in over 30 days.**
> Every account with payment history at one anchor is dark.

Verified against stellar.expert. Every figure ships with its transaction hashes.

---

## The difference

Existing anchor monitors **interrogate** anchors — ping an endpoint, validate a TOML, read a quote, and record the answer the anchor chose to give.

Landfall **observes** them — it reads the public ledger and measures what the anchor actually did.

You can fake a TOML file in ten seconds. You cannot fake two years of on-chain settlement history.

---

## Why the ledger is enough

Under SEP-24, both flows leave on-chain traces:

| Flow | On-chain leg | Off-chain leg |
|---|---|---|
| **Deposit** (fiat → asset) | Anchor sends the asset to the user's account | User pays fiat in |
| **Withdrawal** (asset → fiat) | User sends the asset to the anchor's account | Anchor pays fiat out |

So the ledger already contains, for every anchor, retroactively, without anyone's permission:

- **Liveness that cannot be faked** — an account with no activity for three days is not operating, whatever its status endpoint says
- **Deposit fulfilment** — the anchor's outbound payments, amounts and timing
- **Withdrawal intake** — volume flowing in, per asset
- **Refund rate** — value returned to senders. The distress signal no anchor advertises
- **Concentration** — how much of the flow is one counterparty

This is **retroactive**. A prober starts collecting the day you switch it on. Landfall computes years of history on the first run. That is the cold-start problem solved, which is what normally kills reputation products.

---

## How Landfall uses Stellar

Landfall is not a generic app that happens to settle on Stellar. Its core
mechanism depends on properties only this network provides, and it would not
port to another chain without being redesigned.

### SEP-1 — anchor discovery

Anchors publish a `stellar.toml` declaring the accounts they operate. That is
the entry point: a home domain resolves to on-chain accounts, permissionlessly,
with no cooperation from the anchor. `packages/indexer/src/toml.ts`.

### SEP-24 — why the ledger is enough

Under SEP-24 one leg of every deposit and withdrawal is written to the ledger:

| Flow | On-chain | Off-chain |
|---|---|---|
| Deposit (fiat → asset) | anchor sends the asset to the user | user pays fiat in |
| Withdrawal (asset → fiat) | user sends the asset to the anchor | anchor pays fiat out |

So settlement behaviour is already public, retroactively, for every anchor.
No permission needed and no opt-out available.

### CAP-67 — the unified event stream

Protocol 23 makes classic operations emit the same events Soroban contracts do
— `transfer`, `mint`, `burn`, `clawback` — with standardised topics and an
`i128` amount, and backfills them for past ledgers.

For this project that is not a convenience:

- **One stream instead of N cursors.** Follow the ledger once rather than
  paging every anchor account separately.
- **Mint and burn are distinguishable from transfer.** A payment involving the
  issuer is a different event from a user-to-user payment, and the protocol now
  says so rather than leaving us to infer it.

The `ledger_events` table is shaped directly on CAP-67's topics. The REST path
remains as a fallback and for pre-Protocol-23 networks; `payments.source`
records which path each row came from.

### SEP-38 — the slippage baseline

Firm quotes with an expiry give slippage a defined baseline: the gap between
the amount quoted and the amount that landed. That metric does not exist in the
ecosystem today. It needs the fiat leg, which is why Layer 2 is attestation.

### Soroban — publishing the record on-chain

`packages/contracts/landfall-oracle` publishes a **digest** of each dataset plus
a per-account liveness state, so other contracts can route on the same data a
wallet reads from the API.

It stores a digest rather than the dataset because anyone can re-derive the
digest from the published data and check the two agree. An oracle that asks you
to trust it has missed the point of being an oracle.

Events use `#[contractevent]`, so topics and payload shapes are part of the
contract spec and an indexer generates its decoder instead of guessing:

| Topic | Fires when |
|---|---|
| `publish` | a new dataset digest, epoch as a topic |
| `score` | every score write |
| `dark` | **only** on the transition into dormancy |

`dark` fires on the transition, not the state — a consumer wants waking when an
anchor goes quiet, not on every scan confirming it still is.

The contract deliberately emits **no CAP-67 asset events**. CAP-67 standardises
`transfer`/`mint`/`burn` for value movement; a scoring update moves no value,
and faking those topics would pollute the exact stream this project consumes.

### What is built, and what is not

| | Status |
|---|---|
| SEP-1 discovery | shipping |
| Horizon indexing, resumable cursors | shipping |
| Liveness, volume, concentration, returns | shipping |
| Postgres persistence + read API | shipping |
| Soroban oracle | written, 16 tests, **not yet deployed** |
| CAP-67 event ingestion | schema ready, ingestion **not written** |
| SEP-38 slippage / attestations | **designed, not built** |
| `@landfall/sdk`, MCP server | **designed, not built** |

We would rather list this honestly than let a roadmap read as a changelog.

---

## Quick start

**Whole stack, one command.** Requires Docker.

```bash
cp .env.example .env
docker compose up
```

Brings up a local Stellar Quickstart node, Postgres with the schema applied,
the indexer, and the API — no account anywhere, no mainnet, no credentials.
Site on :8080, API on :8787, Horizon on :8000.

**Just the indexer.** Requires Node 20+, no Docker, no database.

```bash
npm install
npm run discover     # resolve anchor domains to on-chain accounts
npm run scan         # index payment history and print the finding
```

Layout:

```
packages/contracts   Rust + Soroban oracle
packages/db          PostgreSQL schema
packages/indexer     ledger reader and metrics
packages/api         read-only HTTP API
packages/web         the public site
```

See [docs/architecture.md](docs/architecture.md).

Scan writes full results, including both transaction hashes for every matched
refund pair, to `out/scan-<timestamp>.json` so any claim can be checked
against the ledger.

### Flags

```
--domains a.com,b.com     override the seed list in data/anchors.json
--horizon <url>           default https://horizon.stellar.org
--max-records <n>         per-account record cap (default 2000)
--since <iso>             ignore records older than this
--min-inbound <n>         minimum inbound payments to be ranked (default 25)
--concurrency <n>         parallel requests (default 4)
--out <dir>               output directory (default ./out)
```

### Example

```bash
npm run scan -- --since 2026-01-01T00:00:00Z --max-records 5000 --min-inbound 50
```

---

## What it reports

```
DOMAIN                     ACCOUNT      IN      OUT     REFUNDS   RATE      LAST SEEN
--------------------------------------------------------------------------------------
example-anchor.com         GABC…WXYZ    1204    1190    47        3.90%     2.1h
```

Followed by a headline finding — the aggregate refund rate across every account
with enough inbound traffic to support the claim.

---

## Honesty rules

These are constraints on the code, not aspirations:

1. **No number on the site that the code cannot prove.** Every published figure traces to indexed ledger records.
2. **Failures are visible.** A domain that will not resolve prints as `FAIL`. It is never silently dropped, because a missing anchor is itself a finding.
3. **Thin data is suppressed, not ranked.** A refund rate computed over three payments is noise dressed as a statistic. Accounts below `--min-inbound` are excluded from the headline.
4. **Heuristics are labelled.** Refund detection is a heuristic. It says so, everywhere it appears. See [docs/methodology.md](docs/methodology.md).
5. **Degradation is stale, not broken.** There is no external probe to fail. If indexing stops, it resumes from the last cursor. The honest status is "N ledgers behind."

---

## Status

Layer 1 (ledger truth) is implemented. Layers 2 and 3 are designed, not built:

- **Layer 1 — ledger truth.** Indexer, metrics, refund detection. ✅ working
- **Layer 2 — attested outcomes.** Signed settlement receipts covering the fiat leg, so slippage between quoted and landed amounts becomes measurable. Designed.
- **Layer 3 — distribution.** `pickAnchor()` SDK for wallets, public API, MCP server for payment agents, Soroban oracle publishing signed score digests. Designed.

See [docs/roadmap.md](docs/roadmap.md).

---

## Contributing

Issues are scoped and labelled by complexity. Start with `good-first-issue`.
See [CONTRIBUTING.md](CONTRIBUTING.md), [DEVELOPMENT.md](DEVELOPMENT.md) and
[docs/backlog.md](docs/backlog.md).

## Tests

```bash
npm test                # indexer: 35 tests, no network required
npm run contracts:test  # oracle: 16 tests
npm run typecheck
```

The suite includes a mock Horizon server, so the pagination, normalisation and
metrics path is verified end to end without touching the network.

## Licence

MIT
