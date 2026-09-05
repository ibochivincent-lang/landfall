/**
 * build-evidence.ts
 *
 * Turns published figures into published *evidence*.
 *
 * Until now the API said "cowrie.exchange is slow, 24 inbound, 289h since
 * activity" and a reader's only option was to believe it. There was no way to
 * ask which dataset produced that, whether the dataset had changed since, or
 * whether the same inputs would produce the same answer.
 *
 * This commits every scan to a Merkle root over the exact per-account records
 * the published figures derive from, and emits a per-account inclusion proof.
 * A consumer can then recompute the leaf from the record they were served,
 * walk the proof, and confirm it lands on the root the scan published — which
 * turns "trust the score" into "check the arithmetic".
 *
 *   npx tsx scripts/build-evidence.ts
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT
 * --------------------------------------
 * It proves the served record is the one committed in that scan's dataset, and
 * that the dataset is internally consistent and reproducible.
 *
 * It does **not**, on its own, prove tamper-evidence. The root travels in the
 * same document it authenticates, so whoever publishes that document could
 * recompute both and nobody downstream would notice. A root becomes evidence
 * against its own publisher only once it is committed somewhere the publisher
 * cannot rewrite — the Stellar ledger, via the MEMO_HASH path in
 * packages/anchoring — or once a third party has retained a copy.
 *
 * Every artifact this script writes says so, in those words. Publishing a root
 * while implying it means more than it does would be a worse failure than not
 * publishing one, because it would look like proof.
 */

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import {
  canonicalBytes,
  hashLeaf,
  inclusionProof,
  rootFromLeaves,
  toHex,
  type Hash,
} from "../packages/anchoring/src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT_DIR = join(ROOT, "out");
const API_DIR = join(ROOT, "packages", "web", "api", "v1");
const ANCHORS_JSON = join(API_DIR, "anchors.json");
const EVIDENCE_JSON = join(API_DIR, "evidence.json");
const EVIDENCE_DIR = join(API_DIR, "evidence");

/** Bound into every leaf so a proof from this dataset cannot be replayed
 *  against a different Landfall artifact. */
const NAMESPACE = "landfall-settlement-v1";

/**
 * The record a published figure derives from.
 *
 * Deliberately the *inputs and outputs of the classification*, not the whole
 * scan metric: a leaf should contain exactly what the API serves, so a
 * consumer can canonicalise what they were given and get the same leaf. Adding
 * fields the API does not return would make the proof uncheckable by the
 * person holding the response.
 */
interface EvidenceRecord {
  account: string;
  domain: string;
  state: string;
  inbound: number;
  outbound: number;
  returns: number;
  returnRate: number | null;
  hoursSinceActivity: number | null;
  sampled: number;
  windowStart: string | null;
  windowEnd: string | null;
}

interface ScanMetric {
  account: string;
  domain: string;
  sampled?: number;
  windowStart?: string;
  windowEnd?: string;
  hoursSinceLastActivity?: number;
  hasLifetimeActivity?: boolean;
  inbound?: { count?: number };
  outbound?: { count?: number };
  refundCount?: number;
  refundRate?: number | null;
}

interface PublishedAccount {
  account: string;
  domain: string;
  state: string;
  inbound?: number;
  outbound?: number;
  returns?: number;
  returnRate?: number | null;
  hoursSinceActivity?: number | null;
}

async function newestScan(): Promise<{ file: string; body: { generatedAt: string; options?: Record<string, unknown>; metrics?: ScanMetric[] } }> {
  const files = (await readdir(OUT_DIR)).filter((f) => f.startsWith("scan-") && f.endsWith(".json")).sort();
  const latest = files.at(-1);
  if (!latest) throw new Error(`No scan files in ${OUT_DIR}`);
  return { file: latest, body: JSON.parse(await readFile(join(OUT_DIR, latest), "utf8")) };
}

/**
 * A stable identifier for *how* the figures were produced.
 *
 * Everything that changes the numbers without the ledger changing belongs
 * here: the record cap, the dust floor, the refund matcher's window and
 * tolerance, and the liveness thresholds. If any of it moves, the version
 * moves, and a consumer comparing two scans can tell "the anchor changed" from
 * "we changed how we measure".
 */
function methodologyVersion(options: Record<string, unknown> | undefined): {
  id: string;
  parameters: Record<string, unknown>;
} {
  const parameters = {
    maxRecords: options?.["maxRecords"] ?? null,
    dustThreshold: options?.["dustThreshold"] ?? null,
    refundWindowHours: options?.["refundWindowHours"] ?? null,
    refundTolerance: options?.["refundTolerance"] ?? null,
    livenessLiveMaxHours: 72,
    livenessDarkMinHours: 720,
    classification: "packages/indexer/src/report.ts classifyLiveness",
    leafNamespace: NAMESPACE,
  };
  const id = createHash("sha256")
    .update(Buffer.from(canonicalBytes(parameters as never)))
    .digest("hex")
    .slice(0, 16);
  return { id, parameters };
}

function toEvidenceRecord(published: PublishedAccount, metric: ScanMetric | undefined): EvidenceRecord {
  return {
    account: published.account,
    domain: published.domain,
    state: published.state,
    inbound: Number(published.inbound ?? 0),
    outbound: Number(published.outbound ?? 0),
    returns: Number(published.returns ?? 0),
    returnRate: published.returnRate ?? null,
    hoursSinceActivity: published.hoursSinceActivity ?? null,
    sampled: Number(metric?.sampled ?? 0),
    windowStart: metric?.windowStart ?? null,
    windowEnd: metric?.windowEnd ?? null,
  };
}

async function main(): Promise<void> {
  const { file, body: scan } = await newestScan();
  const published = JSON.parse(await readFile(ANCHORS_JSON, "utf8")) as {
    asOf: string;
    accounts: PublishedAccount[];
    [k: string]: unknown;
  };

  const metricsByAccount = new Map((scan.metrics ?? []).map((m) => [m.account, m]));

  // Sorted by account so the tree is deterministic: the same scan must produce
  // the same root on any machine, or the root proves nothing about the data.
  const accounts = [...published.accounts].sort((a, b) => a.account.localeCompare(b.account));
  const records = accounts.map((a) => toEvidenceRecord(a, metricsByAccount.get(a.account)));

  const leaves: Hash[] = records.map((r) => hashLeaf(NAMESPACE, canonicalBytes(r as never)));
  const datasetRoot = toHex(rootFromLeaves(leaves));
  const methodology = methodologyVersion(scan.options);

  const NOT_YET_ANCHORED =
    "This root is published in the same document it authenticates, so on its own it demonstrates " +
    "reproducibility and internal consistency — not tamper-evidence. Whoever serves this file could " +
    "recompute both. It becomes evidence against its own publisher once committed to the Stellar " +
    "ledger (MEMO_HASH is exactly 32 bytes; see packages/anchoring) or once a third party has retained " +
    "a copy of it. Until then, treat it as a checksum you can verify, not a commitment you can enforce.";

  /* ── per-account proofs ────────────────────────────────────────────────── */
  await mkdir(EVIDENCE_DIR, { recursive: true });
  let written = 0;

  for (const [index, record] of records.entries()) {
    const proof = inclusionProof(leaves, index).map((s) => ({ position: s.position, hash: toHex(s.hash) }));

    await writeFile(
      join(EVIDENCE_DIR, `${record.account}.json`),
      JSON.stringify(
        {
          asOf: published.asOf,
          scanFile: file,
          datasetRoot,
          methodology,
          record,
          proof: { index, count: records.length, path: proof, namespace: NAMESPACE, algorithm: "sha256-rfc6962" },
          howToVerify: [
            "1. Canonicalise `record` per RFC 8785 (sorted keys, no whitespace).",
            "2. leaf = SHA-256(0x00 || 'landfall-settlement-v1' || 0x00 || canonical_bytes).",
            "3. Walk `proof.path`: for each step, parent = SHA-256(0x01 || left || right), where the step's",
            "   `position` says which side its hash sits on.",
            "4. The result must equal `datasetRoot`.",
            "Reference implementation: packages/anchoring (rootFromProof).",
          ],
          limits: NOT_YET_ANCHORED,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    written++;
  }

  /* ── manifest ──────────────────────────────────────────────────────────── */
  await writeFile(
    EVIDENCE_JSON,
    JSON.stringify(
      {
        asOf: published.asOf,
        scanFile: file,
        datasetRoot,
        recordCount: records.length,
        namespace: NAMESPACE,
        algorithm: "sha256-rfc6962",
        methodology,
        note:
          "A Merkle commitment to the exact per-account records the published figures derive from. Each " +
          "account has an inclusion proof at /api/v1/evidence/<account>.json, so a consumer can recompute " +
          "the leaf from the record they were served and confirm it lands on this root — the difference " +
          "between trusting a score and checking one.",
        limits: NOT_YET_ANCHORED,
        appendOnlyAudit:
          "Successive dataset roots can be checked for append-only behaviour with the consistency proofs in " +
          "packages/anchoring. Note that this dataset is a per-scan snapshot rather than a growing log, so " +
          "roots are expected to differ between scans; consistency applies to logs built to be append-only, " +
          "not to independent snapshots.",
        accounts: records.map((r, i) => ({
          account: r.account,
          domain: r.domain,
          index: i,
          proof: `/api/v1/evidence/${r.account}.json`,
        })),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  /* ── stamp the root onto the main API response ─────────────────────────── */
  const enriched = {
    ...published,
    evidence: {
      datasetRoot,
      recordCount: records.length,
      methodologyVersion: methodology.id,
      namespace: NAMESPACE,
      algorithm: "sha256-rfc6962",
      manifest: "/api/v1/evidence.json",
      proofFor: "/api/v1/evidence/<account>.json",
      limits: NOT_YET_ANCHORED,
    },
  };
  await writeFile(ANCHORS_JSON, JSON.stringify(enriched, null, 2) + "\n", "utf8");

  console.log(`✓ datasetRoot ${datasetRoot}`);
  console.log(`✓ methodology ${methodology.id}`);
  console.log(`✓ ${written} per-account inclusion proof(s) → api/v1/evidence/`);
  console.log(`✓ manifest → api/v1/evidence.json`);
  console.log(`  Root is NOT yet committed on-chain; it proves reproducibility, not tamper-evidence.`);
}

main().catch((err) => {
  console.error("build-evidence failed:", err);
  process.exit(1);
});
