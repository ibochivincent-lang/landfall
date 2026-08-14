/**
 * Landfall — Vercel serverless function
 *
 * Catches all /api/v1/* requests and serves live data from Supabase.
 * Falls back gracefully with a 503 when DATABASE_URL is not configured,
 * which causes dashboard.js to use the bundled snapshot.json instead.
 *
 * Public routes handled:
 *   GET  /api/v1/anchors
 *   GET  /api/v1/anchors/:domain/payments
 *   GET  /api/v1/assets
 *   GET  /api/v1/corridors           -- cross-asset flow matrix (path payments)
 *   GET  /health
 *
 * Admin routes (session-cookie gated, see requireSession()):
 *   POST   /api/v1/admin/login
 *   POST   /api/v1/admin/logout
 *   GET    /api/v1/admin/me
 *   GET    /api/v1/admin/health      -- ops board: scans, table sizes, cursors
 *   GET    /api/v1/admin/payments    -- full raw payment browser
 *   GET    /api/v1/admin/anchors     -- tracked_anchors list
 *   POST   /api/v1/admin/anchors     -- add a tracked domain
 *   PATCH  /api/v1/admin/anchors/:domain
 *   DELETE /api/v1/admin/anchors/:domain
 *
 * A previous revision of this file exposed POST /api/v1/chat, which had an
 * LLM translate free-text into SQL and executed it directly against this
 * database with no auth and only a "starts with SELECT" check — an
 * unauthenticated arbitrary-read (and DoS) hole. The front-end for it was
 * removed in fe8a7d8 but the route itself was still live. It is gone here,
 * not just unlinked.
 */

import pg from 'pg';
import { scrypt as scryptCb, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const { Pool } = pg;
const scrypt = promisify(scryptCb);

// ── Connection pool — created once, reused across warm invocations ────────────
let _pool = null;

function pool() {
  if (_pool) return _pool;
  const url = process.env.DATABASE_URL;
  if (!url) return null;

  _pool = new Pool({
    connectionString: url,
    max: 2,                          // stay within Supabase free-tier limits
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 8_000,
    ssl: { rejectUnauthorized: false }, // required for Supabase TLS
  });
  return _pool;
}

// ── CORS / response helpers ───────────────────────────────────────────────────
const ORIGIN = process.env.CORS_ORIGIN || 'https://landfall-ib.vercel.app';

function json(res, status, body, cacheSeconds = 60) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', status === 200 ? `public, s-maxage=${cacheSeconds}` : 'no-store');
  res.status(status).json(body);
}

/**
 * Admin responses never carry Access-Control-Allow-Origin: the admin board is
 * served from this same origin and the session cookie must never be sent
 * cross-site. No ACAO header at all is more restrictive than one naming this
 * origin, and simpler to reason about than getting credentialed CORS right.
 */
function adminJson(res, status, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
  const buffers = [];
  for await (const chunk of req) buffers.push(chunk);
  const raw = Buffer.concat(buffers).toString();
  return raw ? JSON.parse(raw) : {};
}

// ── Auth: password hashing, session tokens, cookies ───────────────────────────
//
// node:crypto only — no new dependency for something security-critical.
// Passwords: scrypt with a random 16-byte salt, stored as `scrypt$salt$hash`.
// Sessions: a random 32-byte token in an httpOnly cookie; only its SHA-256 is
// stored in Postgres, so a leaked DB dump cannot be replayed as a live login.

const SESSION_COOKIE = 'landfall_admin';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, 64)).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hashHex] = parts;
  const computed = await scrypt(password, salt, 64);
  const expected = Buffer.from(hashHex, 'hex');
  if (computed.length !== expected.length) return false;
  return timingSafeEqual(computed, expected);
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function setSessionCookie(res, token, maxAgeSeconds) {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ];
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
}

/** Returns { id, username } for a valid, unexpired session, or null. */
async function requireSession(req, db) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const tokenHash = sha256Hex(token);
  const { rows } = await db.query(
    `SELECT u.id, u.username
       FROM admin_sessions s
       JOIN admin_users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [tokenHash],
  );
  if (!rows[0]) return null;
  // Sliding activity marker — not extending expiry, just recording use, so a
  // stolen-but-unused cookie still dies on schedule.
  db.query('UPDATE admin_sessions SET last_seen_at = now() WHERE token_hash = $1', [tokenHash]).catch(() => {});
  return rows[0];
}

// ── SQL helpers (mirrors packages/api/src/server.ts exactly) ─────────────────

async function latestScan(db) {
  const { rows } = await db.query(`
    SELECT id, finished_at,
           EXTRACT(EPOCH FROM (now() - finished_at)) / 3600 AS stale_hours
      FROM scans
     WHERE finished_at IS NOT NULL
     ORDER BY finished_at DESC
     LIMIT 1
  `);
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    id: Number(r.id),
    finishedAt: new Date(r.finished_at).toISOString(),
    staleHours: Math.round(Number(r.stale_hours) * 100) / 100,
  };
}

async function accountRows(db) {
  const { rows } = await db.query(`
    SELECT account_id, domain, role, org_name, state,
           last_activity_at, hours_since_activity,
           inbound_count, outbound_count, refund_count, refund_rate,
           top_counterparty_share
      FROM current_accounts
     ORDER BY
       CASE state
         WHEN 'dark'        THEN 0
         WHEN 'slow'        THEN 1
         WHEN 'no_activity' THEN 2
         ELSE                    3
       END,
       hours_since_activity DESC NULLS LAST
  `);

  const num = v => (v === null || v === undefined ? null : Number(v));

  return rows.map(r => ({
    account:              r.account_id,
    domain:               r.domain,
    name:                 r.org_name ?? r.domain,
    state:                r.state,
    inbound:              r.inbound_count,
    outbound:             r.outbound_count,
    returns:              r.refund_count,
    returnRate:           num(r.refund_rate),
    hoursSinceActivity:   num(r.hours_since_activity),
    topCounterpartyShare: num(r.top_counterparty_share),
  }));
}

async function paymentsPage(db, { accounts, direction, asset, before, limit, includeRaw = false }) {
  const where  = [];
  const params = [];

  if (accounts && accounts.length > 0) {
    params.push(accounts);
    const i = params.length;
    if (direction === 'in')       where.push(`p.to_account   = ANY($${i})`);
    else if (direction === 'out') where.push(`p.from_account = ANY($${i})`);
    else                          where.push(`(p.to_account = ANY($${i}) OR p.from_account = ANY($${i}))`);
  }

  if (asset)  { params.push(asset);  where.push(`p.asset = $${params.length}`); }
  if (before) { params.push(before); where.push(`p.id    < $${params.length}`); }

  params.push(limit + 1);  // one extra tells us if there's another page
  const sql = `
    SELECT p.id, p.tx_hash, p.op_type, p.from_account, p.to_account,
           p.amount::text AS amount, p.asset, p.source_amount::text AS source_amount, p.source_asset, p.memo,
           p.created_at, p.is_dust, p.source,
           ai.domain AS to_domain, af.domain AS from_domain
      FROM payments p
      LEFT JOIN anchor_accounts ai ON ai.account_id = p.to_account
      LEFT JOIN anchor_accounts af ON af.account_id = p.from_account
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY p.id DESC
     LIMIT $${params.length}
  `;

  const { rows } = await db.query(sql, params);
  const hasMore = rows.length > limit;
  const page    = hasMore ? rows.slice(0, limit) : rows;

  return {
    payments: page.map(r => ({
      ...(includeRaw ? { id: String(r.id), source: r.source, opType: r.op_type } : {}),
      txHash:       r.tx_hash,
      from:         r.from_account,
      to:           r.to_account,
      fromDomain:   r.from_domain,
      toDomain:     r.to_domain,
      amount:       r.amount,
      asset:        r.asset,
      sourceAmount: r.source_amount,
      sourceAsset:  r.source_asset,
      memo:         r.memo,
      createdAt:    new Date(r.created_at).toISOString(),
      isDust:       r.is_dust,
    })),
    nextCursor: hasMore ? String(page[page.length - 1].id) : null,
  };
}

async function assetRows(db) {
  const { rows } = await db.query(`
    SELECT at.asset, SUM(at.count)::int AS count
      FROM asset_totals at
      JOIN scans s ON s.id = at.scan_id
     WHERE s.finished_at IS NOT NULL
     GROUP BY at.asset
     ORDER BY count DESC
  `);
  return rows.map(r => ({ asset: r.asset, count: Number(r.count) }));
}

/**
 * Aggregate cross-asset payment corridors.
 * Groups path payments by source_asset → destination asset, summing count
 * and total delivered volume. Only rows where source_asset differs from
 * the delivered asset are true cross-asset trades.
 */
async function corridorRows(db) {
  const { rows } = await db.query(`
    SELECT
      source_asset                         AS from_asset,
      asset                                AS to_asset,
      COUNT(*)::int                        AS count,
      SUM(amount)::text                    AS volume,
      MIN(created_at)                      AS first_seen,
      MAX(created_at)                      AS last_seen
    FROM payments
    WHERE source_asset IS NOT NULL
      AND source_asset <> asset
    GROUP BY source_asset, asset
    ORDER BY count DESC
    LIMIT 100
  `);
  return rows.map(r => ({
    fromAsset:  r.from_asset,
    toAsset:    r.to_asset,
    count:      r.count,
    volume:     r.volume,
    firstSeen:  new Date(r.first_seen).toISOString(),
    lastSeen:   new Date(r.last_seen).toISOString(),
  }));
}

async function domainAccounts(db, domain) {
  const { rows } = await db.query(
    'SELECT account_id FROM anchor_accounts WHERE domain = $1',
    [domain]
  );
  return rows.map(r => r.account_id);
}

// ── Admin: ops/backend health board ───────────────────────────────────────────

const HEALTH_TABLES = [
  'anchors', 'anchor_accounts', 'payments', 'ledger_events', 'cursors',
  'scans', 'account_metrics', 'refund_pairs', 'attestations',
  'oracle_publications', 'tracked_anchors', 'admin_users',
];

async function adminHealth(db) {
  const started = Date.now();
  const [scanRows, tableCounts, cursorRows, latestScanRow, oracleRow] = await Promise.all([
    db.query(`
      SELECT id, started_at, finished_at, horizon_url, accounts_seen, notes
        FROM scans ORDER BY id DESC LIMIT 10
    `),
    db.query(`
      SELECT relname AS table_name, n_live_tup AS approx_rows
        FROM pg_stat_user_tables
       WHERE schemaname = 'public'
       ORDER BY relname
    `),
    db.query(`
      SELECT stream, key, cursor, updated_at
        FROM cursors ORDER BY updated_at DESC LIMIT 50
    `),
    latestScan(db),
    db.query(`
      SELECT digest, ledger_seq, tx_hash, contract_id, published_at
        FROM oracle_publications ORDER BY published_at DESC LIMIT 1
    `),
  ]);
  const dbLatencyMs = Date.now() - started;

  const countsByTable = {};
  for (const name of HEALTH_TABLES) countsByTable[name] = 0;
  for (const r of tableCounts.rows) countsByTable[r.table_name] = Number(r.approx_rows);

  return {
    dbLatencyMs,
    latestScan: latestScanRow,
    recentScans: scanRows.rows.map(r => ({
      id: Number(r.id),
      startedAt: new Date(r.started_at).toISOString(),
      finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
      horizon: r.horizon_url,
      accountsSeen: r.accounts_seen,
      notes: r.notes,
      status: r.finished_at ? 'finished' : 'running-or-crashed',
    })),
    approxRowCounts: countsByTable,
    resumeCursors: cursorRows.rows.map(r => ({
      stream: r.stream,
      key: r.key,
      cursor: r.cursor,
      updatedAt: new Date(r.updated_at).toISOString(),
    })),
    oracle: oracleRow.rows[0] ? {
      lastDigest: oracleRow.rows[0].digest,
      ledgerSeq: oracleRow.rows[0].ledger_seq ? Number(oracleRow.rows[0].ledger_seq) : null,
      txHash: oracleRow.rows[0].tx_hash,
      contractId: oracleRow.rows[0].contract_id,
      publishedAt: new Date(oracleRow.rows[0].published_at).toISOString(),
    } : null,
  };
}

// ── Admin: tracked-anchor management ──────────────────────────────────────────

async function listTrackedAnchors(db) {
  const { rows } = await db.query(`
    SELECT domain, active, added_by, notes, created_at, updated_at
      FROM tracked_anchors ORDER BY domain
  `);
  return rows.map(r => ({
    domain: r.domain,
    active: r.active,
    addedBy: r.added_by,
    notes: r.notes,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  }));
}

// ── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // Preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  const db = pool();
  if (!db) {
    return json(res, 503, { error: 'DATABASE_URL not configured' }, 0);
  }

  const urlPath = (req.url || '').split('?')[0];
  const stripped = urlPath.replace(/^\/api\//, '');
  const parts  = stripped.split('/').filter(Boolean);
  const joined = parts.join('/');

  try {
    // ── Admin routes ──────────────────────────────────────────────────────
    if (parts[0] === 'v1' && parts[1] === 'admin') {
      const sub = parts.slice(2);

      if (req.method === 'POST' && sub.join('/') === 'login') {
        const body = await readJsonBody(req);
        const username = String(body.username || '').trim().toLowerCase();
        const password = String(body.password || '');
        if (!username || !password) return adminJson(res, 400, { error: 'Username and password are required.' });

        const { rows } = await db.query('SELECT id, password_hash FROM admin_users WHERE username = $1', [username]);
        const user = rows[0];
        // Run verifyPassword against a dummy hash even when the user does not
        // exist, so a login attempt for an unknown username takes the same
        // time as a wrong password for a real one.
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

      if (req.method === 'POST' && sub.join('/') === 'logout') {
        const token = parseCookies(req)[SESSION_COOKIE];
        if (token) await db.query('DELETE FROM admin_sessions WHERE token_hash = $1', [sha256Hex(token)]);
        clearSessionCookie(res);
        return adminJson(res, 200, { ok: true });
      }

      // Everything else under /admin requires a live session.
      const session = await requireSession(req, db);
      if (!session) return adminJson(res, 401, { error: 'Not authenticated.' });

      if (req.method === 'GET' && sub.join('/') === 'me') {
        return adminJson(res, 200, { ok: true, username: session.username });
      }

      if (req.method === 'GET' && sub.join('/') === 'health') {
        return adminJson(res, 200, await adminHealth(db));
      }

      if (req.method === 'GET' && sub.join('/') === 'payments') {
        const url = new URL(req.url, `https://${req.headers.host}`);
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 100), 1), 1000);
        const page = await paymentsPage(db, {
          direction: url.searchParams.get('direction') || null,
          asset: url.searchParams.get('asset') || null,
          before: url.searchParams.get('before') || null,
          limit,
          includeRaw: true,
        });
        return adminJson(res, 200, page);
      }

      if (req.method === 'GET' && sub.join('/') === 'anchors') {
        return adminJson(res, 200, { anchors: await listTrackedAnchors(db) });
      }

      if (req.method === 'POST' && sub.join('/') === 'anchors') {
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
        return adminJson(res, 200, { ok: true, anchors: await listTrackedAnchors(db) });
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
        return adminJson(res, 200, { ok: true, anchors: await listTrackedAnchors(db) });
      }

      return adminJson(res, 404, { error: `Unknown admin route: /${joined}` });
    }

    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });

    // GET /health
    if (joined === 'health' || joined === '') {
      await db.query('SELECT 1');
      return json(res, 200, { ok: true }, 0);
    }

    // GET /api/v1/anchors
    if (joined === 'v1/anchors') {
      const scan = await latestScan(db);
      if (!scan) return json(res, 503, { error: 'No completed scan yet.' }, 0);
      const accounts = await accountRows(db);
      return json(res, 200, { asOf: scan.finishedAt, staleHours: scan.staleHours, accounts });
    }

    // GET /api/v1/assets
    if (joined === 'v1/assets') {
      return json(res, 200, { assets: await assetRows(db) });
    }

    // GET /api/v1/corridors
    if (joined === 'v1/corridors') {
      const corridors = await corridorRows(db);
      return json(res, 200, { corridors }, 300);
    }

    // GET /api/v1/anchors/:domain/payments
    if (parts.length === 4 && parts[0] === 'v1' && parts[1] === 'anchors' && parts[3] === 'payments') {
      const domain    = decodeURIComponent(parts[2]);
      const url       = new URL(req.url, `https://${req.headers.host}`);
      const limit     = Math.min(Math.max(Number(url.searchParams.get('limit') || 50), 1), 500);
      const direction = url.searchParams.get('direction') || null;
      const asset     = url.searchParams.get('asset')     || null;
      const before    = url.searchParams.get('before')    || null;

      const accounts = await domainAccounts(db, domain);
      if (!accounts.length) return json(res, 404, { error: `No accounts for ${domain}` });

      return json(res, 200, await paymentsPage(db, { accounts, direction, asset, before, limit }));
    }

    return json(res, 404, { error: `Unknown route: /api/${joined}` });

  } catch (err) {
    console.error('[landfall-api]', err.message);
    return json(res, 500, { error: err.message }, 0);
  }
}
