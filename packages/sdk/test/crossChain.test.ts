import { test } from "node:test";
import assert from "node:assert/strict";

import { crossChainScan } from "../src/crossChain.js";
import { addDecimalStrings } from "../src/decimal.js";
import { bestAnchor, pickAnchor } from "../src/pickAnchor.js";
import { formatTierMix, summarizeTiers } from "../src/tiers.js";
import { attestationDigest, buildAttestation, toUnsignedAttestation } from "../src/attest.js";
import { generateSigningKey, verifyAttestation } from "../../stp/src/sign.js";
import { parseStpAttestation } from "../../stp/src/schema.js";
import type { ChainAdapter, EvidenceTier, SettlementEvent } from "../../adapters/src/types.js";

function event(overrides: Partial<SettlementEvent> = {}): SettlementEvent {
  return {
    anchorId: "example-anchor.test",
    chain: "stellar",
    asset: "USDC",
    direction: "deposit",
    amount: "100.0000000",
    onchainRef: "tx-" + Math.random().toString(16).slice(2),
    evidenceTier: "PROVEN",
    evidenceDetail: "stellar_ledger",
    observedAt: "2026-09-01T12:00:00Z",
    ...overrides,
  };
}

/** A stub adapter that yields the events it was handed, or throws. */
function stubAdapter(chain: string, maxTier: EvidenceTier, events: SettlementEvent[], throws?: string): ChainAdapter {
  return {
    chain,
    maxTier,
    async *scan() {
      if (throws) throw new Error(throws);
      for (const e of events) yield e;
    },
    async verify() {
      return true;
    },
  };
}

const ATTESTATION = { signer: "test-attester" };

test("addDecimalStrings adds across differing scales without float drift", () => {
  assert.equal(addDecimalStrings("100.0000000", "0.25"), "100.25");
  assert.equal(addDecimalStrings("0.1", "0.2"), "0.3"); // 0.30000000000000004 as floats
  assert.equal(addDecimalStrings("9007199254740993", "1"), "9007199254740994"); // past Number.MAX_SAFE_INTEGER
  assert.equal(addDecimalStrings("5", "5"), "10");
});

test("summarizeTiers keeps volume per asset and never sums across assets", () => {
  const tiers = summarizeTiers([
    event({ asset: "USDC", amount: "100" }),
    event({ asset: "USDC", amount: "50.5" }),
    event({ asset: "XLM", amount: "7" }),
  ]);

  const proven = tiers.find((t) => t.tier === "PROVEN")!;
  assert.equal(proven.events, 3);
  const usdc = proven.byAsset.find((a) => a.asset === "USDC")!;
  assert.equal(usdc.volume, "150.5");
  assert.equal(usdc.count, 2);
  const xlm = proven.byAsset.find((a) => a.asset === "XLM")!;
  assert.equal(xlm.volume, "7");
});

test("summarizeTiers reports every tier, including the empty ones", () => {
  const tiers = summarizeTiers([event()]);
  assert.deepEqual(tiers.map((t) => t.tier), ["PROVEN", "ATTESTED", "DERIVED"]);
  assert.equal(formatTierMix(tiers), "PROVEN 1 · ATTESTED 0 · DERIVED 0");
});

test("crossChainScan folds several adapters into one tier-labelled summary", async () => {
  const result = await crossChainScan({
    anchorId: "example-anchor.test",
    sources: [
      { adapter: stubAdapter("stellar", "PROVEN", [event(), event()]), address: "GACCOUNT" },
      {
        adapter: stubAdapter("base", "ATTESTED", [
          event({ chain: "base", evidenceTier: "ATTESTED", evidenceDetail: "cctp_burn+iris", direction: "bridge_out", amount: "25" }),
        ]),
        address: "0xabc",
      },
    ],
    unresolved: [{ chain: "tron", maxTier: "DERIVED", reason: "no address curated in anchors.registry.json" }],
    attestation: ATTESTATION,
  });

  assert.equal(result.summary.totalEvents, 3);
  assert.equal(result.summary.tierMix, "PROVEN 2 · ATTESTED 1 · DERIVED 0");
  assert.equal(result.failures.length, 0);

  const byChain = new Map(result.summary.chains.map((c) => [c.chain, c]));
  assert.equal(byChain.get("stellar")?.state, "observed");
  assert.equal(byChain.get("base")?.state, "observed");
  assert.equal(byChain.get("tron")?.state, "unresolved");
  assert.match(byChain.get("tron")?.note ?? "", /no address curated/);
});

test("crossChainScan distinguishes 'scanned, found nothing' from 'no address curated'", async () => {
  const result = await crossChainScan({
    anchorId: "example-anchor.test",
    sources: [{ adapter: stubAdapter("solana", "DERIVED", []), address: "TokenAcct" }],
    unresolved: [{ chain: "tron", maxTier: "DERIVED", reason: "no address curated" }],
    attestation: ATTESTATION,
  });

  const byChain = new Map(result.summary.chains.map((c) => [c.chain, c]));
  assert.equal(byChain.get("solana")?.state, "empty");
  assert.equal(byChain.get("tron")?.state, "unresolved");
  assert.notEqual(byChain.get("solana")?.state, byChain.get("tron")?.state);
});

test("crossChainScan surfaces a failed chain instead of reporting it as zero activity", async () => {
  const result = await crossChainScan({
    anchorId: "example-anchor.test",
    sources: [
      { adapter: stubAdapter("stellar", "PROVEN", [event()]), address: "GACCOUNT" },
      { adapter: stubAdapter("base", "ATTESTED", [], "RPC timed out"), address: "0xabc" },
    ],
    attestation: ATTESTATION,
  });

  assert.equal(result.summary.totalEvents, 1, "the surviving chain still reports");
  assert.deepEqual(result.failures, [{ chain: "base", error: "RPC timed out" }]);
  const base = result.summary.chains.find((c) => c.chain === "base")!;
  assert.equal(base.state, "failed");
  assert.notEqual(base.state, "empty");
});

test("crossChainScan rewrites each event's anchorId to the canonical id, not the scanned address", async () => {
  // The adapter can only echo back the address it was handed; the canonical
  // anchor id is what has to reach the attestation, or nothing joins across chains.
  const result = await crossChainScan({
    anchorId: "example-anchor.test",
    sources: [
      { adapter: stubAdapter("stellar", "PROVEN", [event({ anchorId: "GACCOUNT_A" })]), address: "GACCOUNT_A" },
      {
        adapter: stubAdapter("base", "ATTESTED", [
          event({ anchorId: "0xabc", chain: "base", evidenceTier: "ATTESTED", evidenceDetail: "cctp_burn+iris" }),
        ]),
        address: "0xabc",
      },
    ],
    attestation: ATTESTATION,
  });

  assert.deepEqual([...new Set(result.events.map((e) => e.anchorId))], ["example-anchor.test"]);
  for (const built of result.attestations) {
    assert.equal(built.attestation.anchor_id, "example-anchor.test");
  }
});

test("crossChainScan merges several addresses on one chain into a single row", async () => {
  const result = await crossChainScan({
    anchorId: "example-anchor.test",
    sources: [
      { adapter: stubAdapter("stellar", "PROVEN", [event(), event()]), address: "GACCOUNT_A" },
      { adapter: stubAdapter("stellar", "PROVEN", [event()]), address: "GACCOUNT_B" },
    ],
    attestation: ATTESTATION,
  });

  const stellar = result.summary.chains.filter((c) => c.chain === "stellar");
  assert.equal(stellar.length, 1, "one row per chain, not per address");
  assert.equal(stellar[0]?.events, 3);
  assert.equal(stellar[0]?.sourcesScanned, 2);
  assert.equal(stellar[0]?.sourcesFailed, 0);
});

test("crossChainScan marks a partial failure as incomplete rather than reporting it as a clean count", async () => {
  const result = await crossChainScan({
    anchorId: "example-anchor.test",
    sources: [
      { adapter: stubAdapter("stellar", "PROVEN", [event(), event()]), address: "GACCOUNT_A" },
      { adapter: stubAdapter("stellar", "PROVEN", [], "Horizon 504"), address: "GACCOUNT_B" },
    ],
    attestation: ATTESTATION,
  });

  const stellar = result.summary.chains.find((c) => c.chain === "stellar")!;
  assert.equal(stellar.state, "observed");
  assert.equal(stellar.events, 2);
  assert.equal(stellar.sourcesFailed, 1);
  assert.match(stellar.note ?? "", /incomplete/);
  assert.deepEqual(result.failures, [{ chain: "stellar", error: "Horizon 504" }]);
});

test("crossChainScan reports a chain as failed only when every address scan failed", async () => {
  const result = await crossChainScan({
    anchorId: "example-anchor.test",
    sources: [
      { adapter: stubAdapter("stellar", "PROVEN", [], "Horizon 504"), address: "GACCOUNT_A" },
      { adapter: stubAdapter("stellar", "PROVEN", [], "Horizon 504"), address: "GACCOUNT_B" },
    ],
    attestation: ATTESTATION,
  });

  const stellar = result.summary.chains.find((c) => c.chain === "stellar")!;
  assert.equal(stellar.state, "failed");
  assert.equal(stellar.sourcesFailed, 2);
});

test("crossChainScan rejects an adapter emitting a tier above its declared maxTier", async () => {
  await assert.rejects(
    crossChainScan({
      anchorId: "example-anchor.test",
      sources: [
        {
          // A DERIVED-tier adapter claiming PROVEN — the one defect that would
          // make everything downstream untrustworthy.
          adapter: stubAdapter("tron", "DERIVED", [event({ chain: "tron", evidenceTier: "PROVEN" })]),
          address: "TAnchor",
        },
      ],
      attestation: ATTESTATION,
    }),
    /above its declared maxTier/,
  );
});

test("attestations are built for every event, digested, and left unsigned without a key", async () => {
  const result = await crossChainScan({
    anchorId: "example-anchor.test",
    sources: [{ adapter: stubAdapter("stellar", "PROVEN", [event()]), address: "GACCOUNT" }],
    attestation: ATTESTATION,
  });

  assert.equal(result.attestations.length, 1);
  const built = result.attestations[0]!;
  assert.equal(built.signed, false);
  assert.match(built.digest, /^[0-9a-f]{64}$/);
  assert.equal(built.attestation.evidence_tier, "PROVEN");
});

test("a signed attestation verifies against the published key and matches the STP schema", () => {
  const key = generateSigningKey();
  const built = buildAttestation(event(), { signer: "landfall-attester-1", privateKeyB64: key.privateKeyB64 });

  assert.equal(built.signed, true);
  const parsed = parseStpAttestation(built.attestation);
  assert.equal(verifyAttestation(parsed, key.publicKeyB64), true);
});

test("the digest is reproducible from the attestation body alone, with no key", () => {
  const ev = event({ onchainRef: "fixed-ref" });
  const a = attestationDigest(toUnsignedAttestation(ev, "landfall-attester-1"));
  const b = attestationDigest(toUnsignedAttestation(ev, "landfall-attester-1"));
  assert.equal(a, b);
  assert.notEqual(a, attestationDigest(toUnsignedAttestation(ev, "someone-else")));
});

test("pickAnchor never lets DERIVED evidence outrank PROVEN", () => {
  const proven = summarizeTiers([event()]);
  const derivedPile = summarizeTiers(
    Array.from({ length: 50 }, () => event({ chain: "tron", evidenceTier: "DERIVED", evidenceDetail: "tron_transfer+zktls" })),
  );

  const ranked = pickAnchor([
    { anchorId: "derived-heavy.test", summary: { anchorId: "derived-heavy.test", tiers: derivedPile, chains: [], totalEvents: 50, tierMix: formatTierMix(derivedPile) } },
    { anchorId: "proven-thin.test", summary: { anchorId: "proven-thin.test", tiers: proven, chains: [], totalEvents: 1, tierMix: formatTierMix(proven) } },
  ]);

  assert.equal(ranked[0]?.anchorId, "proven-thin.test");
  assert.match(ranked[0]?.rationale ?? "", /ledger-proven/);
  assert.equal(ranked[1]?.anchorId, "derived-heavy.test");
});

test("bestAnchor explains an anchor with no evidence rather than scoring it", () => {
  const empty = summarizeTiers([]);
  const best = bestAnchor([
    {
      anchorId: "nothing.test",
      summary: {
        anchorId: "nothing.test",
        tiers: empty,
        chains: [
          {
            chain: "base",
            maxTier: "ATTESTED",
            state: "unresolved",
            events: 0,
            sourcesScanned: 0,
            sourcesFailed: 0,
            note: "no address curated",
          },
        ],
        totalEvents: 0,
        tierMix: formatTierMix(empty),
      },
    },
  ]);

  assert.equal(best?.anchorId, "nothing.test");
  assert.match(best?.rationale ?? "", /no address curated|No evidence yet/);
});

test("bestAnchor returns null with no candidates", () => {
  assert.equal(bestAnchor([]), null);
});
