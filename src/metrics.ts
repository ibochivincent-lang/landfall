import type {
  AccountMetrics,
  AnchorAccount,
  AssetTotals,
  PaymentRecord,
  RefundPair,
  ScanOptions,
} from "./types.js";

/* ------------------------------------------------------------------ *
 * Decimal handling
 *
 * Stellar amounts carry 7 decimal places. We convert to integer stroops
 * and do all arithmetic in BigInt so that summing millions of payments
 * never drifts. Floats are used only for ratios, where drift is harmless.
 * ------------------------------------------------------------------ */

const SCALE = 7n;
const SCALE_FACTOR = 10n ** SCALE;

export function toStroops(amount: string): bigint {
  const trimmed = (amount ?? "0").trim();
  if (!/^-?\d*(\.\d*)?$/.test(trimmed) || trimmed === "" || trimmed === ".") return 0n;
  const negative = trimmed.startsWith("-");
  const body = negative ? trimmed.slice(1) : trimmed;
  const [whole = "0", frac = ""] = body.split(".");
  const paddedFrac = (frac + "0000000").slice(0, 7);
  const value = BigInt(whole || "0") * SCALE_FACTOR + BigInt(paddedFrac || "0");
  return negative ? -value : value;
}

export function fromStroops(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / SCALE_FACTOR;
  const frac = (abs % SCALE_FACTOR).toString().padStart(7, "0").replace(/0+$/, "");
  const out = frac ? `${whole}.${frac}` : `${whole}`;
  return negative ? `-${out}` : out;
}

/* ------------------------------------------------------------------ *
 * Aggregation helpers
 * ------------------------------------------------------------------ */

function rollUpByAsset(records: PaymentRecord[]): AssetTotals[] {
  const totals = new Map<string, { count: number; volume: bigint }>();
  for (const r of records) {
    const entry = totals.get(r.asset) ?? { count: 0, volume: 0n };
    entry.count += 1;
    entry.volume += toStroops(r.amount);
    totals.set(r.asset, entry);
  }
  return [...totals.entries()]
    .map(([asset, t]) => ({ asset, count: t.count, volume: fromStroops(t.volume) }))
    .sort((a, b) => (toStroops(b.volume) > toStroops(a.volume) ? 1 : -1));
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

const HOUR_MS = 3_600_000;

/* ------------------------------------------------------------------ *
 * Refund detection
 *
 * Under SEP-24 a withdrawal begins with the user sending the asset on-chain
 * to the anchor. If the anchor cannot complete the off-chain leg, the honest
 * behaviour is to send the asset back. That return is visible on the ledger.
 *
 * We match an outbound payment to a prior inbound payment when all hold:
 *   - same counterparty
 *   - same asset
 *   - outbound occurs after the inbound, within `refundWindowHours`
 *   - amounts agree within `refundTolerance` (fees make them inexact)
 *
 * Each inbound may be matched at most once. Matching is greedy nearest-in-time,
 * which biases toward the tightest interpretation.
 *
 * This is a heuristic, and the report labels it as one. It will over-count
 * genuine round-trips (a user withdrawing and being paid back for unrelated
 * reasons) and under-count partial refunds. It is still the strongest distress
 * signal available without the anchor's cooperation.
 * ------------------------------------------------------------------ */

export function detectRefunds(
  account: string,
  records: PaymentRecord[],
  opts: Pick<ScanOptions, "refundWindowHours" | "refundTolerance">,
): RefundPair[] {
  const inboundByKey = new Map<string, PaymentRecord[]>();
  for (const r of records) {
    if (r.to !== account || r.from === account) continue;
    const key = `${r.from}|${r.asset}`;
    const list = inboundByKey.get(key);
    if (list) list.push(r);
    else inboundByKey.set(key, [r]);
  }
  for (const list of inboundByKey.values()) {
    list.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  const outbound = records
    .filter((r) => r.from === account && r.to !== account)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  const consumed = new Set<string>();
  const pairs: RefundPair[] = [];

  for (const out of outbound) {
    const candidates = inboundByKey.get(`${out.to}|${out.asset}`);
    if (!candidates) continue;

    const outAt = Date.parse(out.createdAt);
    const outAmount = toStroops(out.amount);
    if (outAmount <= 0n) continue;

    let best: PaymentRecord | undefined;
    let bestGap = Infinity;

    for (const inb of candidates) {
      if (consumed.has(inb.cursor)) continue;
      const inAt = Date.parse(inb.createdAt);
      if (!(inAt < outAt)) continue;

      const gapHours = (outAt - inAt) / HOUR_MS;
      if (gapHours > opts.refundWindowHours) continue;

      const inAmount = toStroops(inb.amount);
      if (inAmount <= 0n) continue;

      const diff = outAmount > inAmount ? outAmount - inAmount : inAmount - outAmount;
      const relative = Number(diff) / Number(inAmount);
      if (relative > opts.refundTolerance) continue;

      if (gapHours < bestGap) {
        bestGap = gapHours;
        best = inb;
      }
    }

    if (best) {
      consumed.add(best.cursor);
      pairs.push({
        counterparty: out.to,
        asset: out.asset,
        inAmount: best.amount,
        outAmount: out.amount,
        inAt: best.createdAt,
        outAt: out.createdAt,
        latencyHours: Math.round(bestGap * 100) / 100,
        inTxHash: best.txHash,
        outTxHash: out.txHash,
      });
    }
  }

  return pairs;
}

/* ------------------------------------------------------------------ *
 * Top-level metrics
 * ------------------------------------------------------------------ */

export function computeMetrics(
  anchor: AnchorAccount,
  records: PaymentRecord[],
  opts: ScanOptions,
  now: Date = new Date(),
): AccountMetrics {
  const account = anchor.account;
  const inbound = records.filter((r) => r.to === account && r.from !== account);
  const outbound = records.filter((r) => r.from === account && r.to !== account);

  const times = records
    .map((r) => Date.parse(r.createdAt))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);

  const windowStart = times[0] !== undefined ? new Date(times[0]).toISOString() : undefined;
  const newest = times[times.length - 1];
  const windowEnd = newest !== undefined ? new Date(newest).toISOString() : undefined;

  const hoursSinceLastActivity =
    newest !== undefined
      ? Math.round(((now.getTime() - newest) / HOUR_MS) * 100) / 100
      : undefined;

  const refunds = detectRefunds(account, records, opts);

  // Concentration: share of inbound volume held by the largest single sender.
  const bySender = new Map<string, bigint>();
  let inboundTotal = 0n;
  for (const r of inbound) {
    const v = toStroops(r.amount);
    inboundTotal += v;
    bySender.set(r.from, (bySender.get(r.from) ?? 0n) + v);
  }
  let topShare: number | null = null;
  if (inboundTotal > 0n && bySender.size > 0) {
    const top = [...bySender.values()].reduce((a, b) => (b > a ? b : a), 0n);
    topShare = Math.round((Number(top) / Number(inboundTotal)) * 10000) / 10000;
  }

  return {
    account,
    domain: anchor.domain,
    name: anchor.name,
    sampled: records.length,
    windowStart,
    windowEnd,
    lastActivityAt: windowEnd,
    hoursSinceLastActivity,
    inbound: {
      count: inbound.length,
      uniqueCounterparties: new Set(inbound.map((r) => r.from)).size,
      byAsset: rollUpByAsset(inbound),
    },
    outbound: {
      count: outbound.length,
      uniqueCounterparties: new Set(outbound.map((r) => r.to)).size,
      byAsset: rollUpByAsset(outbound),
    },
    refundCount: refunds.length,
    refundRate:
      inbound.length > 0 ? Math.round((refunds.length / inbound.length) * 10000) / 10000 : null,
    medianRefundLatencyHours: median(refunds.map((p) => p.latencyHours)),
    refunds,
    topCounterpartyShare: topShare,
  };
}
