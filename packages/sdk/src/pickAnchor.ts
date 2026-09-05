import type { EvidenceTier } from "../../adapters/src/types.js";
import { TIER_ORDER, type CrossChainSummary } from "./tiers.js";

export interface AnchorCandidate {
  anchorId: string;
  summary: CrossChainSummary;
}

export interface RankedAnchor {
  anchorId: string;
  evidence: Record<EvidenceTier, number>;
  tierMix: string;
  /** Plain-language reason for the position. A ranking that can't say why it ranked is just a vibe with a number attached. */
  rationale: string;
}

/**
 * Ranks anchors by the evidence behind them, strongest tier first
 * (MULTICHAIN.md §4). The comparison is lexicographic over
 * PROVEN → ATTESTED → DERIVED, which means a pile of DERIVED evidence can
 * never outrank ledger-proven settlement: the honesty ladder is the sort
 * order, not a label bolted on after scoring.
 *
 * This deliberately does not return a blended 0–100 score. Collapsing tiers
 * into one figure is exactly what §4 forbids, and it's what would let a
 * custodial guess get laundered into something that looks proven.
 */
export function pickAnchor(candidates: AnchorCandidate[]): RankedAnchor[] {
  return candidates
    .map((candidate) => {
      const evidence = tierCounts(candidate.summary);
      return {
        anchorId: candidate.anchorId,
        evidence,
        tierMix: candidate.summary.tierMix,
        rationale: rationaleFor(evidence, candidate.summary),
      };
    })
    .sort((a, b) => {
      for (const tier of TIER_ORDER) {
        const diff = b.evidence[tier] - a.evidence[tier];
        if (diff !== 0) return diff;
      }
      return a.anchorId.localeCompare(b.anchorId);
    });
}

/** The top-ranked anchor, or null when there are no candidates. */
export function bestAnchor(candidates: AnchorCandidate[]): RankedAnchor | null {
  return pickAnchor(candidates)[0] ?? null;
}

function tierCounts(summary: CrossChainSummary): Record<EvidenceTier, number> {
  const counts: Record<EvidenceTier, number> = { PROVEN: 0, ATTESTED: 0, DERIVED: 0 };
  for (const tier of summary.tiers) counts[tier.tier] = tier.events;
  return counts;
}

function rationaleFor(evidence: Record<EvidenceTier, number>, summary: CrossChainSummary): string {
  if (evidence.PROVEN === 0 && evidence.ATTESTED === 0 && evidence.DERIVED === 0) {
    const unresolved = summary.chains.filter((c) => c.state === "unresolved").length;
    const failed = summary.chains.filter((c) => c.state === "failed").length;
    if (failed > 0) return `No usable evidence: ${failed} chain scan(s) failed.`;
    if (unresolved > 0) return `No evidence yet: ${unresolved} chain(s) have no address curated.`;
    return "No settlement events observed on any scanned chain.";
  }

  const parts: string[] = [];
  if (evidence.PROVEN > 0) parts.push(`${evidence.PROVEN} ledger-proven settlement(s)`);
  if (evidence.ATTESTED > 0) parts.push(`${evidence.ATTESTED} attested cross-chain settlement(s)`);
  if (evidence.DERIVED > 0) parts.push(`${evidence.DERIVED} derived settlement(s) with a bound off-chain proof`);
  return `Ranked on ${parts.join(", ")}.`;
}
