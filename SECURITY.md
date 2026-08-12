# Security policy

## Reporting a vulnerability

Use GitHub's **[private security advisory](https://github.com/ibochivincent-lang/landfall/security/advisories/new)**
to report a vulnerability. Do not open a public issue for a security problem.

Expect an acknowledgement within 72 hours and an assessment within a week.

## What counts as a vulnerability here

Landfall holds no user funds and has no authentication, so the usual web
application surface mostly does not apply. What matters for this project:

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
described in the methodology document and in the commit history.

A project that scores other people's reliability has no standing to hide its
own defects.
