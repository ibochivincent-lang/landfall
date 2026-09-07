/**
 * The alerter's decision logic.
 *
 * The network calls are not tested here; the part worth holding still is
 * which steps count as failed and what the alert says, because both are what
 * a human acts on at 3am.
 *
 *   node --test scripts/alert-on-failure.test.mjs
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { failedSteps, issueBody } from './alert-on-failure.mjs';

test('a step that failed under continue-on-error is still reported', () => {
  // This is the whole point: continue-on-error leaves outcome 'failure' while
  // conclusion becomes 'success' and the job goes green. Reading `outcome` is
  // what makes a swallowed failure visible.
  const steps = JSON.stringify({
    scan: { outcome: 'failure', conclusion: 'success' },
    oracle: { outcome: 'success', conclusion: 'success' },
  });
  assert.deepEqual(failedSteps(steps), ['scan']);
});

test('an all-green run reports nothing', () => {
  const steps = JSON.stringify({
    scan: { outcome: 'success', conclusion: 'success' },
    webhooks: { outcome: 'success', conclusion: 'success' },
  });
  assert.deepEqual(failedSteps(steps), []);
});

test('skipped and cancelled steps are not failures', () => {
  const steps = JSON.stringify({
    scan: { outcome: 'skipped' },
    oracle: { outcome: 'cancelled' },
    webhooks: { outcome: 'success' },
  });
  assert.deepEqual(failedSteps(steps), []);
});

test('several failures are reported, sorted, so the set is comparable run to run', () => {
  const steps = JSON.stringify({
    webhooks: { outcome: 'failure' },
    scan: { outcome: 'failure' },
    oracle: { outcome: 'failure' },
  });
  // Sorted output is what lets the caller compare "same failing set as last
  // time?" by string equality and stay quiet.
  assert.deepEqual(failedSteps(steps), ['oracle', 'scan', 'webhooks']);
});

test('malformed or absent step JSON reports nothing rather than throwing', () => {
  // An alerter that crashes on bad input takes the scan job with it.
  for (const bad of ['', undefined, 'not json', '{', 'null']) {
    assert.deepEqual(failedSteps(bad), []);
  }
});

test('the body names every failing step and links the run', () => {
  const body = issueBody(['oracle', 'scan'], {
    repo: 'ibochivincent-lang/landfall',
    runId: '123',
    server: 'https://github.com',
  });
  assert.match(body, /`oracle`/);
  assert.match(body, /`scan`/);
  assert.match(body, /actions\/runs\/123/);
  assert.match(body, /2 failing step/);
});

test('the body explains why the workflow looks green, which is the confusing part', () => {
  const body = issueBody(['scan'], { repo: 'r', runId: '1', server: 'https://github.com' });
  assert.match(body, /continue-on-error/);
  assert.match(body, /closes automatically/);
});

test('the body is deterministic, so an unchanged failure set produces identical text', () => {
  const args = { repo: 'r', runId: '1', server: 'https://github.com' };
  assert.equal(issueBody(['scan', 'oracle'], args), issueBody(['scan', 'oracle'], args));
});

test('a missing run url degrades to a note rather than an undefined link', () => {
  const body = issueBody(['scan'], {});
  assert.match(body, /run url unavailable/);
  assert.doesNotMatch(body, /undefined/);
});
