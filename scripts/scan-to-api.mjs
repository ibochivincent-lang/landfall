/**
 * scan-to-api.mjs
 *
 * Reads the most recent scan-*.json from ./out/ and writes:
 *   packages/web/api/v1/anchors.json   — the main dashboard API endpoint
 *   packages/web/snapshot.json          — the fallback snapshot
 *
 * Called by .github/workflows/scan.yml after every successful scan.
 * Can also be run manually: node scripts/scan-to-api.mjs
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');
const OUT_DIR   = join(ROOT, 'out');
const API_FILE  = join(ROOT, 'packages', 'web', 'api', 'v1', 'anchors.json');
const SNAP_FILE = join(ROOT, 'packages', 'web', 'snapshot.json');

// ── 1. Find the newest scan file ─────────────────────────────────────────────
const files = (await readdir(OUT_DIR))
  .filter(f => f.startsWith('scan-') && f.endsWith('.json'))
  .sort();                         // ISO timestamps sort lexicographically

if (files.length === 0) {
  console.error('No scan files found in', OUT_DIR);
  process.exit(1);
}

const latest = files.at(-1);
const raw    = JSON.parse(await readFile(join(OUT_DIR, latest), 'utf8'));
console.log(`Converting ${latest} (${raw.metrics?.length ?? 0} accounts)...`);

// ── 2. Derive staleHours from the scan timestamp ──────────────────────────────
const generatedAt = new Date(raw.generatedAt);
const staleHours  = parseFloat(
  ((Date.now() - generatedAt.getTime()) / 3_600_000).toFixed(2)
);

// ── 3. Map raw metrics → the shape dashboard.js expects ──────────────────────
//
// Raw scan metric fields (from computeMetrics):
//   account, domain, name, lastActivityAt, hoursSinceLastActivity,
//   hasLifetimeActivity, inbound.count, outbound.count, refundCount, etc.
//
// dashboard.js expects per-account:
//   account, domain, name, state, inbound (count), outbound (count),
//   returns (count), returnRate (nullable), hoursSinceActivity (nullable)

function classify(m) {
  if (!m.hasLifetimeActivity)           return 'no_activity';
  const h = m.hoursSinceLastActivity ?? Infinity;
  if (h <= 72)                          return 'live';
  if (h <= 720)                         return 'slow';
  return 'dark';
}

const accounts = (raw.metrics ?? []).map(m => ({
  account:           m.account,
  domain:            m.domain,
  name:              m.name ?? m.domain,
  state:             classify(m),
  inbound:           m.inbound?.count  ?? 0,
  outbound:          m.outbound?.count ?? 0,
  returns:           m.refundCount     ?? 0,
  returnRate:        m.refundRate      ?? null,
  hoursSinceActivity: m.hoursSinceLastActivity ?? null,
  topCounterpartyShare: m.topCounterpartyShare ?? null,
}));

// ── 4. Build the API response body ────────────────────────────────────────────
const body = {
  asOf:       raw.generatedAt,
  staleHours,
  returnRateCaveat:
    'A return is the honest failure mode. An anchor that accepts value, fails to settle ' +
    'and keeps it produces no return event and scores 0. A low rate is the absence of ' +
    'one kind of evidence, not evidence of good conduct.',
  accounts,
};

// ── 5. Write files ────────────────────────────────────────────────────────────
await writeFile(API_FILE,  JSON.stringify(body, null, 2));
await writeFile(SNAP_FILE, JSON.stringify(body, null, 2));

console.log(`✓ Wrote ${API_FILE}`);
console.log(`✓ Wrote ${SNAP_FILE}`);
console.log(`  ${accounts.length} accounts — staleHours: ${staleHours}`);
console.log(`  live: ${accounts.filter(a => a.state === 'live').length}  ` +
            `dark: ${accounts.filter(a => a.state === 'dark').length}  ` +
            `slow: ${accounts.filter(a => a.state === 'slow').length}`);
