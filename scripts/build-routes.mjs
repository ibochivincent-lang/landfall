/**
 * build-routes.mjs
 *
 * The question a wallet actually has, answered in one request:
 *
 *   "I hold USDC. My user is in Nigeria and wants naira. Who can do that,
 *    and which of them is actually working right now?"
 *
 * Three things already existed separately and answered a third of it each —
 * which currencies an anchor declares (SEP-1), whether its endpoints answer
 * (capabilities.json), and whether it has settled anything lately (the ledger
 * scan). A wallet had to fetch all three and join them itself, which in
 * practice means nobody did.
 *
 *   node scripts/build-routes.mjs   →  packages/web/api/v1/routes.json
 *
 * Ranking, and what it deliberately is not
 * ----------------------------------------
 * Routes are ordered by evidence, not by a score. An anchor whose endpoints
 * answer and which settled an hour ago ranks above one whose endpoints answer
 * but which has been silent for a month, which ranks above one that declares
 * the corridor and whose API is down. That ordering is defensible from the
 * data; a number like 0.94 would not be, and would hide which of the three
 * facts was carrying it.
 *
 * Every route therefore carries its own evidence inline: last settlement,
 * which SEPs answered when probed, and when each was checked. A consumer that
 * disagrees with the ordering has everything needed to impose its own.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const API = join(ROOT, 'packages', 'web', 'api', 'v1');

/**
 * Currency to country.
 *
 * Only where the mapping is unambiguous. Shared currencies — EUR across the
 * eurozone, XOF across eight countries — are deliberately left without a
 * single country rather than being assigned a misleading one, because a wallet
 * filtering on "country" would then get a wrong answer rather than no answer.
 */
const COUNTRY = {
  NGN: { code: 'NG', name: 'Nigeria' },
  KES: { code: 'KE', name: 'Kenya' },
  GHS: { code: 'GH', name: 'Ghana' },
  ZAR: { code: 'ZA', name: 'South Africa' },
  BRL: { code: 'BR', name: 'Brazil' },
  ARS: { code: 'AR', name: 'Argentina' },
  CLP: { code: 'CL', name: 'Chile' },
  PEN: { code: 'PE', name: 'Peru' },
  MXN: { code: 'MX', name: 'Mexico' },
  INR: { code: 'IN', name: 'India' },
  IDR: { code: 'ID', name: 'Indonesia' },
  MYR: { code: 'MY', name: 'Malaysia' },
  KZT: { code: 'KZ', name: 'Kazakhstan' },
  DZD: { code: 'DZ', name: 'Algeria' },
  AOA: { code: 'AO', name: 'Angola' },
  JPY: { code: 'JP', name: 'Japan' },
  AUD: { code: 'AU', name: 'Australia' },
  NZD: { code: 'NZ', name: 'New Zealand' },
  UAH: { code: 'UA', name: 'Ukraine' },
  GBP: { code: 'GB', name: 'United Kingdom' },
  USD: { code: 'US', name: 'United States' },
  // EUR and XOF omitted on purpose — see the note above.
};

async function readJson(name, fallback) {
  try {
    return JSON.parse(await readFile(join(API, name), 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Asset codes an anchor is associated with, from both places they appear.
 *
 * SEP-1 `[[CURRENCIES]]` is what the anchor claims; a working /info is what it
 * currently serves. Both are included so an anchor that declares a corridor
 * and whose API is down still appears — flagged `api-down` rather than
 * silently missing. A wallet needs to know "they claim naira but nothing
 * answers", which is different information from "nobody does naira".
 */
function corridorsFor(capabilityEntry) {
  const codes = new Set((capabilityEntry.declaredCurrencies ?? []).map((c) => c.toUpperCase()));
  for (const cap of Object.values(capabilityEntry.capabilities ?? {})) {
    for (const list of Object.values(cap.assets ?? {})) {
      for (const code of list ?? []) codes.add(code.toUpperCase());
    }
  }
  return codes;
}

/**
 * Which declared fiat currency an asset code corresponds to.
 *
 * Anchors name assets after what they settle — NGNC for naira, APSINRM for
 * rupees, GYEN for yen — so a currency is present when its code appears
 * inside an asset code. Three letters is short enough that this occasionally
 * over-matches, which is why the matched asset is reported alongside: a
 * consumer can see what the claim rests on.
 */
function matchCorridor(assetCodes, currency) {
  for (const code of assetCodes) {
    if (code.includes(currency)) return code;
  }
  return null;
}

/**
 * Ledger liveness per domain, derived from the account rows.
 *
 * Deliberately not read from the `reliability` map: that is computed by the
 * serverless API from the database and is absent from the static artifact this
 * script runs against, so depending on it made every anchor "untracked" when
 * built offline. The account rows carry the same facts and are always present.
 */
function buildLiveness(accounts) {
  const byDomain = {};
  for (const a of accounts) (byDomain[a.domain] = byDomain[a.domain] || []).push(a);

  const out = {};
  for (const [domain, rows] of Object.entries(byDomain)) {
    const freshest = rows
      .map((r) => r.hoursSinceActivity)
      .filter((h) => h !== null && h !== undefined)
      .sort((x, y) => x - y)[0];

    out[domain] =
      freshest === undefined
        ? { state: 'no-payment-history', hoursSinceActivity: null, accounts: rows.length }
        : {
            state: freshest <= 72 ? 'settling' : freshest <= 720 ? 'slow' : 'dark',
            hoursSinceActivity: Number(freshest.toFixed(1)),
            accounts: rows.length,
          };
  }
  return out;
}

function livenessOf(liveness, domain) {
  return liveness[domain] ?? { state: 'untracked', hoursSinceActivity: null, accounts: 0 };
}

/** Lower sorts first. Ordinal over evidence, deliberately not a score. */
function rank(route) {
  const api = route.api.working > 0 ? 0 : route.api.declared > 0 ? 2 : 1;
  const led = { settling: 0, slow: 1, 'no-payment-history': 2, dark: 3, untracked: 4 }[route.ledger.state] ?? 4;
  return api * 10 + led;
}

async function main() {
  const capabilities = await readJson('capabilities.json', { anchors: [] });
  const anchors = await readJson('anchors.json', { accounts: [], reliability: {} });
  const fees = await readJson('anchor-fees.json', { anchors: {} });

  const liveness = buildLiveness(anchors.accounts ?? []);
  const byCorridor = {};

  for (const entry of capabilities.anchors ?? []) {
    if (!entry.reachable) continue;

    const assetCodes = corridorsFor(entry);
    const working = Object.entries(entry.capabilities ?? {})
      .filter(([, c]) => c.declared && c.observed === 'yes')
      .map(([id]) => id);
    const failing = Object.entries(entry.capabilities ?? {})
      .filter(([, c]) => c.declared && c.observed === 'no')
      .map(([id]) => id);

    for (const currency of Object.keys(COUNTRY)) {
      const asset = matchCorridor(assetCodes, currency);
      if (!asset) continue;

      const feeEntry = fees.anchors?.[entry.domain];
      const feeTerms = feeEntry?.withdraw
        ? Object.entries(feeEntry.withdraw).find(([code]) => code.includes(currency))?.[1]
        : null;

      const route = {
        anchor: entry.domain,
        name: entry.orgName ?? entry.domain,
        asset,
        api: {
          declared: working.length + failing.length,
          working: working.length,
          workingSeps: working,
          failingSeps: failing,
          checkedAt: entry.checkedAt,
        },
        ledger: livenessOf(liveness, entry.domain),
        fees:
          feeTerms && feeTerms.pricing === 'published'
            ? { pricing: 'published', feePercent: feeTerms.feePercent, feeFixed: feeTerms.feeFixed }
            : feeTerms
              ? { pricing: 'quoted-per-transaction' }
              : { pricing: 'unknown' },
        // Named so it cannot be read as an endorsement. See `status` below.
        status:
          working.length === 0 && failing.length > 0
            ? 'api-down'
            : livenessOf(liveness, entry.domain).state === 'settling' && working.length > 0
              ? 'observed-working'
              : 'observed-degraded',
      };

      (byCorridor[currency] = byCorridor[currency] || []).push(route);
    }
  }

  for (const list of Object.values(byCorridor)) list.sort((a, b) => rank(a) - rank(b));

  const corridors = Object.entries(byCorridor)
    .map(([currency, routes]) => ({
      currency,
      country: COUNTRY[currency],
      routes,
      counts: {
        total: routes.length,
        observedWorking: routes.filter((r) => r.status === 'observed-working').length,
        degraded: routes.filter((r) => r.status === 'observed-degraded').length,
        apiDown: routes.filter((r) => r.status === 'api-down').length,
      },
    }))
    .sort((a, b) => b.routes.length - a.routes.length);

  await writeFile(
    join(API, 'routes.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        note:
          'Which anchors can move value into a given local currency, and which of them are demonstrably ' +
          'working. Joins three things that previously had to be joined by the caller: the currencies an ' +
          'anchor declares, whether its SEP endpoints answered when probed, and whether it has settled ' +
          'anything on the ledger lately.',
        ranking:
          'Ordered by evidence, not by a score. Endpoints answering and a recent settlement ranks above ' +
          'endpoints answering and a long silence, which ranks above a declared corridor with a dead API. ' +
          'Every route carries the evidence inline so a consumer that disagrees can impose its own order.',
        vocabulary: {
          'observed-working': 'Endpoints answered when probed AND the anchor settled on-chain within 72 hours.',
          'observed-degraded': 'Something is stale or unproven — read the ledger and api fields to see which.',
          'api-down': 'The anchor declares this corridor but none of its declared SEP endpoints answered.',
        },
        limits:
          'These are observations, not endorsements. Nothing here says an anchor is solvent, licensed, ' +
          'honest, or safe to use — only that its endpoints answered a probe and its accounts moved value ' +
          'on a public ledger. A single failed probe can be geo-blocking or a deploy rather than an outage. ' +
          'EUR and XOF carry no country because they span many, and assigning one would be worse than none.',
        corridorCount: corridors.length,
        corridors,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  console.log(`✓ ${corridors.length} corridors`);
  for (const c of corridors.slice(0, 10)) {
    console.log(
      `  ${c.currency}  ${String(c.counts.total).padStart(2)} route(s)  ` +
        `${c.counts.observedWorking} working, ${c.counts.degraded} degraded, ${c.counts.apiDown} api-down`,
    );
  }
  console.log(`✓ ${join(API, 'routes.json')}`);
}

main().catch((err) => {
  console.error('build-routes failed:', err);
  process.exit(1);
});
