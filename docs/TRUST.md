# Trust assumptions

What you have to trust to rely on Landfall, stated plainly, including the
parts that are weak. If you are auditing this project, or deciding whether to
route money on its output, this is the page to read first.

Last reviewed: 8 September 2026.

---

## The short version

Almost everything Landfall publishes is **independently recomputable** — it is
derived from Stellar's public ledger, and anyone can re-derive it from Horizon
without asking Landfall or any anchor for permission. That is the whole design.

There is exactly one place where you must trust a key rather than check a
computation: **the Soroban oracle's admin key.** Everything below builds to
that, because it is the load-bearing weakness.

---

## What you do NOT have to trust

| | Why |
|---|---|
| Anchor cooperation | Accounts are discovered from SEP-1 TOMLs and read off the public ledger. No anchor grants access, and none can withhold it |
| Landfall's arithmetic | Every score is a documented deduction from named flags ([methodology.md](methodology.md)). Recompute it by hand from the evidence |
| Landfall's honesty about a fraud report | Every report cites a transaction verified to exist *and* involve the subject before storage. Report volume is never counted toward anything |
| The AI narrative | It is labelled with the model that wrote it and is generated from a fixed list of cited facts shown alongside it. Deterministic facts compute with no model at all |
| Attestation signatures | Signed or not, every attestation carries a SHA-256 digest of its canonical form that anyone can recompute from the body |

---

## What you DO have to trust

### 1. The oracle admin key — the single biggest risk

`packages/contracts/landfall-oracle` gates `set_score`, `set_scores` and
`set_admin` on one `require_auth()` against **one stored address**, with **no
timelock**. Whoever controls that key can rewrite the published state of every
tracked anchor, or hand the contract to a new admin, in a single transaction
with no delay and no second party.

For a contract whose purpose is to be a tamper-resistant reputation record,
that is the weakness that matters most.

**Current status:** the oracle is deployed to **testnet only**. No mainnet
oracle exists, `ORACLE_ADMIN_SECRET` is not set in this repository's CI, and
nothing on mainnet currently depends on it. The risk described here is
therefore **prospective** — it becomes live the moment the oracle goes to
mainnet, and it must be resolved *before* that, not after.

**Two mitigations, and the difference matters:**

- **Multisig needs no contract change.** `require_auth()` on a Stellar
  `G...` account delegates to that account's own signers and thresholds.
  Making the admin a Stellar account with several signers and a raised medium
  threshold gives real multisig using a native Stellar primitive — no redeploy,
  no custom code. This is the cheapest meaningful hardening available and
  should be a precondition for mainnet.
- **A timelock does need contract work.** Delaying `set_admin` so a handover
  is visible before it takes effect cannot be done from the account side; it
  needs a contract change or a contract-based admin.

The contract already emits `AdminChanged` on every handover, so a takeover is
publicly visible in the event stream. **Nothing currently watches for it.**

### 2. The scan pipeline's integrity

Published JSON is written by an hourly GitHub Actions run. If that workflow
were compromised — a malicious dependency, a workflow-trigger abuse — the
published record could be falsified without touching the ledger.

Mitigating factors: every figure is recomputable from Horizon by a third
party, the full observation history is committed to this repository
([`data/scan-history.ndjson`](../data/scan-history.ndjson)), and every payload
carries `asOf`/`staleHours` so a stale or missing update is visible rather
than silent. It is *detectable*, not *prevented*.

### 3. The API's availability, not its truthfulness

Landfall is a Vercel function over Supabase Postgres. Both can go down. A
consumer should treat an unreachable or stale Landfall as **unknown**, never
as a pass — see `examples/x402-payee-check`, where a failed check refuses the
payment rather than falling through to it.

### 4. Account attribution

A SEP-1 TOML declares which accounts a domain operates. Nothing proves the
domain actually operates them. This is the largest correctness risk in the
data itself, is stated in [gaps.md](gaps.md) and [ROADMAP.md](../ROADMAP.md),
and is why unresolved accounts are reported as `unresolved` rather than
guessed.

---

## Keys and secrets

| Secret | Where it lives | What it can do | Rotation |
|---|---|---|---|
| `ORACLE_ADMIN_SECRET` | GitHub Actions secret (**currently unset**) | Rewrite any published oracle score; transfer admin | None automated |
| `STP_SIGNING_KEY` | GitHub Actions secret (**currently unset**) | Sign attestations as Landfall. Cannot alter ledger-derived data | None automated |
| `DATABASE_URL` | GitHub Actions + Vercel env | Full read/write on the application database | Manual, via Supabase |
| `OPENROUTER_API_KEY` | Vercel env | Spend against the model account. Generates narrative text only; cannot alter cited facts | Manual, via OpenRouter |
| Portal API keys (`lf_live_…`) | Hashed at rest in Postgres | Read-only API access under a rate limit | User-revocable in the portal |

**Not hardware-backed. Not rotated on a schedule. No anomaly monitoring.** If
you are assessing this project for a role where that is unacceptable, it is
unacceptable today, and saying so here is more useful than discovering it
later.

---

## What is not audited

The Soroban contract has **16 internal tests and no external audit.** Stellar
runs the [Soroban Audit Bank](https://stellar.org/grants-and-funding/soroban-audit-bank)
for exactly this situation — SCF-funded projects, with the SDF covering most
of the cost and a 5% co-payment refundable on timely remediation. Shipping
this oracle to mainnet without going through that pipeline would skip the
standard Stellar itself set for contracts at this stage.

**Position: the oracle does not go to mainnet before (a) the admin account is
multisig and (b) an external audit has been applied for.** Neither is done.

---

## Reporting a problem

See [SECURITY.md](../SECURITY.md). If you find something that makes any claim
on this page false, that is the most valuable bug you can report — the claims
here are the product.
