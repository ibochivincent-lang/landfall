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
