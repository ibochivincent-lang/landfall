/**
 * fetch-anchor-fees.mjs
 *
 * Gets each anchor's fees from the anchor, instead of from a hardcoded table
 * or from nowhere.
 *
 * Route Scout showed "Not published" for most anchors and hand-typed constants
 * for the rest. Both were wrong in different ways: the constants go stale
 * silently, and "not published" was often untrue — the operator publishes fees
 * perfectly well, in the machine-readable place SEP-24 defines for exactly this
 * purpose, and nobody was looking.
 *
 *   stellar.toml → TRANSFER_SERVER_SEP0024 → GET /info
 *
 * That endpoint returns `fee_fixed` and `fee_percent` per asset, plus limits
 * and whether the flow is enabled at all. It is the operator's own current
 * terms, fetched live, attributable to them rather than to us.
 *
 *   node scripts/fetch-anchor-fees.mjs
 *
 * Three outcomes are kept distinct, because collapsing them is how a tool ends
 * up lying politely:
 *
 *   published  — the anchor states a number. Use it, and say where it came from.
 *   dynamic    — the anchor says fees exist but are quoted per transaction
 *                (`"fee": {"enabled": true}` with no static figure). Genuinely
 *                unknowable in advance; "quoted at withdrawal" is the truth.
 *   unreachable — /info did not answer. Not the same as "free", and not the
 *                same as "declines to say".
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SEED = join(ROOT, 'packages', 'indexer', 'data', 'anchors.json');
const OUT = join(ROOT, 'packages', 'web', 'api', 'v1', 'anchor-fees.json');

const TIMEOUT = 12_000;

async function getText(url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** TRANSFER_SERVER_SEP0024 out of a stellar.toml, without a TOML parser. */
function sep24Endpoint(toml) {
  const line = toml.split(/\r?\n/).find((l) => /^\s*TRANSFER_SERVER_SEP0024\s*=/.test(l));
  if (!line) return null;
  const m = line.match(/["']([^"']+)["']/);
  return m ? m[1].replace(/\/$/, '') : null;
}

/**
 * Normalise one asset's withdraw terms.
 *
 * Withdraw, not deposit: Route Scout prices getting *out* to local currency,
 * and the two directions frequently carry different fees. Reading the deposit
 * number and presenting it as the withdrawal cost would be a quiet
 * misstatement of the thing the user is actually about to pay.
 */
function readAssetTerms(entry) {
  if (!entry || entry.enabled === false) return { enabled: false };

  const hasStatic = typeof entry.fee_fixed === 'number' || typeof entry.fee_percent === 'number';
  return {
    enabled: true,
    ...(hasStatic
      ? {
          pricing: 'published',
          feeFixed: typeof entry.fee_fixed === 'number' ? entry.fee_fixed : 0,
          feePercent: typeof entry.fee_percent === 'number' ? entry.fee_percent : 0,
        }
      : { pricing: 'dynamic' }),
    ...(typeof entry.min_amount === 'number' ? { minAmount: entry.min_amount } : {}),
    ...(typeof entry.max_amount === 'number' ? { maxAmount: entry.max_amount } : {}),
  };
}

async function forDomain(domain) {
  let toml;
  try {
    toml = await getText(`https://${domain}/.well-known/stellar.toml`);
  } catch (err) {
    return { domain, status: 'unreachable', reason: `stellar.toml: ${err.message}` };
  }

  const endpoint = sep24Endpoint(toml);
  if (!endpoint) {
    return { domain, status: 'no-sep24', reason: 'stellar.toml declares no TRANSFER_SERVER_SEP0024' };
  }

  let info;
  try {
    info = await getJson(`${endpoint}/info`);
  } catch (err) {
    return { domain, status: 'unreachable', endpoint, reason: `/info: ${err.message}` };
  }

  const withdraw = info.withdraw ?? {};
  const assets = {};
  for (const [code, entry] of Object.entries(withdraw)) assets[code] = readAssetTerms(entry);

  // Some anchors state only that fees exist and are computed per request. That
  // is a real answer, and a different one from silence.
  const dynamicGlobal = info.fee?.enabled === true && !Object.values(assets).some((a) => a.pricing === 'published');

  return {
    domain,
    status: 'ok',
    endpoint,
    fetchedAt: new Date().toISOString(),
    withdraw: assets,
    pricing: dynamicGlobal
      ? 'dynamic'
      : Object.values(assets).some((a) => a.pricing === 'published')
        ? 'published'
        : 'unknown',
  };
}

async function main() {
  const seed = JSON.parse(await readFile(SEED, 'utf8'));
  const domains = seed.domains ?? [];

  process.stderr.write(`Asking ${domains.length} anchors for their own terms…\n`);

  const results = [];
  const queue = [...domains];
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (queue.length) {
        const d = queue.shift();
        const r = await forDomain(d);
        const summary =
          r.status === 'ok'
            ? `${r.pricing}  (${Object.keys(r.withdraw).length} withdrawable asset(s))`
            : `${r.status}  ${r.reason ?? ''}`;
        process.stderr.write(`  ${r.status === 'ok' ? 'ok  ' : 'skip'}  ${d.padEnd(26)} ${summary}\n`);
        results.push(r);
      }
    }),
  );

  results.sort((a, b) => a.domain.localeCompare(b.domain));
  const ok = results.filter((r) => r.status === 'ok');

  await writeFile(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: "each anchor's own SEP-24 /info endpoint, reached via its stellar.toml",
        note:
          'Withdrawal terms as the operator publishes them, not as we estimate them. `pricing` is ' +
          '"published" when the anchor states fee_fixed/fee_percent, "dynamic" when it says fees exist but ' +
          'are quoted per transaction, and the anchor is omitted entirely when /info could not be reached — ' +
          'which is not the same as free, and not the same as declining to say.',
        caveat:
          'These are the fees the anchor advertises. The binding number is the one quoted inside its own ' +
          'withdrawal flow, which may differ; nothing here is a quote.',
        counts: {
          asked: domains.length,
          answered: ok.length,
          published: ok.filter((r) => r.pricing === 'published').length,
          dynamic: ok.filter((r) => r.pricing === 'dynamic').length,
        },
        anchors: Object.fromEntries(ok.map((r) => [r.domain, r])),
        unavailable: results
          .filter((r) => r.status !== 'ok')
          .map((r) => ({ domain: r.domain, status: r.status, reason: r.reason })),
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  console.log('');
  console.log(`✓ ${ok.length} of ${domains.length} anchors answered`);
  console.log(`  published fees: ${ok.filter((r) => r.pricing === 'published').length}`);
  console.log(`  quoted per transaction: ${ok.filter((r) => r.pricing === 'dynamic').length}`);
  console.log(`✓ ${OUT}`);
}

main().catch((err) => {
  console.error('fetch-anchor-fees failed:', err);
  process.exit(1);
});
