# Landfall — Master Roadmap

**Consolidated from:** [`docs/gaps.md`](docs/gaps.md) · [`docs/checklist.md`](docs/checklist.md) ·
[`docs/backlog.md`](docs/backlog.md) · [`docs/scf-submission.md`](docs/scf-submission.md) ·
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

**As of 13 August 2026.** Horizon 0 is what a stranger can verify against the
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
- [x] 35 offline tests including a mock Horizon server; 16 Rust tests on the contract
- [x] Postgres schema — 15+ tables including `portal_users`, `api_keys`, `user_webhooks`, applied and verified on Supabase
- [x] Read-only HTTP API — live, backed by Supabase pooler, deployed on Vercel
- [x] Transactions dashboard at `/dashboard.html` — keyset-paginated, dark account highlights, live ledger feeds
- [x] Soroban oracle written and **deployed to testnet** — 16 tests, admin key set
- [x] Real mainnet scan — 13 accounts across candidate home domains
- [x] Headline finding cross-checked against stellar.expert: **6 of 13 accounts dark for 30+ days**
- [x] Automated **hourly scan via GitHub Actions** (`0 * * * *`), with `$0/month` hosting upkeep
- [x] GraphQL API at `/api/v1/graphql` — reuses REST resolvers directly (`docs/GRAPHQL_API.md`)

---

## 🎯 Horizon 1 — Close the "nothing runs on its own" gap + grant resubmission (now → SCF deadline)

### Grant path — the only item on this page with a hard clock

- [ ] Submit the SCF #45 interest form — **deadline 16 August 2026**
- [ ] Fill the remaining `[FILL]`s in `docs/scf-submission.md`: one line of real background per team member with a link, and whether the team is part-time or full-time (the budget arithmetic depends on it)
- [ ] Apply the repo to the Stellar Wave in Drips — the 20 issues are filed; the application itself is not made
- [ ] Re-run the scan on submission day and update every figure that moved

### Measurement — the highest-leverage engineering item open

- [ ] **Memo-based leg correlation** (backlog M1, SEP-24) — turns refund detection from a heuristic into a measurement; also Tranche 1 of the grant, so this is milestone work either way
- [ ] **Persist the resume cursor between runs** (issue #13) — a fix exists and is unshipped; closing it stops every run re-paging history it already has
- [ ] Investigate `vibrantapp.com` serving a TOML that parses to zero accounts — likely a parser gap, not an empty declaration

### Reconciling the site with reality

- [ ] Label or remove every claim still ahead of what's built: invented $99/mo pricing, "Get API access" implying access control that doesn't exist, "Log in" with no accounts behind it, an advertised SDK/webhooks that aren't built yet
- [ ] **Route Scout publishes invented rates and fees — highest-priority honesty fix.** `/compare.html` says it compares anchors by "payout, fees, speed, and verified on-chain settlement reliability" and footers "no anchor self-reporting", while `GET /api/v1/quotes/compare` serves a hardcoded catalogue: static FX rates, per-anchor `rateSpread`, `feePercent`, `feeFixedUsd` and payout speeds, none of them fetched from anywhere. The reliability column is real; every commercial figure beside it is invented and attributed to a named business. Either label the rate/fee columns as illustrative until SEP-38 ingestion lands, or drop those columns and ship the reliability comparison alone. See [docs/gaps.md](docs/gaps.md)
- [ ] Make a deliberate call on the AI chat explorer feature that shipped outside this backlog — decide whether it belongs in the grant pitch or gets held back, since it cuts against the "infrastructure, not application" positioning the whole submission argues for

---

## 🎯 Horizon 2 — Layer 2: attested outcomes and distribution (months 1–6)

- [ ] **Signed settlement receipt ingest** (backlog H1) — an attestation format so an anchor or user can assert the fiat leg, which the ledger alone cannot show
- [ ] **Slippage metric: quoted versus landed** (backlog H2) — depends on receipts; nothing in the ecosystem currently publishes this number. This is the number that makes Route Scout's rate column a measurement instead of a catalogue
- [ ] **Dark-anchor early warning** — an anchor rarely stops instantly: volume falls, counterparty concentration tightens, gaps between settlements stretch, then silence. Every scan is already stored, so the training data exists and nothing reads it back. A degradation signal 48–72h ahead is worth more to a wallet than an accurate post-mortem, and it is the natural Tranche 2 milestone. Must ship with its false-positive rate published — an early warning that cries wolf about a named business is worse than none
- [ ] **`pickAnchor()` multi-factor route scoring** — one weighted score over net payout, reliability grade, and degradation signal, with the caller choosing the emphasis (safest / cheapest / fastest) rather than the formula choosing for them. Blocked on live SEP-38 quotes: optimising over a hardcoded rate table produces a confident recommendation from invented inputs, which is worse than no recommendation
- [ ] Talk to at least one wallet about embedding `pickAnchor()` — one real conversation in progress outweighs three more shipped features in a grant application
- [ ] Publish `@landfall/sdk` with `pickAnchor()` to npm (backlog H3)
- [ ] **CAP-67 unified event ingestion** — replaces N per-account REST cursors with one ledger-wide stream, and makes mint/burn distinguishable from transfer instead of inferred
- [ ] Multi-region indexing, to remove the single-vantage-point assumption
- [ ] Expand anchor coverage past the current 8 candidate domains (5 resolving) — "6 of 13 dark" is a real finding about a small sample, not a census
- [ ] Confidence intervals (Wilson score) on every published rate
- [ ] Roll metrics up to the domain level, so a reader isn't aggregating by eye across an anchor's several accounts

---

## 🎯 Horizon 3 — Layer 3: mainnet oracle and agent distribution (months 6–12+)

- [ ] **Wire the indexer to publish digests to the oracle after every persisted scan** (issue #21) — the gap between "deployed contract" and "running oracle"
- [ ] Oracle to **mainnet**, once there is a real dataset worth publishing
- [x] ~~MCP server exposing anchor quality to payment agents~~ (issue #23) — shipped in Horizon 0, ahead of schedule; what's still open is a real external agent actually calling it
- [ ] Anchor dispute portal — promised by the code of conduct and security policy today; doesn't exist yet
- [ ] Paid API tier — sustainability without grant dependence
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
- [ ] **Small sample** — 5 resolving domains is a real finding, not a census of the ecosystem → retired by coverage expansion (Horizon 2)
- [ ] **The fiat leg is invisible** without attestation — we can prove value moved on-chain, not that anyone was paid → retired by signed settlement receipts
- [ ] **Anchors may object to being scored** → mitigated by publishing observations plus an open, recomputable formula, and by shipping the dispute portal rather than waiting for the first complaint (Horizon 3)
- [ ] **No stated position on legal pushback** from a named anchor over a negative finding — the code of conduct covers tone, nothing covers what happens if a lawyer writes in
- [ ] **Site claims ahead of reality** (invented pricing, login with no accounts, an advertised SDK/MCP that don't exist) → retired by the labelling pass in Horizon 1

---

## 📊 Success metrics per horizon

| Horizon | The bar |
|---|---|
| H1 — SCF deadline (~days) | Interest form submitted; Wave application made; memo correlation shipped; resume cursors closed (#13); every site claim matches what's built |
| H2 (months 1–6) | ≥1 signed settlement receipt ingested; slippage metric live; ≥1 wallet conversation in progress; `@landfall/sdk` published to npm |
| H3 (months 6–12+) | Oracle publishing real digests on testnet continuously; mainnet oracle live with a seeded dataset; ≥1 external MCP/agent consumer; dispute portal live |

---

## Dependencies and risks (from the original tranche plan)

**Wallet partnership is the critical path.** Layer 1 stands alone, but the
most valuable metric — slippage — requires attestors. Pursue wallet
conversations from week one, not after launch.

**Attribution is the main correctness risk**, restated above because it
gates more than one horizon: treat unresolved accounts as unknown rather than
guessing.

**Anchors may object to being scored.** Mitigated by publishing observations
plus an open formula, and by shipping the dispute path early rather than
after the first complaint.
