#!/usr/bin/env node
// ===========================================================
// Landfall — append the current scan to the measurement record
//
// Runs hourly, right after anchors.json is rebuilt, and appends that scan's
// per-account rows to data/scan-history.ndjson.
//
// Why this exists: the series used to live only in git history of
// anchors.json, which meant a history rewrite could orphan it — and one did.
// The 5 September rewrite left 26 days of measurements on two local-only
// branches, recoverable then but not forever (see data/README.md).
// Appending to a tracked file makes the record durable by construction
// rather than by luck: it survives any future rewrite the same way the rest
// of the working tree does.
//
// scripts/extract-scan-history.mjs remains the backfill path — it rebuilds
// the whole file from git history. This is the incremental one.
//
// Idempotent: a scan is keyed by its `asOf`, so re-running on the same
// anchors.json appends nothing. That matters because the workflow step runs
// on every hourly job whether or not the scan produced new data.
//
// Usage:
//   node scripts/append-scan-history.mjs
// ===========================================================

import { appendFile, readFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const ANCHORS = resolve('packages/web/api/v1/anchors.json');
const HISTORY = resolve('data/scan-history.ndjson');

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

async function main() {
  let doc;
  try {
    doc = JSON.parse(await readFile(ANCHORS, 'utf8'));
  } catch (err) {
    // No anchors.json means the scan did not get far enough to produce one.
    // That is a scan problem, already reported by the steps above this one —
    // not a reason to fail the job and block the snapshot commit.
    console.log(`No readable ${ANCHORS} (${err.code ?? err.message}) — nothing to append.`);
    return;
  }

  const asOf = doc?.asOf;
  if (!asOf) {
    console.log('anchors.json has no asOf — refusing to append an unstamped scan.');
    return;
  }

  let existing = '';
  try {
    existing = await readFile(HISTORY, 'utf8');
  } catch {
    /* first run: the file is created by the append below */
  }

  // Keyed on the exact quoted form the rows are written with, so a substring
  // of a different timestamp cannot produce a false match.
  if (existing.includes(`{"asOf":"${asOf}"`)) {
    console.log(`Scan ${asOf} is already in the record — nothing appended.`);
    return;
  }

  const rows = (doc.accounts ?? [])
    .slice()
    .sort((a, b) => String(a.account).localeCompare(String(b.account)))
    .map((a) => {
      const row = { asOf };
      for (const f of FIELDS) row[f] = a[f] ?? null;
      return JSON.stringify(row, ['asOf', ...FIELDS]);
    });

  if (rows.length === 0) {
    console.log(`Scan ${asOf} has no accounts — nothing appended.`);
    return;
  }

  await mkdir(dirname(HISTORY), { recursive: true });
  // Leading newline only when the file exists and does not already end with
  // one, so a truncated previous write cannot glue two rows together.
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  await appendFile(HISTORY, prefix + rows.join('\n') + '\n', 'utf8');

  console.log(`Appended ${rows.length} observation(s) for scan ${asOf}.`);
}

await main();
