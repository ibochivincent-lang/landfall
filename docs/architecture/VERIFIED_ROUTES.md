# Verified Routes

## The question this answers

Route Scout has always answered "what's the cheapest route?" That's a
comparison, and the cheapest row is not necessarily the safest one to
actually route money through. `sortBy: "verified"` answers a different
question: "what's the cheapest *reliable* route?" — reliability and recent
activity ranked ahead of price, not folded into it.

The worked example this exists for (from the product proposal that asked for
it):

| Route | FX rate | Fee | Reliability | Liquidity | Payout rank | Verified rank |
|---|---|---|---|---|---|---|
| A | ₦1,500 | 0.5% | A / 94 | High | 🥉 | 🥇 |
| B | ₦1,505 | 0.2% | C / 58 | Medium | 🥈 | 🥈 |
| C | ₦1,510 | 0.1% | D / 31 | Low | 🥇 | 🥉 |

Under plain payout ranking, C wins — best rate, lowest fee. Under verified
ranking, A wins — despite the worse rate and fee, because it has the
strongest grade and the most measured settlement activity behind it. Neither
ranking is wrong; they answer different questions, and Route Scout now lets
the user pick which one they're asking.

## Why grade and liquidity are never blended into one score

The tempting shortcut is a single weighted number: `0.6 × reliability + 0.3 ×
liquidity + 0.1 × price`, sort by that, done. This codebase already refuses to
do the equivalent thing elsewhere — `packages/sdk`'s `pickAnchor()` never lets
DERIVED evidence outrank PROVEN no matter how large a weight might suggest
otherwise, and `/cross-chain.html` states outright that collapsing evidence
tiers into one number "is exactly the kind of number the ecosystem publishes
today, and it means nothing" (paraphrased from that page's own copy).

A blended score has the same failure mode here: a large enough liquidity
figure could out-vote a real grade difference, and the person reading a
single number would have no way to tell that had happened. So the comparator
in `packages/intents/src/solve.ts` is lexicographic, not weighted — grade
decides first, full stop; liquidity only breaks a tie between two routes with
the *same* grade; amount only breaks a tie between two routes with the same
grade and the same liquidity tier. A route with a better grade always
outranks one with worse, regardless of how much liquidity the worse one has.
Tested directly: `sortBy 'verified' never blends grade and liquidity into one
number — grade always decides first` in
`packages/intents/test/solve.test.ts`.

## What "liquidity" means here, and what it doesn't

Named "liquidity" in the product surface because that's the word someone
routing a payment reaches for, but nothing here observes an order book,
a reserve balance, or market depth. The signal is a plain count: measured
payments for the matching on-chain asset in the current scan window, taken
from `packages/web/api/v1/asset-health.json` (built by
`scripts/build-asset-health.mjs`). High/medium/low thresholds on that count
are a first cut, stated as such in `packages/intents/src/types.ts`, not a
calibrated model — they exist to give a coarse, honest signal, not a precise
one.

An anchor whose corridor isn't found in `asset-health.json` at all gets
`"unknown"`, never `"low"`. Silence about an anchor's activity is not the
same claim as "this anchor is confirmed to have low activity," and treating
them the same would manufacture certainty about anchors nobody has actually
measured yet.

## Where it lives

| | |
|---|---|
| `packages/intents/src/types.ts` | `LiquidityTier`, `LIQUIDITY_ORDER`, `Intent.sortBy` |
| `packages/intents/src/solve.ts` | The lexicographic comparator |
| `packages/web/intent.js` | Browser mirror, checked against the package by `packages/intents/test/parity.test.ts` |
| `packages/web/compare.js` | `liquidityFor()` reads `asset-health.json` and joins it onto each candidate; the "Best payout / Best verified" toggle sets `sortBy` |

## What this still doesn't do

**No execution.** The verified card links to the anchor's own SEP-24
off-ramp, exactly like every other card — it does not move funds, hold a key,
or submit a transaction on the user's behalf. Building an "Execute route"
button means Landfall taking custody of a decision to move real money, which
is a business and risk decision, not something that should arrive as a side
effect of a ranking algorithm. That stays a deliberate, separate decision for
whoever runs this project to make explicitly.

**No "last settlement" timestamp per anchor, only per asset.** The evidence
trail shows recency from the matching corridor's own `liveness.hoursSinceActivity`
in `asset-health.json`, inferred from the account carrying that asset — see
that artifact's own `basis: "inferred"` note. There is no finer-grained
"this specific route settled N minutes ago" figure available yet.
