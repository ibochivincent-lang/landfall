# Landfall

**Did the money land?**

Ledger-derived settlement record for Stellar anchors.

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

Requires Node 20+.

```bash
npm install
npm run discover     # resolve anchor domains to on-chain accounts
npm run scan         # index payment history and print the finding
```

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
See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/backlog.md](docs/backlog.md).

## Tests

```bash
npm test         # 19 tests, no network required
npm run typecheck
```

The suite includes a mock Horizon server, so the pagination, normalisation and
metrics path is verified end to end without touching the network.

## Licence

MIT
