/**
 * probe-capabilities.mjs
 *
 * Declared capability versus observed capability.
 *
 * A stellar.toml is a claim. `TRANSFER_SERVER_SEP0024 = "https://..."` asserts
 * that an anchor supports hosted deposit and withdrawal; it does not assert
 * that the endpoint answers, and nothing in the ecosystem checks. Directories
 * list the claim. Wallets integrate against the claim. The claim can have been
 * false for a year.
 *
 * This probes every SEP endpoint each tracked anchor declares and records what
 * actually happened. The output is deliberately shaped as a comparison rather
 * than a status:
 *
 *     SEP-24  declared: yes   observed: yes    247ms
 *     SEP-31  declared: yes   observed: NO     connection refused
 *     SEP-38  declared: no    observed: —
 *
 * That gap is the product. Stellar tells you what an anchor says it supports;
 * the ledger tells you what settled; this tells you whether the machinery in
 * between is answering the phone.
 *
 *   node scripts/probe-capabilities.mjs
 *
 * Probing etiquette: one GET per declared endpoint per run, to the `/info`
 * paths the SEPs define as public and unauthenticated, with a short timeout
 * and bounded concurrency. Nothing is authenticated, nothing is written, and
 * no transaction is created. This is the same request a wallet makes before
 * showing a deposit screen.
 *
 * WHAT A FAILED PROBE DOES AND DOES NOT MEAN
 * ------------------------------------------
 * It means: from this vantage point, at this moment, that endpoint did not
 * answer correctly. It does not mean the anchor is broken, dishonest, or
 * unsafe — it may be geo-blocking us, rate-limiting, mid-deploy, or requiring
 * auth on a path the SEP says should be open. A single probe is an
 * observation, not a verdict, and the output says so in those words rather
 * than rendering a red cross and letting a reader draw the harsher conclusion.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SEED = join(ROOT, 'packages', 'indexer', 'data', 'anchors.json');
const OUT = join(ROOT, 'packages', 'web', 'api', 'v1', 'capabilities.json');

const TIMEOUT = 12_000;
const CONCURRENCY = 5;

/**
 * The SEPs worth probing, and where each declares itself.
 *
 * `probe` is the public, unauthenticated path each SEP defines for capability
 * discovery. SEP-10 is the exception and is handled separately: its endpoint
 * is a challenge generator, not an info document.
 */
const SEPS = [
  { id: 'SEP-6',  name: 'Programmatic deposit & withdrawal', tomlKey: 'TRANSFER_SERVER',           probe: '/info' },
  { id: 'SEP-24', name: 'Hosted deposit & withdrawal',       tomlKey: 'TRANSFER_SERVER_SEP0024',   probe: '/info' },
  { id: 'SEP-31', name: 'Cross-border payments',             tomlKey: 'DIRECT_PAYMENT_SERVER',     probe: '/info' },
  { id: 'SEP-38', name: 'Firm quotes',                       tomlKey: 'ANCHOR_QUOTE_SERVER',       probe: '/info' },
  { id: 'SEP-12', name: 'KYC',                               tomlKey: 'KYC_SERVER',                probe: null   },
  { id: 'SEP-10', name: 'Web authentication',                tomlKey: 'WEB_AUTH_ENDPOINT',         probe: 'auth'  },
];

/** Read a top-level `KEY = "value"` out of a stellar.toml without a parser. */
function tomlValue(toml, key) {
  const line = toml.split(/\r?\n/).find((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
  if (!line) return null;
  const m = line.match(/["']([^"']+)["']/);
  return m ? m[1].replace(/\/$/, '') : null;
}

async function timedFetch(url) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT),
    });
    return { status: res.status, ms: Date.now() - started, res };
  } catch (err) {
    return { status: null, ms: Date.now() - started, error: err.message };
  }
}

/**
 * Probe one declared endpoint.
 *
 * SEP-10 is judged differently on purpose. Its endpoint answers a *challenge*
 * request, so a bare GET correctly returns 400 — that is a working SEP-10
 * server declining a malformed request, and scoring it as a failure would
 * punish correct behaviour. Anything that answers at all is alive.
 */
async function probeEndpoint(sep, base) {
  if (sep.probe === null) {
    return { observed: 'not-probed', note: 'No public capability document is defined for this SEP.' };
  }

  if (sep.probe === 'auth') {
    const r = await timedFetch(base);
    if (r.status === null) return { observed: 'no', latencyMs: r.ms, note: r.error };
    // 400 is the correct answer to a challenge request with no account.
    const alive = r.status === 400 || r.status === 200;
    return {
      observed: alive ? 'yes' : 'no',
      latencyMs: r.ms,
      httpStatus: r.status,
      note: alive
        ? 'Answered a bare challenge request, which is the expected behaviour.'
        : `Returned HTTP ${r.status}.`,
    };
  }

  const r = await timedFetch(base + sep.probe);
  if (r.status === null) return { observed: 'no', latencyMs: r.ms, note: r.error };
  if (r.status !== 200) {
    return { observed: 'no', latencyMs: r.ms, httpStatus: r.status, note: `Returned HTTP ${r.status}.` };
  }

  // A 200 that is not JSON is a login page or an error page wearing a 200,
  // which is not a working capability endpoint.
  let body;
  try {
    body = await r.res.json();
  } catch {
    return { observed: 'no', latencyMs: r.ms, httpStatus: 200, note: 'Answered 200 but the body was not JSON.' };
  }

  return {
    observed: 'yes',
    latencyMs: r.ms,
    httpStatus: 200,
    ...summariseInfo(sep.id, body),
  };
}

/** A little structure from each /info, where the SEP defines one. */
function summariseInfo(sepId, body) {
  if (sepId === 'SEP-6' || sepId === 'SEP-24') {
    const deposit = Object.keys(body.deposit ?? {});
    const withdraw = Object.keys(body.withdraw ?? {});
    return {
      assets: { deposit, withdraw },
      note: `${deposit.length} depositable, ${withdraw.length} withdrawable asset(s).`,
    };
  }
  if (sepId === 'SEP-31') {
    const send = Object.keys(body.receive ?? body.send ?? {});
    return { assets: { send }, note: `${send.length} corridor asset(s) advertised.` };
  }
  if (sepId === 'SEP-38') {
    return { note: 'Quote server answered.' };
  }
  return {};
}

async function probeDomain(domain) {
  let toml;
  const t0 = Date.now();
  try {
    const res = await fetch(`https://${domain}/.well-known/stellar.toml`, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    toml = await res.text();
  } catch (err) {
    return {
      domain,
      reachable: false,
      note: `stellar.toml did not resolve: ${err.message}. Nothing further could be checked.`,
      capabilities: {},
    };
  }

  const tomlLatency = Date.now() - t0;
  const orgName = (toml.match(/^\s*ORG_NAME\s*=\s*["']([^"']+)/m) || [])[1] ?? null;

  // Currencies the anchor declares in SEP-1, captured separately from the
  // assets its endpoints report. The two differ, and the difference matters:
  // a corridor declared here but absent from a working /info is a claim with
  // nothing serving it, which is exactly the gap this script exists to find.
  const declaredCurrencies = [...toml.matchAll(/^\s*code\s*=\s*["']([^"']+)/gm)].map((m) => m[1].toUpperCase());

  const capabilities = {};

  for (const sep of SEPS) {
    const base = tomlValue(toml, sep.tomlKey);
    if (!base) {
      capabilities[sep.id] = { name: sep.name, declared: false, observed: 'n/a' };
      continue;
    }
    const result = await probeEndpoint(sep, base);
    capabilities[sep.id] = { name: sep.name, declared: true, endpoint: base, ...result };
  }

  const declared = Object.values(capabilities).filter((c) => c.declared);
  const working = declared.filter((c) => c.observed === 'yes');
  const broken = declared.filter((c) => c.observed === 'no');

  return {
    domain,
    orgName,
    reachable: true,
    declaredCurrencies: [...new Set(declaredCurrencies)],
    tomlLatencyMs: tomlLatency,
    checkedAt: new Date().toISOString(),
    counts: {
      declared: declared.length,
      observedWorking: working.length,
      observedFailing: broken.length,
      notProbed: declared.length - working.length - broken.length,
    },
    capabilities,
  };
}

async function main() {
  const seed = JSON.parse(await readFile(SEED, 'utf8'));
  const domains = seed.domains ?? [];

  process.stderr.write(`Probing declared SEP endpoints for ${domains.length} anchors…\n\n`);

  const results = [];
  const queue = [...domains];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) {
        const d = queue.shift();
        const r = await probeDomain(d);
        // "not probed" is kept out of this ratio on purpose. SEP-12 declares a
        // KYC server with no public capability document, so counting it as a
        // failure would manufacture a gap that does not exist.
        const probed = r.reachable ? r.counts.observedWorking + r.counts.observedFailing : 0;
        const line = r.reachable
          ? `${r.counts.observedWorking}/${probed} probeable SEPs answering` +
            (r.counts.observedFailing ? `  (${r.counts.observedFailing} NOT answering)` : '') +
            (r.counts.notProbed ? `  [${r.counts.notProbed} not probeable]` : '')
          : 'stellar.toml unreachable';
        process.stderr.write(`  ${r.reachable ? 'ok  ' : 'skip'}  ${d.padEnd(26)} ${line}\n`);
        results.push(r);
      }
    }),
  );

  results.sort((a, b) => a.domain.localeCompare(b.domain));
  const reachable = results.filter((r) => r.reachable);

  const gaps = reachable
    .filter((r) => r.counts.observedFailing > 0)
    .map((r) => ({
      domain: r.domain,
      failing: Object.entries(r.capabilities)
        .filter(([, c]) => c.declared && c.observed === 'no')
        .map(([id, c]) => ({ sep: id, endpoint: c.endpoint, note: c.note })),
    }));

  await writeFile(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        note:
          'Declared capability versus observed capability. A stellar.toml entry is a claim that an anchor ' +
          'supports a SEP; this records whether that endpoint actually answered when asked. Directories ' +
          'publish the claim and nothing checks it, which is the gap this measures.',
        method:
          'One unauthenticated GET per declared endpoint, to the public /info path each SEP defines. SEP-10 ' +
          'is judged on answering a bare challenge request at all, since HTTP 400 is the correct response ' +
          'there and scoring it as failure would punish correct behaviour. Nothing is written and no ' +
          'transaction is created.',
        limits:
          'A failed probe means this endpoint did not answer correctly from one vantage point at one moment. ' +
          'It does not mean the anchor is broken, dishonest or unsafe — geo-blocking, rate limiting, a ' +
          'deploy in progress, or auth on a path the SEP says should be open all look identical from here. ' +
          'One probe is an observation, not a verdict. Repeated failures across runs are worth more than any ' +
          'single one, and this file records a single run.',
        totals: {
          anchors: results.length,
          reachable: reachable.length,
          declaredCapabilities: reachable.reduce((n, r) => n + r.counts.declared, 0),
          observedWorking: reachable.reduce((n, r) => n + r.counts.observedWorking, 0),
          observedFailing: reachable.reduce((n, r) => n + r.counts.observedFailing, 0),
        },
        gapsFound: gaps,
        anchors: results,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  const t = {
    declared: reachable.reduce((n, r) => n + r.counts.declared, 0),
    working: reachable.reduce((n, r) => n + r.counts.observedWorking, 0),
    failing: reachable.reduce((n, r) => n + r.counts.observedFailing, 0),
  };

  console.log('');
  console.log(`Anchors reachable        ${reachable.length} of ${results.length}`);
  console.log(`SEP endpoints declared   ${t.declared}`);
  console.log(`  answering              ${t.working}`);
  console.log(`  not answering          ${t.failing}`);
  console.log(`Anchors with a gap       ${gaps.length}`);
  console.log('');
  console.log(`✓ ${OUT}`);
}

main().catch((err) => {
  console.error('probe-capabilities failed:', err);
  process.exit(1);
});
