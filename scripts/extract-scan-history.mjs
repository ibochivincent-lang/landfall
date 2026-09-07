#!/usr/bin/env node
// ===========================================================
// Landfall — scan history extractor
//
// Reconstructs the per-account hourly time series from git history of
// packages/web/api/v1/anchors.json and writes it to data/scan-history.ndjson.
//
// Why this exists rather than a database query: the hourly GitHub Action
// commits a fresh anchors.json every scan, so git already holds the whole
// series — but the 5 September history rewrite (which made the repository
// single-author) reset `main` and left everything before that date on two
// local-only branches. Those branches are not on the remote and never will
// be: pushing them would reintroduce the very authorship this project
// deliberately removed. This script lifts the *measurements* off them
// instead, which is the part with lasting value.
//
// The observations it recovers cannot be re-derived from Horizon later.
// `hoursSinceActivity` and `topCounterpartyShare` are point-in-time
// readings, not queryable retroactively — once the branch holding them is
// gone, so are they.
//
// Re-runnable and idempotent: scans are keyed by their `asOf`, so running
// it again after more hourly commits appends the new ones and rewrites the
// file in timestamp order. Branches that no longer exist are skipped with a
// warning rather than failing the run.
//
// Usage:
//   node scripts/extract-scan-history.mjs [--out data/scan-history.ndjson]
// ===========================================================

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ANCHORS_PATH = 'packages/web/api/v1/anchors.json';

/**
 * Ordered oldest-first. `main` is last so that where a scan appears on both
 * a pre-rewrite branch and on main, the main copy is the one already kept —
 * they are byte-identical for the same `asOf`, but preferring main keeps the
 * result stable once the archive branches are eventually deleted.
 */
const BRANCHES = [
  'archive/full-history-20260905',
  'backup/pre-rewrite-20260905',
  'main',
];

const FIELDS = [
  'account',
  'domain',
  'state',
  'inbound',
  'outbound',
  'returns',
  'returnRate',
  'hoursSinceActivity',
  'topCounterpartyShare',
];

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function branchExists(branch) {
  try {
    git(['rev-parse', '--verify', '--quiet', branch]);
    return true;
  } catch {
    return false;
  }
}

function revisionsOf(branch) {
  const out = git(['log', '--format=%H', '--reverse', branch, '--', ANCHORS_PATH]);
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

function main() {
  const outArg = process.argv.indexOf('--out');
  const outPath = resolve(outArg === -1 ? 'data/scan-history.ndjson' : process.argv[outArg + 1]);

  /** asOf -> rows, so a scan present on several branches is only kept once. */
  const byScan = new Map();
  let unparseable = 0;

  for (const branch of BRANCHES) {
    if (!branchExists(branch)) {
      process.stderr.write(`SKIP ${branch} — no such ref\n`);
      continue;
    }
    const revs = revisionsOf(branch);
    process.stderr.write(`${branch}: ${revs.length} revisions of ${ANCHORS_PATH}\n`);

    for (const sha of revs) {
      let doc;
      try {
        doc = JSON.parse(git(['show', `${sha}:${ANCHORS_PATH}`]));
      } catch {
        // A revision that will not parse is counted and reported, never
        // silently dropped — a scan missing from the series is a gap in a
        // measurement record, which the reader has to be able to see.
        unparseable += 1;
        continue;
      }
      const asOf = doc?.asOf;
      if (!asOf || byScan.has(asOf)) continue;

      byScan.set(
        asOf,
        (doc.accounts ?? []).map((a) => {
          const row = { asOf };
          for (const f of FIELDS) row[f] = a[f] ?? null;
          return row;
        }),
      );
    }
  }

  const scans = [...byScan.keys()].sort();
  const rows = scans.flatMap((asOf) =>
    byScan.get(asOf).slice().sort((x, y) => String(x.account).localeCompare(String(y.account))),
  );

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    rows.map((r) => JSON.stringify(r, ['asOf', ...FIELDS])).join('\n') + '\n',
    'utf8',
  );

  process.stderr.write(
    `\nscans: ${scans.length}\nrows: ${rows.length}\n` +
      `span: ${scans[0]} -> ${scans[scans.length - 1]}\n` +
      `unparseable revisions skipped: ${unparseable}\n` +
      `wrote: ${outPath}\n`,
  );
}

main();
