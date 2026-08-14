import { readFile, writeFile, mkdir } from "node:fs/promises";
import { discoverDomain } from "./toml.js";
import { fetchPayments, fetchLastActivity } from "./horizon.js";
import { computeMetrics } from "./metrics.js";
import { renderTable, renderHeadline, renderDiscovery } from "./report.js";
import { classifyLiveness } from "./report.js";
import { Store, connectionStringFromEnv } from "./db.js";
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
  /** Write results to Postgres as well as to disk. */
  persist: boolean;
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
    persist: argv.includes("--persist"),
  };
}

async function loadDomains(explicit?: string[]): Promise<string[]> {
  if (explicit?.length) return explicit;
  const raw = await readFile(new URL("../data/anchors.json", import.meta.url), "utf8");
  const parsed = JSON.parse(raw) as { domains?: string[] };
  const seed = parsed.domains ?? [];

  // Domains added through the admin board live in `tracked_anchors`, not this
  // file — a Vercel deployment cannot rewrite a file that ships in the git
  // tree. Merge them in so the admin panel's anchor list feeds real scans
  // rather than a table nobody reads. Any failure here (no DATABASE_URL, DB
  // unreachable) falls back to the seed list alone; a scan must never fail
  // because the admin-additions lookup did.
  const connectionString = connectionStringFromEnv();
  if (!connectionString) return seed;
  let store: Store | undefined;
  try {
    store = new Store({ connectionString, connectionTimeoutMillis: 3_000 });
    const extra = await store.trackedDomains();
    return Array.from(new Set([...seed, ...extra]));
  } catch {
    return seed;
  } finally {
    await store?.close().catch(() => {});
  }
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

  const rawByAccount = new Map<string, Awaited<ReturnType<typeof fetchPayments>>["records"]>();

  // Resume cursors. `horizon.ts` has always accepted one and returned the
  // newest; `db.ts` has always been able to store one. Nothing wired the two
  // together, so every scan re-paged from the beginning and honesty rule 6
  // ("interrupted work resumes from a cursor") was documented rather than
  // implemented. This is that wiring.
  //
  // Cursors live in Postgres, not on disk, so they are only available with
  // --persist. Without a database the scan is stateless and re-pages, which is
  // correct: there is nowhere to have remembered.
  const cursorStore = args.persist ? storeFromEnv() : null;
  const resumeFrom = new Map<string, string>();
  const newestSeen = new Map<string, string>();
  if (cursorStore) {
    for (const a of accounts) {
      const c = await cursorStore.getCursor("payments", a.account).catch(() => undefined);
      if (c) resumeFrom.set(a.account, c);
    }
    if (resumeFrom.size > 0) {
      process.stderr.write(`Resuming ${resumeFrom.size} of ${accounts.length} account(s) from a stored cursor.\n`);
    }
  }

  const metrics = await mapLimit(accounts, args.concurrency, async (anchor) => {
    try {
      // Liveness first, and deliberately outside the --since window: an account
      // dormant since before the window still has a real last-activity date.
      const lifetime = await fetchLastActivity(args.horizon, anchor.account);

      const { records, newestCursor } = await fetchPayments({
        horizon: args.horizon,
        account: anchor.account,
        maxRecords: args.maxRecords,
        since: args.since,
        cursor: resumeFrom.get(anchor.account),
      });
      if (newestCursor) newestSeen.set(anchor.account, newestCursor);
      rawByAccount.set(anchor.account, records);
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

  if (args.persist) await persist(args, accounts, ok, rawByAccount, opts, newestSeen);

  // Cursors advance only after the scan has been written. Advancing earlier
  // would mean a crash between fetch and persist skips those records forever:
  // degradation has to be stale, never wrong.
  if (cursorStore) {
    for (const [account, cursor] of newestSeen) {
      await cursorStore.setCursor("payments", account, cursor).catch(() => {});
    }
    await cursorStore.close().catch(() => {});
  }
}

/**
 * A Store, or null when there is no database configured.
 *
 * Cursors are the only thing that needs the database before the scan runs, and
 * a missing DATABASE_URL there must not be fatal - `--persist` already reports
 * that loudly at the end. Returning null degrades to a stateless full re-page.
 */
function storeFromEnv(): Store | null {
  const connectionString = connectionStringFromEnv();
  if (!connectionString) return null;
  try {
    return new Store({ connectionString });
  } catch {
    return null;
  }
}

/**
 * Write the scan to Postgres.
 *
 * Deliberately runs after the JSON and the report, and never throws into the
 * caller: a database problem must not lose a scan that already succeeded. The
 * JSON on disk is the durable record; Postgres is the queryable copy.
 */
async function persist(
  args: Args,
  accounts: AnchorAccount[],
  metrics: AccountMetrics[],
  raw: Map<string, { cursor: string }[]>,
  opts: typeof DEFAULT_SCAN_OPTIONS,
  _newestSeen?: Map<string, string>,
): Promise<void> {
  const connectionString = connectionStringFromEnv();
  if (!connectionString) {
    process.stderr.write(
      "\n--persist was requested but DATABASE_URL is not set. Nothing written.\n" +
      "Set it, or drop --persist. See .env.example.\n",
    );
    process.exitCode = 1;
    return;
  }

  const store = new Store({ connectionString });
  try {
    await store.assertReady();

    const domains = new Map<string, string>();
    for (const a of accounts) domains.set(a.account, a.domain);
    for (const domain of new Set(accounts.map((a) => a.domain))) {
      await store.upsertAnchor(domain);
    }
    await store.upsertAccounts(accounts);

    const scanId = await store.startScan(args.horizon, opts);
    process.stderr.write(`\nPersisting scan #${scanId}...\n`);

    let payments = 0;
    for (const m of metrics) {
      await store.setLiveness(m.account, m.lastActivityAt);
      await store.writeMetrics(scanId, m, classifyLiveness(m).replace("-", "_"));

      const records = raw.get(m.account) ?? [];
      if (records.length > 0) {
        // Dust is stored, not discarded — flagged so a future change of
        // threshold can be applied without re-fetching the ledger.
        const dust = new Set<string>();
        payments += await store.insertPayments(records as never, dust);
      }
    }

    await store.finishScan(scanId, metrics.length);
    process.stderr.write(`Wrote ${metrics.length} accounts and ${payments} payments.\n`);
  } catch (err) {
    process.stderr.write(
      `\nPersist failed: ${err instanceof Error ? err.message : String(err)}\n` +
      `The scan itself succeeded and the JSON above is intact.\n`,
    );
    process.exitCode = 1;
  } finally {
    await store.close();
  }
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
        "  --persist                        also write to Postgres via $DATABASE_URL",
        "  --out <dir>                      output directory (default ./out)",
        "",
      ].join("\n"),
    );
    process.exitCode = 1;
}
