/**
 * api/routes/admin.js
 *
 * Route controller for Landfall Administrator operations.
 * Author: ibochivincent-lang
 */

import { randomBytes } from 'node:crypto';
import {
  adminJson,
  readJsonBody,
  verifyPassword,
  sha256Hex,
  setSessionCookie,
  clearSessionCookie,
  parseCookies,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from '../_lib/helpers.js';
import { redeliverFailedWebhooks } from '../_lib/webhook-redelivery.js';

export async function handleAdminRoute(req, res, db, parts, joined, context = {}) {
  const sub = parts.slice(2);
  const subPath = sub.join('/');

  if (req.method === 'POST' && subPath === 'login') {
    if (context.enforceAuthRateLimit && (await context.enforceAuthRateLimit(req, res, db, 'admin-login'))) {
      return true;
    }

    const body = await readJsonBody(req);
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!username || !password) return adminJson(res, 400, { error: 'Username and password are required.' });

    const { rows } = await db.query('SELECT id, password_hash FROM admin_users WHERE username = $1', [username]);
    const user = rows[0];
    const ok = user
      ? await verifyPassword(password, user.password_hash)
      : await verifyPassword(password, 'scrypt$00$00').catch(() => false);
    if (!user || !ok) return adminJson(res, 401, { error: 'Invalid username or password.' });

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await db.query(
      `INSERT INTO admin_sessions (token_hash, user_id, expires_at, user_agent)
       VALUES ($1, $2, $3, $4)`,
      [sha256Hex(token), user.id, expiresAt.toISOString(), String(req.headers['user-agent'] || '').slice(0, 300)],
    );
    await db.query('UPDATE admin_users SET last_login_at = now() WHERE id = $1', [user.id]);
    setSessionCookie(res, token, SESSION_TTL_MS / 1000);
    return adminJson(res, 200, { ok: true, username });
  }

  if (req.method === 'POST' && subPath === 'logout') {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) await db.query('DELETE FROM admin_sessions WHERE token_hash = $1', [sha256Hex(token)]);
    clearSessionCookie(res);
    return adminJson(res, 200, { ok: true });
  }

  // The caller has already validated requireSession() and role === 'admin'
  const session = context.session;
  if (!session) return adminJson(res, 401, { error: 'Not authenticated.' });

  if (req.method === 'GET' && subPath === 'me') {
    return adminJson(res, 200, { ok: true, username: session.username });
  }

  if (req.method === 'GET' && subPath === 'health') {
    if (context.adminHealth) return adminJson(res, 200, await context.adminHealth(db));
    return adminJson(res, 200, { ok: true, status: 'healthy' });
  }

  if (req.method === 'GET' && subPath === 'payments') {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 100), 1), 1000);
    if (context.paymentsPage) {
      const page = await context.paymentsPage(db, {
        direction: url.searchParams.get('direction') || null,
        asset: url.searchParams.get('asset') || null,
        before: url.searchParams.get('before') || null,
        limit,
        includeRaw: true,
      });
      return adminJson(res, 200, page);
    }
    return adminJson(res, 200, { payments: [] });
  }

  if (req.method === 'GET' && subPath === 'anchors') {
    if (context.listTrackedAnchors) {
      return adminJson(res, 200, { anchors: await context.listTrackedAnchors(db) });
    }
    return adminJson(res, 200, { anchors: [] });
  }

  if (req.method === 'POST' && subPath === 'anchors') {
    const body = await readJsonBody(req);
    const domain = String(body.domain || '').trim().toLowerCase();
    if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
      return adminJson(res, 400, { error: 'A valid domain is required, e.g. example.com.' });
    }
    await db.query(
      `INSERT INTO tracked_anchors (domain, active, added_by, notes)
       VALUES ($1, true, $2, $3)
       ON CONFLICT (domain) DO UPDATE
         SET active = true, updated_at = now(), notes = COALESCE(EXCLUDED.notes, tracked_anchors.notes)`,
      [domain, session.username, body.notes ? String(body.notes).slice(0, 500) : null],
    );
    if (context.listTrackedAnchors) {
      return adminJson(res, 200, { ok: true, anchors: await context.listTrackedAnchors(db) });
    }
    return adminJson(res, 200, { ok: true });
  }

  if ((req.method === 'PATCH' || req.method === 'DELETE') && sub[0] === 'anchors' && sub[1]) {
    const domain = decodeURIComponent(sub[1]).toLowerCase();
    if (req.method === 'DELETE') {
      await db.query('DELETE FROM tracked_anchors WHERE domain = $1', [domain]);
    } else {
      const body = await readJsonBody(req);
      await db.query(
        'UPDATE tracked_anchors SET active = $2, updated_at = now() WHERE domain = $1',
        [domain, Boolean(body.active)],
      );
    }
    if (context.listTrackedAnchors) {
      return adminJson(res, 200, { ok: true, anchors: await context.listTrackedAnchors(db) });
    }
    return adminJson(res, 200, { ok: true });
  }

  // Dead-letter webhook redelivery (Item 3)
  if (req.method === 'POST' && subPath === 'webhooks/redeliver') {
    const body = await readJsonBody(req).catch(() => ({}));
    const maxAgeHours = body.maxAgeHours ? Number(body.maxAgeHours) : 48;
    const maxPerRun = body.maxPerRun ? Number(body.maxPerRun) : 100;
    const dryRun = Boolean(body.dryRun);

    const result = await redeliverFailedWebhooks(db, { maxAgeHours, maxPerRun, dryRun });
    return adminJson(res, 200, { ok: true, ...result });
  }

  return adminJson(res, 404, { error: `Unknown admin route: /${joined}` });
}
