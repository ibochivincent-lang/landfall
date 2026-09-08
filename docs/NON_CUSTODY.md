# Non-custody

**Landfall never holds, moves, or can move anyone's money.** It holds no user
keys, signs no payments, and has no account that funds pass through.

This is the constraint the rest of the design bends around, so it is written
in one place rather than asserted in passing. It is also falsifiable: every
claim below names the code that enforces it.

---

## What that means concretely

| | |
|---|---|
| User funds held | **None.** There is no custodial account, no pooled balance, no escrow |
| Payments signed by Landfall | **None.** No user key is ever transmitted to, stored by, or reconstructable from this system |
| Transactions submitted on a user's behalf | **None** |
| What Landfall does instead | Reads a public ledger and publishes what it says |

The only private key Landfall itself holds is the oracle publisher key, which
writes a digest and liveness state to a contract. It cannot move value: the
contract has no transfer function, holds no asset, and its `publish` and
`set_score` entry points write data. See [TRUST.md](TRUST.md).

---

## Where the constraint is enforced, not just stated

**In the type system.** `packages/intents` produces plans as ordered steps,
each carrying an actor. The type's own comment reads: *"Who performs a step.
Never `landfall` for anything that moves value."* `landfall` appears only on
read-only steps — checking an anchor, computing a route. Every step that moves
value belongs to `user`, `wallet`, or `anchor`.

**In a refused feature.** The obvious next thing after a route comparison is
an "Execute route" button. [VERIFIED_ROUTES.md](architecture/VERIFIED_ROUTES.md)
records the decision not to build one, and the reason is structural rather
than a matter of sequencing: executing a payment means holding a key or a
session with one, which is custody. That is a different risk category from
everything else here — indexing a public ledger needs no permission and cannot
lose anyone's money.

**In the x402 integration.** `POST /api/v1/x402/check-payee` assesses the
payees named in a 402 response and stops. It returns a recommendation; the
agent's own wallet signs. Landfall is not an x402 facilitator, because
verifying and settling payments means routing funds — see
[WHY_NOT.md](WHY_NOT.md).

**In the dispute path.** A reported party proves control of an address by
signing a message with a key that never leaves their possession. The page
shows the exact message to sign and takes back only the signature. No field
in this project has ever asked for a secret key, and adding one would be a
break with the design, not an extension of it.

**In SEP scope.** Landfall implements no SEP that requires holding funds or
personal data — see [SEP_COVERAGE.md](SEP_COVERAGE.md). SEP-24, SEP-6 and
SEP-31 are read as evidence or probed for capability, never participated in.

---

## Why it is worth the cost

The cost is real: Landfall stops one step short of the thing a user ultimately
wants, which is the payment itself. It is worth it for two reasons.

**A scorer that also executes has a conflict its users cannot audit.** If
Landfall both ranked anchors and moved money through them, every ranking would
carry a question about routing incentives. An observer that touches no funds
has nothing to gain from any particular ranking, and that is precisely what
makes the ranking worth reading.

**Custody is a different business with different failure modes.** Indexing a
public ledger cannot lose anyone's money; the worst failure is a wrong number,
which is recomputable and correctable. Holding funds introduces failures that
are not.

---

## What this is not

**Not a legal opinion.** This page describes system architecture. For the
regulatory reading that follows from it, see
[JURISDICTIONAL.md](JURISDICTIONAL.md), which is also not legal advice.

**Not permanent by accident.** Reversing this needs an explicit decision from
the repository owner, not a feature request answered in passing. If it is ever
reversed, this page should be the first thing rewritten — and if you are
reading it while the code does something else, the code is the bug.
