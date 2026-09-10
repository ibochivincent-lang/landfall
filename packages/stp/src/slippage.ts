/**
 * packages/stp/src/slippage.ts
 *
 * Author: ibochivincent-lang
 *
 * Slippage Intelligence Engine (Quoted vs. Landed).
 *
 * Measures the execution gap between what an anchor quotes via SEP-38 and what
 * actually lands on-chain via the final settlement.
 * Suppresses metric publishing when sample size N is below a statistical floor.
 */

export interface SlippageObservation {
  domain: string;
  assetIn: string;
  assetOut: string;
  quotedAmount: number;
  landedAmount: number;
  feeAmount?: number;
  timestamp?: string;
  referenceId?: string;
}

export interface SlippageCalculation {
  domain: string;
  quotedAmount: number;
  landedAmount: number;
  feeAmount: number;
  deltaAmount: number;
  slippageBps: number;
  slippagePercent: number;
  favorable: boolean; // true if landed >= quoted
}

export interface AnchorSlippageSummary {
  domain: string;
  sampleCount: number;
  status: "reliable" | "suppressed_below_floor";
  medianBps: number | null;
  p90Bps: number | null;
  minBps: number | null;
  maxBps: number | null;
  reason?: string;
}

export const MIN_DATA_FLOOR_SAMPLES = 3;

/**
 * Calculates slippage for a single matched quote-to-settlement pair.
 * Positive slippage bps means less value landed than was quoted (unfavorable).
 * Negative slippage bps means more value landed than quoted (favorable).
 */
export function computeSlippage(obs: SlippageObservation): SlippageCalculation {
  if (obs.quotedAmount <= 0) {
    throw new Error("quotedAmount must be strictly positive");
  }

  const fee = obs.feeAmount ?? 0;
  // Delta between expected delivery and actual delivery
  const delta = obs.quotedAmount - obs.landedAmount;
  const ratio = delta / obs.quotedAmount;
  const slippageBps = Math.round(ratio * 10_000);
  const slippagePercent = Math.round(ratio * 10_000) / 100;

  return {
    domain: obs.domain,
    quotedAmount: obs.quotedAmount,
    landedAmount: obs.landedAmount,
    feeAmount: fee,
    deltaAmount: delta,
    slippageBps,
    slippagePercent,
    favorable: obs.landedAmount >= obs.quotedAmount,
  };
}

/**
 * Computes median value from a sorted array of numbers.
 */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const mid = Math.floor(values.length / 2);
  return values.length % 2 !== 0 ? values[mid]! : Math.round((values[mid - 1]! + values[mid]!) / 2);
}

/**
 * Aggregates a series of slippage observations for an anchor, enforcing
 * sample size floors to avoid publishing misleading rates on sparse data.
 */
export function aggregateAnchorSlippage(
  domain: string,
  observations: SlippageObservation[],
  options: { minSamples?: number } = {}
): AnchorSlippageSummary {
  const minSamples = options.minSamples ?? MIN_DATA_FLOOR_SAMPLES;
  const domainObs = observations.filter((o) => o.domain.toLowerCase() === domain.toLowerCase());

  if (domainObs.length < minSamples) {
    return {
      domain,
      sampleCount: domainObs.length,
      status: "suppressed_below_floor",
      medianBps: null,
      p90Bps: null,
      minBps: null,
      maxBps: null,
      reason: `Sample size ${domainObs.length} is below the statistical floor of ${minSamples} required observations.`,
    };
  }

  const bpsList = domainObs
    .map((o) => computeSlippage(o).slippageBps)
    .sort((a, b) => a - b);

  const p90Index = Math.min(Math.floor(bpsList.length * 0.9), bpsList.length - 1);

  return {
    domain,
    sampleCount: bpsList.length,
    status: "reliable",
    medianBps: median(bpsList),
    p90Bps: bpsList[p90Index]!,
    minBps: bpsList[0]!,
    maxBps: bpsList[bpsList.length - 1]!,
  };
}
