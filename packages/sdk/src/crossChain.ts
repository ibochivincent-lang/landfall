import type { ChainAdapter, EvidenceTier, ScanOpts, SettlementEvent } from "../../adapters/src/types.js";
import { buildAttestation, type AttestationOptions, type BuiltAttestation } from "./attest.js";
import {
  formatTierMix,
  summarizeTiers,
  type ChainSummary,
  type CrossChainSummary,
} from "./tiers.js";

export interface AdapterSource {
  adapter: ChainAdapter;
  /**
   * The chain-specific address to scan. Each adapter documents what it
   * expects (a Stellar G-account, an EVM depositor, an SPL token account),
   * pending SEP-1-driven resolution via @landfall/registry.
   */
  address: string;
}

export interface UnresolvedChain {
  chain: string;
  maxTier: EvidenceTier;
  /** Why there's nothing to scan — e.g. "no address curated in anchors.registry.json". */
  reason: string;
}

export interface CrossChainScanOptions {
  anchorId: string;
  sources: AdapterSource[];
  /**
   * Chains in scope for this anchor that have no address to scan. Reported
   * as `unresolved`, never folded in as a zero — "we have no address for
   * this anchor on Base" and "this anchor did nothing on Base" are
   * different claims, and only one of them is one we can make.
   */
  unresolved?: UnresolvedChain[];
  scanOpts?: ScanOpts;
  attestation: AttestationOptions;
}

export interface ChainFailure {
  chain: string;
  error: string;
}

export interface CrossChainScanResult {
  anchorId: string;
  events: SettlementEvent[];
  attestations: BuiltAttestation[];
  summary: CrossChainSummary;
  /** A chain whose scan threw. Surfaced, never swallowed — an undercount that looks like a measurement is the worst outcome here. */
  failures: ChainFailure[];
}

/**
 * Runs every configured adapter for one anchor and folds the results into a
 * single tier-labelled view (MULTICHAIN.md §1: one schema, many chains,
 * evidence tier attached to every claim).
 *
 * Adapters run independently: one chain's RPC being down degrades that
 * chain to `failed` and leaves the rest intact, rather than failing the
 * whole scan or — worse — reporting the survivors as if they were the
 * whole picture.
 */
export async function crossChainScan(opts: CrossChainScanOptions): Promise<CrossChainScanResult> {
  const { anchorId, sources, unresolved = [], scanOpts = {}, attestation } = opts;

  const events: SettlementEvent[] = [];
  const failures: ChainFailure[] = [];

  // Several sources can share a chain — an anchor typically declares more
  // than one Stellar account — so results are accumulated per chain and
  // merged into a single row at the end.
  const perChain = new Map<
    string,
    { maxTier: EvidenceTier; events: number; scanned: number; failed: number; errors: string[] }
  >();

  for (const source of sources) {
    const { adapter, address } = source;
    const acc = perChain.get(adapter.chain) ?? {
      maxTier: adapter.maxTier,
      events: 0,
      scanned: 0,
      failed: 0,
      errors: [],
    };
    acc.scanned += 1;

    const collected: SettlementEvent[] = [];
    try {
      for await (const event of adapter.scan(address, scanOpts)) {
        collected.push(event);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ chain: adapter.chain, error: message });
      acc.failed += 1;
      acc.errors.push(message);
      perChain.set(adapter.chain, acc);
      continue;
    }

    // An adapter must never exceed the tier it declares. This is a guard
    // against a future adapter bug, not a hypothetical: an inflated tier is
    // the one defect that makes every number downstream untrustworthy.
    for (const event of collected) {
      if (rank(event.evidenceTier) < rank(adapter.maxTier)) {
        throw new Error(
          `adapter ${adapter.chain} emitted ${event.evidenceTier} above its declared maxTier ${adapter.maxTier} (${event.onchainRef})`,
        );
      }
    }

    // An adapter is handed a chain-specific address and can only echo that
    // back as anchorId — it has no way to know the canonical id. Resolving
    // the two is this layer's job (MULTICHAIN.md §5: anchor_id is the join
    // key across every adapter), so it is rewritten here. Without this, the
    // same anchor appears under a different id on every chain and nothing
    // joins up.
    events.push(...collected.map((event) => ({ ...event, anchorId })));
    acc.events += collected.length;
    perChain.set(adapter.chain, acc);
  }

  const chains: ChainSummary[] = [...perChain.entries()].map(([chain, acc]) => ({
    chain,
    maxTier: acc.maxTier,
    state: chainState(acc),
    events: acc.events,
    sourcesScanned: acc.scanned,
    sourcesFailed: acc.failed,
    note: chainNote(acc),
  }));

  for (const chain of unresolved) {
    chains.push({
      chain: chain.chain,
      maxTier: chain.maxTier,
      state: "unresolved",
      events: 0,
      sourcesScanned: 0,
      sourcesFailed: 0,
      note: chain.reason,
    });
  }

  const tiers = summarizeTiers(events);

  return {
    anchorId,
    events,
    attestations: events.map((event) => buildAttestation(event, attestation)),
    summary: {
      anchorId,
      tiers,
      chains,
      totalEvents: events.length,
      tierMix: formatTierMix(tiers),
    },
    failures,
  };
}

/** 0 is strongest. Used only to detect an adapter claiming more than it declared. */
function rank(tier: EvidenceTier): number {
  return tier === "PROVEN" ? 0 : tier === "ATTESTED" ? 1 : 2;
}

interface ChainAccumulator {
  events: number;
  scanned: number;
  failed: number;
  errors: string[];
}

function chainState(acc: ChainAccumulator): "observed" | "empty" | "failed" {
  // Every scan failed: there is no measurement here at all, and saying
  // "empty" would present a blackout as a finding.
  if (acc.scanned > 0 && acc.failed === acc.scanned) return "failed";
  return acc.events > 0 ? "observed" : "empty";
}

function chainNote(acc: ChainAccumulator): string | undefined {
  if (acc.failed > 0 && acc.failed === acc.scanned) return acc.errors.join("; ");
  if (acc.failed > 0) {
    return `${acc.failed} of ${acc.scanned} address scans failed — this count is incomplete: ${acc.errors.join("; ")}`;
  }
  if (acc.events === 0) return "scanned, no settlement events in range";
  return undefined;
}
