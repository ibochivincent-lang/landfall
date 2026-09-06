# Payment Intents

## What changed

Route Scout asked one question: *"I am sending $100 — who pays out most?"* That
is a comparison. The person reading it does the deciding, and the table always
has a top row.

An intent asks the other question: *"They must receive ₦500,000 — what does
that cost, and can it be done at all?"*

The second form is not a rephrasing. It differs in three ways that matter.

## 1. An intent can be unsatisfiable

A comparison table always has a best row, even when every row is a bad idea.
An intent can come back with nothing, and that is a real answer rather than an
empty result.

`SolveResult.unsatisfiable` is true when no route can satisfy the target. Every
route that was ruled out appears in `rejected` with a reason:

| Reason | Meaning |
|---|---|
| `unpriced` | The anchor publishes no rate card, so it cannot be quoted. |
| `below-grade-floor` | The caller set `minGrade` and this route is under it. |
| `fee-exceeds-principal` | Arithmetic: the fees consume the whole amount. |

These are kept distinct rather than collapsed into one "no", because they are
not the same fact. Missing information, a filter doing its job, and an
impossibility deserve different responses from a caller.

## 2. The ranking flips

Sending a fixed amount, best means the most delivered. Delivering a fixed
amount, best means the least spent — every anchor delivers exactly the target,
so payout cannot rank them at all. Ranking a receive-first result by payout
would produce a five-way tie.

## 3. Rounding has a direction

The reverse solve is:

```
send − (send × p + f) = receive / rate         where p = feePercent / 100
send                  = (receive / rate + f) / (1 − p)
```

Two things follow.

**`p ≥ 1` has no solution.** A percentage fee of 100% or more consumes the
principal at any size, so the target is unreachable rather than expensive. This
is not hypothetical — the fee refresh found an anchor publishing 20% where the
catalog claimed 0.4%, so "percentage fees are small" is an assumption this
codebase has already been wrong about once.

**The send amount rounds up, not to nearest.** The send side is priced in
cents; the destination side multiplies by a rate in the thousands. Half a cent
of rounding is several naira at the far end, so rounding to nearest delivers
*under* the target about half the time. "Pay ₦500,000" that pays ₦499,994 is a
failed instruction, not a rounding detail. Rounding up costs the sender at most
one cent and keeps the promise. Measured: a ₦500,000 target overshoots by
₦8.42 and never lands short.

## Where it lives

| | |
|---|---|
| `packages/intents/src/types.ts` | The model — `Intent`, `RouteCandidate`, `Solution`, `SolveResult`. |
| `packages/intents/src/solve.ts` | The solver. Pure: no fetching, no clock, no globals. |
| `packages/web/intent.js` | Browser mirror, since the site is static and has no bundler. |

Two implementations of the same arithmetic drift apart. That is not left to
discipline: `packages/intents/test/parity.test.ts` loads the actual browser
file in a `vm` context, runs nine intents against six candidate routes through
both, and fails if any figure disagrees. Change the maths in one place and the
test names the other.

## What it does not do

It does not execute anything. It ranks routes and says what each would cost;
the settlement still happens through the anchor, and the evidence tier attached
to that anchor still says how much of it Landfall can actually see.

In particular, a solved intent is not a quote. The rate is mid-market times the
anchor's published spread, and the anchor prices the real withdrawal itself.
Anchors that publish no terms are listed and never priced — inventing a spread
would put a fabricated number in front of someone deciding where to send money.
