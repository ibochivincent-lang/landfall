/**
 * The dead-letter selection rule.
 *
 * The candidate query in redeliver-webhooks.mjs decides which failed
 * deliveries get a second chance. Getting it wrong is expensive in both
 * directions: too narrow and a subscriber silently never receives a
 * degradation they asked for; too broad and a permanently dead endpoint
 * collects a fresh POST every hour forever, which is an outage amplifier
 * rather than a recovery mechanism.
 *
 * Mirrors the SQL's WHERE clause rather than importing it, for the same
 * reason dispatch-webhooks.test.mjs mirrors the rank rule: importing the
 * module would execute its DATABASE_URL guard and lazy `pg` import.
 *
 *   node --test scripts/redeliver-webhooks.test.mjs
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

const MAX_AGE_HOURS = 48;

/**
 * The predicate the SQL expresses. `replays` is every row whose `replay_of`
 * points at the candidate.
 */
function isCandidate(delivery, webhook, replays, now = Date.now()) {
  if (delivery.status !== 'failed') return false;
  if (delivery.payload == null) return false;      // pre-migration row: nothing to resend
  if (delivery.replay_of != null) return false;    // a replay is never itself replayed
  if (!webhook.active) return false;
  const ageHours = (now - delivery.created_at) / 3_600_000;
  if (ageHours > MAX_AGE_HOURS) return false;
  return !replays.some((r) => r.replay_of === delivery.id && r.status === 'delivered');
}

const NOW = Date.parse('2026-09-08T12:00:00Z');
const ACTIVE = { active: true };

function failed(over = {}) {
  return {
    id: 1,
    status: 'failed',
    payload: { event: 'anchor.degraded' },
    replay_of: null,
    created_at: NOW - 3_600_000, // an hour ago
    ...over,
  };
}

test('a recent failed delivery with a payload is replayable', () => {
  assert.equal(isCandidate(failed(), ACTIVE, [], NOW), true);
});

test('a delivered row is never replayed', () => {
  assert.equal(isCandidate(failed({ status: 'delivered' }), ACTIVE, [], NOW), false);
});

test('a row written before migration 014 has no payload and is skipped, not invented', () => {
  // The alternative — rebuilding the event from current state — would deliver
  // a different fact under the original event's timestamp.
  assert.equal(isCandidate(failed({ payload: null }), ACTIVE, [], NOW), false);
});

test('a replay is never itself replayed, so failures cannot chain', () => {
  assert.equal(isCandidate(failed({ replay_of: 7 }), ACTIVE, [], NOW), false);
});

test('an inactive subscription is excluded', () => {
  assert.equal(isCandidate(failed(), { active: false }, [], NOW), false);
});

test('once a replay has been delivered, the original stops being a candidate', () => {
  const replays = [{ replay_of: 1, status: 'delivered' }];
  assert.equal(isCandidate(failed(), ACTIVE, replays, NOW), false);
});

test('a replay that also failed does NOT block another attempt', () => {
  // The endpoint may have recovered since. Only a success retires the row.
  const replays = [{ replay_of: 1, status: 'failed' }];
  assert.equal(isCandidate(failed(), ACTIVE, replays, NOW), true);
});

test('past the age window a missed event is left to the API rather than re-POSTed', () => {
  const old = failed({ created_at: NOW - (MAX_AGE_HOURS + 1) * 3_600_000 });
  assert.equal(isCandidate(old, ACTIVE, [], NOW), false);
});

test('exactly at the boundary is still replayable', () => {
  const edge = failed({ created_at: NOW - MAX_AGE_HOURS * 3_600_000 });
  assert.equal(isCandidate(edge, ACTIVE, [], NOW), true);
});

test('a permanently dead endpoint does not accumulate unbounded replays', () => {
  // Each hourly run adds at most one replay per original, and the age window
  // retires the original entirely after two days.
  let replays = [];
  for (let hour = 1; hour <= 72; hour++) {
    const now = NOW + hour * 3_600_000;
    if (isCandidate(failed(), ACTIVE, replays, now)) {
      replays.push({ replay_of: 1, status: 'failed' });
    }
  }
  assert.ok(
    replays.length <= MAX_AGE_HOURS,
    `expected replays to stop at the age window, got ${replays.length}`,
  );
});
