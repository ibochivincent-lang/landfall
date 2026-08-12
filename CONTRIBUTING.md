# Contributing

## Setup

```bash
npm install
npm test          # must pass, no network needed
npm run typecheck # must be clean
```

## Picking work

[`docs/backlog.md`](docs/backlog.md) lists scoped issues by complexity tier
(Trivial 100 / Medium 150 / High 200). Every entry is written so you can start
without asking a question first.

If you are participating through a bounty program, **wait to be assigned
before you start coding.** An unassigned issue is not yours.

## Ground rules

The project has six invariants, listed in [CLAUDE.md](CLAUDE.md). The two that
catch people most often:

- **Money arithmetic is BigInt stroops.** Never `parseFloat` an amount. Use
  `toStroops` / `fromStroops` from `src/metrics.ts`.
- **Failures must stay visible.** Do not turn an error into a silent skip. A
  domain that will not resolve is a finding, and the report prints it.

`src/metrics.ts` and `src/report.ts` are pure — no I/O. Keep them that way, so
the suite keeps running offline.

## Pull requests

- One issue per PR, linked in the description
- Add a test for every behaviour change; new metrics need a null/empty-input case
- Update `docs/methodology.md` in the same PR if you add or change a published number
- Keep the diff focused — unrelated refactors make review slow

## Reporting a data error

If a Landfall figure looks wrong, open an issue with the account, the scan
timestamp, and the transaction hashes from the JSON output. Every published
number is traceable to ledger records, so a disagreement is resolvable by
checking the ledger. That is the point of the design.
