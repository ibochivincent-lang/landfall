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

**As of 13 August 2026.** Horizon 0 is what a stranger can verify against the
repository and the live site today. Line items carry the backlog or issue
number that tracks them where one exists, so this page stays checkable rather
than becoming a second changelog.

---

## ✅ Horizon 0 — Already shipped, verified against the repo and the live site

- [x] Core thesis implemented: ledger observation instead of endpoint probing
- [x] SEP-1 discovery — home domain → declared on-chain accounts (`packages/indexer/src/toml.ts`)
- [x] Horizon indexer — pagination, retry/backoff, per-run resume cursor support
- [x] BigInt stroop arithmetic throughout — no float drift on aggregate volume
- [x] Refund-detection heuristic with documented limits (`docs/methodology.md`)
- [x] Liveness classification (live / slow / dark / no-activity) and dust filtering
- [x] 35 offline tests including a mock Horizon server; 16 Rust tests on the contract
- [x] Postgres schema — 12 tables, applied and verified on real Postgres
- [x] Read-only HTTP API — live, backed by Supabase, deployed on Vercel
- [x] Transactions dashboard at `/dashboard` — keyset-paginated, live-only by design (no stale snapshot)
- [x] Soroban oracle written and **deployed to testnet** — 16 tests, admin key set. Not on mainnet; the indexer does not publish to it yet, so it is a deployed contract, not a running oracle
- [x] Real mainnet scan — 13 accounts, 5 home domains, ~4,000 payments
- [x] Headline finding cross-checked against stellar.expert: **6 of 13 accounts dark for 30+ days**
- [x] Two self-found measurement bugs fixed with named regression tests (liveness read inside the `--since` window; dust inflating phantom refund pairs)
- [x] 20 contributor issues filed and labelled `Stellar Wave` (#4–#23)
- [x] Stellar-branded site redesign, merged (PR #24), live at [landfall-ib.vercel.app](https://landfall-ib.vercel.app)
- [x] Automated daily scan via GitHub Actions, feeding a static JSON API
- [x] Repository public at `ibochivincent-lang/landfall`

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

- [ ] Label or remove every claim still ahead of what's built: invented $99/mo pricing, "Get API access" implying access control that doesn't exist, "Log in" with no accounts behind it, an advertised SDK/MCP server/webhooks that aren't built yet
- [ ] Make a deliberate call on the AI chat explorer feature that shipped outside this backlog — decide whether it belongs in the grant pitch or gets held back, since it cuts against the "infrastructure, not application" positioning the whole submission argues for

---

## 🎯 Horizon 2 — Layer 2: attested outcomes and distribution (months 1–6)

- [ ] **Signed settlement receipt ingest** (backlog H1) — an attestation format so an anchor or user can assert the fiat leg, which the ledger alone cannot show
- [ ] **Slippage metric: quoted versus landed** (backlog H2) — depends on receipts; nothing in the ecosystem currently publishes this number
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
- [ ] **MCP server** exposing anchor quality to payment agents (issue #23)
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
