# Contributor backlog

The canonical list lives in the **[GitHub issue tracker](https://github.com/ibochivincent-lang/landfall/issues)**.
`scripts/setup-issues.ps1` files all of it in one run; this page is the summary.

## Labels

| Label | Meaning |
|---|---|
| `good first issue` | Scoped, unblocked, reviewer-ready |
| `help wanted` | Larger ticket looking for an owner |
| `type:feat` / `type:bug` / `type:docs` / `type:chore` / `type:test` | What kind of work |
| `trivial-100` / `medium-150` / `high-200` | Drips Wave point value |
| `module/*` | Which package it touches |
| `Stellar Wave` | In scope for the current cycle |

GitHub's canonical spellings for the first two use spaces, not hyphens. The
hyphenated variants do not appear in the Contribute tab, which is where new
contributors actually look.

## What is in there

**Good first issues** - local testnet deployment guide, CLI `--format` flag,
progress counter, CSV output, API docs, local Horizon support.

**Medium** - SEP-24 memo correlation (the highest-value item in the repo),
Freighter wallet integration, CAP-67 event ingestion,
resume cursors, partial refunds, confidence intervals, domain rollup, account
merges, an end-to-end test against the local node.

**High** - signed settlement receipts, the slippage metric, publishing digests
to the oracle, `@landfall/sdk`, an MCP server.

## Out of scope

- A consumer rate-comparison dashboard. Distribution is the SDK.
- Transaction execution. Landfall reports; it does not move funds.
- Any score component an anchor could fake in ten seconds.
