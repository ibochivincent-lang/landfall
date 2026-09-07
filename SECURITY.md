# Security policy

## Reporting a vulnerability

Use GitHub's **[private security advisory](https://github.com/ibochivincent-lang/landfall/security/advisories/new)**
to report a vulnerability. Do not open a public issue for a security problem.

Expect an acknowledgement within 72 hours and an assessment within a week.

## What counts as a vulnerability here

Landfall holds no user funds and moves no money. It does, however, have real
authentication — an earlier version of this page said it had none, which was
true when written and stopped being true when the developer portal shipped.
Both the ordinary web application surface and the project-specific one below
are in scope.

**Authentication and the developer portal.** `/portal.html` has self-serve
accounts (email plus scrypt-hashed password), server-side sessions over
cookies, and issued API keys (`lf_live_…`) stored hashed, under token-bucket
rate limits. All of it is in scope: session fixation or forgery, privilege
escalation between accounts, API keys that outlive revocation, rate limits
that can be bypassed, timing attacks on key or password comparison, and
anything letting one portal user read another's data.

**Signature-gated endpoints.** Disputing a fraud report requires an Ed25519
signature from the reported Stellar account
(`packages/fraud-reports/src/dispute.ts`). Any way to attach a response to a
report without controlling that account, replay another account's signature,
or get a signature accepted outside its validity window, is in scope — a
forged response is as damaging as a forged accusation.

**SEP-10 Stellar web authentication** (`api/_lib/sep10.js`, `/api/v1/auth`).
Anchor operators can authenticate by proving control of a Stellar account
instead of with a password. In scope: any way to obtain a token for an
account you do not control, replay a captured challenge (they are single-use,
enforced by a unique constraint — see migration 013), get a challenge this
server never issued accepted, defeat the signer-weight check against an
account's medium threshold so that one key authenticates a multisig account,
or forge or extend a JWT.

**Admin and oracle authority.** The Soroban oracle's admin key can rewrite
every published score, and its trust assumptions are documented plainly in
[docs/TRUST.md](docs/TRUST.md). Weaknesses in how that authority is held,
used, or could be escalated are in scope. So is anything letting a fraud
report, a dispute, or an investigation be created or altered by someone who
should not be able to.

What matters most for this project, beyond the above:

**Data integrity — the most serious class.** Anything that lets a third party
influence a published figure. Landfall's entire value is that its numbers are
derived from the ledger rather than supplied by an interested party. A way to
make an anchor look better or worse than the ledger shows is the worst bug this
project can have. That includes:

- Account attribution errors, or a way to claim an account you do not operate
- Manipulation of the refund heuristic to manufacture or suppress pairs
- Dust or spam patterns that distort activity counts
- Anything causing the indexer to silently drop records rather than report a gap

**Attestation forgery (once Layer 2 ships).** A settlement receipt accepted
without a valid signature over a real on-chain transaction, or a way to replay
another party's receipt.

**Supply chain.** A compromised dependency, or a build step that could inject
code into published output.

## What does not count

- Rate limiting from Horizon. That is expected; the indexer backs off.
- Findings you disagree with. Those are data disputes — open a normal issue with
  the account, the scan timestamp, and the transaction hashes from the JSON
  output. Every published figure is traceable to ledger records, so a
  disagreement is resolvable by checking the ledger.
- The absence of a metric. Known gaps are documented in
  [docs/methodology.md](docs/methodology.md); the fiat leg in particular is
  invisible on-chain and openly stated as such.

## Disclosure

We will credit reporters by name unless you ask otherwise, and we publish a
short note describing any defect that affected a published figure — including
what the numbers were before and after. We have done this before: two bugs
found on 12 August 2026 during verification against stellar.expert are
described in `docs/checklist.md` and `docs/gaps.md` and in the commit history.

A project that scores other people's reliability has no standing to hide its
own defects.
