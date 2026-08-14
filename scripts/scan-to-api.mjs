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

// ── 6. Keep the static fallbacks in index.html honest ─────────────────────────
//
// app.js overwrites these from the live API, so a browser always sees current
// values. A crawler, a reader with JS off, or anyone hitting the page while the
// API is down sees whatever is baked into the HTML — and until now that was a
// scan date typed by hand, which drifted two days stale under a "LIVE" badge.
// The scan already knows the right values, so it writes them.
//
// Never fatal: a scan that indexed the ledger correctly must not fail because a
// marketing string would not substitute.
try {
  const INDEX_FILE = join(ROOT, 'packages', 'web', 'index.html');
  let html = await readFile(INDEX_FILE, 'utf8');

  const scanDate = new Date(body.asOf).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
  const inbound = accounts.reduce((sum, a) => sum + Number(a.inbound || 0), 0);
  const dark    = accounts.filter(a => a.state === 'dark').length;

  const before = html;
  html = html
    .replace(/(<span id="scanDate">)[^<]*(<\/span>)/,       `$1${scanDate}$2`)
    .replace(/(<span id="footerAccounts">)[^<]*(<\/span>)/, `$1${accounts.length}$2`)
    .replace(/(<strong id="cardVolume">)[^<]*(<\/strong>)/, `$1${inbound.toLocaleString('en-US')}$2`)
    .replace(/(<span id="cardAccounts">)[^<]*(<\/span>)/,   `$1${accounts.length} accounts$2`)
    .replace(/(<b class="ledger-panel__dark" id="heroDark">)[^<]*(<\/b>)/, `$1${dark} of ${accounts.length}$2`);

  if (html !== before) {
    await writeFile(INDEX_FILE, html);
    console.log(`✓ Wrote ${INDEX_FILE} (static fallbacks: ${scanDate}, ${inbound} inbound, ${dark}/${accounts.length} dark)`);
  } else {
    console.log('  index.html fallbacks already current');
  }
} catch (err) {
  console.warn(`! Could not refresh index.html fallbacks: ${err.message}`);
  console.warn('  Scan output above is unaffected.');
}
console.log(`  ${accounts.length} accounts — staleHours: ${staleHours}`);
console.log(`  live: ${accounts.filter(a => a.state === 'live').length}  ` +
            `dark: ${accounts.filter(a => a.state === 'dark').length}  ` +
            `slow: ${accounts.filter(a => a.state === 'slow').length}`);
