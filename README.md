# Landfall

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/ibochivincent-lang/landfall/actions/workflows/ci.yml/badge.svg)](https://github.com/ibochivincent-lang/landfall/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/tests-431%20JS%20%2B%2025%20Rust-brightgreen)](https://github.com/ibochivincent-lang/landfall/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@landfall/sdk?logo=npm&label=%40landfall%2Fsdk)](https://www.npmjs.com/package/@landfall/sdk)
[![Deployed on Vercel](https://img.shields.io/badge/Deployed-Vercel-black?logo=vercel)](https://landfall-chi.vercel.app)
[![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-fe5196?logo=conventionalcommits)](https://www.conventionalcommits.org/en/v1.0.0/)

**Did the money land?**

A settlement-quality record for Stellar anchors, computed entirely from the public ledger — not from asking the anchor.

Every existing anchor monitor *interrogates* — pings an endpoint, validates a `stellar.toml`, records the answer the anchor chose to give. Landfall *observes* — it reads what anchor accounts actually did on-chain under SEP-24, and turns that into liveness, settlement volume, counterparty concentration, and refund rate. A TOML file can be edited in ten seconds. Two years of settlement history cannot.

**Live: [landfall-chi.vercel.app](https://landfall-chi.vercel.app)**

> **Contributors welcome.** Issues are filed and labelled by complexity.
> Start with `good first issue`, and **wait to be assigned before writing
> code** — an unassigned issue is not yours. See
> [CONTRIBUTING.md](CONTRIBUTING.md).

## Table of contents

- [Why this exists](#why-this-exists)
- [Current finding](#current-finding)
- [Tech stack](#tech-stack)
- [Getting started](#getting-started)
- [Environment variables](#environment-variables)
- [Documentation](#documentation)
- [Honesty rules](#honesty-rules)
- [Contributing](#contributing)
- [Contributors](#contributors)
- [License](#license)

## Why this exists

### The problem, stated plainly

**Stellar's anchors are the bridge between the ledger and real money, and there is no independent record of whether any of them are actually settling.**

An anchor is the on/off ramp: it takes fiat and issues a token, or takes the token and pays out fiat. A wallet routing a remittance has to pick one. Today that choice rests on three things, and all three are supplied by the anchor itself:

| What a wallet can check today | Who controls the answer |
|---|---|
| The `stellar.toml` at the home domain | The anchor — editable in ten seconds |
| The SEP-24 `/info` endpoint | The anchor — it returns what it chooses |
| The anchor's own status page | The anchor |

So the question *"is this anchor still paying people?"* has no answer a wallet can verify. When an anchor quietly stops settling, the ledger shows it immediately — but nobody was reading the ledger for that purpose, so the first signal reaching a user is their own payment not arriving.

This has teeth on Stellar specifically because the network's whole value proposition is cross-border payments into markets where the recipient is least able to absorb a failure. A stalled remittance is not an inconvenience; and the party best placed to detect the stall — the anchor — is the party with the least incentive to announce it.

**Landfall answers it from the ledger instead.** Anchor accounts are discovered from SEP-1, their SEP-24 settlement legs are already public and permanent, and liveness, volume, counterparty concentration and refund rate are computed from what those accounts *did*. No anchor grants access. No anchor can withhold it. A TOML file can be edited in ten seconds; two years of settlement history cannot.

### Why it has to be Stellar

This is answerable because of how Stellar itself works, not despite it:

- **SEP-1** resolves a home domain to the accounts an anchor claims to operate — permissionlessly, with no cooperation required.
- **SEP-24** puts one leg of every deposit and withdrawal on the public ledger, so settlement behaviour is already there, retroactively, for every anchor — a prober starts collecting the day you switch it on, Landfall computed years of history on its first run.
- **CAP-67** (Protocol 23) turns per-account paging into one unified event stream, and makes mint/burn distinguishable from transfer instead of inferred.
- **SEP-38** firm quotes give slippage — quoted amount versus landed amount — a defined baseline, which nothing in the ecosystem publishes today.
- **x402** turns "can an agent pay?" into a solved problem, and leaves "who should an agent pay?" open — see below.
- **Soroban** publishes a digest of each dataset on-chain (deployed to testnet), so a contract can route on the same data a wallet reads from the API, and anyone can re-derive the digest and check it agrees.

Move any of this to a chain without those primitives and there is nothing left — it is not a generic app that happens to settle on Stellar.

### The agent gap

In July 2026 Stellar joined the [x402 Foundation](https://x402.org) alongside Visa, Stripe and
Google, standardising how software pays software with no human in the loop. Stellar's own
[x402 announcement](https://stellar.org/blog/foundation-news/x402-on-stellar) covers the
settlement path in detail — facilitators, spending limits, budget controls, stablecoin transfer
in about five seconds. It answers *how much* an agent may spend. It does not answer **who an
agent should be willing to pay.**

A human routing a payment has a fallback the protocol does not provide: they recognise the brand,
they have used it before, a colleague vouched for it. An autonomous agent has none of that. It
has a domain string and whatever that domain says about itself — which is the one input that can
be edited in ten seconds.

That is the gap Landfall was already built for, and why the MCP server matters more than its size
suggests: it is the interface through which an agent can ask *did this anchor actually settle?*
and get an answer computed from the ledger rather than supplied by the counterparty.

Nothing in this repository claims that gap is closed. No external agent queries Landfall today.
But the question is now the ecosystem's, not just ours.

**What is built, and what is not:**

| Capability | Status | Description |
|---|---|---|
| SEP-1 discovery | ✅ **shipping** | Permissionless domain $\rightarrow$ declared issuer/distribution accounts |
| Horizon indexing & incremental sync | ✅ **shipping** | Scheduled scan with fast `order=asc` cursor pagination (sub-minute runtime) |
| Liveness, volume, concentration, returns | ✅ **shipping** | Deterministic settlement metrics without requesting data from anchors |
| **Path payments (cross-asset flows)** | ✅ **shipping** | Extracts source & delivered asset pairs (`USD ➔ NGN`, `EUR ➔ BRL`) |
| **Settlement corridors API + export** | ✅ **shipping** | `GET /api/v1/corridors` with real-time matrix and compliance CSV export |
| **Anchor Reliability Score (0–100 & A–F)** | ✅ **shipping** | Deterministic health score based on liveness, throughput, and refund rates |
| **Pre-Flight Wallet Health Check API** | ✅ **shipping** | `GET /api/v1/anchors/:domain/health-check` for wallet routing checks |
| **Dynamic SVG Status Badges** | ✅ **shipping** | `GET /api/v1/badges/:domain.svg` for embedding live status badges in repos/docs |
| **Developer & Admin Portal** | ✅ **shipping** | `/portal.html` with self-serve auth, hashed API keys (`lf_live_...`), and webhooks |
| **Interactive API Documentation** | ✅ **shipping** | `/docs.html` with live try-it playground and badge renderer |
| **Model Context Protocol (MCP) Server** | ✅ **shipping** | `scripts/mcp/server.mjs` for AI agents (Claude, Cursor, Antigravity) |
| **x402 payee check** | ✅ **shipping, no facilitator** | `POST /api/v1/x402/check-payee`, `landfall_x402_check_payee` MCP tool — Trust Check for every Stellar `payTo` in a real x402 `accepts` array before an agent signs. Deliberately doesn't verify or settle a payment; that's the facilitator's job. Runnable worked example, no dependencies and no API key: [`examples/x402-payee-check`](examples/x402-payee-check). See `packages/x402` |
| **GraphQL API** | ✅ **shipping** | `POST /api/v1/graphql` for structured queries |
| Postgres persistence + REST API | ✅ **shipping** | Supabase Session Pooler + serverless Vercel function endpoints |
| Live transactions dashboard | ✅ **shipping** | `/dashboard.html` with dark account indicators and counterparty breakdown |
| Scheduled ledger scan (GitHub Actions) | ✅ **shipping** | Cron asks for hourly (`0 * * * *`); GitHub runs scheduled workflows best-effort, so the measured cadence over 24h is a **median 2.8h gap** (range 1.7–4.8h), starting a median 38 minutes past the hour. Every payload carries `asOf`/`staleHours` so a consumer reads the real age rather than trusting a schedule. `$0/month` hosting upkeep |
| **Anchor Route Scout** (`/compare.html`) | ⚠️ **partly real** | Reliability grades are ledger-derived. Fees are live where an anchor publishes SEP-24 terms, hardcoded catalogue otherwise. FX rates now check every anchor's SEP-38 quote server too — but as of this writing SEP-38 adoption among tracked anchors is close to zero, so the rate column is still mostly the catalogue spread. See [docs/gaps.md](docs/gaps.md) and `/api/v1/anchor-quotes.json` for exactly which anchor, if any |
| **Trust Check** (`/trust-check.html`) | ✅ **shipping** | Paste a Stellar address or transaction hash — live, ledger-only counterparty signals (observed history, counterparty concentration, pass-through/forwarding pattern), a transparent 0–100 score with every deduction traceable to a named flag, and a confidence rating that overrides the score when there isn't enough history to say anything. No external fraud database — none exists that this project can independently verify, and fabricating one would be the exact failure mode Landfall exists to catch elsewhere. See `packages/trust-check/src/analyze.ts` |
| **Fraud Reports** | ✅ **shipping** | `POST /api/v1/fraud-reports` — every report must cite a transaction Landfall verifies exists *and* involves the reported address before it is stored; unverifiable reports are rejected, not filed quietly at low weight. Shown on the Trust Check page in their own card, never blended into the score, and **report volume is never counted toward anything** — three reports is three strangers, which may be three victims or one person with three browsers. See `packages/fraud-reports` |
| **Dispute response** | ✅ **shipping** | `POST /api/v1/fraud-reports/:id/dispute` — the reported party answers, gated on an Ed25519 signature from that account's own key. Landfall never asks for or receives a secret key: the page shows the message to sign and takes back only the signature. The response travels with the accusation everywhere the report appears |
| **AI Investigator** (Sentinel's "Analyzed" stage) | ✅ **shipping, narrative needs a key** | `POST /api/v1/fraud-reports/:id/investigate` — splits into two strictly separate halves. **Cited facts** (the report's fields, the cited transaction re-fetched from Horizon, the subject's Trust Check flags) are deterministic and computed with **no AI at all**. The **narrative** is optional model-written prose over exactly those facts, labelled with the model that wrote it, and `null` whenever no key is configured. The model is never told how many other reports exist — feeding it a count risks it reading volume as corroboration, which is the one thing fraud reports must never become. See `packages/investigator` |
| **Dispute-response attestations** (Sentinel's "Attested" stage) | ✅ **shipping, one-sided on purpose** | `GET /api/v1/fraud-reports/:id/attestation` — a portable, verifiable record that the account holder **responded and proved control**. The accusation itself is never signed: a signature makes a claim permanent and portable, and a portable accusation travels stripped of the disclaimer and the response that hold it honest. So the payload carries no category, no reporter note and no evidence hash — asserted by a test, not just by intent. Signed when `STP_SIGNING_KEY` is set, otherwise a recomputable SHA-256 digest and `signed: false` |
| **Crypto Routes** (`/compare.html`, same page) | ✅ **shipping** | Live XLM→BTC/ETH/SOL/BNB quotes fetched client-side from [NEAR Intents](https://near-intents.org)' public 1Click API — real market rates, no API key, no backend. Informational only: Landfall never executes the swap. Stellar-side USDC isn't wired up yet (see the note in the page) |
| **Cross-chain evidence view** (`/cross-chain.html`) | ✅ **shipping** | Per-anchor settlement evidence across Stellar, EVM/CCTP, Tron and Solana, every figure labelled with the tier behind it |
| **STP attestation schema + signing** | ✅ **shipping** | `packages/stp` — one portable settlement-attestation shape, canonical serialization, Ed25519 sign/verify |
| **`ChainAdapter` layer** | ✅ **shipping** | Stellar (`PROVEN`), EVM/CCTP (`ATTESTED`), Tron + Solana (`DERIVED`) behind one interface — see [docs/architecture/MULTICHAIN.md](docs/architecture/MULTICHAIN.md) |
| **`pickAnchor()` evidence ranking** | ✅ **shipping, on npm** | `npm install @landfall/sdk` — ranks PROVEN → ATTESTED → DERIVED, so derived evidence can never outrank ledger-proven settlement. Deliberately no blended score. See `packages/sdk/README.md` |
| Non-Stellar anchor addresses | **not curated** | Every non-Stellar chain reports `unresolved`, not zero: no anchor has a verified address in `registry/anchors.registry.json` yet, and a guessed one would misattribute settlement |
| Recipient-confirmation proof binder | ✅ **shipping** | The weakest of three ways to bind DERIVED evidence, and the only one needing no anchor cooperation — a recipient's own report, tightly scoped (once per transfer, timed server-side, sender reports never bind). See `packages/adapters/src/fiatConfirmation.ts` |
| zkTLS / Proof-of-Reserve proof binder | **designed, not built** | The two stronger options — need a counterparty's cooperation or hard engineering. Until either exists the `DERIVED` adapters lean on recipient confirmation or emit nothing |
| Soroban smart contract oracle | **deployed to testnet** | Rust Soroban contract with 16 test cases, digest verification |
| CAP-67 event stream ingestion | schema ready | Ingestion pipeline planned |
| Live SEP-38 quote ingestion | ✅ **shipping, near-zero coverage** | `scripts/fetch-anchor-quotes.mjs` asks every tracked anchor's own quote server hourly. The mechanism is real; today essentially no tracked anchor runs SEP-38 against a corridor Route Scout shows for it, so most rates are still the catalogue estimate — stated per anchor, not hidden |
| Dark-anchor early warning (predictive) | **measured as not yet buildable** | The scan history now exists as a committed record (`data/scan-history.ndjson`, 5,900+ observations from 12 August, extended hourly). Measured against it, **exactly one account went dark in 26 days** (`slow → dark`, n=1) against 17 `live → slow` degradations. This roadmap item requires the false-positive rate be published, and one positive example cannot produce a rate that means anything — any threshold fits n=1 perfectly and generalises to nothing. Revisited on a count of going-dark events, not on a date. Full transition table in [data/README.md](data/README.md) |
| `pickAnchor()` multi-factor route scoring | **designed, not built** | Weighted score over payout, reliability, and degradation signal; needs real quotes first |
| Slippage: quoted versus landed | **designed, not built** | Depends on attestation (Horizon 2). Nothing in the ecosystem publishes this today |

We would rather list this honestly than let a roadmap read as a changelog. Full detail in [docs/gaps.md](docs/gaps.md) and [ROADMAP.md](ROADMAP.md).

## Current finding

From the scheduled ledger scan, most recently 6 September 2026, across 108 declared
anchor accounts on 27 Stellar home domains:

> **62 of 108 anchor accounts have processed no on-chain settlement in over 30 days.**
> A further 26 are slow (nothing in 3–30 days); 19 are settling; 1 has no payment
> history at all.

Two things this is not. It is **not a census** — the scan covers accounts seeded in
`packages/indexer/data/anchors.json` and discovered from their own SEP-1
declarations, which is a curated set, not every anchor on Stellar. And a dark
account is **not a failed anchor**: an issuer account that never moves, a rotated
account still declared in a stale `stellar.toml`, and an operator who has actually
stopped settling all look identical from the ledger. The figure is what the ledger
shows, not a verdict on any operator — see [DISPUTES.md](DISPUTES.md) if you run one
of these and think a specific figure is wrong.

Every figure ships with its transaction hashes — see `/dashboard.html` on the live
site, and `/api/v1/anchors.json` for the raw records behind it.

*(An earlier version of this section read "6 of 13 accounts", from the first scan on
12 August 2026. That number was true of that scan and is preserved in
[docs/gaps.md](docs/gaps.md) as
the dated record it is — the network tracked here has since grown from 5 domains to
27.)*

## Tech stack

| Layer | Technology |
|---|---|
| Indexer | TypeScript, Node.js 20+, `tsx`, `node:test` (zero-dep SEP-1/TOML parser, incremental cursor syncing) |
| API | Node.js serverless functions, read-only HTTP over `pg` with Supabase pooler |
| Web Portal | Vanilla HTML/CSS/JS (no framework bloat), responsive for mobile, GSAP loader |
| Oracle | Rust, Soroban SDK — deployed to testnet |
| AI Integration | Model Context Protocol (MCP) stdio server (`@modelcontextprotocol/sdk`) |
| Database | PostgreSQL (Supabase Session Pooler or local via Docker) |
| Deployment | Vercel (frontend + API proxy), GitHub Actions (scheduled ledger scan cron) |

## Getting started

**Whole stack, one command.** Requires Docker.

```bash
# Clone the repository
git clone https://github.com/ibochivincent-lang/landfall.git
cd landfall
cp .env.example .env

# Run full stack with local Postgres + Horizon
docker compose up
```

Brings up a local Stellar Quickstart node, Postgres with the schema applied, the indexer, and the API — no account anywhere, no mainnet, no credentials. Site on `:8080`, API on `:8787`, Horizon on `:8000`.

If you already run Postgres natively, port 5432 is taken and both servers will bind it — host
connections then reach the wrong one and fail with a password error against credentials that are
correct. Publish the container somewhere else instead:

```bash
POSTGRES_PORT=55432 docker compose up
```

**Just the indexer.** Requires Node 20+, no Docker, no database.

```bash
npm install
npm run anchors:discover  # propose new anchor domains from an independent directory
npm run discover          # resolve tracked anchor domains to on-chain accounts
npm run scan              # index payment history and print the finding
npm run scan:verify       # check the newest scan before it could be published
npm test                  # 342 tests, no network required
npm run typecheck
```

`anchors:discover` reads stellar.expert's anchor directory, drops anything
tagged malicious/unsafe/scam, and resolves what remains against SEP-1 — a
domain only reaches the seed list if it declares its own accounts. It reports
by default; `-- --write` applies. The directory is treated as a source of
candidates, never of truth.

Layout:

```
packages/contracts   Rust + Soroban oracle
packages/db          PostgreSQL schema
packages/indexer     ledger reader and metrics
packages/api         read-only HTTP API
packages/web         the public site and dashboard
```

Scan flags, deployment steps (Supabase, prod compose, Vercel, oracle), and the transactions dashboard are covered in [docs/architecture.md](docs/architecture.md) and [docs/deployment.md](docs/deployment.md).

### What it reports

```
DOMAIN                     ACCOUNT      IN      OUT     REFUNDS   RATE      LAST SEEN
--------------------------------------------------------------------------------------
example-anchor.com         GABC…WXYZ    1204    1190    47        3.90%     2.1h
```

Followed by a headline finding — the aggregate refund rate across every account with enough inbound traffic to support the claim.

### Admin / developer board

An internal `/admin` view for maintainers — backend health (scan status, table sizes, resume cursors), the full raw payment stream, and tracked-anchor management (added domains feed straight into the next scan, no redeploy needed). Session-based login only: scrypt-hashed passwords, httpOnly cookies, 24h expiry. There is no public sign-up route and it is not linked from the public nav.

```bash
npm run db:migrate
DATABASE_URL=... node scripts/create-admin.mjs <username>
```

Then log in at `/admin` on the deployed site, or `localhost:8080/admin` locally. Full setup notes in [docs/deployment.md](docs/deployment.md#admin-board).

## Environment variables

Copy `.env.example` to `.env` and adjust. Nothing in the example file is a secret — the local stack is deliberately credential-free so a contributor can start without asking anyone for anything.

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | For `--persist` | `postgres://landfall:landfall@localhost:5432/landfall` | Postgres connection string. |
| `HORIZON_URL` | No | `http://localhost:8000` | Horizon server. Point at `https://horizon.stellar.org` to scan mainnet anchors. |
| `SOROBAN_RPC_URL` | No | `http://localhost:8001` | Soroban RPC endpoint, for oracle interaction. |
| `SCAN_INTERVAL_SECONDS` | No | `900` | How often the indexer loop re-scans. |
| `DUST_THRESHOLD` | No | `0.01` | Minimum payment amount counted, to filter dust. |
| `MAX_RECORDS` | No | `10000` | Per-account record cap for a scan. |
| `PORT` | No | `8787` | API listen port. |
| `CORS_ORIGIN` | No | `*` | API CORS origin. |
| `ORACLE_CONTRACT_ID` | Only to publish on-chain | — | Deployed Soroban oracle contract id. |
| `ORACLE_ADMIN_SECRET` | Only to publish on-chain | — | Admin key for the oracle contract. Never commit this. |
| `SEP10_SERVER_SECRET` | For Stellar web auth | — | Server signing key (`S...`) for [SEP-10](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md). Unset means `/api/v1/auth` reports that web auth is disabled — no challenge, no token, nothing half-enabled. |
| `SEP10_HOME_DOMAIN` | No | `landfall-chi.vercel.app` | Home domain named in the challenge. Must match what the client expects, or its wallet will refuse to sign. |
| `SEP10_NETWORK_PASSPHRASE` | No | Public network | Set to the testnet passphrase to authenticate testnet accounts. |
| `SEP10_JWT_LIFETIME_SECONDS` | No | `86400` | Token lifetime. |
| `RESEND_API_KEY` | For password-reset emails | — | [Resend](https://resend.com) API key. Without it, the reset endpoint logs a clear failure instead of pretending to succeed. |
| `FROM_EMAIL` | Same as above | — | Sending address. Must be on a domain verified with Resend — it cannot send from a `vercel.app` subdomain this project doesn't control DNS for. |

## Documentation

| Document | What it covers |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Package layout, the request/scan flow, and where each piece runs. |
| [docs/architecture/MULTICHAIN.md](docs/architecture/MULTICHAIN.md) | The cross-chain design: the STP attestation schema, the `ChainAdapter` interface, and the evidence-tier ladder that keeps a custodial guess from reading as ledger truth. |
| [docs/methodology.md](docs/methodology.md) | Exactly how each published metric is computed, and where the method is weak. |
| [docs/TRUST.md](docs/TRUST.md) | What you have to trust to rely on this, stated plainly — including the one place you must trust a key rather than check a computation, and why the oracle is not on mainnet yet. |
| [docs/SECURITY_ASSESSMENT.md](docs/SECURITY_ASSESSMENT.md) | STRIDE and OWASP Top 10:2025 review, with findings cited to file and line — including one critical privilege escalation found and fixed, and what held up under review. |
| [docs/gaps.md](docs/gaps.md) | Honest inventory of what isn't built yet, ordered by how much each gap could hurt. |
| [docs/product-vision-status.md](docs/product-vision-status.md) | The product vision deck, module by module, checked against what's actually running. |
| [ROADMAP.md](ROADMAP.md) | What is built, what is next, and what is deliberately not being built. |
| [docs/deployment.md](docs/deployment.md) | Full deploy path: Supabase, production compose, Vercel, the oracle. |
| [docs/GRAPHQL_API.md](docs/GRAPHQL_API.md) | The `/api/v1/graphql` schema, examples, and how it reuses the REST resolvers. |
| [docs/MCP.md](docs/MCP.md) | Running the MCP server, its tools, and how to connect an agent to it. |
| [docs/backlog.md](docs/backlog.md) | Summary of the scoped, complexity-tagged issues filed on the tracker. |
| [docs/checklist.md](docs/checklist.md) | Current status snapshot: what is done, what is open. |
| [SECURITY.md](SECURITY.md) | Disclosure policy. |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | Includes a project-specific clause on discussing named anchors factually. |
| [DISPUTES.md](DISPUTES.md) | For a graded anchor operator: what a grade is and isn't, and how to challenge a specific figure. |

## Honesty rules

Constraints on the code, not aspirations:

1. **No number on the site that the code cannot prove.** Every published figure traces to indexed ledger records.
2. **Failures are visible.** A domain that will not resolve prints as `FAIL` — never silently dropped, because a missing anchor is itself a finding.
3. **Thin data is suppressed, not ranked.** A refund rate computed over three payments is noise dressed as a statistic. Accounts below `--min-inbound` are excluded from the headline.
4. **Heuristics are labelled**, everywhere they surface. Refund detection is a heuristic and says so. See [docs/methodology.md](docs/methodology.md).
5. **Degradation is stale, not broken.** There is no external probe to fail. If indexing stops, it resumes from the last cursor.
6. **Incoherent scans are not published.** Every scan is checked against the last published one before it can overwrite it ([`packages/indexer/src/invariants.ts`](packages/indexer/src/invariants.ts), run by [`scripts/verify-scan.ts`](scripts/verify-scan.ts) as a workflow step ahead of the publish). One on-chain account attributed to two anchors, a row belonging to no anchor, or payment counts moving implausibly between scans all block publication rather than ship. Rule 5 is why: a reader can see stale data, but cannot see a misattributed figure, so withholding beats publishing.

   This exists because it was needed. The site credited Circle's shared USDC issuer account to a named anchor — MoneyGram's `stellar.toml` cites that issuer correctly under SEP-1, and the discovery code read every cited issuer as the citing domain's own — so global stablecoin issuance traffic was published as one business's settlement record, and nothing objected. Discovery now confirms a cited issuer's own `home_domain` before attributing it, and these invariants are the second line for whatever the next version of that mistake looks like.

## Contributing

Issues are scoped and labelled by complexity. Start with `good first issue`; larger tickets are tagged `help wanted`.

See [CONTRIBUTING.md](CONTRIBUTING.md), [DEVELOPMENT.md](DEVELOPMENT.md), and [docs/backlog.md](docs/backlog.md) for the full backlog. All contributors are expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

```bash
npm run contracts:test   # oracle: 16 Rust tests
```

## Contributors

Thanks to everyone who has shipped code, docs, or infrastructure for Landfall.

| | |
|---|---|
| **Ibochi Vincent** ([@ibochivincent-lang](https://github.com/ibochivincent-lang)) | Lead — indexer, contract, project owner |
| Your name here | [Open a PR →](CONTRIBUTING.md) |

## License

MIT — see [LICENSE](LICENSE).
