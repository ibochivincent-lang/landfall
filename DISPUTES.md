# Disputing a grade or figure

This page is for an anchor operator, not a code contributor — if you run one
of the businesses this site measures and a number about you looks wrong, this
is what to do and what to expect.

## What Landfall's grades are, and are not

Every figure Landfall publishes about your accounts — settlement counts,
liveness, the reliability grade — is computed by a documented, reproducible
procedure run directly against the public Stellar ledger. See
[docs/methodology.md](docs/methodology.md) for the exact rules.

It is **not** an accusation, an editorial judgment, or a claim about your
intent. `CODE_OF_CONDUCT.md` states this as a binding project rule, not just a
tone preference: *"If the ledger shows 40 days of dormancy, say that. Do not
extrapolate to fraud. Our credibility depends on the distinction between what
we measured and what we suspect."* A "Dark" or "F" label means what the
methodology document says it means — nothing broader.

## How to dispute a specific figure

Because every number is derived from ledger records, a disagreement is a
question of fact, not opinion — and it's resolved by checking the ledger, not
by argument.

1. **Open a GitHub issue**: [github.com/ibochivincent-lang/landfall/issues/new](https://github.com/ibochivincent-lang/landfall/issues/new)
2. Include:
   - The account address(es) in question
   - The scan timestamp shown on the page (every page states one — "Scan of …")
   - Which figure you believe is wrong and why
   - If you have it, the specific transaction hash(es) the figure should or
     shouldn't include
3. We will check the claim against the actual ledger records the figure was
   computed from — the same records `/api/v1/anchors/<domain>/profile.json`
   publishes for that account — and respond in the issue with what we found.

If the figure is wrong, we fix it and say so publicly in the issue and, where
relevant, in [docs/gaps.md](docs/gaps.md) — this project has already published
two defects found in its own tooling, including what the numbers were before
and after. If the figure is correct, we'll show the ledger records that
establish it.

## What this process does not cover

This resolves factual disputes about what the ledger shows. It does not
cover, and Landfall makes no attempt to adjudicate:

- Disagreements about the *methodology itself* being fair — raise those as a
  separate issue for public discussion, not as a "my grade is wrong" dispute.
- Anything about your business other than what appears in your Stellar
  accounts' own on-chain payment history.

If your concern is broader than one figure — for example, a request not to be
tracked at all — raise it through the same issue channel. That is a different
kind of request from a factual correction and will be considered on its own
terms rather than folded into this process silently.

## Security issues

If what you found is a security vulnerability rather than a data dispute, see
[SECURITY.md](SECURITY.md) instead — that goes to a private advisory, not a
public issue.
