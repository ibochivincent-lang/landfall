/**
 * detect-toml-drift.mjs
 *
 * Watches each anchor's stellar.toml for changes to the things that decide
 * where money goes.
 *
 * A stellar.toml is mutable and unsigned. An anchor can rotate its declared
 * ACCOUNTS, repoint a transfer server, or swap the issuer behind a currency
 * code at any moment, and every wallet that reads SEP-1 will follow — because
 * following is the whole point of the standard. Nothing in the ecosystem
 * records that it changed. A takeover of a domain, a stale entry after a
 * migration, and a routine key rotation are indistinguishable to a wallet
 * reading the file today with nothing to compare it against.
 *
 * This keeps the comparison. Each run fingerprints the safety-relevant fields
 * and diffs them against the last snapshot, so "this anchor now declares an
 * account it did not declare an hour ago" becomes a visible event rather than
 * a silent one.
 *
 *   node scripts/detect-toml-drift.mjs
 *
 * Why the ledger cross-reference matters
 * -------------------------------------
 * A diff alone cannot tell a legitimate rotation from a hostile one. So a
 * newly declared account is looked up on Horizon before it is reported: an
 * account that has existed for years with real history is a very different
 * proposition from one created yesterday with no transactions, even though
 * both look identical in the toml. The finding carries that context rather
 * than leaving a reader to guess.
 *
 * This is deliberately not an alarm system. It records what changed, when,
 * and what the ledger says about the new values. Whether a change is
 * legitimate is not something a diff can know, and the output never claims
 * otherwise.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SEED = join(ROOT, 'packages', 'indexer', 'data', 'anchors.json');
const OUT = join(ROOT, 'packages', 'web', 'api', 'v1', 'toml-drift.json');

const HORIZON = process.env.HORIZON_URL || 'https://horizon.stellar.org';
const TIMEOUT = 12_000;
const CONCURRENCY = 5;

/** Endpoint fields whose value decides where a wallet sends a user. */
const ENDPOINT_KEYS = [
  'TRANSFER_SERVER',
  'TRANSFER_SERVER_SEP0024',
  'DIRECT_PAYMENT_SERVER',
  'ANCHOR_QUOTE_SERVER',
  'WEB_AUTH_ENDPOINT',
  'KYC_SERVER',
];

function tomlValue(toml, key) {
  const line = toml.split(/\r?\n/).find((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
  if (!line) return null;
  const m = line.match(/["']([^"']+)["']/);
  return m ? m[1] : null;
}

/** Every G... account in the ACCOUNTS array, however it is formatted. */
function tomlAccounts(toml) {
  const m = toml.match(/ACCOUNTS\s*=\s*\[([\s\S]*?)\]/);
  if (!m) return [];
  return [...new Set((m[1].match(/G[A-Z2-7]{55}/g) || []))];
}

/** code → issuer for every [[CURRENCIES]] block. */
function tomlCurrencies(toml) {
  const out = {};
  const blocks = toml.split(/\[\[CURRENCIES\]\]/).slice(1);
  for (const block of blocks) {
    const code = (block.match(/^\s*code\s*=\s*["']([^"']+)/m) || [])[1];
    const issuer = (block.match(/^\s*issuer\s*=\s*["']([^"']*)/m) || [])[1] ?? '';
    if (code) out[code] = issuer;
  }
  return out;
}

/** The safety-relevant shape of one anchor's declaration. */
function fingerprint(toml) {
  const endpoints = {};
  for (const key of ENDPOINT_KEYS) {
    const v = tomlValue(toml, key);
    if (v) endpoints[key] = v.replace(/\/$/, '');
  }
  return {
    accounts: tomlAccounts(toml).sort(),
    signingKey: tomlValue(toml, 'SIGNING_KEY'),
    endpoints,
    currencies: tomlCurrencies(toml),
    orgName: tomlValue(toml, 'ORG_NAME'),
  };
}

/**
 * What the ledger knows about an account, so a new declaration can be read in
 * context rather than in the abstract.
 */
async function ledgerContext(account) {
  try {
    const res = await fetch(`${HORIZON.replace(/\/$/, '')}/accounts/${account}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (res.status === 404) {
      return { exists: false, note: 'This account does not exist on the ledger. Funds sent to it would fail.' };
    }
    if (!res.ok) return { exists: null, note: `Horizon returned HTTP ${res.status}; could not check.` };
    const body = await res.json();

    const payments = await fetch(
      `${HORIZON.replace(/\/$/, '')}/accounts/${account}/payments?limit=1&order=asc`,
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT) },
    ).then((r) => (r.ok ? r.json() : null)).catch(() => null);

    const first = payments?._embedded?.records?.[0]?.created_at ?? null;
    return {
      exists: true,
      homeDomain: body.home_domain ?? null,
      firstPaymentAt: first,
      note: first
        ? `Exists, with payment history since ${first.slice(0, 10)}.`
        : 'Exists but has no payment history — newly created or unused.',
    };
  } catch (err) {
    return { exists: null, note: `Could not check the ledger: ${err.message}` };
  }
}

/**
 * Diff two fingerprints into findings.
 *
 * Severity is assigned on what a change could cost a user who follows it, not
 * on how unusual it looks. An account appearing is high because a wallet will
 * send real value there; a currency being added is informational because
 * nothing routes on it until something else changes too.
 */
function diff(before, after) {
  const findings = [];

  const added = after.accounts.filter((a) => !before.accounts.includes(a));
  const removed = before.accounts.filter((a) => !after.accounts.includes(a));

  for (const account of added) {
    findings.push({
      severity: 'high',
      code: 'account-declared',
      account,
      message: `Now declares account ${account}, which it did not declare before.`,
      why: 'A wallet reading SEP-1 will send to a newly declared account without asking. This is what a domain takeover or a stale migration looks like from the outside, and also what a routine rotation looks like.',
    });
  }
  for (const account of removed) {
    findings.push({
      severity: 'high',
      code: 'account-withdrawn',
      account,
      message: `No longer declares account ${account}.`,
      why: 'Anything already routed to this account may now be unattended. Value held there does not move because the declaration changed.',
    });
  }

  if (before.signingKey !== after.signingKey) {
    findings.push({
      severity: 'high',
      code: 'signing-key-rotated',
      message: `SEP-10 signing key changed from ${before.signingKey ?? '(none)'} to ${after.signingKey ?? '(none)'}.`,
      why: 'This key authenticates the anchor to wallets. A rotation is routine operationally and is also exactly what a takeover would do.',
    });
  }

  for (const key of new Set([...Object.keys(before.endpoints), ...Object.keys(after.endpoints)])) {
    const b = before.endpoints[key];
    const a = after.endpoints[key];
    if (b === a) continue;
    findings.push({
      severity: 'medium',
      code: 'endpoint-changed',
      field: key,
      message: `${key} changed from ${b ?? '(absent)'} to ${a ?? '(absent)'}.`,
      why: 'This is the address a wallet hands the user to for deposit or withdrawal. A changed host is a different party serving that flow.',
    });
  }

  for (const code of new Set([...Object.keys(before.currencies), ...Object.keys(after.currencies)])) {
    const b = before.currencies[code];
    const a = after.currencies[code];
    if (b === a) continue;
    if (b === undefined) {
      findings.push({ severity: 'info', code: 'currency-added', asset: code, message: `Now declares ${code}.` });
    } else if (a === undefined) {
      findings.push({ severity: 'info', code: 'currency-removed', asset: code, message: `No longer declares ${code}.` });
    } else {
      findings.push({
        severity: 'high',
        code: 'issuer-changed',
        asset: code,
        message: `Issuer for ${code} changed from ${b || '(none)'} to ${a || '(none)'}.`,
        why: 'The same ticker now refers to a different asset. A holder of the old one is holding something the anchor no longer recognises.',
      });
    }
  }

  if (before.orgName !== after.orgName) {
    findings.push({
      severity: 'medium',
      code: 'org-name-changed',
      message: `ORG_NAME changed from ${JSON.stringify(before.orgName)} to ${JSON.stringify(after.orgName)}.`,
      why: 'The organisation claiming this domain now describes itself differently.',
    });
  }

  return findings;
}

async function main() {
  const seed = JSON.parse(await readFile(SEED, 'utf8'));
  const domains = seed.domains ?? [];

  let previous = { snapshots: {} };
  try {
    previous = JSON.parse(await readFile(OUT, 'utf8'));
  } catch {
    /* first run */
  }

  process.stderr.write(`Checking ${domains.length} declarations for drift…\n\n`);

  const snapshots = {};
  const events = [];
  const queue = [...domains];

  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) {
        const domain = queue.shift();
        let toml;
        try {
          const res = await fetch(`https://${domain}/.well-known/stellar.toml`, {
            redirect: 'follow',
            signal: AbortSignal.timeout(TIMEOUT),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          toml = await res.text();
        } catch (err) {
          process.stderr.write(`  skip  ${domain.padEnd(26)} unreachable (${err.message})\n`);
          // Keep the last known snapshot rather than dropping it: a domain that
          // is down today has not "changed its declaration to nothing", and
          // recording that would produce a spurious withdrawal event tomorrow.
          if (previous.snapshots?.[domain]) snapshots[domain] = previous.snapshots[domain];
          continue;
        }

        const fp = fingerprint(toml);
        const before = previous.snapshots?.[domain]?.fingerprint;

        if (!before) {
          process.stderr.write(`  base  ${domain.padEnd(26)} baseline recorded\n`);
        } else {
          const findings = diff(before, fp);
          if (findings.length) {
            // Look up the ledger only for accounts, and only when something
            // actually changed — no reason to hit Horizon on a quiet run.
            for (const f of findings) {
              if (f.account) f.ledger = await ledgerContext(f.account);
            }
            events.push({ domain, detectedAt: new Date().toISOString(), findings });
            const high = findings.filter((f) => f.severity === 'high').length;
            process.stderr.write(
              `  DRIFT ${domain.padEnd(26)} ${findings.length} change(s)` + (high ? `, ${high} high severity` : '') + '\n',
            );
          } else {
            process.stderr.write(`  ok    ${domain.padEnd(26)} unchanged\n`);
          }
        }

        snapshots[domain] = { fingerprint: fp, lastCheckedAt: new Date().toISOString() };
      }
    }),
  );

  // Events accumulate: the value of this file is the record over time, not the
  // current instant. Bounded so it cannot grow without limit.
  const history = [...(previous.events ?? []), ...events].slice(-500);

  await writeFile(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        note:
          "Changes to each anchor's SEP-1 declaration over time. A stellar.toml is mutable and unsigned: an " +
          'anchor can rotate declared accounts, repoint a transfer server, or change the issuer behind a ' +
          'currency code at any time, and wallets follow by design. Nothing else records that it changed.',
        limits:
          'A diff cannot tell a legitimate rotation from a hostile one, and this file never claims to. It ' +
          'records what changed and what the ledger says about the new values. Severity reflects what a ' +
          'change could cost a user who follows it, not a judgement about the operator. An unreachable ' +
          'domain keeps its previous snapshot rather than being recorded as having withdrawn everything.',
        watchedDomains: Object.keys(snapshots).length,
        eventsThisRun: events.length,
        eventsRetained: history.length,
        events: history.slice().reverse(),
        // Sorted by domain. Snapshots are filled by concurrent workers, so
        // insertion order follows whichever domain answered first, which
        // reordered the whole map every run and produced a 600-line diff for
        // zero actual changes. Real drift has to be visible in the diff, so
        // this output has to be deterministic.
        snapshots: Object.fromEntries(Object.keys(snapshots).sort().map((d) => [d, snapshots[d]])),
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  const high = events.flatMap((e) => e.findings).filter((f) => f.severity === 'high').length;
  console.log('');
  console.log(`Watched            ${Object.keys(snapshots).length} declarations`);
  console.log(`Changed this run   ${events.length}`);
  console.log(`  high severity    ${high}`);
  console.log(`Events retained    ${history.length}`);
  console.log(`✓ ${OUT}`);
}

main().catch((err) => {
  console.error('detect-toml-drift failed:', err);
  process.exit(1);
});
