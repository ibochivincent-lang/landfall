/** A payment-like operation as returned by Horizon, normalised. */
export interface PaymentRecord {
  /** Horizon paging token — used as the resume cursor. */
  cursor: string;
  type: string;
  txHash: string;
  /** Sending account. */
  from: string;
  /** Receiving account. */
  to: string;
  /** Amount as a decimal string, kept as string to avoid float loss. */
  amount: string;
  /** Canonical asset id: "native" or "CODE:ISSUER". */
  asset: string;
  createdAt: string;
  /**
   * SEP-24 uses a memo to correlate the two legs of a transfer. Reading it is
   * what turns refund matching from an inference into a measurement, so it is
   * carried on the record even before the matcher uses it.
   */
  memo?: string;
  memoType?: string;
}

/** An anchor account discovered from a SEP-1 stellar.toml. */
export interface AnchorAccount {
  /** Home domain the account was declared by. */
  domain: string;
  /** Human name from the TOML, if present. */
  name?: string;
  account: string;
  /** How the account was found: declared ACCOUNTS entry or a currency issuer. */
  role: "declared" | "issuer";
}

/** Volume rolled up per asset. */
export interface AssetTotals {
  asset: string;
  count: number;
  volume: string;
}

/**
 * A refund is an outbound payment that returns value to an account which
 * recently paid in, at roughly the same amount and in the same asset.
 * Under SEP-24 this is the on-chain signature of a withdrawal the anchor
 * could not complete.
 */
export interface RefundPair {
  counterparty: string;
  asset: string;
  inAmount: string;
  outAmount: string;
  inAt: string;
  outAt: string;
  /** Hours between the inbound payment and the return. */
  latencyHours: number;
  inTxHash: string;
  outTxHash: string;
  /**
   * How the two legs were tied together. "memo" means SEP-24 said so;
   * "heuristic" means we inferred it and could be wrong in both directions.
   */
  confidence?: "memo" | "heuristic";
}

export interface AccountMetrics {
  account: string;
  domain: string;
  name?: string;

  /** Number of payment records examined. */
  sampled: number;
  /** Oldest and newest record in the sample. */
  windowStart?: string;
  windowEnd?: string;

  /**
   * Liveness — cannot be faked, the ledger either has activity or it doesn't.
   *
   * This is deliberately measured OUTSIDE the `--since` window. An account
   * whose last payment predates the window has zero sampled records, and
   * treating that as "no history" would hide the most dormant accounts in the
   * set — the exact opposite of the truth. Liveness answers "when did this
   * account last do anything, ever", not "within the analysis window".
   */
  lastActivityAt?: string;
  hoursSinceLastActivity?: number;
  /** Whether the account has any payment history at all, ignoring the window. */
  hasLifetimeActivity: boolean;

  inbound: { count: number; uniqueCounterparties: number; byAsset: AssetTotals[] };
  outbound: { count: number; uniqueCounterparties: number; byAsset: AssetTotals[] };

  /**
   * Payments below the dust threshold, excluded from all counts above.
   *
   * Abandoned Stellar accounts accumulate unsolicited dust — tiny amounts of
   * assorted assets sent by spammers. Counting it makes a dead account look
   * busy, so it is excluded and reported separately.
   */
  dustExcluded: number;

  /** Refund signal. */
  refundCount: number;
  /** refundCount / inbound.count, or null when there is no inbound traffic. */
  refundRate: number | null;
  /** Median hours from inbound payment to return, across matched pairs. */
  medianRefundLatencyHours: number | null;
  refunds: RefundPair[];

  /** Share of inbound volume held by the single largest counterparty, 0..1. */
  topCounterpartyShare: number | null;
}

export interface ScanOptions {
  /** Horizon base URL. */
  horizon: string;
  /** Max payment records to pull per account. */
  maxRecords: number;
  /** Only consider records at or after this ISO timestamp. */
  since?: string;
  /** Refund matching: max hours between inbound and return. */
  refundWindowHours: number;
  /** Refund matching: allowed relative difference in amount, e.g. 0.02 = 2%. */
  refundTolerance: number;
  /**
   * Payments strictly below this amount are treated as dust and excluded.
   * Set to "0" to disable filtering.
   */
  dustThreshold: string;
}

export const DEFAULT_SCAN_OPTIONS: ScanOptions = {
  horizon: "https://horizon.stellar.org",
  maxRecords: 2000,
  refundWindowHours: 24 * 30,
  refundTolerance: 0.02,
  dustThreshold: "0.01",
};
