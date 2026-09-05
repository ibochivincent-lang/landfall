/**
 * discover-anchors.ts
 *
 * Finds candidate anchor home domains from an independent directory, checks
 * each one against SEP-1, and reports what is actually trackable.
 *
 *   npx tsx scripts/discover-anchors.ts            # report only
 *   npx tsx scripts/discover-anchors.ts --write    # also update the seed list
 *
 * Why this exists
 * ---------------
 * The tracked-anchor seed list was eight domains typed by hand, of which five
 * resolved. Three weeks of hourly history over that set contains exactly one
 * account that settles regularly — which is not enough observational base to
 * support most of what the project wants to say, and no amount of better
 * analysis fixes a sample that small. Coverage is the binding constraint, and
 * a hand-maintained list is the reason it binds.
 *
 * Source and its limits
 * ---------------------
 * stellar.expert's public directory is curated by a third party, not by the
 * ledger, so it is treated as a source of *candidates* and nothing more.
 * Nothing here is trusted on the directory's say-so: every candidate is
 * resolved against its own stellar.toml by the same `discoverDomain` the scan
 * uses, so a domain only enters the seed list if it declares accounts under
 * SEP-1 — the permissionless standard the operator controls — and issuer
 * attribution is confirmed against each issuer's own on-chain home_domain.
 *
 * The directory does carry one thing the ledger cannot: abuse labelling. A
 * little under half the anchor-tagged domains in it are tagged malicious,
 * unsafe, or scam. Those are excluded and never auto-added, because Landfall
 * publishes reliability figures about named businesses and listing a known
 * counterfeiter alongside real anchors would lend it the same presentation as
 * the real ones. They are reported, so the exclusion is visible rather than
 * silent, but promoting one is a deliberate human act.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { discoverDomain } from "../packages/indexer/src/toml.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SEED_FILE = join(ROOT, "packages", "indexer", "data", "anchors.json");
const REPORT_FILE = join(ROOT, "out", "anchor-candidates.json");

const DIRECTORY = "https://api.stellar.expert/explorer/public/directory";
const HORIZON = process.env.HORIZON_URL || "https://horizon.stellar.org";
const CONCURRENCY = 6;

/** Directory tags that disqualify a domain from ever being auto-added. */
const DISQUALIFYING = new Set(["malicious", "unsafe", "scam", "deleted"]);

interface DirectoryRecord {
  address: string;
  domain?: string;
  name?: string;
  tags?: string[];
}

interface Candidate {
  domain: string;
  name?: string;
  tags: string[];
  directoryAccounts: number;
}

async function fetchAnchorDirectory(): Promise<DirectoryRecord[]> {
  const out: DirectoryRecord[] = [];
  let url: string | null = `${DIRECTORY}?tag[]=anchor&limit=200`;

  // Bounded rather than while(url): a paging bug upstream must not turn this
  // into an unbounded crawl of someone else's API.
  for (let page = 0; page < 10 && url; page++) {
    const res: Response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Directory returned HTTP ${res.status}`);
    const body = (await res.json()) as {
      _embedded?: { records?: DirectoryRecord[] };
      _links?: { next?: { href?: string } };
    };
    const records = body._embedded?.records ?? [];
    if (records.length === 0) break;
    out.push(...records);
    const next = body._links?.next?.href;
    url = next ? `https://api.stellar.expert${next}` : null;
  }
  return out;
}

function groupByDomain(records: DirectoryRecord[]): Candidate[] {
  const byDomain = new Map<string, Candidate>();
  for (const record of records) {
    const domain = record.domain?.trim().toLowerCase();
    if (!domain) continue;
    const existing = byDomain.get(domain) ?? {
      domain,
      name: record.name,
      tags: [] as string[],
      directoryAccounts: 0,
    };
    existing.directoryAccounts++;
    for (const tag of record.tags ?? []) {
      if (!existing.tags.includes(tag)) existing.tags.push(tag);
    }
    byDomain.set(domain, existing);
  }
  return [...byDomain.values()].sort((a, b) => a.domain.localeCompare(b.domain));
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i] as T);
      }
    }),
  );
  return results;
}

async function main(): Promise<void> {
  const write = process.argv.includes("--write");

  const seed = JSON.parse(await readFile(SEED_FILE, "utf8")) as { note?: string; domains?: string[] };
  const seeded = new Set((seed.domains ?? []).map((d) => d.toLowerCase()));

  process.stderr.write("Fetching anchor-tagged records from stellar.expert…\n");
  const records = await fetchAnchorDirectory();
  const all = groupByDomain(records);

  const excluded = all.filter((c) => c.tags.some((t) => DISQUALIFYING.has(t)));
  const candidates = all.filter((c) => !c.tags.some((t) => DISQUALIFYING.has(t)));

  process.stderr.write(
    `${records.length} records → ${all.length} domains ` +
      `(${excluded.length} excluded on abuse tags, ${candidates.length} to check).\n\n`,
  );

  const checked = await mapLimit(candidates, CONCURRENCY, async (candidate) => {
    const { accounts, error } = await discoverDomain(candidate.domain, fetch, HORIZON);
    const status = error ? `FAIL  ${error}` : accounts.length === 0 ? "FAIL  no accounts declared" : `ok    ${accounts.length} account(s)`;
    process.stderr.write(`  ${status.startsWith("ok") ? "ok  " : "FAIL"}  ${candidate.domain.padEnd(32)} ${status.replace(/^(ok|FAIL)\s+/, "")}\n`);
    return { ...candidate, accounts: accounts.length, error };
  });

  const resolved = checked.filter((c) => !c.error && c.accounts > 0);
  const failed = checked.filter((c) => c.error || c.accounts === 0);
  const additions = resolved.filter((c) => !seeded.has(c.domain));

  const report = {
    generatedAt: new Date().toISOString(),
    source: DIRECTORY,
    sourceCaveat:
      "stellar.expert's directory is curated by a third party. It is used only to propose candidates; " +
      "every domain here was independently resolved against its own SEP-1 stellar.toml, and only domains " +
      "that declare accounts themselves are eligible.",
    totals: {
      directoryDomains: all.length,
      excludedOnAbuseTags: excluded.length,
      checked: candidates.length,
      resolved: resolved.length,
      failed: failed.length,
      newToSeedList: additions.length,
    },
    resolved: resolved.map((c) => ({ domain: c.domain, name: c.name, accounts: c.accounts, tags: c.tags })),
    failed: failed.map((c) => ({ domain: c.domain, reason: c.error ?? "no accounts declared" })),
    excludedOnAbuseTags: excluded.map((c) => ({ domain: c.domain, name: c.name, tags: c.tags })),
  };

  await writeFile(REPORT_FILE, JSON.stringify(report, null, 2) + "\n", "utf8");

  console.log("");
  console.log(`Directory domains       ${all.length}`);
  console.log(`  excluded (abuse tags) ${excluded.length}`);
  console.log(`  resolved via SEP-1    ${resolved.length}`);
  console.log(`  failed to resolve     ${failed.length}`);
  console.log(`  new to the seed list  ${additions.length}`);
  console.log("");
  console.log(`Report: ${REPORT_FILE}`);

  if (additions.length > 0) {
    console.log("");
    console.log("New, verified, unflagged domains:");
    for (const a of additions) console.log(`  ${a.domain.padEnd(32)} ${a.accounts} account(s)`);
  }

  if (!write) {
    console.log("");
    console.log("Report only. Re-run with --write to add the resolved domains to the seed list.");
    return;
  }

  const merged = [...new Set([...(seed.domains ?? []), ...additions.map((a) => a.domain)])];
  await writeFile(SEED_FILE, JSON.stringify({ ...seed, domains: merged }, null, 2) + "\n", "utf8");
  console.log("");
  console.log(`✓ Seed list updated: ${seed.domains?.length ?? 0} → ${merged.length} domains.`);
}

main().catch((err) => {
  console.error("discover-anchors failed:", err);
  process.exit(1);
});
