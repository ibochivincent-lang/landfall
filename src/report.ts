import type { AccountMetrics } from "./types.js";

function pct(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(2)}%`;
}

function hours(value: number | null | undefined): string {
  if (value === null || value === undefined) return "n/a";
  if (value < 48) return `${value.toFixed(1)}h`;
  return `${(value / 24).toFixed(1)}d`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text.padEnd(width);
}

export function renderTable(metrics: AccountMetrics[]): string {
  const rows = [...metrics].sort((a, b) => (b.refundRate ?? -1) - (a.refundRate ?? -1));

  const header = [
    pad("DOMAIN", 26),
    pad("ACCOUNT", 12),
    pad("IN", 7),
    pad("OUT", 7),
    pad("REFUNDS", 9),
    pad("RATE", 9),
    pad("LAST SEEN", 10),
  ].join(" ");

  const lines = rows.map((m) =>
    [
      pad(m.domain, 26),
      pad(`${m.account.slice(0, 4)}…${m.account.slice(-4)}`, 12),
      pad(String(m.inbound.count), 7),
      pad(String(m.outbound.count), 7),
      pad(String(m.refundCount), 9),
      pad(pct(m.refundRate), 9),
      pad(hours(m.hoursSinceLastActivity), 10),
    ].join(" "),
  );

  return [header, "-".repeat(header.length), ...lines].join("\n");
}

/**
 * The headline finding: one number worth publishing.
 *
 * Deliberately conservative — accounts with too little inbound traffic are
 * excluded rather than ranked, because a refund rate over three payments is
 * noise dressed as a statistic.
 */
export function renderHeadline(metrics: AccountMetrics[], minInbound = 25): string {
  const eligible = metrics.filter((m) => m.inbound.count >= minInbound && m.refundRate !== null);

  if (eligible.length === 0) {
    return [
      "No account carried enough inbound traffic to support a refund-rate claim.",
      `(threshold: ${minInbound} inbound payments in the sampled window)`,
      "Widen --max-records or --since, or add more domains, then re-run.",
    ].join("\n");
  }

  const totalInbound = eligible.reduce((sum, m) => sum + m.inbound.count, 0);
  const totalRefunds = eligible.reduce((sum, m) => sum + m.refundCount, 0);
  const aggregate = totalRefunds / totalInbound;

  const worst = eligible.reduce((a, b) => ((b.refundRate ?? 0) > (a.refundRate ?? 0) ? b : a));
  const latencies = eligible
    .map((m) => m.medianRefundLatencyHours)
    .filter((v): v is number => v !== null);

  const out = [
    "HEADLINE",
    "",
    `Across ${eligible.length} anchor account(s) with at least ${minInbound} inbound payments,`,
    `${totalRefunds} of ${totalInbound} inbound payments were returned to sender —`,
    `an aggregate refund rate of ${pct(aggregate)}.`,
    "",
    `Highest: ${worst.domain} at ${pct(worst.refundRate)} (${worst.refundCount}/${worst.inbound.count}).`,
  ];

  if (latencies.length > 0) {
    const med = latencies.sort((a, b) => a - b)[Math.floor(latencies.length / 2)] as number;
    out.push(`Median time to return, across anchors: ${hours(med)}.`);
  }

  out.push(
    "",
    "Method: a return is an outbound payment to an account that paid in earlier,",
    "same asset, amount within tolerance, inside the refund window. Heuristic —",
    "see docs/methodology.md. Every pair is listed in the JSON output with both",
    "transaction hashes so any claim here can be checked against the ledger.",
  );

  return out.join("\n");
}

export function renderDiscovery(
  resolved: { domain: string; count: number }[],
  failed: { domain: string; error: string }[],
): string {
  const lines: string[] = [];
  for (const r of resolved) lines.push(`  ok    ${pad(r.domain, 28)} ${r.count} account(s)`);
  for (const f of failed) lines.push(`  FAIL  ${pad(f.domain, 28)} ${f.error}`);
  return lines.join("\n");
}
