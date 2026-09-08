# Landfall — grant proposal

**The settlement record Stellar anchors cannot write themselves.** Landfall
reads the public ledger and publishes, permissionlessly, which anchors are
actually settling — so a wallet routing a remittance into Lagos, Buenos Aires
or Manila picks on evidence rather than on the anchor's own status page.

| | |
|---|---|
| **Submitted by** | ibochivincent-lang ([@ibochivincent-lang](https://github.com/ibochivincent-lang)) |
| **Repository** | [github.com/ibochivincent-lang/landfall](https://github.com/ibochivincent-lang/landfall) |
| **Live** | [landfall-chi.vercel.app](https://landfall-chi.vercel.app) |
| **SDK** | [`npm install @landfall/sdk`](https://www.npmjs.com/package/@landfall/sdk) |
| **License** | MIT |
| **Prepared** | 8 September 2026 |

> **Every figure in this document is checkable.** Each claim names the file,
> endpoint, or test behind it. Where something is not built, this document
> says so rather than dropping it from the list — the same rule the codebase
> holds itself to in [docs/gaps.md](gaps.md) and [docs/TRUST.md](TRUST.md).

## Contents

1. [Executive summary](#1-executive-summary)
2. [The problem](#2-the-problem)
3. [The thesis — four load-bearing primitives](#3-the-thesis--four-load-bearing-primitives)
4. [What has shipped](#4-what-has-shipped)
5. [What is deliberately not built](#5-what-is-deliberately-not-built)
6. [Roadmap](#6-roadmap)
7. [Why this, why now](#7-why-this-why-now)
8. [Ask and use of funds](#8-ask-and-use-of-funds)
9. [Risks and mitigations](#9-risks-and-mitigations)
10. [References](#10-references)

---

## 1. Executive summary

Stellar has the best stablecoin-to-fiat anchor coverage of any public chain,
and a set of SEPs — SEP-1, SEP-10, SEP-24, SEP-38 — that specify precisely how
an anchor should behave. What the ecosystem lacks is an **evidence layer**: an
independent record of whether any given anchor is honouring those specs in
practice.

Landfall is that layer. It does four things:

1. **Observes.** Discovers anchor accounts from SEP-1 and reads their on-chain
   SEP-24 settlement legs from Horizon. No anchor grants access; none can
   withhold it.
2. **Derives.** Computes liveness, settlement volume, counterparty
   concentration and refund rate as documented arithmetic over named flags —
   every score recomputable by hand from the evidence.
3. **Publishes.** Serves the record over REST, GraphQL, a published npm SDK,
   an 11-tool MCP server, and a Soroban oracle so contracts read the same
   digest wallets do.
4. **Refuses to guess.** Unresolved accounts report `unresolved`, thin samples
   are suppressed rather than ranked, and every payload carries
   `asOf`/`staleHours` so a stale answer is visible instead of served as
   current.

The product is live. This proposal funds the work that turns a working
system into infrastructure other systems depend on: a mainnet oracle behind
a proper key split, an external contract audit, and the first external
consumers.

## 2. The problem

An anchor is the bridge between the Stellar ledger and a real bank account. A
wallet routing a payment must pick one. Today that choice rests on three
inputs, and **all three are controlled by the anchor being assessed**:

| What a wallet can check | Who controls the answer |
|---|---|
| The `stellar.toml` at the home domain | The anchor — editable in ten seconds |
| The SEP-24 `/info` endpoint | The anchor — returns what it chooses |
| The anchor's status page | The anchor |

So *"is this anchor still paying people?"* has no independently verifiable
answer. When an anchor quietly stops settling, the ledger shows it
immediately — but nobody reads the ledger for that purpose, so the first
signal reaching a user is their own payment failing to arrive.

This matters more on Stellar than elsewhere. The network's value proposition
is cross-border payment into markets where the recipient can least absorb a
failure, and the party best placed to detect a stall — the anchor — has the
least incentive to announce it.

**Measured, not asserted.** Across 352 hourly scans covering 108 accounts on
28 domains (12 August – 8 September 2026, committed at
[`data/scan-history.ndjson`](../data/scan-history.ndjson)): 17 accounts
degraded from `live` to `slow`, and one went dark entirely. None of those
transitions was announced by the anchor. All were visible on the ledger the
hour they happened.

## 3. The thesis — four load-bearing primitives

### 3.1 Evidence-layer framing, and why not execution

The obvious next step from a comparison table is an "Execute" button.
Landfall has **declined** to build one, and the reason is structural rather
than a matter of sequencing: executing a payment means holding a key or a
session with one, which means custody. That is a different risk category from
everything else here — indexing a public ledger needs no permission and
cannot lose anyone's money; moving funds can.

This is enforced in the type system, not just in prose. `packages/intents`'
plan output assigns every step an explicit actor, and the comment above it
reads: *"Who performs a step. Never `landfall` for anything that moves
value."* Landfall appears on read-only steps only. See
[docs/architecture/VERIFIED_ROUTES.md](architecture/VERIFIED_ROUTES.md).

Being the evidence layer rather than the execution layer is the product
decision. An execution layer that also scores its counterparties has a
conflict a user cannot audit; an evidence layer that touches no funds does
not.

### 3.2 Verified routing

Route ranking never blends evidence into a single weighted score. In
`sortBy: "verified"` mode the reliability grade decides first, liquidity only
breaks grade ties, and price only breaks both. A cheaper route can never
outrank a better-evidenced one, because the moment those collapse into one
number, a large enough discount buys a good ranking.

The same rule governs cross-chain evidence: tiers are compared
lexicographically — `PROVEN` > `ATTESTED` > `DERIVED` — so 900 derived
observations never outrank 12 ledger-proven ones. Tested in
`packages/sdk`'s `pickAnchor()`.

### 3.3 The record, and what makes it hard to fake

Every scan is committed to the repository as an append-only observation log,
and the Soroban oracle publishes a digest of each dataset on-chain. A
consumer re-derives the digest from the published data and checks it agrees —
an oracle that asks you to trust it has missed the point of being an oracle.

The contract separates its two authorities: score and digest writes gate on a
**publisher** address, while `set_admin` gates on the **admin**. A leaked
hourly CI key can write bad scores — visible in the event stream,
recomputable from Horizon, revocable by rotating the key — but cannot take
the contract. Proven by `the_publisher_cannot_take_the_contract` and
`a_rotated_out_publisher_can_no_longer_write`, which use `mock_auths` rather
than `mock_all_auths` so the escalation check cannot pass vacuously.

### 3.4 The agent surface

In July 2026 Stellar joined the [x402 Foundation](https://x402.org),
standardising how software pays software with no human in the loop. x402
settles *how much* an agent may spend and leaves open *who it should be
willing to pay* — an agent has a domain string and whatever that domain says
about itself.

Landfall answers that question for the Stellar payees named in a real 402
response. `POST /api/v1/x402/check-payee` takes the `accepts` array, runs
Trust Check against every `payTo`, and returns a verdict per option — with
non-Stellar chains and Soroban contract addresses reported `supported: false`
with a stated reason rather than silently dropped. A worked, runnable example
is in [`examples/x402-payee-check`](../examples/x402-payee-check), where a
failed check refuses the payment rather than falling through to it.

## 4. What has shipped

All on `main`, MIT licensed, verifiable in the repository.

| Area | Shipped | Evidence |
|---|---|---|
| Ledger indexer | SEP-1 discovery → Horizon paging, resumable cursors, BigInt stroop arithmetic | `packages/indexer` |
| Observation record | 352 scans · 6,229 observations · 108 accounts · 28 domains, hourly, committed | [`data/scan-history.ndjson`](../data/scan-history.ndjson) |
| Reliability scoring | Deterministic 0–100 and A–F from liveness, throughput, refund rate | `computeDomainReliability()` |
| Trust Check | Ledger-only counterparty signals, transparent scoring, confidence override | `packages/trust-check`, `/trust-check.html` |
| Fraud Reports | Every report cites a tx verified to exist *and* involve the subject before storage | `packages/fraud-reports` |
| Dispute path | Signature from the reported address proves control — no passwords | `POST /api/v1/fraud-reports/:id/dispute` |
| AI Investigator | Deterministic cited facts, plus an optional labelled AI narrative over only those facts | `packages/investigator` |
| Intent + Route Engine | Route solving, verified-ranking mode, executable plans with explicit actors | `packages/intents` |
| Cross-chain evidence | Stellar `PROVEN`, EVM/CCTP `ATTESTED`, Tron + Solana `DERIVED` behind one interface | `packages/adapters` |
| Attestations | Canonical form, Ed25519 sign/verify, Merkle inclusion proofs | `packages/stp`, `packages/anchoring` |
| Soroban oracle | Deployed **testnet**; publisher/admin key split; 25 tests | `packages/contracts/landfall-oracle` |
| SDK | Published to npm, verified against the live registry copy | [`@landfall/sdk`](https://www.npmjs.com/package/@landfall/sdk) |
| MCP server | 11 tools over stdio | `scripts/mcp/server.mjs`, [docs/MCP.md](MCP.md) |
| x402 payee check | Trust Check for every Stellar payee in a 402 response | `packages/x402` |
| API | REST + GraphQL, rate limited, hashed API keys | `api/[...path].js` |
| Tests | **431 JavaScript + 25 Rust**, all green in CI | `npm test`, `cargo test` |
| Security posture | Documented trust assumptions and a STRIDE/OWASP assessment | [TRUST.md](TRUST.md), [SECURITY_ASSESSMENT.md](SECURITY_ASSESSMENT.md) |

## 5. What is deliberately not built

Stated because a proposal that lists only strengths is not checkable.

- **Payment execution.** See §3.1. Reversing this needs an explicit custody
  decision, not a feature request.
- **An x402 facilitator.** Verifying and settling payments means routing
  funds. Stellar already has a facilitator; duplicating it would be custody by
  another name.
- **A fraud database or reputation feed.** No external feed exists that this
  project can independently verify, and fabricating one would be the exact
  failure mode Landfall exists to catch in other tools.
- **Dark-anchor prediction.** Measured as not yet buildable: exactly one
  account went dark in 26 days (n=1) against 17 degradations. The roadmap
  requires a published false-positive rate, and one positive example cannot
  produce a meaningful one. Revisited on a count of events, not a date.

## 6. Roadmap

Each wave gates on merged work with CI green, not on a date.

| Wave | Theme | Deliverables | Gate |
|---|---|---|---|
| **v1 Observed** ✅ | A correct, public settlement record | Indexer, scoring, Trust Check, API, SDK, MCP, x402 check | Shipped |
| **v1.1 Hardened** | Key hygiene and audit readiness | Publisher key installed, admin account multisig, external contract audit applied for, backup for application tables | 30 days |
| **v2 On-chain** | Oracle on mainnet | Mainnet deploy behind the key split; publish wired to the hourly scan; reference consumer library | 90 days |
| **v3 Depended-upon** | The infrastructure test | One external consumer — a wallet calling `pickAnchor()` or an agent calling the MCP server — in production | 150 days |
| **v4 Attested** | Beyond ledger-only evidence | Signed settlement receipts; quoted-versus-landed slippage; first verified non-Stellar anchor address | 240 days |
| **v5 Predictive** | Early warning, if the data supports it | Degradation signal with a published false-positive rate — gated on enough going-dark events to hold out a validation set | Gated on evidence, not time |

## 7. Why this, why now

**Why this approach.** Every competing anchor monitor *interrogates* — pings
an endpoint, validates a TOML, records the answer the anchor chose to give.
Landfall *observes*. That difference is the entire product: a TOML can be
edited in ten seconds, and years of settlement history cannot.

**Why now.** Three things converge. Stellar joined the x402 Foundation in
July 2026, which makes "who should an agent pay?" an urgent question with no
answer. SEP-38 firm quotes give slippage a defined baseline for the first
time. And CAP-67 turns per-account paging into one unified event stream,
which is the ingestion path this indexer is designed to move onto.

**Why Stellar.** SEP-1 makes anchor discovery permissionless; SEP-24 puts one
leg of every deposit and withdrawal on a public ledger, retroactively, for
every anchor. A prober starts collecting the day you switch it on — Landfall
computed years of history on its first run. Move this to a chain without
those primitives and there is nothing left.

**Honest position on maturity.** The roadmap's own test is that Landfall
becomes infrastructure when external systems depend on it. **Nothing outside
this repository depends on it yet.** That is the gap this funding is meant to
close, and it is stated here rather than obscured.

## 8. Ask and use of funds

> **To complete before submitting:** the total figure and the reviewer-facing
> budget breakdown. The allocation below is the shape of the work; the amount
> should be set against the specific programme being applied to.

| Bucket | Share | Purpose |
|---|---|---|
| Core engineering | ~50% | Mainnet oracle behind the key split, CAP-67 ingestion, signed settlement receipts |
| Audit & security | ~20% | External Soroban contract audit, dependency and supply-chain tooling |
| Coverage & outreach | ~15% | Expanding past the current 28 domains; obtaining verified non-Stellar anchor addresses, which is research rather than code |
| Contributor funnel | ~10% | Issue triage, review capacity, reducing the single-maintainer bus factor |
| Infra & ops | ~5% | Hosting, monitoring, database backup beyond default retention |

Release against merged milestones, not dates.

## 9. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Account attribution is unverified** — a TOML declares accounts; nothing proves the domain operates them | Medium | High | The largest correctness risk in the data, stated in [gaps.md](gaps.md). Unresolved accounts report `unresolved` rather than being guessed; attestation (v4) retires it |
| **Oracle admin key compromise** | Low | High | Write authority is already split from admin authority in the contract. Remaining work is operational: install a distinct publisher key, make the admin multisig. [TRUST.md](TRUST.md) |
| **An anchor objects to a negative finding** | Medium | Medium | Every figure is recomputable from Horizon by a third party; the formula is published; a dispute path exists that requires proving control of the address rather than a password |
| **Small sample** — 28 domains is a finding, not a census | High | Medium | Stated wherever coverage is reported; thin data is suppressed rather than ranked |
| **Single-maintainer bus factor** | High | High | Every observation is committed to the repository rather than living only in a database; contributor funnel is funded in §8 |
| **Scan pipeline compromise** | Low | High | Detectable rather than prevented: every figure is independently recomputable, the observation history is committed, and every payload carries `asOf`/`staleHours` |

## 10. References

| | |
|---|---|
| Repository | [github.com/ibochivincent-lang/landfall](https://github.com/ibochivincent-lang/landfall) |
| Architecture — three planes | [docs/architecture.md](architecture.md) |
| Trust assumptions | [docs/TRUST.md](TRUST.md) |
| Security assessment (STRIDE / OWASP) | [docs/SECURITY_ASSESSMENT.md](SECURITY_ASSESSMENT.md) |
| Methodology | [docs/methodology.md](methodology.md) |
| Known gaps, kept as a record | [docs/gaps.md](gaps.md) |
| Roadmap | [ROADMAP.md](../ROADMAP.md) |
| MCP server | [docs/MCP.md](MCP.md) |
| Verified routing | [docs/architecture/VERIFIED_ROUTES.md](architecture/VERIFIED_ROUTES.md) |
| Cross-chain evidence tiers | [docs/architecture/MULTICHAIN.md](architecture/MULTICHAIN.md) |
| x402 worked example | [examples/x402-payee-check](../examples/x402-payee-check) |
| Observation record | [data/scan-history.ndjson](../data/scan-history.ndjson) |
| SEP-1 · SEP-10 · SEP-24 · SEP-38 | [stellar.org/protocol](https://stellar.org/protocol) |
| x402 | [x402.org](https://x402.org) · [Stellar's announcement](https://stellar.org/blog/foundation-news/x402-on-stellar) |
