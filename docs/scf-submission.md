# Landfall — SCF #45 submission pack

**Track: Integration** (infrastructure other projects consume — 26 of 46 awards in SCF #44)

Two parts: the short interest form (deadline **16 August 2026**) and a draft of the
full Build Award submission for when you're invited. Placeholders marked `[FILL]`
are things only you can answer — do not leave them in.

> **Figures verified 12 August 2026** against stellar.expert. That check found
> two defects in Landfall itself — both fixed, both covered by regression tests,
> both of which had caused it to *understate* dormancy. The numbers below are
> post-fix. Re-run the scan on the day you submit and update them.

---

# PART 1 — Interest form

Short. It only gates an invite, so submit it even if Part 2 isn't finished.

### What are you building?

> Landfall is a settlement-quality record for Stellar anchors, derived entirely
> from public ledger data. Existing anchor monitoring asks anchors how they are
> doing — pinging status endpoints, validating TOML files, reading quote APIs.
> All of those measure what an anchor reports about itself, and all of them are
> trivial to satisfy while failing users.
>
> Landfall measures what anchors actually did. It resolves anchor accounts from
> SEP-1 declarations, indexes their on-chain payment history, and publishes
> liveness, settlement volume, return-to-sender rates and counterparty
> concentration — none of which require the anchor's cooperation, and none of
> which can be faked without spending real money on-chain.
>
> A working indexer already exists. Scanning 13 anchor accounts across 5 domains
> on 12 August 2026, it found that **6 of 13 — nearly half — had processed no
> on-chain settlement in over 30 days**, including every account with payment
> history at one anchor. Some individual anchors are already flagged by hand in
> explorer directories; what does not exist is this computed continuously for
> every account, including the ones nobody has manually reviewed. Output is open
> data with transaction hashes attached, so every claim is independently
> checkable.
>
> The grant funds three things: memo-based leg correlation to turn the return
> metric from a heuristic into a measurement, a signed-attestation layer to
> cover the off-chain fiat leg, and an SDK plus Soroban oracle so wallets and
> contracts can route on the data programmatically.

### Which track?

Integration.

### Referred by anyone in the Stellar community?

`[FILL — leave blank if not. Do not invent one.]`

---

# PART 2 — Full Build Award submission (draft)

## 1. Problem

Three questions decide whether a stablecoin off-ramp goes well for someone
converting USDC to naira, cedi, or peso:

1. Which anchor delivers the best **landed** amount — not the advertised rate
2. Will the anchor honour the quote it just gave
3. Is the anchor actually operating right now

Today the only way to answer any of them is to ask the anchor. Every existing
monitoring approach — uptime pings, quote-endpoint checks, TOML validation,
issuer verification — measures self-reported state. Each of those four signals
can be satisfied in seconds by an anchor that is not paying anyone out.

An anchor can hold a perfect score on every available check and still be
failing every user it has.

## 2. The validated need

Landfall's indexer is built and running. A scan on 12 August 2026 covering
13 anchor accounts across cowrie.exchange, mykobo.co, anclap.com,
stellar.moneygram.com and ntokens.com, over 4,650 inbound payments:

| Finding | Value |
|---|---|
| Accounts with no on-chain settlement in over 30 days | **6 of 13 (46%)** |
| Accounts settling within the last 48 hours | 6 of 13 |
| Domains where every account with payment history is dark | **1** (ntokens.com) |
| Inbound payments in window (dust excluded) | 3,974 |
| Inbound payments returned to sender | 5 (0.13%) |
| Median time for a return to arrive | 0.3 hours (n=5) |

Two things follow.

**Nearly half of the anchor accounts we could discover are dormant, and nothing
surfaces that to a routing decision.** Individual anchors do get flagged by hand
— stellar.expert labels ntokens.com "Discontinued," for instance. But that is a
curated directory entry: someone noticed, and tagged it. There is no continuous,
computed dormancy signal covering every declared account, including the many
nobody has reviewed, and no machine-readable form a wallet or agent could route
on. That gap is what Landfall closes.

**The return metric proves the deeper problem.** 0.13% looks like a clean bill
of health — but a return is the *honest* failure mode. An anchor that accepts
value, fails to settle, and simply keeps the asset generates no return event and
scores 0.00%. That gap is exactly what the attestation layer in Tranche 2
exists to close, and it is why ledger data alone is necessary but not sufficient.

We are not claiming user traction. We are claiming a need validated by
measurement, using a tool that already runs.

### How these figures were checked

Every account in the scan was cross-checked against stellar.expert before
publication. That check found two defects in Landfall itself:

1. Liveness was being read from inside the analysis window, so an account whose
   last payment predated the window reported as having no history at all —
   hiding the most dormant account in the set.
2. Unsolicited dust payments were inflating activity counts, making abandoned
   accounts look busy and generating spurious return pairs.

Both are fixed, both carry named regression tests, and both had caused the tool
to *understate* dormancy — the dark count rose from 5 to 6 after the fix, and a
reported median return time of 11.7 days collapsed to 0.3 hours once phantom
pairs were removed.

We mention this because it is how the project intends to operate: every
published figure carries its transaction hashes, gets checked against an
independent source, and the methodology document states where the method is
weak before anyone else has to find out.

## 3. Solution and architecture

### Layer 1 — Ledger truth (built)

Under SEP-24 both flows leave on-chain traces: on a deposit the anchor sends the
asset to the user; on a withdrawal the user sends the asset to the anchor. So
the ledger already contains, for every anchor, retroactively, without permission:

- **Liveness** — last settlement activity. Unfakeable.
- **Deposit fulfilment** — anchor outbound payments, amounts and timing
- **Withdrawal intake** — inbound volume per asset
- **Return rate** — value sent back to senders
- **Concentration** — largest counterparty share of inbound volume

Implemented as: SEP-1 discovery (domain → declared accounts), a Horizon indexer
with pagination, exponential backoff and resume cursors, and metric computation
in integer stroops via BigInt so aggregate volumes never drift.

Because it reads a ledger rather than probing endpoints, the failure mode is
*stale*, not *broken* — an interrupted run resumes from its last cursor.

**This is retroactive.** A probing system collects data from the day it is
switched on. Landfall computes full history on first run, which removes the
cold-start problem that normally makes reputation products unusable at launch.

### Layer 2 — Attested outcomes (Tranche 2)

The fiat leg is invisible on-chain, so it requires attestation. Landfall accepts
settlement receipts containing the SEP-38 quote reference, the quoted amount,
the on-chain transaction hash, the amount that actually landed, and a signature
from the Stellar key that made the payment.

Because the receipt is bound to a real on-chain transaction, **attestation spam
costs real money** — you cannot flood the system with fabricated receipts
without funding genuine payments to the anchor you are trying to discredit.

The gap between quoted and landed amount is **slippage**, which no one in the
ecosystem currently measures.

### Layer 3 — Distribution (Tranche 3)

Distribution is an SDK, not a dashboard. People sending remittances do not
comparison-shop on websites; their wallet should choose for them.

```ts
import { pickAnchor } from '@landfall/sdk'
const ranked = await pickAnchor({ from: 'USDC', to: 'NGN', amount: 100 })
```

Plus a public API, an MCP server so payment agents can query anchor quality
natively, and a Soroban oracle publishing signed score digests on-chain for
contracts that route programmatically.

## 4. Why Stellar, specifically

This project cannot exist without Stellar's particular properties, and it is not
portable to another chain as a copy-paste.

- **SEP-1** gives a standard, machine-readable path from a domain to the accounts
  it claims — the discovery layer depends on it
- **SEP-24** puts one leg of every deposit and withdrawal on a public ledger,
  which is the entire data source
- **SEP-38** provides firm quotes with expiry, giving slippage a defined baseline
- **Soroban** allows scores to be published on-chain so other contracts can route
  on them, making this composable infrastructure rather than an external service

Stellar is the subject of the measurement and the substrate for publishing it,
not a storage backend.

## 5. Differentiation

The existing category is anchor *monitoring*: probe endpoints, validate TOMLs,
read status pages. Landfall is anchor *observation*: read the ledger.

| | Probing tools | Landfall |
|---|---|---|
| Data source | Anchor's self-report | Public ledger |
| History at launch | Starts at zero | Full retroactive history |
| Gameable | TOML editable in seconds | Requires real on-chain spend |
| Vantage point | One prober's network path | Globally consistent ledger state |
| Failure mode | Probe breaks, data lost | Resumes from cursor, stale only |
| Measures | Availability | Settlement behaviour |

Differentiation is a different data source, not a different interface.

## 5a. Timing: why this matters now

Stellar does not yet have x402 support, and SCF has an open RFP to build a
facilitator for it. When that lands, HTTP 402 becomes a machine-native payment
path and agents will be able to pay for services autonomously.

An agent that can pay still has to decide **who to pay**. Today there is no
machine-readable answer to "which anchor should this payment go through," and
an agent cannot read a status page or exercise judgement about a stale TOML
file. It needs structured reliability data with confidence attached.

That is what Landfall's SDK and MCP surface provide. The dataset is useful to
humans today and becomes infrastructure for agentic payments the moment x402
arrives on Stellar.

To be clear about the dependency: **Landfall is not blocked on x402.** Every
tranche below delivers value without it. The agent surface is positioned to
serve that ecosystem when it exists rather than betting on it.

---

## 6. Milestones

Total delivery **20 weeks**, mainnet by **Q1 2027**. The product roadmap extends
into 2028; this award funds the first three milestones only.

### Tranche 1 — MVP (weeks 1–6)

- Memo-based SEP-24 leg correlation, replacing amount-and-time heuristic matching
- Multi-region indexing to eliminate single-vantage assumptions
- Public dataset published with open methodology
- One corridor (USDC↔NGN) fully characterised across all discoverable anchors
- **Acceptance:** memo-correlated pairs distinguishable from heuristic matches in
  output; published dataset reproducible by a third party from the same ledgers

### Tranche 2 — Testnet (weeks 7–12)

- Signed settlement receipt schema, ingest, and signature verification against
  the referenced on-chain transaction
- Slippage metric: SEP-38 quoted amount versus attested landed amount
- Public REST/GraphQL API with a free tier
- `@landfall/sdk` published with `pickAnchor()`
- **Acceptance:** a forged receipt is rejected; a valid one links to its ledger
  record; SDK installable from npm and returns rankings against the live API

### Tranche 3 — Mainnet (weeks 13–20)

- Soroban oracle publishing signed score digests on-chain — **open source, MIT**
- MCP server exposing anchor quality to payment agents
- Anchor dispute portal
- Paid API tier live
- **Acceptance:** oracle deployed to mainnet, digests verifiable against the
  published dataset; at least one external consumer integrated

## 7. Budget

**Total requested: $50,000 USD in XLM**, one third of the $150K ceiling.

| Tranche | Scope | Weeks | Amount |
|---|---|---|---|
| 1 — MVP | Memo correlation, multi-region indexing, public dataset | 6 | $15,000 |
| 2 — Testnet | Attestation layer, slippage metric, API, SDK | 6 | $17,500 |
| 3 — Mainnet | Soroban oracle, MCP server, dispute portal, paid tier | 8 | $17,500 |
| | | **20** | **$50,000** |

This covers development of Stellar-integrated components only. No marketing
spend, no token allocation, no ineligible line items.

Across five contributors over twenty weeks this is approximately $2,000 per
person-month, reflecting a Lagos-based cost structure and a team working
`[FILL: part-time / full-time — state which, the arithmetic must be honest]`.
Operating costs after the grant are low by design: the system indexes a public
ledger and maintains no probe fleet.

## 8. Team

Five contributors, based in Lagos, Nigeria — in the corridor the project
measures.

| Name | Role | Owns |
|---|---|---|
| **Ibochi Vincent** | Project lead / architect | Methodology, published claims, tranche delivery |
| **Faith Adenuga** | Data & metrics engineer | Metric correctness, confidence intervals, suppression thresholds |
| **Oludare Ojo** | Indexer / backend engineer | Horizon indexing, multi-region collection, public API |
| **Adex Adeyemi** | Soroban engineer | On-chain oracle, signed score digests, contract tests |
| **Olukorode John** | SDK & integrations engineer | `@landfall/sdk`, MCP server, wallet partnerships |

`[FILL — one line of real background per person: prior shipped work, relevant
stack, links to GitHub or live projects. Do not skip this. Reviewers weigh
execution capacity heavily, and five names with no evidence behind them is
weaker than three names with proof.]`

Roles map directly onto the tranches: Tranche 1 is led by data and indexing,
Tranche 2 by backend and SDK, Tranche 3 by Soroban and integrations. No tranche
depends on a single person.

**Location is a qualification, not a footnote.** SCF's stated priority is
cross-border infrastructure for Latin America and Africa. This team lives in the
NGN corridor Landfall measures, uses these anchors, and knows which failures are
routine and which are alarming. That is not knowledge a team elsewhere can
substitute for.

> A note on titles: for a development grant, "project lead" or "technical lead"
> reads stronger than "CEO." Reviewers are assessing who will write the code and
> ship the tranches. Use "CEO" in investor contexts; use build titles here.

## 9. Open source

Everything is MIT, including the Soroban oracle contract. The published dataset
and the methodology are open, and every figure carries the transaction hashes
needed to reproduce it. A reputation system that cannot be audited has no claim
on anyone's trust.

---

# What reviewers will push on

Prepare answers. These are the weak points.

**"You have no users."**
Correct, and the criteria allow a validated need instead. The validation is a
working tool producing a finding nobody else publishes. Do not overstate — say
plainly that adoption is the Tranche 2 and 3 objective, and that the SDK is the
distribution mechanism.

**"Refund matching is a heuristic."**
Agreed — the methodology doc says so, publicly and in detail. Tranche 1 replaces
it with memo correlation. Volunteering a limitation before a reviewer finds it is
the strongest move available.

**"stellar.expert already flags discontinued anchors."**
It does, by hand, for anchors someone has reviewed. Landfall computes dormancy
for every declared account continuously, publishes it as open data with
transaction hashes, and exposes it in a form a wallet or agent can route on.
Curated directory versus computed signal — and the SDK is the difference between
a human reading a label and software acting on it.

**"Anchors won't like being scored."**
Landfall publishes observations plus an open formula, not opinions. A disputed
score is a disputed formula, recomputable by anyone. The dispute portal ships in
Tranche 3.

**"What stops this being abandoned?"**
Paid API tier in Tranche 3, and the operating cost is low — indexing a public
ledger, no probe fleet to maintain.

**"Why won't SDF just build this?"**
It is small, unglamorous, and adversarial to some ecosystem participants. It is
better done by an independent party, which is also what makes the output
credible.

**"Your roadmap runs to 2028 — why should we fund this now?"**
The award funds twenty weeks to mainnet, complete Q1 2027, with defined
acceptance criteria per tranche. 2028 is the product vision, not the grant
scope. Never let these two blur in conversation.

**"Is Landfall dependent on x402 shipping?"**
No. Every tranche delivers value to human users and wallet integrators without
it. The agent surface is positioned for x402 when it arrives — not contingent
on it.

---

# Pre-submission checklist

- [x] Verify findings against stellar.expert — done 12 Aug, two bugs found and fixed
- [ ] Push the repo public and link it in the submission
- [ ] Re-run the scan the day you submit so figures are current, and date them
- [ ] Add one line of real background per team member
- [ ] State whether the team is part-time or full-time, so the budget arithmetic holds
- [ ] Confirm no marketing or token costs in the budget
- [ ] Check that 2028 appears nowhere as a delivery date — only as roadmap horizon
- [ ] Read it once as a reviewer who has never heard of the project — it must
      stand alone with no follow-up questions
