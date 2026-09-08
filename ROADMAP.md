# Landfall — Master Roadmap

**Consolidated from:** [`docs/gaps.md`](docs/gaps.md) · [`docs/checklist.md`](docs/checklist.md) ·
[`docs/backlog.md`](docs/backlog.md) ·
the 13 August audit · verified GitHub issue tracker state.

**North star:** become the settlement-quality primitive Stellar wallets,
contracts, and payment agents route on — a ledger-derived reputation record
for anchors that needs no anchor's cooperation and cannot be gamed by editing
a TOML.

**Infrastructure test.** Landfall is infrastructure once external systems
depend on it: a wallet calls `pickAnchor()`, a Soroban contract reads the
oracle digest, an agent queries the MCP server — and removing Landfall breaks
them. Today nothing outside this repo depends on it yet. That is the honest
line every horizon below is measured against.

**Why the clock moved.** In July 2026 Stellar joined the
[x402 Foundation](https://x402.org) with Visa, Stripe and Google, standardising
autonomous software-to-software payment. Stellar's
[own announcement](https://stellar.org/blog/foundation-news/x402-on-stellar)
specifies the settlement path — facilitators, spending limits, budget controls —
and leaves the counterparty question open: an agent can now pay without a human,
but nothing tells it *who is safe to pay*. A human falls back on brand
recognition; an agent has only the domain's self-description, which is the one
input that can be edited in ten seconds.

This does not change what Landfall is. It changes who needs it, and how soon.
Every horizon below is ordered on the assumption that the consumer of this data
is increasingly a program rather than a person — machine-readable first,
dashboard second.

**As of 8 September 2026.** Horizon 0 is what a stranger can verify against the
repository and the live site today. Line items carry the backlog or issue
number that tracks them where one exists, so this page stays checkable rather
than becoming a second changelog.

---

## ✅ Horizon 0 — Already shipped, verified against the repo and the live site

- [x] Core thesis implemented: ledger observation instead of endpoint probing
- [x] SEP-1 discovery — home domain → declared on-chain accounts (`packages/indexer/src/toml.ts`)
- [x] Horizon indexer — fast `order=asc` cursor pagination, sub-minute sync runtime, retry/backoff
- [x] BigInt stroop arithmetic throughout — no float drift on aggregate volume
- [x] Refund-detection heuristic with documented limits (`docs/methodology.md`)
- [x] Liveness classification (live / slow / dark / no-activity) and dust filtering
- [x] **Path Payments Engine & Dual-Asset Tracking** — parses `source_amount` & `source_asset` for cross-asset payments
- [x] **Settlement Corridors Matrix (`/corridors`)** — cross-asset flow analytics with compliance CSV export
- [x] **Deterministic Anchor Reliability Score (0–100 & Grades A–F)** — liveness, throughput, and refund scoring
- [x] **Pre-Flight Wallet Health Check API (`/health-check`)** — real-time verification before SEP-24/SEP-31 execution
- [x] **Dynamic SVG Status Badges (`/badges/:domain.svg`)** — live status badges for repositories and docs
- [x] **Developer & Admin Portal (`/portal.html`)** — multi-user auth, API key hashing (`lf_live_...`), token-bucket rate limits, and webhooks
- [x] **Interactive Public API Docs (`/docs.html`)** — live interactive testing playground and badge previewer
- [x] **Model Context Protocol (MCP) Server (`scripts/mcp/server.mjs`)** — native AI agent stdio integration
- [x] 431 offline tests including a mock Horizon server; 25 Rust tests on the contract
- [x] Postgres schema — 27 tables including `portal_users`, `api_keys`, `user_webhooks`, applied and verified on Supabase
- [x] Read-only HTTP API — live, backed by Supabase pooler, deployed on Vercel
- [x] Transactions dashboard at `/dashboard.html` — keyset-paginated, dark account highlights, live ledger feeds
- [x] Soroban oracle written and **deployed to testnet** — 25 tests, publisher/admin roles split
- [x] Real mainnet scan — 13 accounts across candidate home domains
- [x] Headline finding cross-checked against stellar.expert: **6 of 13 accounts dark for 30+ days** — the August figure, kept as the dated record of what was verified then. Coverage has since grown to 108 accounts across 27 domains, and the current figure lives in the README
- [x] Automated **hourly scan via GitHub Actions** (`0 * * * *`), with `$0/month` hosting upkeep
- [x] GraphQL API at `/api/v1/graphql` — reuses REST resolvers directly (`docs/GRAPHQL_API.md`)

---

## 🎯 Horizon 1 — Close the "nothing runs on its own" gap

### Measurement — the highest-leverage engineering item open

- [ ] **Memo-based leg correlation** (backlog M1, SEP-24) — turns refund detection from a heuristic into a measurement
- [x] ~~**Persist the resume cursor between runs** (issue #13).~~ Shipped — `packages/indexer/src/cli.ts` reads a stored cursor per account with `--persist` and writes it back after each run, so a scan resumes instead of re-paging history it already has
- [ ] Investigate `vibrantapp.com` serving a TOML that parses to zero accounts — likely a parser gap, not an empty declaration

### Reconciling the site with reality

- [ ] Label or remove every claim still ahead of what's built. Mostly done — the SDK is on npm, webhooks are real (`user_webhooks`, dispatched by `scripts/dispatch-webhooks.mjs`), API keys are enforced as a rate-limit tier, and "Log in" is genuine SEP-10 web auth against the account's medium threshold. **What is still ahead of reality is the $99/mo pricing**: there is no billing behind it and no buyer has seen the number
- [x] ~~**Route Scout publishes invented rates and fees.**~~ Largely closed. The `GET /api/v1/quotes/compare` route — a second, server-side hardcoded catalogue, undocumented and unused by any page — was deleted outright rather than corrected. `scripts/fetch-anchor-fees.mjs` now reads each anchor's own published SEP-24 terms, and `scripts/fetch-anchor-quotes.mjs` asks every tracked anchor's SEP-38 quote server hourly. **What remains is a coverage problem, not an honesty one:** essentially no tracked anchor runs SEP-38 against a corridor Route Scout shows, so most rate cells are still a catalogue estimate — now labelled as such per anchor rather than presented as measured. See `/api/v1/anchor-quotes.json` for which anchor, if any, returned a real quote

---

## 🎯 Horizon 2 — Layer 2: attested outcomes and distribution (months 1–6)

- [x] **STP attestation format + cross-chain adapter layer** — `packages/stp` (schema, canonical
  serialization, Ed25519 sign/verify), `packages/adapters` (Stellar `PROVEN`, EVM/CCTP `ATTESTED`,
  Tron + Solana `DERIVED` behind one `ChainAdapter` interface), `packages/registry` (SEP-1 identity
  + the curated cross-chain address book), and `packages/sdk` (`crossChainScan()`, tier summaries,
  `pickAnchor()` evidence ranking). Rendered at `/cross-chain.html`, regenerated hourly. Spec and
  current state: [docs/architecture/MULTICHAIN.md](docs/architecture/MULTICHAIN.md)
- [ ] **Curate the first non-Stellar anchor address** — the adapters, the schema and the page all
  work; what's missing is a *verified* address for a real anchor on a real second chain. Every
  non-Stellar chain currently reports `unresolved`, which is honest but is not yet cross-chain
  coverage. This is the single item that turns ATTESTED from wiring into a measurement, and it is
  research, not code: a wrong address here misattributes a settlement to the wrong business, which
  is the one error `evidence_tier` cannot catch because it happens before attribution
- [ ] **zkTLS / Proof-of-Reserve proof binder** — until it exists the `DERIVED` adapters emit
  nothing at all rather than present a bare transfer as evidence it hasn't earned
- [ ] **Signed settlement receipt ingest** (backlog H1) — an attestation format so an anchor or user can assert the fiat leg, which the ledger alone cannot show
- [ ] **Slippage metric: quoted versus landed** (backlog H2) — depends on receipts; nothing in the ecosystem currently publishes this number. This is the number that makes Route Scout's rate column a measurement instead of a catalogue
- [ ] **Dark-anchor early warning** — an anchor rarely stops instantly: volume falls, counterparty concentration tightens, gaps between settlements stretch, then silence. Every scan is already stored, so the training data exists and nothing reads it back. A degradation signal 48–72h ahead is worth more to a wallet than an accurate post-mortem, Must ship with its false-positive rate published — an early warning that cries wolf about a named business is worse than none
- [ ] **`pickAnchor()` multi-factor route scoring** — one weighted score over net payout, reliability grade, and degradation signal, with the caller choosing the emphasis (safest / cheapest / fastest) rather than the formula choosing for them. Blocked on live SEP-38 quotes: optimising over a hardcoded rate table produces a confident recommendation from invented inputs, which is worse than no recommendation
- [ ] Talk to at least one wallet about embedding `pickAnchor()` — the roadmap's own infrastructure test is met by one external consumer, not by another shipped feature
- [x] ~~Publish `@landfall/sdk` with `pickAnchor()` to npm~~ (backlog H3) — published 7 September 2026, verified against the live registry copy rather than the local build
- [ ] **CAP-67 unified event ingestion** — replaces N per-account REST cursors with one ledger-wide stream, and makes mint/burn distinguishable from transfer instead of inferred
- [ ] Multi-region indexing, to remove the single-vantage-point assumption
- [x] ~~Expand anchor coverage past the current 8 candidate domains (5 resolving).~~ Now **27 domains and 108 accounts** in the latest scan. Still a sample rather than a census, and reported as one — but no longer the handful the original finding rested on
- [ ] Confidence intervals (Wilson score) on every published rate
- [ ] Roll metrics up to the domain level, so a reader isn't aggregating by eye across an anchor's several accounts

---

## 🎯 Horizon 3 — Layer 3: mainnet oracle and agent distribution (months 6–12+)

- [x] ~~**Wire the indexer to publish digests to the oracle after every persisted scan**~~ (issue #21) — `scripts/publish-oracle.mjs` runs in the hourly workflow and was verified end to end in a dry run. It no-ops while `ORACLE_ADMIN_SECRET` is unset, which is deliberate: switching it on waits on installing a distinct publisher key and making the admin account multisig
- [ ] Oracle to **mainnet**, once there is a real dataset worth publishing
- [x] ~~MCP server exposing anchor quality to payment agents~~ (issue #23) — shipped in Horizon 0, ahead of schedule; what's still open is a real external agent actually calling it
- [x] ~~Anchor dispute portal — doesn't exist yet.~~ Shipped: `POST /api/v1/fraud-reports/:id/dispute`, gated on an Ed25519 signature from the reported address rather than a password, with the response attached to the report wherever it appears. A signed attestation of that response is available at `GET /api/v1/fraud-reports/:id/attestation`. See `DISPUTES.md`
- [ ] Paid API tier — sustainability
- [ ] Move the repository to an organisation

---

## 🔁 Continuous doctrine goals (never "done")

These are the constraints in `DEVELOPMENT.md` and `README.md`, restated as
ongoing work rather than a one-time checklist:

- [ ] No number ships that the code cannot trace to indexed ledger records
- [ ] Failures stay visible — a domain that won't resolve prints `FAIL`, never a silent skip
- [ ] Thin data is suppressed, not ranked — respect `--min-inbound`
- [ ] Heuristics are labelled as heuristics everywhere they surface, not just in the methodology doc
- [ ] Degradation is stale, not broken — interrupted work resumes from a cursor, every API response carries `staleHours`
- [ ] Money arithmetic stays BigInt stroops — `toStroops`/`fromStroops` are the only conversion path
- [ ] `docs/gaps.md` is corrected in place as items close, never deleted clean

---

## ⚠️ Risks to actively retire

- [ ] **Account attribution is unverified** — a TOML declares accounts; nothing proves the domain operates them. This is the single largest correctness risk in the project → retired by attestation (Horizon 2)
- [ ] **Small sample** — 27 resolving domains is a real finding, not a census of the ecosystem. Materially better than the 5 this line was written against, and still not the whole ecosystem
- [ ] **The fiat leg is invisible** without attestation — we can prove value moved on-chain, not that anyone was paid → retired by signed settlement receipts
- [ ] **Anchors may object to being scored** → mitigated by publishing observations plus an open, recomputable formula, and by shipping the dispute portal rather than waiting for the first complaint (Horizon 3)
- [ ] **No stated position on legal pushback** from a named anchor over a negative finding — the code of conduct covers tone, nothing covers what happens if a lawyer writes in
- [ ] **Site claims ahead of reality.** Mostly retired: the SDK and MCP server both exist now, and login is real SEP-10 web auth. What remains is the invented $99/mo pricing, which has no billing behind it and no buyer has seen

---

---

## Dependencies and risks

**Wallet partnership is the critical path.** Layer 1 stands alone, but the
most valuable metric — slippage — requires attestors. Pursue wallet
conversations from week one, not after launch.

**Attribution is the main correctness risk**, restated above because it
gates more than one horizon: treat unresolved accounts as unknown rather than
guessing.

**Anchors may object to being scored.** Mitigated by publishing observations
plus an open formula, and by shipping the dispute path early rather than
after the first complaint.
