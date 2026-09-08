# Benchmarks

Measured figures, with the method stated so you can rerun them and disagree.

**Measured 8 September 2026.** Every number here came from an actual run on
that date — none is a target, an estimate, or carried over from a previous
version of this file.

---

## API latency

Five sequential requests per endpoint against the live deployment from a
single residential connection in Lagos, Nigeria. Vercel edge, Supabase pooler.

| Endpoint | Median | Min | Max |
|---|---|---|---|
| `GET /api/v1/anchors` | **603 ms** | 366 ms | 1882 ms |
| `GET /api/v1/trust-check` | **351 ms** | 326 ms | 1034 ms |
| `GET /api/v1/corridors` | **334 ms** | 324 ms | 3357 ms |

```bash
curl -s -o /dev/null -w "%{time_total}\n" \
  https://landfall-chi.vercel.app/api/v1/anchors
```

**Read the max column, not just the median.** The spread is wide and the cause
is structural, not noise: these are serverless functions over a pooled
database, so a cold start or a new pool connection costs a second or more. A
consumer on a latency budget should assume the max, not the median.

`trust-check` is consistently the fastest despite doing the most work, because
it queries Horizon directly and never touches the database — which is also why
it stays up when the database does not.

Five samples is a small sample. It is enough to show the shape and the
variance; it is not a percentile distribution, and this file does not pretend
otherwise.

---

## Test suite

| Suite | Count | Wall time |
|---|---|---|
| JavaScript / TypeScript | **441** | 59 s |
| Rust (Soroban contract) | **28** | 0.24 s |

```bash
npm test                # 441
npm run contracts:test  # 28
```

The JS figure is dominated by process startup — the suite runs 16 workspaces
plus several standalone files, each spawning its own runner. Individual suites
are in the tens of milliseconds. It is offline: no network, no database, no
credentials.

---

## Scan pipeline

| | |
|---|---|
| Accounts per scan | 108 across 27 domains |
| Cadence requested | Hourly (`0 * * * *`) |
| Cadence measured | **Median 2.8 h gap** over 24 h, range 1.7–4.8 h |
| Observations retained | 6,445 |
| History file size | 1.6 MB |
| Hosting cost | $0/month |

**The measured cadence is not the requested one**, and that gap is the honest
figure. GitHub runs scheduled workflows best-effort and defers them under
load; the cron asks for hourly and gets a median 2.8 hours. This is why every
payload carries `asOf`/`staleHours` — a consumer reads the real age rather
than trusting a schedule.

---

## Storage growth

At 108 accounts and the measured cadence, `data/scan-history.ndjson` grows
roughly **1.6 MB per month**, appended one line per (scan, account).

That is fine in a git repository for years. If coverage grows an order of
magnitude the file becomes the constraint, and the answer is compaction or a
columnar format — not deleting history, since these are point-in-time
observations that cannot be re-derived from Horizon later.

---

## What is not measured

Stated because a benchmarks page listing only flattering numbers is not one.

- **No load testing.** Behaviour under concurrent load is unknown. The rate
  limits in [API_REFERENCE.md](API_REFERENCE.md) are a policy choice, not a
  capacity measurement.
- **No p95/p99.** Five samples is a shape, not a distribution.
- **No cold-start isolation.** The max figures include cold starts and the
  method does not separate them.
- **No indexer throughput figure.** Full-scan wall time is not instrumented.
- **No contract gas/resource measurement.** The 28 tests assert behaviour, not
  cost. This matters before mainnet and is not done.

---

## Rerunning this

Latency and test counts change. If you rerun and get materially different
numbers, the file is stale and a corrected version is a welcome change — with
the date and method updated alongside it.
