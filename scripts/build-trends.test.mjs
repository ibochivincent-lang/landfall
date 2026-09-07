/**
 * The arithmetic in build-trends.mjs decides whether a published sentence
 * like "dark for 26 days" is true, so the edge cases that would quietly
 * corrupt it are pinned here.
 *
 *   node --test scripts/build-trends.test.mjs
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { currentRun, dedupeByTimestamp, findTransitions, volumeTrend } from './build-trends.mjs';

const p = (t, state, extra = {}) => ({ t, state, in: 0, out: 0, ...extra });

test('duplicate timestamps collapse to one observation', () => {
  // Real data contains these: the hourly append and the git backfill overlap.
  const points = [
    p('2026-08-12T00:00:00Z', 'live'),
    p('2026-08-12T00:00:00Z', 'live'),
    p('2026-08-13T00:00:00Z', 'live'),
  ];
  assert.equal(dedupeByTimestamp(points).length, 2);
});

test('observations are sorted by time regardless of input order', () => {
  const out = dedupeByTimestamp([
    p('2026-08-14T00:00:00Z', 'dark'),
    p('2026-08-12T00:00:00Z', 'live'),
    p('2026-08-13T00:00:00Z', 'slow'),
  ]);
  assert.deepEqual(out.map((x) => x.state), ['live', 'slow', 'dark']);
});

test('a duplicated timestamp does not fabricate a transition', () => {
  // If dedupe ran after transition detection, the repeated point below would
  // read as live -> live -> slow and still be one transition; but a repeated
  // point with a DIFFERENT state would invent one. Pin the ordering.
  const points = [
    p('2026-08-12T00:00:00Z', 'live'),
    p('2026-08-12T00:00:00Z', 'slow'), // same instant, contradictory
    p('2026-08-13T00:00:00Z', 'slow'),
  ];
  assert.equal(findTransitions(points).length, 1);
});

test('transitions record where they came from and when', () => {
  const t = findTransitions([
    p('2026-08-12T00:00:00Z', 'live'),
    p('2026-08-13T00:00:00Z', 'live'),
    p('2026-08-14T00:00:00Z', 'slow'),
    p('2026-08-15T00:00:00Z', 'dark'),
  ]);
  assert.deepEqual(t, [
    { at: '2026-08-14T00:00:00Z', from: 'live', to: 'slow' },
    { at: '2026-08-15T00:00:00Z', from: 'slow', to: 'dark' },
  ]);
});

test('a never-changing account reports everChanged false', () => {
  // The distinction that matters: "dark for 3 days" versus "dark for the
  // whole time anyone has been looking, which is 3 days".
  const run = currentRun(
    [p('2026-08-12T00:00:00Z', 'dark'), p('2026-08-15T00:00:00Z', 'dark')],
    Date.parse('2026-08-15T00:00:00Z'),
  );
  assert.equal(run.everChanged, false);
  assert.equal(run.observations, 2);
  assert.equal(run.since, '2026-08-12T00:00:00Z');
});

test('run length counts only the current state, not the whole history', () => {
  const run = currentRun(
    [
      p('2026-08-10T00:00:00Z', 'live'),
      p('2026-08-11T00:00:00Z', 'live'),
      p('2026-08-12T00:00:00Z', 'slow'),
      p('2026-08-13T00:00:00Z', 'slow'),
    ],
    Date.parse('2026-08-14T00:00:00Z'),
  );
  assert.equal(run.state, 'slow');
  assert.equal(run.observations, 2, 'two slow observations, not four total');
  assert.equal(run.since, '2026-08-12T00:00:00Z');
  assert.equal(run.everChanged, true);
  assert.equal(run.days, 2);
});

test('an empty history returns null rather than a zero-length run', () => {
  assert.equal(currentRun([]), null);
});

test('volume trend needs enough observations before it says anything', () => {
  assert.equal(volumeTrend([p('2026-08-12T00:00:00Z', 'live')]), null);
});

test('an account whose inbound counter stops rising reads as stopped', () => {
  const points = [
    p('2026-08-12T00:00:00Z', 'live', { in: 10 }),
    p('2026-08-13T00:00:00Z', 'live', { in: 20 }),
    p('2026-08-14T00:00:00Z', 'slow', { in: 30 }),
    p('2026-08-15T00:00:00Z', 'slow', { in: 30 }),
    p('2026-08-16T00:00:00Z', 'slow', { in: 30 }),
    p('2026-08-17T00:00:00Z', 'slow', { in: 30 }),
  ];
  assert.equal(volumeTrend(points).direction, 'stopped');
});

test('counters are cumulative, so growth is measured as a delta not a total', () => {
  // A busy account with a huge absolute count but flat growth must not read
  // as healthy just because the numbers are large.
  const points = [
    p('2026-08-12T00:00:00Z', 'live', { in: 100000 }),
    p('2026-08-13T00:00:00Z', 'live', { in: 100010 }),
    p('2026-08-14T00:00:00Z', 'live', { in: 100010 }),
    p('2026-08-15T00:00:00Z', 'live', { in: 100010 }),
  ];
  const trend = volumeTrend(points);
  assert.equal(trend.recentGrowth, 0);
  assert.equal(trend.direction, 'stopped');
});
