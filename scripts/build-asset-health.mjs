/**
 * build-asset-health.mjs
 *
 * Settlement health per asset, instead of per anchor.
 *
 * The scan has always computed inbound and outbound totals broken down by
 * asset — `byAsset` on every metric — and `toAccountSummary` has always thrown
 * that away, publishing one liveness verdict for the whole anchor. So an
 * anchor moving EURC hourly and NGNT never reads as "settling", and a payment
 * agent routing naira gets a green light from euro traffic.
 *
 * This surfaces what was already measured.
 *
 *   node scripts/build-asset-health.mjs  →  packages/web/api/v1/asset-health.json
 *
 * What it can and cannot say
 * --------------------------
 * Per-asset counts, volumes and counterparty spread are real measurements off
 * the ledger. Per-asset *liveness* is not directly available: the scan records
 * one last-activity timestamp per account, not per asset, so an asset's
 * recency is inferred from the account carrying it and is marked as inferred
 * rather than presented as measured. Fixing that properly means timestamping
 * per asset in the indexer, which is a change to the scan, not to this file.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_DIR = join(ROOT, 'out');
const API = join(ROOT, 'packages', 'web', 'api', 'v1');

/** "EURC:GABC…" → { code, issuer }; "native" → XLM. */
function parseAsset(assetId) {
  if (assetId === 'native') return { code: 'XLM', issuer: null };
  const [code, issuer] = assetId.split(':');
  return { code: code ?? assetId, issuer: issuer ?? null };
}

function sumVolume(a, b) {
  // Volumes are decimal strings and can exceed float precision, so they are
  // added in fixed-point rather than with `+`. Stellar carries 7 decimals.
  const scale = 10n ** 7n;
  const toFixed = (s) => {
    const [w = '0', f = ''] = String(s).split('.');
    return BigInt(w) * scale + BigInt((f + '0000000').slice(0, 7));
  };
  const total = toFixed(a) + toFixed(b);
  const whole = total / scale;
  const frac = (total % scale).toString().padStart(7, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

async function newestScan() {
  const files = (await readdir(OUT_DIR)).filter((f) => f.startsWith('scan-') && f.endsWith('.json')).sort();
  const latest = files.at(-1);
  if (!latest) throw new Error(`No scan files in ${OUT_DIR}`);
  return { file: latest, body: JSON.parse(await readFile(join(OUT_DIR, latest), 'utf8')) };
}

function livenessFrom(hours) {
  if (hours === null || hours === undefined) return 'no-payment-history';
  if (hours <= 72) return 'settling';
  if (hours <= 720) return 'slow';
  return 'dark';
}

async function main() {
  const { file, body: scan } = await newestScan();

  // domain → asset code → aggregate
  const byDomain = new Map();

  for (const m of scan.metrics ?? []) {
    if (!byDomain.has(m.domain)) byDomain.set(m.domain, new Map());
    const assets = byDomain.get(m.domain);

    const record = (direction, entry) => {
      const { code, issuer } = parseAsset(entry.asset);
      const key = code;
      const cur = assets.get(key) ?? {
        asset: code,
        issuers: new Set(),
        inbound: { count: 0, volume: '0' },
        outbound: { count: 0, volume: '0' },
        accounts: new Set(),
        freshestHours: null,
      };
      if (issuer) cur.issuers.add(issuer);
      cur[direction].count += entry.count ?? 0;
      cur[direction].volume = sumVolume(cur[direction].volume, entry.volume ?? '0');
      cur.accounts.add(m.account);

      // Inferred, not measured — see the header note.
      const h = m.hoursSinceLastActivity ?? null;
      if (h !== null && (cur.freshestHours === null || h < cur.freshestHours)) cur.freshestHours = h;

      assets.set(key, cur);
    };

    for (const e of m.inbound?.byAsset ?? []) record('inbound', e);
    for (const e of m.outbound?.byAsset ?? []) record('outbound', e);
  }

  const anchors = [...byDomain.entries()]
    .map(([domain, assets]) => {
      const corridors = [...assets.values()]
        .map((c) => ({
          asset: c.asset,
          issuers: [...c.issuers],
          inbound: c.inbound,
          outbound: c.outbound,
          totalPayments: c.inbound.count + c.outbound.count,
          accounts: c.accounts.size,
          liveness: {
            state: livenessFrom(c.freshestHours),
            hoursSinceActivity: c.freshestHours === null ? null : Number(c.freshestHours.toFixed(1)),
            basis: 'inferred',
            note: 'Taken from the last activity of the account carrying this asset, not from the asset itself — the scan timestamps per account, not per asset.',
          },
        }))
        .sort((a, b) => b.totalPayments - a.totalPayments || a.asset.localeCompare(b.asset));

      // The finding the whole file exists for: one anchor, different assets,
      // different health. Worth naming explicitly rather than leaving a reader
      // to spot it across rows.
      const states = new Set(corridors.map((c) => c.liveness.state));
      const busiest = corridors[0];
      const quietest = corridors.filter((c) => c.totalPayments > 0).at(-1);

      return {
        anchor: domain,
        corridorCount: corridors.length,
        mixedHealth: states.size > 1,
        spread:
          busiest && quietest && busiest.asset !== quietest.asset
            ? `${busiest.asset} carries ${busiest.totalPayments} payments; ${quietest.asset} carries ${quietest.totalPayments}.`
            : null,
        corridors,
      };
    })
    .sort((a, b) => b.corridorCount - a.corridorCount || a.anchor.localeCompare(b.anchor));

  // The same data pivoted the other way: one asset, every anchor moving it.
  const byAsset = new Map();
  for (const a of anchors) {
    for (const c of a.corridors) {
      const cur = byAsset.get(c.asset) ?? { asset: c.asset, anchors: [], totalPayments: 0 };
      cur.anchors.push({
        anchor: a.anchor,
        totalPayments: c.totalPayments,
        inbound: c.inbound,
        outbound: c.outbound,
        liveness: c.liveness,
      });
      cur.totalPayments += c.totalPayments;
      byAsset.set(c.asset, cur);
    }
  }
  const assets = [...byAsset.values()]
    .map((a) => ({ ...a, anchors: a.anchors.sort((x, y) => y.totalPayments - x.totalPayments || x.anchor.localeCompare(y.anchor)) }))
    .sort((a, b) => b.totalPayments - a.totalPayments || a.asset.localeCompare(b.asset));

  await writeFile(
    join(API, 'asset-health.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        scanFile: file,
        note:
          'Settlement broken down by asset rather than rolled up per anchor. An anchor can be busy in one ' +
          'asset and silent in another, and a single per-anchor verdict hides that — a payment agent routing ' +
          'naira should not be reassured by euro traffic.',
        limits:
          'Counts, volumes and counterparty spread are measured. Per-asset liveness is INFERRED from the ' +
          'account carrying the asset, because the scan timestamps last activity per account rather than per ' +
          'asset. Every liveness object says so in its `basis` field. Measuring it properly is a change to ' +
          'the indexer, not to this artifact.',
        totals: {
          anchors: anchors.length,
          distinctAssets: assets.length,
          anchorsWithMixedHealth: anchors.filter((a) => a.mixedHealth).length,
        },
        byAnchor: anchors,
        byAsset: assets,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  console.log(`✓ ${anchors.length} anchors, ${assets.length} distinct assets`);
  console.log(`  anchors whose assets differ in health: ${anchors.filter((a) => a.mixedHealth).length}`);
  for (const a of anchors.filter((x) => x.mixedHealth).slice(0, 6)) {
    console.log(
      `    ${a.anchor.padEnd(22)} ` +
        a.corridors.map((c) => `${c.asset}:${c.liveness.state}`).join('  '),
    );
  }
  console.log(`✓ ${join(API, 'asset-health.json')}`);
}

main().catch((err) => {
  console.error('build-asset-health failed:', err);
  process.exit(1);
});
