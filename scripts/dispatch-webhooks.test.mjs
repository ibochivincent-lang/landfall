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

/* ─── refund.spike ────────────────────────────────────────────────────────
   This event was subscribable with no producer at all until now. The rule
   below mirrors the one in dispatch-webhooks.mjs, and the cases are the real
   ones from data/scan-history.ndjson rather than invented shapes — including
   the two that an ungated rule would have got wrong. */

const SPIKE_MIN_INBOUND = 25;
const SPIKE_MIN_ABSOLUTE_RISE = 0.02;
const SPIKE_MIN_RELATIVE_RISE = 1.5;

function isSpike(prev, cur) {
  const inbound = Number(cur.inbound_count ?? 0);
  if (inbound < SPIKE_MIN_INBOUND) return false;
  if (cur.refund_rate === null || prev.refund_rate === null) return false;
  const from = Number(prev.refund_rate);
  const to = Number(cur.refund_rate);
  if (to - from < SPIKE_MIN_ABSOLUTE_RISE) return false;
  if (from > 0 && to < from * SPIKE_MIN_RELATIVE_RISE) return false;
  return true;
}

test('the aps.money rise is a spike — the one real case in the record', () => {
  // 3.6% -> 15% across 3,352 inbound. Enough volume for the rate to mean
  // something, and a large move.
  assert.equal(
    isSpike({ refund_rate: 0.0362 }, { refund_rate: 0.1504, inbound_count: 3352 }),
    true,
  );
});

test('a thin sample never fires, however alarming the percentage looks', () => {
  // cowrie.exchange: one return out of six inbound payments reads as a 16.7%
  // return rate. An ungated rule fired on this twice — an alert naming a real
  // business on the strength of a single event.
  assert.equal(
    isSpike({ refund_rate: 0 }, { refund_rate: 0.1667, inbound_count: 6 }),
    false,
  );
});

test('a null rate is unknown, not zero, and cannot be risen from or fallen to', () => {
  // refund_rate is NULL when there is no inbound traffic. Treating it as 0
  // would manufacture a rise from nothing on the first payment an account
  // ever receives.
  assert.equal(isSpike({ refund_rate: null }, { refund_rate: 0.5, inbound_count: 100 }), false);
  assert.equal(isSpike({ refund_rate: 0.5 }, { refund_rate: null, inbound_count: 100 }), false);
});

test('a small relative jump on a tiny base does not fire', () => {
  // 0.1% -> 0.2% doubles, which passes the relative test alone. The absolute
  // floor is what stops it.
  assert.equal(isSpike({ refund_rate: 0.001 }, { refund_rate: 0.002, inbound_count: 5000 }), false);
});

test('a large absolute rise on an already-high rate must still be a real move', () => {
  // 30% -> 32% clears the absolute floor but is a 7% relative change. An
  // account that has always been high should not alert on drift.
  assert.equal(isSpike({ refund_rate: 0.30 }, { refund_rate: 0.32, inbound_count: 5000 }), false);
  // 30% -> 50% is both.
  assert.equal(isSpike({ refund_rate: 0.30 }, { refund_rate: 0.50, inbound_count: 5000 }), true);
});

test('a falling refund rate never fires — recovery is not an alert', () => {
  assert.equal(isSpike({ refund_rate: 0.20 }, { refund_rate: 0.02, inbound_count: 5000 }), false);
});

test('a rise from exactly zero fires once the absolute floor is cleared', () => {
  // from === 0 skips the relative test, since nothing is infinitely larger
  // than zero. The absolute floor carries it alone.
  assert.equal(isSpike({ refund_rate: 0 }, { refund_rate: 0.05, inbound_count: 500 }), true);
  assert.equal(isSpike({ refund_rate: 0 }, { refund_rate: 0.01, inbound_count: 500 }), false);
});

test('exactly at the inbound gate is allowed', () => {
  assert.equal(isSpike({ refund_rate: 0 }, { refund_rate: 0.05, inbound_count: 25 }), true);
  assert.equal(isSpike({ refund_rate: 0 }, { refund_rate: 0.05, inbound_count: 24 }), false);
});
