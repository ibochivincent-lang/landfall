/**
 * verify-scan.ts
 *
 * Gate between a completed scan and publishing it to the site.
 *
 * Reads the newest scan in ./out and the currently published
 * packages/web/api/v1/anchors.json — which is, by construction, the previous
 * scan's output — and checks the two against the invariants in
 * packages/indexer/src/invariants.ts. Exits non-zero when a check fails at
 * error severity, which stops the workflow before scan-to-api.mjs overwrites
 * anything.
 *
 * Manual run:  npx tsx scripts/verify-scan.ts
 *
 * Why this is a separate step rather than a check inside scan-to-api.mjs: the
 * publish script's job is to transform and write, and a transformer that
 * sometimes silently declines to write is harder to reason about than a gate
 * that fails loudly in front of it. It also means the scan output stays on
 * disk and inspectable when a run is blocked — the numbers are still there to
 * look at, they simply have not been published.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  hasBlockingFinding,
  renderFindings,
  runInvariants,
  type CheckableAccount,
} from "../packages/indexer/src/invariants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT_DIR = join(ROOT, "out");
const API_FILE = join(ROOT, "packages", "web", "api", "v1", "anchors.json");

/** Written every run, pass or fail — the public record of the decision. */
const VERIFICATION_FILE = join(ROOT, "packages", "web", "api", "v1", "scan-verification.json");

interface ScanMetric {
  account: string;
  domain: string;
  inbound?: { count?: number };
  outbound?: { count?: number };
}

interface PublishedAccount {
  account: string;
  domain: string;
  inbound?: number;
  outbound?: number;
}

async function readNewestScan(): Promise<{ file: string; accounts: CheckableAccount[] }> {
  const files = (await readdir(OUT_DIR))
    .filter((f) => f.startsWith("scan-") && f.endsWith(".json"))
    .sort(); // ISO timestamps sort lexicographically

  const latest = files.at(-1);
  if (!latest) throw new Error(`No scan files found in ${OUT_DIR}`);

  const raw = JSON.parse(await readFile(join(OUT_DIR, latest), "utf8")) as { metrics?: ScanMetric[] };
  const accounts = (raw.metrics ?? []).map((m) => ({
    account: m.account,
    domain: m.domain,
    inbound: m.inbound?.count ?? 0,
    outbound: m.outbound?.count ?? 0,
  }));
  return { file: latest, accounts };
}

/**
 * The previously published set, or undefined on a first run.
 *
 * A missing or unreadable file is not an error: the movement checks are
 * skipped rather than guessed at, and the attribution checks — which are the
 * ones that catch the failure this whole gate exists for — need no history.
 */
async function readPublished(): Promise<CheckableAccount[] | undefined> {
  try {
    const body = JSON.parse(await readFile(API_FILE, "utf8")) as { accounts?: PublishedAccount[] };
    if (!body.accounts?.length) return undefined;
    return body.accounts.map((a) => ({
      account: a.account,
      domain: a.domain,
      inbound: Number(a.inbound ?? 0),
      outbound: Number(a.outbound ?? 0),
    }));
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const { file, accounts } = await readNewestScan();
  const previous = await readPublished();

  console.log(
    `Verifying ${file} (${accounts.length} accounts) against ` +
      (previous ? `${previous.length} previously published accounts.` : "no previous scan — movement checks skipped."),
  );

  const findings = runInvariants({ current: accounts, previous });
  console.log("");
  console.log(renderFindings(findings));

  const blocked = hasBlockingFinding(findings);

  /* ── The audit trail ──────────────────────────────────────────────────
     Written on every run, pass or fail. A safety check that only leaves a
     trace in a CI log nobody reads is a safety check on trust: the decision
     to withhold an update is itself a claim about the data, and it should be
     as inspectable as the data would have been.

     Blocked runs matter most here. The scan output stays on disk and the site
     keeps the previous figures, so without this artifact the only public
     evidence that anything happened is an hour of unchanged numbers.        */
  await writeFile(
    VERIFICATION_FILE,
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        scanFile: file,
        accountsChecked: accounts.length,
        comparedAgainst: previous ? { publishedAccounts: previous.length } : null,
        outcome: blocked ? "blocked" : findings.length > 0 ? "published-with-warnings" : "clean",
        published: !blocked,
        counts: {
          errors: findings.filter((f) => f.severity === "error").length,
          warnings: findings.filter((f) => f.severity === "warning").length,
        },
        findings: findings.map((f) => ({
          severity: f.severity,
          code: f.code,
          message: f.message,
          detail: f.detail ?? null,
        })),
        note: blocked
          ? "This scan was NOT published. One or more invariants failed at error severity, and the site is " +
            "still serving the previous scan's figures. Stale data is visible to a reader; an incoherent " +
            "figure is not, so the update was withheld rather than shipped."
          : findings.length > 0
            ? "Published. Warnings are real changes worth a human look, but they are visible on the site " +
              "itself, so withholding the whole update would trade a visible change for silent staleness."
            : "Published. Every invariant held.",
        checksApplied:
          "See packages/indexer/src/invariants.ts — one on-chain account claimed by two anchors, rows " +
          "attributed to no anchor, duplicate rows that double-count, and payment counts moving implausibly " +
          "in either direction between scans.",
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  console.log(`\nAudit artifact: ${VERIFICATION_FILE}`);

  if (blocked) process.exit(1);
}

main().catch((err) => {
  // A gate that cannot run must not wave the scan through: an unreadable scan
  // file or a crash here is itself a reason not to publish.
  console.error("verify-scan failed to complete:", err);
  process.exit(1);
});
