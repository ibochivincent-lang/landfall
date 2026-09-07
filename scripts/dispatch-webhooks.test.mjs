/**
 * The degradation-detection rule, tested against the transitions that
 * actually occur in this dataset.
 *
 * The version this replaces fired only on transitions INTO dark. That reads
 * as obviously correct and was dead code: zero such transitions have ever
 * been observed, while 15 live -> slow degradations went unalerted. So the
 * cases below are the real ones from /api/v1/trends.json, not invented shapes.
 *
 *   node --test scripts/dispatch-webhooks.test.mjs
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

// Mirrors the rule in dispatch-webhooks.mjs. Kept here rather than exported
// from that file because importing it would execute its DATABASE_URL guard
// and lazy `pg` import at test time.
const RANK = { live: 3, slow: 2, no_activity: 1, dark: 0 };

function detect(current, previousState) {
  return current
    .map((r) => {
      const from = previousState.get(r.account_id);
      if (!from || from === r.state) return null;
      if ((RANK[r.state] ?? 0) >= (RANK[from] ?? 0)) return null;
      return {
        account_id: r.account_id,
        from,
        to: r.state,
        event: r.state === 'dark' ? 'anchor.dark' : 'anchor.degraded',
      };
    })
    .filter(Boolean);
}

const prev = (pairs) => new Map(pairs);

test('live -> slow fires anchor.degraded — the transition that actually happens', () => {
  const out = detect([{ account_id: 'A', state: 'slow' }], prev([['A', 'live']]));
  assert.equal(out.length, 1);
  assert.equal(out[0].event, 'anchor.degraded');
  assert.equal(out[0].from, 'live');
  assert.equal(out[0].to, 'slow');
});

test('anything -> dark still fires anchor.dark, unchanged for existing subscribers', () => {
  const out = detect([{ account_id: 'A', state: 'dark' }], prev([['A', 'slow']]));
  assert.equal(out[0].event, 'anchor.dark');
});

test('slow -> live is a recovery and fires nothing', () => {
  assert.deepEqual(detect([{ account_id: 'A', state: 'live' }], prev([['A', 'slow']])), []);
});

test('dark -> live fires nothing — improvement is not an alert', () => {
  assert.deepEqual(detect([{ account_id: 'A', state: 'live' }], prev([['A', 'dark']])), []);
});

test('an unchanged state fires nothing, however bad that state is', () => {
  assert.deepEqual(detect([{ account_id: 'A', state: 'dark' }], prev([['A', 'dark']])), []);
});

test('an account with no previous observation fires nothing', () => {
  // First sighting is not a degradation. Without this guard every newly
  // discovered dark account would alert on the scan that found it — which is
  // precisely how all 62 currently-dark accounts entered the dataset.
  assert.deepEqual(detect([{ account_id: 'NEW', state: 'dark' }], prev([])), []);
});

test('an unknown state ranks lowest and never crashes the dispatcher', () => {
  const out = detect([{ account_id: 'A', state: 'something_new' }], prev([['A', 'live']]));
  assert.equal(out.length, 1, 'treated as a degradation rather than skipped');
  assert.equal(out[0].event, 'anchor.degraded');
});

test('the real month of transitions produces 15 degradations and no dark events', () => {
  // From /api/v1/trends.json: 15 live->slow, 7 slow->live, 1 dark->live.
  const current = [];
  const previous = [];
  for (let i = 0; i < 15; i++) { current.push({ account_id: 'd' + i, state: 'slow' }); previous.push(['d' + i, 'live']); }
  for (let i = 0; i < 7; i++)  { current.push({ account_id: 'r' + i, state: 'live' }); previous.push(['r' + i, 'slow']); }
  current.push({ account_id: 'x', state: 'live' }); previous.push(['x', 'dark']);

  const out = detect(current, prev(previous));
  assert.equal(out.length, 15, 'the 15 degradations that the old rule missed entirely');
  assert.equal(out.filter((t) => t.event === 'anchor.dark').length, 0, 'and zero dark events, which is why the old rule never fired');
  assert.equal(out.filter((t) => t.event === 'anchor.degraded').length, 15);
});
