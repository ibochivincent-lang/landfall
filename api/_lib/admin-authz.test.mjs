/**
 * Guards the /admin authorization boundary against one specific, once-live
 * privilege escalation.
 *
 * requireSession() accepts a portal session as well as an admin one — it
 * looks in portal_sessions FIRST, because the developer portal reuses the
 * same cookie. For a period the /admin block gated on `if (!session)` alone,
 * so anyone who could fill in the public signup form at
 * POST /api/v1/auth/register received a role:'developer' session that opened
 * every route under /admin — including POST/PATCH/DELETE /admin/anchors,
 * which controls the tracked anchor set every published figure derives from.
 *
 * Verified against a running instance at the time: an ordinary registration
 * returned HTTP 200 from /admin/me, /admin/health and /admin/anchors, and
 * 403 from all three after the fix.
 *
 * This test reads the source rather than running the server, for the same
 * reason routes.test.mjs does: the property that matters is structural — the
 * role check must exist and must sit between the session lookup and the
 * first admin route. A live test would need a database and would only prove
 * it for whichever routes it happened to call.
 *
 *   node --test api/_lib/admin-authz.test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(resolve(__dirname, '..', '[...path].js'), 'utf8');
const LINES = SOURCE.split('\n');

const ADMIN_BLOCK = /parts\[0\] === 'v1' && parts\[1\] === 'admin'/;
const ROLE_CHECK = /session\.role\s*!==\s*['"]admin['"]/;
const ROUTE_HANDLER = /if \(req\.method === '(GET|POST|PATCH|DELETE|PUT)'/;

/** Line index where the /api/v1/admin block begins. */
function adminBlockIndex() {
  return LINES.findIndex((l) => ADMIN_BLOCK.test(l));
}

/**
 * Line index of the session lookup guarding the /admin block.
 *
 * Anchored to the block itself, not to the reply text: two call sites answer
 * "Not authenticated." and the other one — /api/v1/auth/me — correctly has no
 * role check, so matching on the message alone finds the wrong gate and the
 * test passes while proving nothing. That is not hypothetical; the first
 * version of this file did exactly that.
 */
function adminGateIndex() {
  const block = adminBlockIndex();
  if (block === -1) return -1;
  for (let i = block; i < LINES.length; i += 1) {
    if (LINES[i].includes('await requireSession(req, db)')) return i;
  }
  return -1;
}

test('the /admin block checks the admin role, not merely that a session exists', () => {
  assert.notEqual(adminBlockIndex(), -1, 'could not find the /api/v1/admin block — was it renamed?');
  const gate = adminGateIndex();
  assert.notEqual(gate, -1, 'could not find the /admin session gate — was the block rewritten?');

  const window = LINES.slice(gate, gate + 10).join('\n');
  assert.match(
    window,
    ROLE_CHECK,
    'The /admin gate does not check session.role. requireSession() accepts a PORTAL session, so without ' +
      'this check anyone who registers at POST /api/v1/auth/register reaches every /admin route, including ' +
      'the anchor writes that decide what gets published.',
  );
  assert.match(window, /403/, 'a failed role check must answer 403, not fall through');
});

test('no /admin route handler sits between the session lookup and the role check', () => {
  const gate = adminGateIndex();
  const roleLine = LINES.findIndex((l, i) => i >= gate && ROLE_CHECK.test(l));
  assert.notEqual(roleLine, -1, 'no role check found after the /admin session gate');

  const between = LINES.slice(gate, roleLine).join('\n');
  assert.doesNotMatch(
    between,
    ROUTE_HANDLER,
    'a route handler runs before the admin role is checked — that route is reachable by any portal user',
  );
});

test('registration still hands out the developer role, never admin', () => {
  // If registration could mint an admin, the gate above would not help.
  const register = SOURCE.slice(SOURCE.indexOf("action === 'register'"));
  const insert = register.slice(0, register.indexOf('RETURNING'));
  assert.match(insert, /INSERT INTO portal_users/);
  assert.match(insert, /'developer'/, 'public registration must hard-code the developer role');
  assert.doesNotMatch(insert, /'admin'/, 'public registration must never be able to create an admin');
});
