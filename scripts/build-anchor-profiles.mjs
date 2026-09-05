/**
 * build-anchor-profiles.mjs
 *
 * Turns the newest scan into the things a reader — or a due-diligence process
 * — can actually be sent to:
 *
 *   packages/web/api/v1/anchors/<domain>/profile.json   per-anchor record + history
 *   packages/web/api/v1/history.json                    network-wide time series
 *   packages/web/api/v1/verify.json                     attribution verification index
 *   packages/web/anchor/<domain>.html                   a permanent page per anchor
 *
 * Runs after scan-to-api.mjs in the hourly workflow.
 *
 * Why per-anchor pages exist
 * --------------------------
 * Until now there was no URL for a single anchor. Someone asking "does
 * cowrie.exchange actually settle" had nowhere to land, which meant the
 * project's whole output was unreachable except by people who already knew
 * about the dashboard. A record nobody can link to is not a record.
 *
 * Why history is written as an artifact rather than queried
 * --------------------------------------------------------
 * Every hourly scan has been committed to git since August, so the series
 * already existed — as 300+ commits nothing ever read back. This appends to a
 * plain JSON file instead: no database required, diffable, and readable by the
 * static site with no API in the path. `--seed-from-git` backfills it once
 * from that commit history.
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const API_DIR = join(ROOT, 'packages', 'web', 'api', 'v1');
const ANCHORS_JSON = join(API_DIR, 'anchors.json');
const HISTORY_JSON = join(API_DIR, 'history.json');
const VERIFY_JSON = join(API_DIR, 'verify.json');
const PAGE_DIR = join(ROOT, 'packages', 'web', 'anchor');

/** Keep the network series bounded so the artifact stays small and cheap to
 *  serve. At hourly resolution this is roughly three months. */
const MAX_HISTORY_POINTS = 2200;

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A domain is safe as a path segment only if it looks like a domain. Anything
 *  else would let a malformed seed entry write outside the output directory. */
const SAFE_DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/* ------------------------------------------------------------------ *
 * History
 * ------------------------------------------------------------------ */

/**
 * Backfill the network series from committed scans.
 *
 * Only used with --seed-from-git, and only needs to succeed once. Each commit
 * that touched anchors.json is one observation; commits that fail to parse are
 * skipped rather than guessed at.
 */
async function seedHistoryFromGit() {
  const { stdout } = await exec('git', ['log', '--format=%H', '--', 'packages/web/api/v1/anchors.json'], {
    cwd: ROOT,
    maxBuffer: 32 * 1024 * 1024,
  });
  const hashes = stdout.split('\n').filter(Boolean);
  const points = [];

  for (const hash of hashes) {
    try {
      const { stdout: blob } = await exec('git', ['show', `${hash}:packages/web/api/v1/anchors.json`], {
        cwd: ROOT,
        maxBuffer: 32 * 1024 * 1024,
      });
      const body = JSON.parse(blob);
      if (!body.asOf || !Array.isArray(body.accounts)) continue;
      points.push(summarisePoint(body));
    } catch {
      // A commit whose blob will not parse is dropped. It is one hour of a
      // three-week series, and inventing a value for it would be worse.
    }
  }

  points.sort((a, b) => a.asOf.localeCompare(b.asOf));
  return dedupeByAsOf(points);
}

function summarisePoint(body) {
  const counts = { live: 0, slow: 0, dark: 0, no_activity: 0 };
  for (const a of body.accounts) {
    if (counts[a.state] !== undefined) counts[a.state]++;
  }
  return {
    asOf: body.asOf,
    accounts: body.accounts.length,
    domains: new Set(body.accounts.map((a) => a.domain)).size,
    ...counts,
  };
}

function dedupeByAsOf(points) {
  const seen = new Map();
  for (const p of points) seen.set(p.asOf, p);
  return [...seen.values()].sort((a, b) => a.asOf.localeCompare(b.asOf));
}

async function loadHistory() {
  try {
    const body = JSON.parse(await readFile(HISTORY_JSON, 'utf8'));
    return Array.isArray(body.points) ? body.points : [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * Per-anchor history, read back out of the same series
 * ------------------------------------------------------------------ */

/**
 * Per-account series for one domain, taken from committed scans.
 *
 * Deliberately separate from the network series: the network file stays small
 * because it holds counts only, while an anchor's own page is the one place
 * detail per account is worth carrying.
 */
async function accountHistoryFromGit(limit = 400) {
  const { stdout } = await exec('git', ['log', '--format=%H', '-n', String(limit), '--', 'packages/web/api/v1/anchors.json'], {
    cwd: ROOT,
    maxBuffer: 32 * 1024 * 1024,
  });
  const hashes = stdout.split('\n').filter(Boolean);
  const byDomain = new Map();

  for (const hash of hashes) {
    try {
      const { stdout: blob } = await exec('git', ['show', `${hash}:packages/web/api/v1/anchors.json`], {
        cwd: ROOT,
        maxBuffer: 32 * 1024 * 1024,
      });
      const body = JSON.parse(blob);
      if (!body.asOf || !Array.isArray(body.accounts)) continue;
      for (const a of body.accounts) {
        if (!byDomain.has(a.domain)) byDomain.set(a.domain, new Map());
        const perAccount = byDomain.get(a.domain);
        if (!perAccount.has(a.account)) perAccount.set(a.account, []);
        perAccount.get(a.account).push({
          t: body.asOf,
          state: a.state,
          in: a.inbound ?? 0,
          out: a.outbound ?? 0,
          hours: a.hoursSinceActivity ?? null,
        });
      }
    } catch {
      /* skipped, as above */
    }
  }

  for (const perAccount of byDomain.values()) {
    for (const series of perAccount.values()) series.sort((a, b) => a.t.localeCompare(b.t));
  }
  return byDomain;
}

/**
 * This anchor's per-account series: whatever the last profile already carried,
 * plus this scan's observation.
 *
 * `seeded` is only present on a --seed-from-git run and takes precedence, so
 * the backfill establishes the series and every run after it extends by one
 * point. Capped per account for the same reason the network file is: an
 * artifact the site fetches should not grow without bound.
 */
async function mergeAnchorHistory(domain, rows, asOf, seeded) {
  let history = {};
  if (seeded) {
    history = Object.fromEntries(seeded);
  } else {
    try {
      const prior = JSON.parse(await readFile(join(API_DIR, 'anchors', domain, 'profile.json'), 'utf8'));
      if (prior.history && typeof prior.history === 'object') history = prior.history;
    } catch {
      // No prior profile — a newly tracked anchor starts its series here.
    }
  }

  for (const row of rows) {
    const series = Array.isArray(history[row.account]) ? history[row.account] : [];
    if (!series.some((p) => p.t === asOf)) {
      series.push({
        t: asOf,
        state: row.state,
        in: row.inbound ?? 0,
        out: row.outbound ?? 0,
        hours: row.hoursSinceActivity ?? null,
      });
    }
    series.sort((a, b) => a.t.localeCompare(b.t));
    history[row.account] = series.slice(-MAX_HISTORY_POINTS);
  }
  return history;
}

/* ------------------------------------------------------------------ *
 * Page rendering
 * ------------------------------------------------------------------ */

function stateLabel(state) {
  return (
    {
      live: 'Settling — activity within the last 72 hours',
      slow: 'Slow — last settled between 3 and 30 days ago',
      dark: 'Dark — no on-chain settlement in over 30 days',
      no_activity: 'No payment history on this account',
    }[state] ?? state
  );
}

/**
 * Declared capability versus observed capability.
 *
 * The part of an anchor's page that a directory cannot give you. A
 * stellar.toml entry is a claim that an endpoint exists; this is whether it
 * answered. Rendered as a comparison rather than a status, because "declares
 * SEP-31 and it works" and "declares SEP-31 and it doesn't" are the two facts
 * worth separating, and a single tick or cross would blur them.
 */
function renderCapabilities(capabilities) {
  if (!capabilities) return '';

  const rows = Object.entries(capabilities.capabilities ?? {})
    .filter(([, c]) => c.declared)
    .map(([sep, c]) => {
      const verdict =
        c.observed === 'yes'
          ? '<span class="cap cap--yes">answering</span>'
          : c.observed === 'no'
            ? '<span class="cap cap--no">not answering</span>'
            : '<span class="cap cap--na">not probeable</span>';
      return `
      <tr>
        <td><strong>${esc(sep)}</strong><div class="muted small">${esc(c.name || '')}</div></td>
        <td><span class="cap cap--yes">declared</span></td>
        <td>${verdict}</td>
        <td class="num">${c.latencyMs != null ? esc(c.latencyMs) + 'ms' : '—'}</td>
        <td class="muted small">${esc(c.note || '')}</td>
      </tr>`;
    })
    .join('');

  if (!rows) {
    return `
  <section class="anchor-block">
    <h2>Capabilities — declared vs observed</h2>
    <p class="muted">This anchor's <code>stellar.toml</code> declares no SEP transfer endpoints, so there is nothing to probe. It issues assets but does not advertise a deposit or withdrawal service.</p>
  </section>`;
  }

  const failing = Object.values(capabilities.capabilities ?? {}).filter((c) => c.declared && c.observed === 'no').length;

  return `
  <section class="anchor-block">
    <h2>Capabilities — declared vs observed</h2>
    <p>
      A <code>stellar.toml</code> entry is a claim that an endpoint exists. Directories publish that claim
      and nothing checks it. These are the results of asking each declared endpoint directly, at
      ${esc(capabilities.checkedAt || 'the last scan')}.
      ${failing > 0
        ? `<strong>${failing} declared capability(ies) did not answer.</strong>`
        : 'Every declared and probeable capability answered.'}
    </p>
    <table class="anchor-table">
      <thead><tr><th>SEP</th><th>Declared</th><th>Observed</th><th class="num">Latency</th><th>Detail</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="muted small">
      A failed probe means the endpoint did not answer correctly from one vantage point at one moment.
      Geo-blocking, rate limiting or a deploy in progress look identical from here, so this is an
      observation and not a verdict on the operator.
    </p>
  </section>`;
}

function renderPage({ domain, name, accounts, asOf, verification, history, capabilities }) {
  const dark = accounts.filter((a) => a.state === 'dark').length;
  const live = accounts.filter((a) => a.state === 'live').length;
  const inbound = accounts.reduce((s, a) => s + (a.inbound || 0), 0);
  const outbound = accounts.reduce((s, a) => s + (a.outbound || 0), 0);

  const rows = accounts
    .map((a) => {
      const points = history?.[a.account]?.length ?? 0;
      return `
      <tr>
        <td class="mono"><a href="https://stellar.expert/explorer/public/account/${esc(a.account)}" target="_blank" rel="noopener">${esc(a.account.slice(0, 8))}…${esc(a.account.slice(-6))}</a></td>
        <td><span class="state state--${esc(a.state)}">${esc(a.state.replace('_', ' '))}</span></td>
        <td class="num">${a.inbound ?? 0}</td>
        <td class="num">${a.outbound ?? 0}</td>
        <td class="num">${a.hoursSinceActivity == null ? '—' : (a.hoursSinceActivity < 48 ? `${a.hoursSinceActivity.toFixed(1)}h` : `${(a.hoursSinceActivity / 24).toFixed(1)}d`)}</td>
        <td class="num">${points ? `${points} obs` : '—'}</td>
      </tr>`;
    })
    .join('');

  const verifiedAccounts = verification.accounts
    .map(
      (v) =>
        `<li class="mono">${esc(v.account.slice(0, 10))}…${esc(v.account.slice(-6))} — <strong>${esc(v.role)}</strong>${
          v.role === 'issuer' ? ' <span class="muted">(home_domain confirmed on-chain)</span>' : ''
        }</li>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name || domain)} — settlement record | Landfall</title>
<meta name="description" content="Independent, ledger-derived settlement record for ${esc(domain)}: ${accounts.length} declared Stellar account(s), ${live} settling, ${dark} dark. Every figure traces to a transaction hash.">
<link rel="canonical" href="https://landfall-ib.vercel.app/anchor/${esc(domain)}">
<meta property="og:title" content="${esc(name || domain)} — settlement record">
<meta property="og:description" content="${live} of ${accounts.length} accounts settling. Read from the public Stellar ledger, not self-reported.">
<meta property="og:type" content="website">
<link rel="stylesheet" href="../dashboard.css">
<link rel="stylesheet" href="../anchor.css">
</head>
<body class="dash-body">

<header class="topnav">
  <div class="wrap topnav__in">
    <a href="../index.html" class="topnav__logo">landfall<span>.stellar</span></a>
    <nav class="topnav__links">
      <a href="../dashboard.html">Dashboard</a>
      <a href="../cross-chain.html">Cross-chain</a>
      <a href="../compare.html">Route Scout</a>
      <a href="../docs.html">API</a>
    </nav>
  </div>
</header>

<main class="wrap anchor-wrap">
  <a class="backlink" href="../dashboard.html">← All anchors</a>

  <h1 class="anchor-title">${esc(name || domain)}</h1>
  <p class="anchor-domain mono">${esc(domain)}</p>

  <div class="anchor-summary">
    <div class="sum"><b>${accounts.length}</b><span>declared account${accounts.length === 1 ? '' : 's'}</span></div>
    <div class="sum"><b>${live}</b><span>settling now</span></div>
    <div class="sum"><b class="${dark ? 'is-dark' : ''}">${dark}</b><span>dark &gt; 30 days</span></div>
    <div class="sum"><b>${inbound.toLocaleString('en-US')}</b><span>inbound indexed</span></div>
    <div class="sum"><b>${outbound.toLocaleString('en-US')}</b><span>outbound indexed</span></div>
  </div>

  <section class="anchor-block">
    <h2>Identity — verified, not assumed</h2>
    <p>
      These accounts are the ones <code>${esc(domain)}</code> declares as its own in its
      <a href="https://${esc(domain)}/.well-known/stellar.toml" target="_blank" rel="noopener">SEP-1 <code>stellar.toml</code></a>,
      resolved live at scan time. An account cited there as a currency <em>issuer</em> is only
      attributed to this anchor when the issuer account's own on-chain <code>home_domain</code>
      confirms it — a cited issuer is frequently a third party's, and reading one as the citing
      domain's own is how a shared stablecoin issuer once got credited to a single business here.
    </p>
    <ul class="verify-list">${verifiedAccounts || '<li class="muted">No accounts declared.</li>'}</ul>
    <p class="muted small">SEP-1 resolved ${verification.resolved ? 'successfully' : 'with an error'} at ${esc(asOf)}${
      verification.error ? ` — ${esc(verification.error)}` : ''
    }.</p>
  </section>

  <section class="anchor-block">
    <h2>Settlement record</h2>
    <table class="anchor-table">
      <thead><tr><th>Account</th><th>State</th><th class="num">In</th><th class="num">Out</th><th class="num">Last seen</th><th class="num">History</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="muted small">
      Liveness is read directly from the ledger and cannot be self-reported: an anchor can keep a
      status page green indefinitely, but it cannot fake on-chain silence.
      ${accounts.map((a) => stateLabel(a.state)).some((s) => s.startsWith('Dark')) ? 'Dark means no settlement in over 30 days — a fact about the ledger, not a claim about why.' : ''}
    </p>
  </section>

  ${renderCapabilities(capabilities)}

  <section class="anchor-block">
    <h2>Machine-readable</h2>
    <p>Everything on this page, including the observation history, as one document:</p>
    <p><a class="api-link mono" href="../api/v1/anchors/${esc(domain)}/profile.json">/api/v1/anchors/${esc(domain)}/profile.json</a></p>
  </section>

  <p class="muted small asof">Scan of ${esc(asOf)} · verified against stellar.expert · <a href="../docs.html">methodology</a></p>
</main>

<footer class="dash-footer">
  <div class="wrap dash-foot-in">
    <span>Settlement reliability derived from the public Stellar ledger — no anchor self-reporting</span>
    <span>© 2026 Landfall · MIT</span>
  </div>
</footer>
</body>
</html>
`;
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  const seedFromGit = process.argv.includes('--seed-from-git');

  const published = JSON.parse(await readFile(ANCHORS_JSON, 'utf8'));

  // Capability probes, if a run has produced them. Optional: a missing file
  // just means that section is absent, never that a capability failed.
  let capabilityByDomain = new Map();
  try {
    const caps = JSON.parse(await readFile(join(API_DIR, 'capabilities.json'), 'utf8'));
    capabilityByDomain = new Map((caps.anchors ?? []).map((a) => [a.domain, a]));
  } catch { /* not built yet */ }
  const accounts = published.accounts ?? [];
  const asOf = published.asOf;

  // ── network history ──────────────────────────────────────────────────────
  let points = seedFromGit ? await seedHistoryFromGit() : await loadHistory();
  points = dedupeByAsOf([...points, summarisePoint(published)]).slice(-MAX_HISTORY_POINTS);

  await writeFile(
    HISTORY_JSON,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        note:
          'One observation per hourly scan: how many tracked accounts were settling, slow, dark, or ' +
          'without payment history. Counts only — per-account detail lives in each anchor profile. ' +
          'Points are appended, never rewritten; a scan that could not be published leaves a gap ' +
          'rather than an interpolated value.',
        points,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  console.log(`✓ history.json — ${points.length} observations`);

  // ── per-anchor profiles + pages ──────────────────────────────────────────
  //
  // Walking git costs ~90s, which is fine once and far too slow every hour.
  // Seed from commits on the first run; afterwards each profile carries its
  // own series forward and this run only appends today's observation.
  const perDomainHistory = seedFromGit ? await accountHistoryFromGit() : new Map();
  const byDomain = new Map();
  for (const a of accounts) {
    if (!byDomain.has(a.domain)) byDomain.set(a.domain, []);
    byDomain.get(a.domain).push(a);
  }

  await mkdir(PAGE_DIR, { recursive: true });
  const verifyIndex = [];
  let pages = 0;

  for (const [domain, rows] of [...byDomain.entries()].sort()) {
    if (!SAFE_DOMAIN.test(domain)) {
      console.warn(`! skipping ${domain} — not a plausible domain, refusing to write a path from it`);
      continue;
    }

    const history = await mergeAnchorHistory(domain, rows, asOf, perDomainHistory.get(domain));
    const verification = {
      resolved: rows.length > 0,
      checkedAt: asOf,
      source: 'SEP-1 stellar.toml, resolved live; issuer attribution confirmed against each issuer account\'s own on-chain home_domain',
      accounts: rows.map((r) => ({ account: r.account, role: r.role ?? 'declared' })),
    };

    const profile = {
      anchorId: domain,
      name: rows[0]?.name ?? domain,
      asOf,
      verification,
      summary: {
        accounts: rows.length,
        live: rows.filter((r) => r.state === 'live').length,
        slow: rows.filter((r) => r.state === 'slow').length,
        dark: rows.filter((r) => r.state === 'dark').length,
        noActivity: rows.filter((r) => r.state === 'no_activity').length,
        inbound: rows.reduce((s, r) => s + (r.inbound || 0), 0),
        outbound: rows.reduce((s, r) => s + (r.outbound || 0), 0),
      },
      accounts: rows,
      history,
      caveats: [
        published.returnRateCaveat,
        'Dark means no on-chain settlement in over 30 days. That is a fact about the ledger. Why an anchor is quiet is not something this project claims to know.',
      ].filter(Boolean),
    };

    const dir = join(API_DIR, 'anchors', domain);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'profile.json'), JSON.stringify(profile, null, 2) + '\n', 'utf8');
    await writeFile(
      join(PAGE_DIR, `${domain}.html`),
      renderPage({ domain, name: profile.name, accounts: rows, asOf, verification, history, capabilities: capabilityByDomain.get(domain) ?? null }),
      'utf8',
    );
    pages++;

    verifyIndex.push({
      anchorId: domain,
      resolved: verification.resolved,
      accounts: verification.accounts.length,
      profile: `/api/v1/anchors/${domain}/profile.json`,
      page: `/anchor/${domain}`,
    });
  }

  await writeFile(
    VERIFY_JSON,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        note:
          'Which on-chain accounts each tracked anchor declares as its own, and how that was established. ' +
          'Attribution comes from the anchor\'s own SEP-1 stellar.toml — the permissionless standard the ' +
          'operator controls — and any account cited there only as a currency issuer is included solely ' +
          'when the issuer account\'s own home_domain confirms the claim. Every published scan is checked ' +
          'for an account claimed by two anchors before it can go out; see packages/indexer/src/invariants.ts.',
        anchors: verifyIndex,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  console.log(`✓ verify.json — ${verifyIndex.length} anchors`);
  console.log(`✓ ${pages} anchor page(s) → packages/web/anchor/`);
}

main().catch((err) => {
  console.error('build-anchor-profiles failed:', err);
  process.exit(1);
});
