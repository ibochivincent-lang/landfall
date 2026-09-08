# Governance

Who decides what, and how a decision that affects published figures about real
businesses gets made.

Landfall scores named companies. That makes "who can change the scoring
formula" a governance question, not just an engineering one.

---

## The honest starting point

**This project has one maintainer.** `ibochivincent-lang` owns the repository,
holds every key, and merges every change. There is no committee, no vote, and
no second signature on anything today.

Writing a governance page for a one-person project risks describing an
organisation that does not exist. So this page splits into two clearly-labelled
halves: **what is true now**, and **what changes if anyone else joins**.

`gaps.md` lists the single-maintainer bus factor as High likelihood, High
impact. This page does not solve that. It makes the current state legible and
says what the second person would inherit.

---

## Decision classes

Not every change carries the same weight. These are ordered by how much
someone outside the project could be harmed by getting them wrong.

### Class 1 — Changes what a published number means

Scoring formula, liveness thresholds, flag severities, evidence-tier ordering,
what counts as a refund.

**These affect named businesses.** An anchor that was `slow` yesterday and
`dark` today because a threshold moved has had its public standing changed by
an edit, not by its own behaviour.

Required:

- The change and its rationale documented in [methodology.md](methodology.md)
  in the same change
- An entry in [CHANGELOG.md](../CHANGELOG.md) — never a silent adjustment
- Recomputed against `data/scan-history.ndjson` first, with the number of
  accounts whose state would flip stated in the commit message
- The old behaviour left readable in the history rather than edited away

**A formula change that moves accounts across a boundary without saying so is
the most damaging non-security bug this project can ship.**

### Class 2 — Changes what the project can do

Adding an entry point that holds keys or funds; implementing a SEP as a
participant; anything touching custody.

Required: an explicit decision by the repository owner, recorded as an
architecture note under `docs/architecture/`. [NON_CUSTODY.md](NON_CUSTODY.md)
is the standing constraint; reversing it is not a feature request answered in
passing.

### Class 3 — Ordinary engineering

Bug fixes, new endpoints, performance, docs. Normal PR review, CI green.

---

## Key authority today

| Key | Held by | Can do | Cannot do |
|---|---|---|---|
| Oracle **admin** | Owner | `set_admin`, rotate the publisher | Write scores while a separate publisher is set |
| Oracle **publisher** | Owner (CI) | Write scores and digests | Take the contract |
| `STP_SIGNING_KEY` | Owner (**unset**) | Sign attestations as Landfall | Alter ledger-derived data |
| `DATABASE_URL` | Owner | Full read/write on the app database | — |
| GitHub `main` | Owner | Merge anything | — |

The publisher/admin split is the one real separation of powers in the system,
and it is a separation between *roles*, not between *people* — one person
holds both today. Its value is limiting blast radius: a leaked CI key writes
bad scores, recomputable and correctable, rather than handing over the
contract.

Rotation procedures: [KEY_ROTATION.md](KEY_ROTATION.md).

---

## Before mainnet: admin multisig

The oracle is testnet-only. **Before it reaches mainnet the admin account
should be multisig**, and that is a governance change as much as a security
one — it is the point at which one person stops being able to hand over the
reputation record alone.

Stellar supports this natively: add signers to the account and raise its
**medium** threshold, which is the threshold Soroban's built-in account
contract checks. Because the admin no longer signs hourly (the publisher
does), requiring several signatures costs nothing operationally.

Order matters — **add the signer first, raise the threshold second.** Reversed,
you get an account requiring two signatures with one signer, which is
unrecoverable. The full runbook is printed by `scripts/deploy-contract.sh`
after every deploy, and the reasoning is in [TRUST.md](TRUST.md).

---

## If someone else joins

Not aspirational structure — the minimum that would need to be true.

1. **A second signer on the oracle admin account**, so no single person can
   transfer the contract. This is the change that makes the word
   "governance" mean something here.
2. **Class 1 changes need two approvals.** A scoring change by one person is
   the same risk regardless of how many people are on the project.
3. **Merge rights are separate from key access.** Someone can review and merge
   without holding a key that writes to the ledger.
4. **This page gets rewritten by whoever joins**, because a governance
   document written entirely by the incumbent describes only the incumbent's
   assumptions.

---

## What is deliberately not governed

**The data.** Nobody votes on what the ledger says. A figure is wrong only if
the arithmetic is wrong or the input was misread — both bugs, fixed as bugs.
There is no process by which an anchor, a funder, or the maintainer can have a
correct finding removed. [DISPUTES.md](../DISPUTES.md) is a right of reply,
not an appeal to have accurate data deleted.

---

## Related

- [TRUST.md](TRUST.md) · [KEY_ROTATION.md](KEY_ROTATION.md) · [SECURITY.md](../SECURITY.md)
- [JURISDICTIONAL.md](JURISDICTIONAL.md) — the legal reading of publishing about named businesses
- [CONTRIBUTING.md](../CONTRIBUTING.md) — how a change actually gets merged
