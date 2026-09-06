/**
 * fetch-anchor-quotes.mjs
 *
 * Gets each anchor's FX rate from the anchor, instead of from a hardcoded
 * constant.
 *
 * Route Scout's `rateSpread` per anchor (packages/web/compare.js) has always
 * been a number someone typed in once and never revisited — README says so
 * plainly: "The FX rates, fee schedules and payout speeds behind them are a
 * hardcoded catalogue, not live SEP-38 quotes." fetch-anchor-fees.mjs already
 * fixed the fee half of that sentence, reading SEP-24 /info instead of a
 * constant. This does the rate half, reading SEP-38 — the standard built for
 * exactly this — instead of a guess.
 *
 *   stellar.toml → ANCHOR_QUOTE_SERVER → GET /info → GET /price
 *
 * GET /price is SEP-38's indicative, unauthenticated quote endpoint — no
 * SEP-10 challenge needed, matching the "public read" posture every other
 * script here already assumes. It is indicative, not firm: an anchor is free
 * to quote differently at execution time, and its price can vary by amount
 * (fee tiers). Sampled at a fixed $100 once an hour, same tradeoff this
 * project already made for fees, and said out loud in the same way.
 *
 * What decides which asset pair to ask about is the anchor's own /info
 * response, not a guess: /info lists exactly which Stellar assets (with
 * issuer) and which fiat currencies it will quote, and this only asks about
 * pairs that appear there AND in the corridor list Route Scout already shows
 * for that anchor (packages/web/compare.js's CATALOG — read directly out of
 * that file rather than duplicated here, so there is one list of which
 * corridors each anchor serves, not two that can disagree).
 *
 *   node scripts/fetch-anchor-quotes.mjs
 *
 * Outcomes kept distinct, same reasoning as fetch-anchor-fees.mjs: collapsing
 * "no SEP-38 server" into "unreachable" into "doesn't support this pair"
 * would hide which of three different facts is true.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SEED = join(ROOT, 'packages', 'indexer', 'data', 'anchors.json');
const COMPARE_JS = join(ROOT, 'packages', 'web', 'compare.js');
const OUT = join(ROOT, 'packages', 'web', 'api', 'v1', 'anchor-quotes.json');

const TIMEOUT = 12_000;
const SAMPLE_AMOUNT = '100';

/** The three "you send" assets compare.html's dropdown offers. */
const SELL_SYMBOLS = ['USDC', 'EURC', 'XLM'];

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

function tomlValue(toml, key) {
  const line = toml.split(/\r?\n/).find((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
  if (!line) return null;
  const m = line.match(/["']([^"']+)["']/);
  return m ? m[1].replace(/\/$/, '') : null;
}

/**
 * Reads CATALOG straight out of compare.js rather than re-typing each
 * anchor's domain and corridor list here. CATALOG is a plain array literal
 * assigned to a top-level `var`; extracting just that literal and handing it
 * to the Function constructor evaluates the data without executing the rest
 * of a file written to run in a browser (DOM lookups, event listeners).
 */
async function readCatalog() {
  const src = await readFile(COMPARE_JS, 'utf8');
  const start = src.indexOf('var CATALOG = [');
  if (start === -1) throw new Error(`Could not find "var CATALOG = [" in ${COMPARE_JS}`);
  const openBracket = src.indexOf('[', start);
  let depth = 0;
  let end = -1;
  for (let i = openBracket; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) throw new Error(`Unbalanced brackets reading CATALOG from ${COMPARE_JS}`);
  const literal = src.slice(openBracket, end);
  // eslint-disable-next-line no-new-func -- evaluating a data literal, not arbitrary code
  return new Function(`return ${literal};`)();
}

/** code → { assetId, ... } for both the stellar: and iso4217: entries in a SEP-38 /info response. */
function indexSep38Assets(info) {
  const sell = new Map(); // symbol -> "stellar:CODE:ISSUER"
  const buy = new Map();  // currency -> "iso4217:CODE"
  for (const a of info.assets ?? []) {
    if (typeof a.asset !== 'string') continue;
    if (a.asset.startsWith('stellar:')) {
      const symbol = a.asset.split(':')[1];
      if (symbol) sell.set(symbol.toUpperCase(), a.asset);
    } else if (a.asset.startsWith('iso4217:')) {
      const currency = a.asset.split(':')[1];
      if (currency) buy.set(currency.toUpperCase(), a.asset);
    }
  }
  return { sell, buy };
}

async function quotesForDomain(domain, corridors) {
  let toml;
  try {
    toml = await getText(`https://${domain}/.well-known/stellar.toml`);
  } catch (err) {
    return { domain, status: 'unreachable', reason: `stellar.toml: ${err.message}`, corridors: {} };
  }

  const endpoint = tomlValue(toml, 'ANCHOR_QUOTE_SERVER');
  if (!endpoint) {
    return { domain, status: 'no-sep38', reason: 'stellar.toml declares no ANCHOR_QUOTE_SERVER', corridors: {} };
  }

  let info;
  try {
    info = await getJson(`${endpoint}/info`);
  } catch (err) {
    return { domain, status: 'unreachable', endpoint, reason: `/info: ${err.message}`, corridors: {} };
  }

  const { sell, buy } = indexSep38Assets(info);
  const corridorResults = {};

  for (const currency of corridors) {
    const buyAsset = buy.get(currency.toUpperCase());
    if (!buyAsset) {
      corridorResults[currency] = { status: 'unsupported-corridor', reason: `anchor's SEP-38 /info does not list ${currency}` };
      continue;
    }

    // First sell asset (in dropdown order) the anchor actually quotes.
    const sellSymbol = SELL_SYMBOLS.find((s) => sell.has(s));
    if (!sellSymbol) {
      corridorResults[currency] = { status: 'unsupported-asset', reason: 'anchor supports this corridor but none of USDC/EURC/XLM' };
      continue;
    }
    const sellAsset = sell.get(sellSymbol);

    try {
      const url = `${endpoint}/price?sell_asset=${encodeURIComponent(sellAsset)}&buy_asset=${encodeURIComponent(buyAsset)}&sell_amount=${SAMPLE_AMOUNT}&context=sep6`;
      const price = await getJson(url);
      const rate = Number(price.price);
      if (!Number.isFinite(rate) || rate <= 0) throw new Error(`non-numeric price in response: ${JSON.stringify(price)}`);

      corridorResults[currency] = {
        status: 'ok',
        sellAsset: sellSymbol,
        buyCurrency: currency,
        sampledAt: SAMPLE_AMOUNT,
        price: rate,
        totalPrice: Number(price.total_price) || rate,
        buyAmount: price.buy_amount ?? null,
        fetchedAt: new Date().toISOString(),
      };
    } catch (err) {
      corridorResults[currency] = { status: 'price-error', reason: err.message };
    }
  }

  return { domain, status: 'ok', endpoint, corridors: corridorResults };
}

async function main() {
  const [seed, catalog] = await Promise.all([
    readFile(SEED, 'utf8').then(JSON.parse),
    readCatalog(),
  ]);
  const seedDomains = new Set(seed.domains ?? []);

  // Only ask about anchors Route Scout actually lists, and only about the
  // corridors it shows for them — asking about every currency an anchor
  // might theoretically support would query pairs nobody sees quoted.
  const targets = catalog.filter((a) => seedDomains.has(a.domain));

  process.stderr.write(`Asking ${targets.length} anchors for live SEP-38 quotes…\n`);

  const results = {};
  let ok = 0, noSep38 = 0, unreachable = 0;

  for (const anchor of targets) {
    const r = await quotesForDomain(anchor.domain, anchor.corridors);
    results[anchor.domain] = r;
    if (r.status === 'no-sep38') noSep38++;
    else if (r.status === 'unreachable') unreachable++;
    else if (Object.values(r.corridors).some((c) => c.status === 'ok')) ok++;
    process.stderr.write(`  ${anchor.domain.padEnd(28)} ${r.status}\n`);
  }

  await writeFile(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        note:
          'Live indicative FX rates from each anchor\'s own SEP-38 quote server, sampled at $' + SAMPLE_AMOUNT +
          ' once an hour. Replaces the hardcoded rateSpread catalogue in packages/web/compare.js wherever an ' +
          'anchor runs SEP-38 and declares the asset pair — see docs.html and README for which anchors that is today.',
        caveat:
          'GET /price is indicative, not firm — an anchor can quote differently at execution time, and its ' +
          'price can vary with amount (fee tiers), so this is a $' + SAMPLE_AMOUNT + ' sample, not a guarantee. ' +
          'Anchors with no ANCHOR_QUOTE_SERVER, or whose /info does not list a corridor Route Scout shows, ' +
          'still fall back to the catalogue rateSpread — status distinguishes exactly why per anchor.',
        counts: { anchorsWithALiveQuote: ok, noSep38Server: noSep38, unreachable },
        anchors: results,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  process.stderr.write(`\n${ok} anchor(s) have at least one live SEP-38 quote, ${noSep38} declare no ANCHOR_QUOTE_SERVER, ${unreachable} unreachable.\n`);
  process.stderr.write(`✓ ${OUT}\n`);
}

main().catch((err) => {
  console.error('fetch-anchor-quotes failed:', err);
  process.exit(1);
});
