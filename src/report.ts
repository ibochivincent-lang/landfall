import type { AccountMetrics } from "./types.js";
import { median } from "./metrics.js";

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

function shortAccount(account: string): string {
  return `${account.slice(0, 4)}…${account.slice(-4)}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/* ------------------------------------------------------------------ *
 * Liveness classification
 *
 * This is the project's strongest signal because it is not a heuristic.
 * "This account has settled nothing for 34 days" is a fact read off the
 * ledger. An anchor can keep a status page green indefinitely; it cannot
 * fake a month of on-chain silence.
 * ------------------------------------------------------------------ */

export type LivenessBucket = "live" | "slow" | "dark" | "no-activity";

export const LIVE_MAX_HOURS = 48;
export const DARK_MIN_HOURS = 24 * 30;

export function classifyLiveness(m: AccountMetrics): LivenessBucket {
  // Deliberately NOT keyed on `sampled`. An account whose last payment predates
  // the --since window has zero sampled records but is maximally dormant, and
  // classifying it as "no history" would drop the most dead accounts in the set
  // out of the dark count entirely. Only a genuine absence of lifetime activity
  // counts as no-activity.
  if (!m.hasLifetimeActivity || m.hoursSinceLastActivity === undefined) return "no-activity";
  if (m.hoursSinceLastActivity < LIVE_MAX_HOURS) return "live";
  if (m.hoursSinceLastActivity >= DARK_MIN_HOURS) return "dark";
  return "slow";
}

export function bucketCounts(metrics: AccountMetrics[]): Record<LivenessBucket, AccountMetrics[]> {
  const out: Record<LivenessBucket, AccountMetrics[]> = {
    live: [],
    slow: [],
    dark: [],
    "no-activity": [],
  };
  for (const m of metrics) out[classifyLiveness(m)].push(m);
  return out;
}

/* ------------------------------------------------------------------ *
 * Table
 * ------------------------------------------------------------------ */

export function renderTable(metrics: AccountMetrics[]): string {
  // Dark and dormant accounts first — the interesting end of the list.
  const order: Record<LivenessBucket, number> = { dark: 0, slow: 1, "no-activity": 2, live: 3 };
  const rows = [...metrics].sort((a, b) => {
    const byBucket = order[classifyLiveness(a)] - order[classifyLiveness(b)];
    if (byBucket !== 0) return byBucket;
    return (b.hoursSinceLastActivity ?? 0) - (a.hoursSinceLastActivity ?? 0);
  });

  const header = [
    pad("DOMAIN", 26),
    pad("ACCOUNT", 12),
    pad("IN", 7),
    pad("OUT", 7),
    pad("RETURNS", 9),
    pad("RATE", 9),
    pad("LAST SEEN", 11),
    "STATE",
  ].join(" ");

  const lines = rows.map((m) => {
    const bucket = classifyLiveness(m);
    const state =
      bucket === "dark" ? "DARK" : bucket === "no-activity" ? "no payments" : bucket;
    return [
      pad(m.domain, 26),
      pad(shortAccount(m.account), 12),
      pad(String(m.inbound.count), 7),
      pad(String(m.outbound.count), 7),
      pad(String(m.refundCount), 9),
      pad(pct(m.refundRate), 9),
      pad(hours(m.hoursSinceLastActivity), 11),
      state,
    ].join(" ");
  });

  return [header, "-".repeat(header.length), ...lines].join("\n");
}

/* ------------------------------------------------------------------ *
 * Headline
 *
 * Liveness leads because it is a census, not a sample: every discovered
 * account is classified, so there is no sample-size caveat. Returns are
 * reported second and explicitly labelled with n, because a median over a
 * handful of pairs is an observation and not a rate estimate.
 * ------------------------------------------------------------------ */

export function renderHeadline(metrics: AccountMetrics[], minInbound = 25): string {
  if (metrics.length === 0) return "No accounts scanned.";

  const buckets = bucketCounts(metrics);
  const domains = new Set(metrics.map((m) => m.domain));
  const out: string[] = ["HEADLINE", ""];

  /* --- Liveness: the census claim --- */

  const dark = buckets.dark;
  out.push(
    `Of ${metrics.length} anchor ${plural(metrics.length, "account")} across ` +
      `${domains.size} ${plural(domains.size, "domain")}, ${dark.length} ` +
      `${dark.length === 1 ? "has" : "have"} processed no on-chain settlement in over 30 days.`,
  );

  // Call out any domain whose every active account is dark — that is the
  // difference between one stale account and an anchor that has stopped.
  const fullyDark: string[] = [];
  for (const domain of domains) {
    const accounts = metrics.filter((m) => m.domain === domain);
    const active = accounts.filter((m) => classifyLiveness(m) !== "no-activity");
    if (active.length > 0 && active.every((m) => classifyLiveness(m) === "dark")) {
      fullyDark.push(domain);
    }
  }
  if (fullyDark.length > 0) {
    out.push(
      "",
      `Every account with payment history at ${fullyDark.join(", ")} is dark.`,
    );
  }

  out.push("", "Liveness:");
  const rows: [string, AccountMetrics[]][] = [
    [`  under 48h`, buckets.live],
    [`  2 to 30 days`, buckets.slow],
    [`  over 30 days`, buckets.dark],
    [`  no payment history`, buckets["no-activity"]],
  ];
  for (const [label, group] of rows) {
    if (group.length === 0) continue;
    const detail =
      label.includes("no payment") ? " (issuer-only accounts)" : ` — ${describeGroup(group)}`;
    out.push(`${pad(label, 22)} ${String(group.length).padStart(2)} ${plural(group.length, "account")}${detail}`);
  }

  /* --- Returns: the sampled claim --- */

  const eligible = metrics.filter((m) => m.inbound.count >= minInbound && m.refundRate !== null);
  const totalInbound = eligible.reduce((s, m) => s + m.inbound.count, 0);
  const totalRefunds = eligible.reduce((s, m) => s + m.refundCount, 0);

  out.push("", "Returns to sender:");
  if (totalInbound === 0) {
    out.push(
      `  No account carried ${minInbound}+ inbound payments in the sampled window.`,
    );
  } else {
    out.push(
      `  ${totalRefunds} of ${totalInbound.toLocaleString("en-US")} inbound payments returned ` +
        `(${pct(totalRefunds / totalInbound)}), across ${eligible.length} ` +
        `${plural(eligible.length, "account")}.`,
    );

    const latencies = eligible
      .flatMap((m) => m.refunds.map((r) => r.latencyHours))
      .sort((a, b) => a - b);

    if (latencies.length > 0) {
      const med = median(latencies) as number;
      out.push(`  Those returns took a median of ${hours(med)} to arrive.`);
      if (latencies.length < 30) {
        out.push(
          `  n=${latencies.length}. Too few pairs for a rate estimate — read this as`,
          `  an observation about specific transactions, not a property of the anchor.`,
        );
      }
    }
  }

  /* --- The limitation that matters most --- */

  out.push(
    "",
    "Limitation: a return is the *honest* failure mode. An anchor that accepts",
    "value and neither settles nor returns it produces no signal here at all, and",
    "would score a clean 0.00%. A low return rate is not evidence of good conduct.",
    "",
    "Liveness is read directly from the ledger. Return matching is a heuristic —",
    "see docs/methodology.md. Every pair is in the JSON output with both",
    "transaction hashes, so any claim here can be checked against the ledger.",
  );

  return out.join("\n");
}

/** "moneygram 1.2h, anclap 26.1h, +3 more" */
function describeGroup(group: AccountMetrics[], limit = 3): string {
  const sorted = [...group].sort(
    (a, b) => (a.hoursSinceLastActivity ?? 0) - (b.hoursSinceLastActivity ?? 0),
  );
  const shown = sorted
    .slice(0, limit)
    .map((m) => `${m.domain.split(".")[0]} ${hours(m.hoursSinceLastActivity)}`);
  const rest = sorted.length - shown.length;
  return rest > 0 ? `${shown.join(", ")}, +${rest} more` : shown.join(", ");
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
