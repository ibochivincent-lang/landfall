import { readFile, writeFile, mkdir } from "node:fs/promises";
import { discoverDomain } from "./toml.js";
import { fetchPayments, fetchLastActivity } from "./horizon.js";
import { computeMetrics } from "./metrics.js";
import { renderTable, renderHeadline, renderDiscovery } from "./report.js";
import { DEFAULT_SCAN_OPTIONS, type AccountMetrics, type AnchorAccount } from "./types.js";

interface Args {
  command: string;
  horizon: string;
  maxRecords: number;
  since?: string;
  domains?: string[];
  out: string;
  minInbound: number;
  concurrency: number;
  dustThreshold: string;
}

function parseArgs(argv: string[]): Args {
  const [command = "scan"] = argv;
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const domainsArg = get("--domains");
  const sinceArg = get("--since");

  return {
    command,
    horizon: get("--horizon") ?? DEFAULT_SCAN_OPTIONS.horizon,
    maxRecords: Number(get("--max-records") ?? DEFAULT_SCAN_OPTIONS.maxRecords),
    since: sinceArg,
    domains: domainsArg ? domainsArg.split(",").map((d) => d.trim()).filter(Boolean) : undefined,
    out: get("--out") ?? "out",
    minInbound: Number(get("--min-inbound") ?? 25),
    concurrency: Number(get("--concurrency") ?? 4),
    dustThreshold: get("--dust") ?? DEFAULT_SCAN_OPTIONS.dustThreshold,
  };
}

async function loadDomains(explicit?: string[]): Promise<string[]> {
  if (explicit?.length) return explicit;
  const raw = await readFile(new URL("../data/anchors.json", import.meta.url), "utf8");
  const parsed = JSON.parse(raw) as { domains?: string[] };
  return parsed.domains ?? [];
}

/** Run tasks with a bounded number in flight. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function discover(args: Args): Promise<AnchorAccount[]> {
  const domains = await loadDomains(args.domains);
  process.stderr.write(`Resolving ${domains.length} domain(s)...\n`);

  const results = await mapLimit(domains, args.concurrency, (d) => discoverDomain(d));

  const resolved: { domain: string; count: number }[] = [];
  const failed: { domain: string; error: string }[] = [];
  const accounts: AnchorAccount[] = [];

  results.forEach((res, i) => {
    const domain = domains[i] as string;
    if (res.error || res.accounts.length === 0) {
      failed.push({ domain, error: res.error ?? "no accounts declared" });
      return;
    }
    resolved.push({ domain, count: res.accounts.length });
    accounts.push(...res.accounts);
  });

  process.stderr.write(renderDiscovery(resolved, failed) + "\n\n");
  return accounts;
}

async function scan(args: Args): Promise<void> {
  const accounts = await discover(args);
  if (accounts.length === 0) {
    process.stderr.write("No anchor accounts resolved. Nothing to scan.\n");
    process.exitCode = 1;
    return;
  }

  const opts = {
    ...DEFAULT_SCAN_OPTIONS,
    horizon: args.horizon,
    maxRecords: args.maxRecords,
    since: args.since,
    dustThreshold: args.dustThreshold,
  };
  process.stderr.write(`Scanning ${accounts.length} account(s) against ${args.horizon}...\n`);

  const metrics = await mapLimit(accounts, args.concurrency, async (anchor) => {
    try {
      // Liveness first, and deliberately outside the --since window: an account
      // dormant since before the window still has a real last-activity date.
      const lifetime = await fetchLastActivity(args.horizon, anchor.account);

      const { records } = await fetchPayments({
        horizon: args.horizon,
        account: anchor.account,
        maxRecords: args.maxRecords,
        since: args.since,
      });
      const dormant = lifetime && records.length === 0 ? "  [dormant before window]" : "";
      process.stderr.write(
        `  ${anchor.domain} ${anchor.account.slice(0, 8)} — ${records.length} records${dormant}\n`,
      );
      return computeMetrics(anchor, records, opts, new Date(), lifetime?.createdAt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`  ${anchor.domain} ${anchor.account.slice(0, 8)} — ERROR ${message}\n`);
      return null;
    }
  });

  const ok = metrics.filter((m): m is AccountMetrics => m !== null);

  await mkdir(args.out, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = `${args.out}/scan-${stamp}.json`;
  await writeFile(
    jsonPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), horizon: args.horizon, options: opts, metrics: ok }, null, 2),
  );

  process.stdout.write("\n" + renderTable(ok) + "\n\n");
  process.stdout.write(renderHeadline(ok, args.minInbound) + "\n\n");
  process.stdout.write(`Full results with transaction hashes: ${jsonPath}\n`);
}

const args = parseArgs(process.argv.slice(2));

switch (args.command) {
  case "discover":
    await discover(args);
    break;
  case "scan":
    await scan(args);
    break;
  default:
    process.stderr.write(
      [
        "landfall — ledger-derived settlement record for Stellar anchors",
        "",
        "Usage:",
        "  npm run discover                 resolve anchor domains to on-chain accounts",
        "  npm run scan                     resolve, then index payment history and report",
        "",
        "Flags:",
        "  --domains a.com,b.com            override the seed list",
        "  --horizon <url>                  default https://horizon.stellar.org",
        "  --max-records <n>                per-account record cap (default 2000)",
        "  --since <iso>                    ignore records older than this",
        "  --min-inbound <n>                minimum inbound payments to be ranked (default 25)",
        "  --concurrency <n>                parallel requests (default 4)",
        "  --dust <amount>                  ignore payments below this (default 0.01, 0 disables)",
        "  --out <dir>                      output directory (default ./out)",
        "",
      ].join("\n"),
    );
    process.exitCode = 1;
}
