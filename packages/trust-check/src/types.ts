/**
 * Trust Check — "paste a wallet, see what the ledger shows before you pay it."
 *
 * The vision document that asked for this ("Trust before payment") lists
 * three signal sources: observed history, external intelligence (known
 * reports, malicious labels), and behavioral signals. This module builds
 * only the first and third. External intelligence — a real feed of known
 * scam reports — does not exist yet, and fabricating one would be exactly
 * the failure mode this entire project exists to catch in other people's
 * tools: inventing a "known malicious" label with nothing real behind it is
 * worse than not labeling at all. When Fraud Reports (docs/architecture, if
 * it lands) gives this a real source, it becomes a second, separately
 * labeled input — never silently blended into the ledger-derived signals
 * below.
 *
 * Every signal here is something anyone can independently recompute from
 * Horizon's public API for the same address. Nothing is proprietary,
 * nothing is a black box.
 */

export interface ObservedPayment {
  txHash: string;
  from: string;
  to: string;
  /** Decimal string — never a float, to avoid precision loss on comparison. */
  amount: string;
  asset: string;
  createdAt: string;
}

export interface TrustCheckInput {
  address: string;
  /**
   * ISO timestamp of the oldest payment Horizon still serves for this
   * account, or null if it has none. This is a LOWER BOUND on account age,
   * not a creation date — Horizon's public instance does not retain full
   * history forever, so an account can be materially older than this
   * timestamp suggests. Never presented as exact age; see
   * `AgeAssessment.isLowerBoundOnly`.
   */
  oldestRetainedPaymentAt: string | null;
  /** Most recent payments involving this address, newest first, capped by the caller (e.g. 200). Not the full history for a busy account. */
  recentPayments: ObservedPayment[];
  /** True when the caller's fetch hit its own cap — recentPayments is a window, not the account's whole history. False when every available record was returned. */
  recentPaymentsTruncated: boolean;
  /** When this check was run — passed in, never read from a clock inside pure logic, so a result is exactly reproducible from its own inputs. */
  checkedAt: string;
}

export interface AgeAssessment {
  oldestRetainedPaymentAt: string | null;
  /** Days between oldestRetainedPaymentAt and checkedAt, or null if there is no payment history at all. */
  observedDays: number | null;
  /** Always true when observedDays is non-null: this is a floor, not the account's real age. */
  isLowerBoundOnly: boolean;
}

export interface ConcentrationAssessment {
  /** Fraction (0–1) of total observed volume (both directions, summed per-asset then combined by count as a fallback — see analyze.ts) attributable to the single largest counterparty. Null if there is no volume to measure. */
  topCounterpartyShare: number | null;
  topCounterparty: string | null;
  distinctCounterparties: number;
}

export interface ForwardingAssessment {
  /** Inbound payments where a comparable amount moved onward to a different address within the forwarding window. */
  fastForwardedCount: number;
  inboundCount: number;
  /** fastForwardedCount / inboundCount, or null if inboundCount is 0. */
  fastForwardedFraction: number | null;
}

export type FlagSeverity = "info" | "warning" | "high";

export interface Flag {
  id: string;
  severity: FlagSeverity;
  summary: string;
  detail: string;
  /** Transaction hashes a reader can look up independently — every flag must point at real evidence, never assert without it. */
  evidenceTxHashes: string[];
}

export type RiskLevel = "low" | "medium" | "high" | "unknown";
export type Confidence = "low" | "medium" | "high";

export interface TrustCheckResult {
  address: string;
  checkedAt: string;

  age: AgeAssessment;
  concentration: ConcentrationAssessment;
  forwarding: ForwardingAssessment;
  paymentCount: number;
  inboundCount: number;
  outboundCount: number;

  flags: Flag[];

  /**
   * 0–100, computed by summing fixed, documented deductions per flag
   * severity from a base of 100 — see SCORE_DEDUCTIONS in analyze.ts.
   * Deliberately not a machine-learned or otherwise opaque score: every
   * point lost is traceable to a specific flag in `flags`, so the number
   * can be recomputed by hand from the evidence alone.
   */
  riskScore: number;
  riskLevel: RiskLevel;

  /**
   * How much observed history this assessment is actually built on.
   * "unknown" risk level overrides whatever the score says when confidence
   * is low — a score computed from three payments is not a finding, it's
   * noise, and presenting it as a finding would repeat the "13 accounts as
   * a network census" mistake this project has already been burned by once.
   */
  confidence: Confidence;

  recommendation: string;

  limits: string;
}
