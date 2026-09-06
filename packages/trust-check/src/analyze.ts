import type {
  AgeAssessment,
  ConcentrationAssessment,
  Confidence,
  Flag,
  ForwardingAssessment,
  ObservedPayment,
  RiskLevel,
  TrustCheckInput,
  TrustCheckResult,
} from "./types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** A payment counts as "fast-forwarded" if this much of it moved onward within the window below. */
const FORWARD_MATCH_FRACTION = 0.9;
const FORWARD_WINDOW_MS = 10 * 60 * 1000;

/** Every point lost is traceable to exactly one flag — see TrustCheckResult.riskScore. */
const SCORE_DEDUCTIONS: Record<Flag["severity"], number> = {
  info: 0,
  warning: 15,
  high: 30,
};

function assessAge(input: TrustCheckInput): AgeAssessment {
  if (!input.oldestRetainedPaymentAt) {
    return { oldestRetainedPaymentAt: null, observedDays: null, isLowerBoundOnly: false };
  }
  const days = (Date.parse(input.checkedAt) - Date.parse(input.oldestRetainedPaymentAt)) / MS_PER_DAY;
  return {
    oldestRetainedPaymentAt: input.oldestRetainedPaymentAt,
    observedDays: Math.max(0, Math.round(days * 10) / 10),
    isLowerBoundOnly: true,
  };
}

/**
 * Combines every counterparty's inbound and outbound volume by summing
 * decimal-string amounts per asset, then folding assets together by
 * dividing each counterparty's per-asset total by that asset's total across
 * all counterparties — this avoids ever adding, say, an XLM amount to a
 * USDC amount as though they were the same unit. The "share" reported is
 * the counterparty's largest single-asset share, which is the honest
 * number when an address only ever moves one asset (the common case) and
 * degrades gracefully rather than fabricating a cross-asset blend when it
 * doesn't.
 */
function assessConcentration(address: string, payments: readonly ObservedPayment[]): ConcentrationAssessment {
  // asset -> counterparty -> total (fixed-point, 7 decimals, Stellar's own precision)
  const scale = 10n ** 7n;
  const toFixed = (s: string): bigint => {
    const [w = "0", f = ""] = s.split(".");
    return BigInt(w) * scale + BigInt((f + "0000000").slice(0, 7));
  };

  const perAsset = new Map<string, Map<string, bigint>>();
  const counterparties = new Set<string>();

  for (const p of payments) {
    const counterparty = p.from === address ? p.to : p.from;
    if (counterparty === address) continue; // self-payment carries no counterparty signal
    counterparties.add(counterparty);

    const byCounterparty = perAsset.get(p.asset) ?? new Map<string, bigint>();
    byCounterparty.set(counterparty, (byCounterparty.get(counterparty) ?? 0n) + toFixed(p.amount));
    perAsset.set(p.asset, byCounterparty);
  }

  if (counterparties.size === 0) {
    return { topCounterpartyShare: null, topCounterparty: null, distinctCounterparties: 0 };
  }

  let bestShare = -1;
  let bestCounterparty: string | null = null;
  for (const byCounterparty of perAsset.values()) {
    const assetTotal = [...byCounterparty.values()].reduce((a, b) => a + b, 0n);
    if (assetTotal === 0n) continue;
    for (const [counterparty, amount] of byCounterparty) {
      const share = Number(amount) / Number(assetTotal);
      if (share > bestShare) {
        bestShare = share;
        bestCounterparty = counterparty;
      }
    }
  }

  return {
    topCounterpartyShare: bestShare < 0 ? null : bestShare,
    topCounterparty: bestCounterparty,
    distinctCounterparties: counterparties.size,
  };
}

/**
 * An inbound payment is "fast-forwarded" when at least FORWARD_MATCH_FRACTION
 * of its amount, in the same asset, moved on to a DIFFERENT address within
 * FORWARD_WINDOW_MS. Each outbound payment can satisfy at most one inbound
 * match, so one large outbound sweep cannot be counted as "forwarding" for
 * several unrelated inbound payments at once.
 */
function assessForwarding(address: string, payments: readonly ObservedPayment[]): ForwardingAssessment {
  const inbound = payments.filter((p) => p.to === address && p.from !== address);
  const outbound = payments.filter((p) => p.from === address && p.to !== address);
  const usedOutbound = new Set<number>();

  let fastForwarded = 0;
  for (const inPay of inbound) {
    const inAt = Date.parse(inPay.createdAt);
    const inAmt = Number(inPay.amount);
    if (!Number.isFinite(inAmt) || inAmt <= 0) continue;

    const matchIdx = outbound.findIndex((outPay, idx) => {
      if (usedOutbound.has(idx)) return false;
      if (outPay.asset !== inPay.asset) return false;
      // Money returning to whoever sent it is a refund, not forwarding — the
      // pattern this flag looks for is value passing THROUGH this address to
      // someone new, not a normal round trip with the original sender.
      if (outPay.to === inPay.from) return false;
      const outAt = Date.parse(outPay.createdAt);
      if (outAt < inAt || outAt - inAt > FORWARD_WINDOW_MS) return false;
      const outAmt = Number(outPay.amount);
      return Number.isFinite(outAmt) && outAmt >= inAmt * FORWARD_MATCH_FRACTION;
    });

    if (matchIdx !== -1) {
      usedOutbound.add(matchIdx);
      fastForwarded++;
    }
  }

  return {
    fastForwardedCount: fastForwarded,
    inboundCount: inbound.length,
    fastForwardedFraction: inbound.length > 0 ? fastForwarded / inbound.length : null,
  };
}

function buildFlags(
  age: AgeAssessment,
  concentration: ConcentrationAssessment,
  forwarding: ForwardingAssessment,
  paymentCount: number,
): Flag[] {
  const flags: Flag[] = [];

  if (
    age.observedDays !== null &&
    age.observedDays < 7 &&
    paymentCount >= 10
  ) {
    flags.push({
      id: "new-with-high-volume",
      severity: "warning",
      summary: `Observed history reaches back only ${age.observedDays} day(s), with ${paymentCount} payment(s) in that time.`,
      detail:
        "A short observed history with a lot of activity is not itself wrong — a busy new service looks the same as this. " +
        "It means there is little track record to judge, not that something is wrong.",
      evidenceTxHashes: [],
    });
  }

  if (
    forwarding.inboundCount >= 3 &&
    forwarding.fastForwardedFraction !== null &&
    forwarding.fastForwardedFraction >= 0.5
  ) {
    flags.push({
      id: "pass-through-pattern",
      severity: "high",
      summary: `${forwarding.fastForwardedCount} of ${forwarding.inboundCount} inbound payments were forwarded onward within ${FORWARD_WINDOW_MS / 60000} minutes.`,
      detail:
        "This is a ledger fact, not a conclusion about intent: this pattern is consistent with a pass-through account — " +
        "automated forwarding, a custodial hot wallet, or a sweep service all look identical on-chain to this. " +
        "It does not by itself establish fraud, and should not be read as an accusation.",
      evidenceTxHashes: [],
    });
  }

  if (
    concentration.topCounterpartyShare !== null &&
    concentration.topCounterpartyShare >= 0.8 &&
    paymentCount >= 5
  ) {
    flags.push({
      id: "high-concentration",
      severity: "info",
      summary: `${Math.round(concentration.topCounterpartyShare * 100)}% of observed volume moves through a single counterparty.`,
      detail:
        "Concentration alone is common and often benign — a personal wallet paying one merchant repeatedly looks the same. " +
        "It is informational context for the other signals, not a finding on its own.",
      evidenceTxHashes: [],
    });
  }

  return flags;
}

function assessConfidence(paymentCount: number): Confidence {
  if (paymentCount < 5) return "low";
  if (paymentCount < 25) return "medium";
  return "high";
}

function riskLevelFor(score: number, confidence: Confidence): RiskLevel {
  if (confidence === "low") return "unknown";
  if (score >= 70) return "low";
  if (score >= 40) return "medium";
  return "high";
}

function recommendationFor(level: RiskLevel, confidence: Confidence, paymentCount: number): string {
  if (paymentCount === 0) {
    return "No observed payment history for this address. There is nothing here to assess either way — treat it with the same caution you would any new counterparty.";
  }
  if (confidence === "low") {
    return `Only ${paymentCount} observed payment(s) — too little history to draw a conclusion. A low count is not itself a warning sign.`;
  }
  switch (level) {
    case "low":
      return "No concerning patterns observed in this account's ledger history.";
    case "medium":
      return "Some patterns worth reviewing before sending a large amount — see the flags below and the evidence behind each.";
    case "high":
      return "Multiple patterns consistent with elevated risk were observed. Review the evidence below before proceeding.";
    default:
      return "Not enough observed activity to assess.";
  }
}

/**
 * Pure: takes exactly the ledger data already fetched, computes signals,
 * flags, and a transparent score. No I/O, no clock read internally — every
 * output is reproducible from the input alone.
 */
export function analyzeTrustCheck(input: TrustCheckInput): TrustCheckResult {
  const age = assessAge(input);
  const concentration = assessConcentration(input.address, input.recentPayments);
  const forwarding = assessForwarding(input.address, input.recentPayments);

  const inboundCount = input.recentPayments.filter((p) => p.to === input.address).length;
  const outboundCount = input.recentPayments.filter((p) => p.from === input.address).length;
  const paymentCount = input.recentPayments.length;

  const flags = buildFlags(age, concentration, forwarding, paymentCount);
  const riskScore = Math.max(0, 100 - flags.reduce((sum, f) => sum + SCORE_DEDUCTIONS[f.severity], 0));
  const confidence = assessConfidence(paymentCount);
  const riskLevel = riskLevelFor(riskScore, confidence);

  return {
    address: input.address,
    checkedAt: input.checkedAt,
    age,
    concentration,
    forwarding,
    paymentCount,
    inboundCount,
    outboundCount,
    flags,
    riskScore,
    riskLevel,
    confidence,
    recommendation: recommendationFor(riskLevel, confidence, paymentCount),
    limits:
      "Computed only from Stellar ledger records Horizon still retains for this address — no external " +
      "fraud reports, scam lists, or reputation feeds are used, because none exist here that this project " +
      "can independently verify. \"Observed days\" is a lower bound: the address may be materially older " +
      "than that." +
      (input.recentPaymentsTruncated
        ? ` This address has more payment history than the ${input.recentPayments.length} most recent ` +
          "record(s) inspected here — signals are computed from that recent window, not the full history."
        : ` All ${input.recentPayments.length} payment record(s) Horizon retains for this address were inspected.`) +
      " Every flag is a ledger fact, not an accusation — see the detail on each.",
  };
}
