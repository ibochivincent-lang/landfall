/**
 * build-trends.mjs
 *
 * Reads the per-account history that every scan has been appending since
 * 12 August and answers the question nothing has been asking of it: has this
 * account's state actually changed, and when?
 *
 *   node scripts/build-trends.mjs  →  packages/web/api/v1/trends.json
 *
 * docs/gaps.md has listed this as open since the beginning — "every scan is
 * stored, so the data for 'dark for N consecutive scans' exists, nothing
 * reads it back yet". This reads it back.
 *
 * What it will and will not claim
 * -------------------------------
 * It reports transitions that were observed. Across 108 accounts and roughly
 * a month of scans the ledger has shown 15 live→slow, 7 slow→live and 1
 * dark→live, and **zero** transitions into dark from any state. Every dark
 * account was already dark the first time it was seen.
 *
 * That matters, because the obvious feature to build here is "warn a wallet
 * 48 hours before an anchor goes dark" — and there is no basis for it. A
 * predictor needs examples of the thing it predicts, and this dataset
 * contains none. Publishing one anyway would mean shipping a confident
 * warning with nothing behind it, which is the exact failure this project
 * exists to find in other people's tools.
 *
 * So: observed transitions, current run lengths, and an explicit statement of
 * what has never been seen. A wallet can act on "this account went from
 * settling to slow eight days ago" without anyone pretending to forecast.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const API_DIR = join(ROOT, 'packages', 'web', 'api', 'v1');
const OUT = join(API_DIR, 'trends.json');

const MS_PER_DAY = 86_400_000;

/**
 * The profile history can contain the same timestamp twice — the builder
 * appends the current scan and a git-seeded backfill can overlap it. Two
 * identical observations are one observation, and counting them twice would
 * inflate every run length.
 */
export function dedupeByTimestamp(points) {
  const seen = new Set();
  const out = [];
  for (const p of points) {
    if (seen.has(p.t)) continue;
    seen.add(p.t);
    out.push(p);
  }
  return out.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

/** Every point where the state differs from the one before it. */
export function findTransitions(points) {
  const clean = dedupeByTimestamp(points);
  const out = [];
  for (let i = 1; i < clean.length; i++) {
    const prev = clean[i - 1];
    const cur = clean[i];
    if (prev.state !== cur.state) {
      out.push({ at: cur.t, from: prev.state, to: cur.state });
    }
  }
  return out;
}

/**
 * How long the account has been in the state it is in now — both in
 * observations and in days. `since` is the timestamp of the observation where
 * the current state began, which for an account that has never changed state
 * is simply the first time it was ever seen. That distinction is kept in
 * `everChanged`, because "dark for 26 days" and "dark for as long as we have
 * been looking, which is 26 days" are different claims.
 */
export function currentRun(points, now = Date.now()) {
  const clean = dedupeByTimestamp(points);
  if (clean.length === 0) return null;

  const state = clean[clean.length - 1].state;
  let startIdx = clean.length - 1;
  while (startIdx > 0 && clean[startIdx - 1].state === state) startIdx--;

  const since = clean[startIdx].t;
  const everChanged = startIdx > 0;
  return {
    state,
    observations: clean.length - startIdx,
    since,
    days: Math.round(((now - Date.parse(since)) / MS_PER_DAY) * 10) / 10,
    everChanged,
  };
}

/** Volume trend: recent half of the observed window against the earlier half. */
export function volumeTrend(points) {
  const clean = dedupeByTimestamp(points);
  if (clean.length < 4) return null;

  const mid = Math.floor(clean.length / 2);
  const sum = (arr) => arr.reduce((s, p) => s + (p.in || 0) + (p.out || 0), 0);
  const earlier = sum(clean.slice(0, mid));
  const recent = sum(clean.slice(mid));

  // These are cumulative counters, so they only ever rise; what matters is
  // how much they rose, not their absolute size.
  const earlierGrowth = (clean[mid - 1]?.in ?? 0) - (clean[0]?.in ?? 0);
  const recentGrowth = (clean[clean.length - 1]?.in ?? 0) - (clean[mid]?.in ?? 0);

  let direction = 'steady';
  if (recentGrowth === 0 && earlierGrowth > 0) direction = 'stopped';
  else if (recentGrowth < earlierGrowth * 0.5) direction = 'slowing';
  else if (recentGrowth > earlierGrowth * 1.5) direction = 'accelerating';

  return { earlierGrowth, recentGrowth, direction, basis: `${clean.length} observations` };
}

async function main() {
  const anchorsDir = join(API_DIR, 'anchors');
  const domains = (await readdir(anchorsDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const now = Date.now();
  const anchors = [];
  const allTransitions = [];
  const transitionCounts = {};

  for (const domain of domains) {
    let profile;
    try {
      profile = JSON.parse(await readFile(join(anchorsDir, domain, 'profile.json'), 'utf8'));
    } catch {
      continue;
    }
    const history = profile.history || {};

    const accounts = [];
    for (const [account, points] of Object.entries(history)) {
      const transitions = findTransitions(points);
      const run = currentRun(points, now);
      if (!run) continue;

      for (const t of transitions) {
        allTransitions.push({ anchor: domain, account, ...t });
        const key = `${t.from}->${t.to}`;
        transitionCounts[key] = (transitionCounts[key] || 0) + 1;
      }

      accounts.push({
        account,
        current: run,
        transitions,
        volume: volumeTrend(points),
      });
    }
    if (accounts.length === 0) continue;

    // An anchor "recently degraded" if any of its accounts moved to a weaker
    // state in the last 14 days. Weaker, not just different — a slow→live
    // recovery is a change and is not a degradation.
    const rank = { live: 3, slow: 2, no_activity: 1, dark: 0 };
    const recentDegradations = accounts.flatMap((a) =>
      a.transitions.filter(
        (t) =>
          (rank[t.to] ?? 0) < (rank[t.from] ?? 0) &&
          now - Date.parse(t.at) < 14 * MS_PER_DAY,
      ).map((t) => ({ account: a.account, ...t })),
    );

    anchors.push({
      anchor: domain,
      name: profile.name || domain,
      accountsTracked: accounts.length,
      recentlyDegraded: recentDegradations.length > 0,
      recentDegradations,
      accounts: accounts.sort((a, b) => b.transitions.length - a.transitions.length),
    });
  }

  allTransitions.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  const intoDark = Object.entries(transitionCounts)
    .filter(([k]) => k.endsWith('->dark'))
    .reduce((s, [, n]) => s + n, 0);

  const body = {
    generatedAt: new Date().toISOString(),
    note:
      'State changes observed per account across every stored scan. Reads back the history the ' +
      'scan has been writing since 12 August 2026, which until now nothing consumed.',
    whatThisIsNot:
      intoDark === 0
        ? 'This is not a prediction. Across every account and every stored scan, ZERO transitions ' +
          'into the dark state have been observed — every dark account was already dark when first ' +
          'seen. A model that warns "this anchor is about to go dark" needs examples of anchors ' +
          'going dark, and this dataset contains none. Observed transitions are reported; forecasts ' +
          'are not, and will not be until the data supports one.'
        : `${intoDark} transition(s) into dark have now been observed. That is the first evidence a ` +
          'degradation signal could ever be built on, and it is still far too few to forecast from.',
    limits:
      'A transition is only visible if two scans straddle it, and scan cadence is irregular — GitHub ' +
      'Actions schedules hourly and delivers roughly every 2.8 hours. A state that flipped and flipped ' +
      'back between two scans is invisible here. Run lengths measured in days are bounded below by how ' +
      'long this project has been observing, which for the oldest accounts is 12 August 2026.',
    totals: {
      anchors: anchors.length,
      accounts: anchors.reduce((s, a) => s + a.accountsTracked, 0),
      transitionsObserved: allTransitions.length,
      transitionsByKind: transitionCounts,
      anchorsRecentlyDegraded: anchors.filter((a) => a.recentlyDegraded).length,
    },
    recentTransitions: allTransitions.slice(0, 50),
    anchors: anchors.sort(
      (a, b) => Number(b.recentlyDegraded) - Number(a.recentlyDegraded) || a.anchor.localeCompare(b.anchor),
    ),
  };

  await writeFile(OUT, JSON.stringify(body, null, 2) + '\n', 'utf8');

  console.log(`✓ ${anchors.length} anchors, ${body.totals.accounts} accounts`);
  console.log(`  transitions observed: ${allTransitions.length}`);
  for (const [k, n] of Object.entries(transitionCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(24)} ${n}`);
  }
  console.log(`  anchors degraded in the last 14 days: ${body.totals.anchorsRecentlyDegraded}`);
  console.log(`✓ ${OUT}`);
}

// Only run when invoked directly, so the tests can import the pure functions.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('build-trends.mjs')) {
  main().catch((err) => {
    console.error('build-trends failed:', err);
    process.exit(1);
  });
}
