# Architecture

```
packages/
  contracts/   Rust + Soroban. The on-chain oracle.
  db/          PostgreSQL schema and migrations.
  indexer/     Reads the ledger, computes metrics, persists them.
  api/         Read-only HTTP over the dataset.
  web/         The public site.
```

One command brings all of it up locally:

```bash
cp .env.example .env
docker compose up
```

That starts a Stellar Quickstart node (core, Horizon, Soroban RPC, friendbot),
Postgres with the schema already applied, the indexer on a loop, and the API.
No account anywhere, no mainnet, no credential to ask anyone for.

| Service | URL |
|---|---|
| Horizon | http://localhost:8000 |
| Soroban RPC | http://localhost:8001 |
| Postgres | postgres://landfall:landfall@localhost:5432/landfall |
| API | http://localhost:8787 |
| Site | http://localhost:8080 |

---

## Why hybrid

Everything Landfall publishes is derived from the public ledger. The ledger is
the source of truth and it always wins. But you cannot ask a ledger "which
anchors have been dark for over thirty days, sorted by dormancy" — so the same
facts are also kept in Postgres, where that question is a query.

The split:

- **On-chain** — a digest of each published dataset and a small liveness state
  per account. Cheap, and enough for another contract to route on.
- **Off-chain** — the full record: every payment, every event, every metric,
  with the transaction hashes behind them.

Anyone can recompute the digest from the published data and check the two
agree. That is the point of publishing a digest rather than a score: an oracle
that asks you to trust it has missed what an oracle is for.

---

## Data flow

```
Stellar ledger
      │
      │  (a) Horizon /payments — paged, resumable cursors
      │  (b) CAP-67 unified events — transfer / mint / burn / clawback
      ▼
  indexer ──────────► postgres ──────────► api ──────────► web / wallets
      │                                                       agents
      │  publishes a digest + liveness per account
      ▼
  soroban oracle ────► other contracts route on-chain
```

### Why CAP-67 changes this

Before Protocol 23, reading anchor settlement meant paging a REST endpoint per
account. **CAP-67 makes classic operations emit the same events Soroban
contracts do** — `transfer`, `mint`, `burn`, `clawback`, with standardised
topics and an `i128` amount. One event stream now covers both classic payments
and contract activity.

For this project that is not a minor convenience. It means:

- **One stream instead of N cursors.** Follow the ledger once rather than
  paging every anchor account separately.
- **Mint and burn are distinguishable from transfer.** A payment involving the
  issuer is not the same event as a payment between two users, and the protocol
  now says so rather than leaving us to infer it.
- **Retroactive emission.** Protocol 23 backfills events for past ledgers, so
  history arrives through the same decoder as live data.

`ledger_events` in the schema is shaped directly on the CAP-67 topics. The
REST path stays as a fallback and for networks below Protocol 23, and every row
records which path it came from in `payments.source`.

---

## The contract

`packages/contracts/landfall-oracle` — Rust, soroban-sdk 27.

Stores a dataset digest, an epoch counter, and a `Score` per account
(`Live` / `Slow` / `Dark` / `NoActivity`, plus last activity and sample size).

Events are declared with `#[contractevent]` so the topics and payload shapes
are part of the contract spec, and an indexer generates its decoder rather than
guessing at string literals:

| Topic | When |
|---|---|
| `init` | once, at initialisation |
| `publish` | a new dataset digest, with the epoch as a topic |
| `score` | every score write |
| `dark` | **only** on the transition into dormancy |
| `set_admin` | admin handover |

`dark` fires on the transition, not the state. A consumer wants waking when an
anchor goes quiet, not on every scan that confirms it is still quiet.

The contract does **not** emit CAP-67 asset events. CAP-67 standardises
`transfer` / `mint` / `burn` for value movement; a scoring update moves no
value, and faking those topics would pollute the exact stream this project
depends on.

### One bug worth recording

`set_scores` originally called the public `set_score` in a loop. Both
authorised, so `require_auth` ran twice in one frame and the host rejected it
with `Error(Auth, ExistingValue)` — the batch endpoint panicked every time it
was called. Authorisation now happens once at the entry point, with a private
writer shared by both paths. `batching_authorises_once_not_per_account` guards
it.

---

## The database

`packages/db/migrations/001_init.sql`. Three decisions do the heavy lifting:

**Every amount is `NUMERIC(30,7)`, never float.** Stellar carries seven decimal
places and the indexer works in integer stroops; the database must not undo
that. Verified: `0.1 + 0.2` sums to exactly `0.3000000`.

**Raw records are stored beside the metrics derived from them.** If a published
figure ever disagrees with its inputs, the inputs win and the metric is the
bug.

**`refund_rate` is `NULL`, not `0`, when there is no inbound traffic.** A rate
over nothing is unknown, not zero, and the difference survives all the way out
to the API. Reporting `0` would tell a caller "this anchor never fails" about
an anchor we have no evidence on.

Cursors live in `cursors`, so an interrupted indexer resumes where it stopped.
The failure mode is stale, never wrong.

---

## The API

`packages/api` — read-only, zero framework, Postgres and `node:http`.

| Endpoint | Returns |
|---|---|
| `GET /health` | liveness |
| `GET /api/v1/summary` | headline figures |
| `GET /api/v1/anchors` | every account with metrics |
| `GET /api/v1/anchors/{domain}` | one anchor |
| `GET /api/v1/dark` | dormant accounts only |

Every response carries `asOf` and `staleHours`, because a consumer must be able
to see the data is a month old without reading our blog. Any response
containing a return rate also carries the caveat that a low rate is the absence
of one kind of evidence, not evidence of good conduct — the limitation ships in
the payload, not just the docs.

---

## The site

Static. It fetches `/api/v1/anchors` on load and falls back to a built-in
snapshot when the API is unreachable, showing a badge either way: **live** with
real staleness, or **snapshot** with its date. Point it at an API by setting

```html
<meta name="landfall-api" content="http://localhost:8787">
```

GSAP is vendored in `packages/web/vendor` rather than loaded from a CDN — the
site's own CSP is `script-src 'self'`, so a CDN copy would be blocked.

---

## Running pieces individually

```bash
npm test                  # indexer: 35 tests, offline
npm run typecheck         # indexer + api
npm run contracts:test    # oracle: 16 tests
npm run contracts:build   # wasm

npm run discover          # resolve domains to accounts
npm run scan              # scan and print
npm run scan -- --persist # scan and write to Postgres

npm run db:migrate        # apply the schema to $DATABASE_URL
npm run api               # API in watch mode
```

The indexer works with no database at all — `--persist` opts in. A contributor
who only wants to fix a metric never has to start Docker.
