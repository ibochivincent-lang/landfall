# @landfall/sdk

Evidence-tiered anchor ranking and cross-chain settlement scanning for Stellar.

The one rule this package exists to enforce: **weaker evidence never outranks
stronger evidence, whatever the numbers say.** A settlement read directly off
the Stellar ledger (`PROVEN`) always ranks above one inferred from a bridge
attestation (`ATTESTED`), which always ranks above one derived from an
off-chain claim (`DERIVED`). There is deliberately no blended score, because a
single number would let a large `DERIVED` figure quietly outweigh a small
`PROVEN` one and nobody reading the result could tell that had happened.

```bash
npm install @landfall/sdk
```

Requires Node 20+. ESM only.

## pickAnchor

A candidate is an anchor id plus the summary `crossChainScan()` produces, so
the two functions compose directly. `summarizeTiers()` builds the tier
breakdown from raw settlement events:

```js
import { pickAnchor, bestAnchor, summarizeTiers } from "@landfall/sdk";

const derivedEvents = [/* 900 DERIVED SettlementEvents */];
const provenEvents  = [/* 12 PROVEN SettlementEvents  */];

const ranked = pickAnchor([
  {
    anchorId: "alpha.example",
    summary: {
      anchorId: "alpha.example",
      tiers: summarizeTiers(derivedEvents),
      chains: [],
      totalEvents: derivedEvents.length,
      tierMix: "PROVEN 0 · ATTESTED 0 · DERIVED 900",
    },
  },
  {
    anchorId: "beta.example",
    summary: {
      anchorId: "beta.example",
      tiers: summarizeTiers(provenEvents),
      chains: [],
      totalEvents: provenEvents.length,
      tierMix: "PROVEN 12 · ATTESTED 0 · DERIVED 0",
    },
  },
]);

ranked[0].anchorId;   // "beta.example" — 12 proven events beat 900 derived ones
ranked[0].tierMix;    // "PROVEN 12 · ATTESTED 0 · DERIVED 0"
ranked[0].rationale;  // why it ranked there, in words
```

`bestAnchor()` returns the top candidate or `null`. It returns `null` rather
than a guess when there is nothing to rank — an empty list is not a winner.

## crossChainScan

Runs every `ChainAdapter` you give it for one anchor, collects settlement
events, and reports the tier mix plus anything that failed:

```js
import { crossChainScan } from "@landfall/sdk";

const result = await crossChainScan({
  anchorId: "alpha.example",
  sources: [{ adapter: stellarAdapter, address: "GA..." }],
  unresolved: [{ chain: "tron", maxTier: "DERIVED", reason: "no address curated" }],
});

result.summary.tiers;   // { PROVEN: 12, ATTESTED: 0, DERIVED: 0 }
result.failures;        // adapters that threw, with the reason
result.unresolved;      // chains not scanned, and why not
```

A chain that could not be scanned is reported as `unresolved` with a reason —
never as zero activity. "We did not look" and "we looked and found nothing"
are different facts and this package keeps them apart.

## Attestations

`buildAttestation()` turns a settlement event into a
[STP](https://github.com/ibochivincent-lang/landfall/blob/main/docs/architecture/MULTICHAIN.md)
attestation with a reproducible SHA-256 digest over its canonical
serialisation. Without a signing key it emits `signed: false` and the digest
only — a signature from a throwaway key would prove nothing to anyone, so it
does not manufacture one.

## What this package does not do

- **It does not fetch anything itself.** You supply the adapters. There is no
  hidden network call, no hosted service dependency, no API key.
- **It cannot see fiat.** Every tier describes on-chain evidence. Whether a
  bank actually credited someone is not observable from a ledger, and nothing
  here pretends otherwise.
- **It does not score anchors 0–100.** If you want a single number, this is the
  wrong package; the refusal is the point.

## Licence

MIT. Part of [Landfall](https://github.com/ibochivincent-lang/landfall) —
settlement intelligence for Stellar anchors, computed from the public ledger
rather than from asking the anchor.
