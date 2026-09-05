import type { EvidenceTier, SettlementEvent } from "../../adapters/src/types.js";
import { addDecimalStrings } from "./decimal.js";

/** Strongest first. Also the ranking order used by pickAnchor() — the honesty ladder decides precedence. */
export const TIER_ORDER: readonly EvidenceTier[] = ["PROVEN", "ATTESTED", "DERIVED"] as const;

export interface AssetVolume {
  asset: string;
  count: number;
  /** Decimal string. Volumes are kept per asset and never summed across assets — USDC plus XLM is not a number. */
  volume: string;
}

export interface TierSummary {
  tier: EvidenceTier;
  events: number;
  byAsset: AssetVolume[];
}

/**
 * What happened on one chain for one anchor. The four states are deliberately
 * distinguishable — "observed", "scanned, found nothing", "no address
 * curated", and "the scan failed" mean very different things, and collapsing
 * them into a single zero is how a monitor starts lying.
 */
export type ChainState = "observed" | "empty" | "unresolved" | "failed";

export interface ChainSummary {
  chain: string;
  maxTier: EvidenceTier;
  state: ChainState;
  events: number;
  /** How many addresses were scanned for this chain (an anchor commonly declares several Stellar accounts). */
  sourcesScanned: number;
  /**
   * How many of those scans failed. Kept separate from `state` on purpose:
   * two accounts reporting and a third timing out is not the same as three
   * accounts reporting, and "observed" alone would hide the difference.
   */
  sourcesFailed: number;
  /** Why this chain is in the state it's in — always populated for unresolved/failed and for partial failures. */
  note?: string;
}

export interface CrossChainSummary {
  anchorId: string;
  tiers: TierSummary[];
  chains: ChainSummary[];
  totalEvents: number;
  /** The rendering rule from MULTICHAIN.md §4, precomputed: a tier is never shown without its label. */
  tierMix: string;
}

/** Groups events by tier, then by asset within a tier. Tiers with no events are still present, at zero. */
export function summarizeTiers(events: SettlementEvent[]): TierSummary[] {
  return TIER_ORDER.map((tier) => {
    const forTier = events.filter((e) => e.evidenceTier === tier);
    const byAsset = new Map<string, AssetVolume>();

    for (const event of forTier) {
      const existing = byAsset.get(event.asset);
      if (existing) {
        existing.count += 1;
        existing.volume = addDecimalStrings(existing.volume, event.amount);
      } else {
        byAsset.set(event.asset, { asset: event.asset, count: 1, volume: event.amount });
      }
    }

    return {
      tier,
      events: forTier.length,
      byAsset: [...byAsset.values()].sort((a, b) => b.count - a.count),
    };
  });
}

/** "PROVEN 128 · ATTESTED 4 · DERIVED 0" — every count carries its tier, always. */
export function formatTierMix(tiers: TierSummary[]): string {
  return tiers.map((t) => `${t.tier} ${t.events}`).join(" · ");
}
