# Scan history — the measurement record

`scan-history.ndjson` is the per-account hourly time series recovered from
git history of `packages/web/api/v1/anchors.json`. One JSON object per line,
one line per (scan, account), ordered oldest first.

Regenerate or extend it with:

```bash
node scripts/extract-scan-history.mjs
```

## Why it lives here as a file

The hourly GitHub Action commits a fresh `anchors.json` every scan, so git
already held the whole series. But the 5 September history rewrite — the one
that made this repository single-author — reset `main` and left everything
before that date on two **local-only** branches
(`archive/full-history-20260905`, `backup/pre-rewrite-20260905`). Neither is
on the remote, and neither should be: pushing them would reintroduce exactly
the authorship the rewrite removed.

That left 26 days of measurements on one laptop, with no copy anywhere else.
This file is that copy, carrying the data forward without carrying the old
commit history with it.

**These observations cannot be re-derived later.** `hoursSinceActivity` and
`topCounterpartyShare` are point-in-time readings of a moving ledger, not
something Horizon can be asked about retroactively. Once the branches
holding them are gone, so are they.

## What is in it

| | |
|---|---|
| Span | 2026-08-12T13:23Z → 2026-09-07T18:29Z (26 days) |
| Scans | 348 |
| Observations | 5,797 |
| Domains | 28 |
| Accounts | 109 |
| Median gap between scans | 0.99 h |
| Longest gap | 31.8 h (14 gaps exceed 6 h) |

Coverage grew during the period — 13 accounts in the first scan, 108 in the
last. An account therefore has between 10 and 348 observations depending on
when it entered the set, and **counts are not comparable across accounts**
without accounting for that.

Fields per row: `asOf`, `account`, `domain`, `state`, `inbound`, `outbound`,
`returns`, `returnRate`, `hoursSinceActivity`, `topCounterpartyShare`.

## What it can and cannot support

ROADMAP Horizon 2 proposes a **dark-anchor early warning** — a 48–72 h ahead
degradation signal — and requires it ship "with its false-positive rate
published." Measured against this record, that is not yet buildable, and the
reason is a count, not an opinion:

| Transition | Count |
|---|---|
| `live` → `slow` | 17 |
| `slow` → `live` | 7 |
| `dark` → `no_activity` | 1 |
| `dark` → `live` | 1 |
| **`slow` → `dark`** | **1** |
| **Total** | **27** |

**Exactly one account went dark in 26 days.** A predictor for an event with
one positive example cannot have a false-positive rate that means anything —
any threshold fits n=1 perfectly and generalises to nothing. Publishing a
confident early warning about a *named business* on that basis is the
failure mode this project exists to catch elsewhere.

What the record *does* support today is the weaker, honest claim already
shipped: `anchor.degraded` webhooks on the 17 live→slow moves that actually
happen, rather than `anchor.dark` on an event that has fired once. See
`scripts/dispatch-webhooks.mjs`.

The predictor becomes worth revisiting when the going-dark count is large
enough to hold out a validation set — not on a date, on a number.
