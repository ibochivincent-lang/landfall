# Architecture

Landfall is a layered distributed system organised into **three planes**. The
split is not cosmetic: it follows the trust boundary. Each plane makes a
strictly weaker claim than the one below it, and the boundary between planes
is where "anyone can recompute this" turns into "you are trusting a key."

```mermaid
flowchart TB
    subgraph P1["① OBSERVATION — what happened (permissionless, recomputable)"]
        SEP1["SEP-1 discovery<br/>home domain → accounts"] --> IDX
        HOR["Stellar ledger · Horizon"] --> IDX["indexer<br/>resumable cursors · BigInt stroops"]
        IDX --> HIST[("scan-history.ndjson<br/>every observation, committed")]
    end

    subgraph P2["② DERIVATION — what it means (pure functions over Plane 1)"]
        PG[("Postgres")]
        PURE["trust-check · intents · adapters<br/>investigator · stp · anchoring"]
        ORC["Soroban oracle<br/>digest + liveness"]
        PG --> PURE
        PG --> ORC
    end

    subgraph P3["③ CONSUMPTION — who reads it (holds no keys, moves no money)"]
        SURF["REST · GraphQL · Web app<br/>@landfall/sdk · MCP (11 tools) · x402 check"]
    end

    EXT["Third-party consumers<br/>wallets · contracts · agents"]

    IDX ==>|"persist"| PG
    PURE ==> SURF
    SURF ==> EXT
    ORC -.->|"digest, read permissionlessly"| EXT

    classDef p1 fill:#e8f5e9,stroke:#2e7d32,color:#1b5e20
    classDef p2 fill:#fff8e1,stroke:#ef6c00,color:#e65100
    classDef p3 fill:#e3f2fd,stroke:#1565c0,color:#0d47a1
    classDef ext fill:#f3e5f5,stroke:#6a1b9a,color:#4a148c
    class SEP1,HOR,IDX,HIST p1
    class PG,PURE,ORC p2
    class SURF p3
    class EXT ext
```

**The trust boundary sits between Plane 1 and Plane 2.** Everything in Plane 1
is the ledger's record, not Landfall's opinion, and a stranger can re-derive
all of it from Horizon without asking permission. The Soroban oracle in
Plane 2 is the one component whose output you must trust a key for — which is
why its write key is deliberately *not* its admin key. See
[TRUST.md](TRUST.md).

**Why the planes are ordered this way.** Plane 1 is the only source of
authority. Plane 2 may *derive* but never *invent* — the reason evidence
tiers (`PROVEN` > `ATTESTED` > `DERIVED`) are compared lexicographically and
never blended into one number is that blending would let a Plane 2 inference
outrank a Plane 1 fact. Plane 3 may *present* but never *decide*: the Intent
Engine's `StepActor` type cannot assign a money-moving step to `landfall`, and
the x402 check stops at a recommendation rather than signing.

Read a plane boundary as a downgrade in certainty, and the whole design
follows from it.

```
packages/
  contracts/   Rust + Soroban. The on-chain oracle.          (plane 2)
  db/          PostgreSQL schema and migrations.             (plane 2)
  indexer/     Reads the ledger, computes metrics, persists. (plane 1 → 2)
  trust-check/ Counterparty signals from ledger history.     (plane 2)
  intents/     Route solving and executable plans.           (plane 2)
  stp/         Attestation schema, canonical form, signing.  (plane 2)
  adapters/    Per-chain evidence, tiered.                   (plane 2)
  anchoring/   Merkle inclusion proofs.                      (plane 2)
  investigator/Cited facts, optional AI narrative.           (plane 2)
  x402/        Payee safety check for agent payments.        (plane 3)
  sdk/         Published client, pickAnchor().               (plane 3)
  api/         Read-only HTTP over the dataset.              (plane 3)
  web/         The public site.                              (plane 3)
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

## Lifecycle

One full turn of the system, from a cron tick to a third party acting on the
result. Steps 1–8 run hourly today; step 9 is gated on a publisher key being
installed (see [TRUST.md](TRUST.md)).

```mermaid
sequenceDiagram
    autonumber
    participant CRON as Hourly cron<br/>(GitHub Actions)
    participant IDX as Indexer
    participant HOR as Horizon<br/>(mainnet)
    participant PG as Postgres
    participant REPO as Repository<br/>scan-history.ndjson
    participant ORC as Soroban oracle
    participant C as Consumer<br/>wallet · agent · contract

    CRON->>IDX: start scan
    IDX->>HOR: GET home_domain/.well-known/stellar.toml
    HOR-->>IDX: declared accounts (SEP-1)
    IDX->>HOR: GET /accounts/{id}/payments (resumable cursor)
    HOR-->>IDX: settlement legs (SEP-24 and classic)
    IDX->>IDX: classify liveness, sum volume<br/>BigInt stroops, never floats
    IDX->>PG: persist scan + per-account metrics
    IDX->>REPO: append observations, commit
    opt publisher key configured
        IDX->>ORC: publish(digest) signed by PUBLISHER<br/>(cannot call set_admin)
        ORC-->>C: event: Published{epoch, digest}
    end
    C->>PG: read via API / SDK / MCP
    PG-->>C: record + asOf / staleHours
    C->>ORC: read digest
    C->>C: re-derive digest from published data<br/>and check the two agree
```

**Step 8 is the one that makes this checkable.** The consumer does not have to
trust the API's answer: it re-derives the digest from the published dataset
and compares. An oracle you cannot audit is just a database with extra steps.

---

## Authentication — SEP-10

Landfall's portal authenticates anchor operators by **proving control of a
Stellar account**, not by storing a password. The implementation is
`api/_lib/sep10.js`; the route is `GET|POST /api/v1/auth`.

```mermaid
sequenceDiagram
    autonumber
    participant W as Wallet<br/>(Freighter, Lab, cold signer)
    participant L as Landfall<br/>/api/v1/auth
    participant H as Horizon

    W->>L: GET /api/v1/auth?account=G...
    L->>L: build challenge transaction<br/>sequence 0 · source = server account<br/>ManageData: home_domain + web_auth_domain<br/>15-minute time bounds · 48-byte nonce
    L-->>W: unsigned challenge (XDR)
    Note over L: Sequence 0 is deliberate — an account<br/>can never have it, so the challenge is<br/>unsubmittable. A challenge that could be<br/>submitted is a blank cheque.
    W->>W: sign with the account's key
    W->>L: POST /api/v1/auth { transaction }
    L->>L: verify sequence 0, server is source,<br/>time bounds live, home domain matches
    L->>H: GET /accounts/{id} — signers + thresholds
    H-->>L: signer set, medium threshold
    L->>L: signature weight ≥ MEDIUM threshold?
    alt weight sufficient
        L-->>W: JWT
    else insufficient or expired
        L-->>W: rejected, with the reason
    end
```

**Why the medium threshold.** It is the same bar Soroban's built-in account
contract applies to `require_auth()`, so an account that is multisig for
contract calls is multisig for logging in here too — no second, weaker door.

The dispute path (`packages/fraud-reports/src/dispute.ts`) uses the same
principle: a reported party proves control of the reported address by
signature. Neither path ever asks for a secret key.

---

## Checking a payee before an agent pays — x402

```mermaid
sequenceDiagram
    autonumber
    participant A as Agent
    participant R as Paid resource
    participant L as Landfall<br/>/api/v1/x402/check-payee
    participant H as Horizon

    A->>R: GET /resource
    R-->>A: 402 + PAYMENT-REQUIRED<br/>(base64 PaymentRequired)
    A->>A: decode accepts[]
    A->>L: POST accepts[]
    loop each payment option
        alt network is stellar:pubnet/testnet AND payTo is G...
            L->>H: fetch payment history for payTo
            H-->>L: observed settlement
            L->>L: Trust Check: age, concentration, forwarding
        else other chain, or a C.../M... address
            L->>L: supported:false + stated reason<br/>never silently dropped
        end
    end
    L-->>A: one assessment per option, input order
    A->>A: apply spending policy<br/>unverifiable ⇒ refuse, not "assume safe"
    A->>R: retry with PAYMENT-SIGNATURE<br/>signed by the agent's own wallet

    Note over L: Landfall never signs, never settles,<br/>and holds no keys. It answers who has<br/>settled before — the agent does the paying.
```

---

## Data flow

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
npm run mcp               # MCP server over stdio, needs $DATABASE_URL — docs/MCP.md
```

The indexer works with no database at all — `--persist` opts in. A contributor
who only wants to fix a metric never has to start Docker.

`npm run api` starts `packages/api/src/server.ts`, the local dev API. It has
no routes of its own — it imports `api/[...path].js`'s handler (the same code
Vercel deploys) and runs it under plain `http.createServer`, so local dev and
production are, by construction, the same implementation rather than two that
can drift apart. See `docs/gaps.md` for the split-brain state this replaced.
