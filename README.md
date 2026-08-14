# Landfall

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/ibochivincent-lang/landfall/actions/workflows/ci.yml/badge.svg)](https://github.com/ibochivincent-lang/landfall/actions/workflows/ci.yml)
[![Deployed on Vercel](https://img.shields.io/badge/Deployed-Vercel-black?logo=vercel)](https://landfall-ib.vercel.app)

**Did the money land?**

A settlement-quality record for Stellar anchors, computed entirely from the public ledger — not from asking the anchor.

Every existing anchor monitor *interrogates* — pings an endpoint, validates a `stellar.toml`, records the answer the anchor chose to give. Landfall *observes* — it reads what anchor accounts actually did on-chain under SEP-24, and turns that into liveness, settlement volume, counterparty concentration, and refund rate. A TOML file can be edited in ten seconds. Two years of settlement history cannot.

**Live: [landfall-ib.vercel.app](https://landfall-ib.vercel.app)**

> **Submitted to the Drips Stellar Wave Program.** Issues are labelled by
> complexity — `trivial-100`, `medium-150`, `high-200` — and tagged
> `Stellar Wave`. New contributors should start with `good first issue`, and
> **wait to be assigned before writing code** — an unassigned issue is not
> yours. See [CONTRIBUTING.md](CONTRIBUTING.md).

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

Someone sending money home through a Stellar anchor cannot tell whether that anchor is actually operating. Neither can the wallet that offered it to them. The anchor's own status endpoint says it is fine, because status endpoints say what the anchor decides they say.

This is answerable because of how Stellar itself works, not despite it:

- **SEP-1** resolves a home domain to the accounts an anchor claims to operate — permissionlessly, with no cooperation required.
- **SEP-24** puts one leg of every deposit and withdrawal on the public ledger, so settlement behaviour is already there, retroactively, for every anchor — a prober starts collecting the day you switch it on, Landfall computed years of history on its first run.
- **CAP-67** (Protocol 23) turns per-account paging into one unified event stream, and makes mint/burn distinguishable from transfer instead of inferred.
- **SEP-38** firm quotes give slippage — quoted amount versus landed amount — a defined baseline, which nothing in the ecosystem publishes today.
- **Soroban** publishes a digest of each dataset on-chain (deployed to testnet), so a contract can route on the same data a wallet reads from the API, and anyone can re-derive the digest and check it agrees.

Move any of this to a chain without those primitives and there is nothing left — it is not a generic app that happens to settle on Stellar.

**What is built, and what is not:**

| | Status |
|---|---|
| SEP-1 discovery | ✅ shipping |
| Horizon indexing, resumable cursors | ✅ shipping |
| Liveness, volume, concentration, returns | ✅ shipping |
| **Path payments (cross-asset trades)** | ✅ **shipping** |
| **Settlement corridors API + dashboard** | ✅ **shipping** |
| **CSV export for compliance reporting** | ✅ **shipping** |
| Postgres persistence + read API | ✅ shipping |
| Transactions dashboard | ✅ shipping |
| **Hourly ledger scan (GitHub Actions)** | ✅ **shipping** |
| **Admin developer board (session auth, backend health, payment browser, anchor management)** | ✅ **shipping** |
| Hosted deployment (Supabase, prod compose, Vercel) | ✅ shipping |
| Soroban oracle | **deployed to testnet**, 16 tests, not on mainnet |
| CAP-67 event ingestion | schema ready, ingestion **not written** |
| SEP-38 slippage / attestations | **designed, not built** |
| `@landfall/sdk`, MCP server | **designed, not built** |

We would rather list this honestly than let a roadmap read as a changelog. Full detail in [docs/gaps.md](docs/gaps.md) and [ROADMAP.md](ROADMAP.md).

## Current finding

From the scan of 12 August 2026, across 13 anchor accounts on 5 home domains:

> **6 of 13 anchor accounts have processed no on-chain settlement in over 30 days.**
> Every account with payment history at one anchor is dark.

Verified against stellar.expert. Every figure ships with its transaction hashes — see [What it reports](#what-it-reports) below and the `/dashboard` on the live site.

## Tech stack

| Layer | Technology |
|---|---|
| Indexer | TypeScript, Node.js 20+, `tsx`, `node:test` (zero-dep SEP-1/TOML parser) |
| API | TypeScript, Node.js, read-only HTTP over `pg` |
| Web | Static HTML/CSS/JS, GSAP for the scan-loader animation |
| Oracle | Rust, Soroban SDK — deployed to testnet |
| Database | PostgreSQL (Supabase-hosted, or local via Docker) |
| Deployment | Vercel (site + API proxy), Docker Compose (self-host), GitHub Actions (CI + daily scan) |

## Getting started

**Whole stack, one command.** Requires Docker.

```bash
git clone https://github.com/ibochivincent-lang/landfall.git
cd landfall
cp .env.example .env
docker compose up
```

Brings up a local Stellar Quickstart node, Postgres with the schema applied, the indexer, and the API — no account anywhere, no mainnet, no credentials. Site on `:8080`, API on `:8787`, Horizon on `:8000`.

**Just the indexer.** Requires Node 20+, no Docker, no database.

```bash
npm install
npm run discover     # resolve anchor domains to on-chain accounts
npm run scan          # index payment history and print the finding
npm test              # 35 tests, no network required
npm run typecheck
```

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

## Documentation

| Document | What it covers |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Package layout, the request/scan flow, and where each piece runs. |
| [docs/methodology.md](docs/methodology.md) | Exactly how each published metric is computed, and where the method is weak. |
| [docs/gaps.md](docs/gaps.md) | Honest inventory of what isn't built yet, ordered by how much each gap could hurt. |
| [ROADMAP.md](ROADMAP.md) | Milestones mapped to the Stellar Community Fund Build Award's three tranches. |
| [docs/deployment.md](docs/deployment.md) | Full deploy path: Supabase, production compose, Vercel, the oracle. |
| [docs/backlog.md](docs/backlog.md) | Summary of the scoped, complexity-tagged issues filed on the tracker. |
| [docs/checklist.md](docs/checklist.md) | Current status snapshot against the Stellar Wave / SCF checklist. |
| [docs/scf-submission.md](docs/scf-submission.md) | Interest-form answers and the full Build Award draft. |
| [SECURITY.md](SECURITY.md) | Disclosure policy. |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | Includes a project-specific clause on discussing named anchors factually. |

## Honesty rules

Constraints on the code, not aspirations:

1. **No number on the site that the code cannot prove.** Every published figure traces to indexed ledger records.
2. **Failures are visible.** A domain that will not resolve prints as `FAIL` — never silently dropped, because a missing anchor is itself a finding.
3. **Thin data is suppressed, not ranked.** A refund rate computed over three payments is noise dressed as a statistic. Accounts below `--min-inbound` are excluded from the headline.
4. **Heuristics are labelled**, everywhere they surface. Refund detection is a heuristic and says so. See [docs/methodology.md](docs/methodology.md).
5. **Degradation is stale, not broken.** There is no external probe to fail. If indexing stops, it resumes from the last cursor.

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
| **Ibochi Vincent** | Lead — indexer, contract, project owner |
| **Mamavee001** | Contributor |
| Your name here | [Open a PR →](CONTRIBUTING.md) |

## License

MIT — see [LICENSE](LICENSE).
