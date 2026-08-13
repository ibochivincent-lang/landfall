/**
 * Landfall — Vercel serverless function
 *
 * Catches all /api/v1/* requests and serves live data from Supabase.
 * Falls back gracefully with a 503 when DATABASE_URL is not configured,
 * which causes dashboard.js to use the bundled snapshot.json instead.
 *
 * Routes handled:
 *   GET /api/v1/anchors
 *   GET /api/v1/anchors/:domain/payments
 *   GET /api/v1/assets
 *   GET /health
 */

import pg from 'pg';
const { Pool } = pg;

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

async function paymentsPage(db, { accounts, direction, asset, before, limit }) {
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
    SELECT p.id, p.tx_hash, p.from_account, p.to_account,
           p.amount::text AS amount, p.asset, p.memo,
           p.created_at, p.is_dust,
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
      txHash:     r.tx_hash,
      from:       r.from_account,
      to:         r.to_account,
      fromDomain: r.from_domain,
      toDomain:   r.to_domain,
      amount:     r.amount,
      asset:      r.asset,
      memo:       r.memo,
      createdAt:  new Date(r.created_at).toISOString(),
      isDust:     r.is_dust,
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

async function domainAccounts(db, domain) {
  const { rows } = await db.query(
    'SELECT account_id FROM anchor_accounts WHERE domain = $1',
    [domain]
  );
  return rows.map(r => r.account_id);
}

// ── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // Preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    return res.status(204).end();
  }

  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });

  const db = pool();
  if (!db) {
    return json(res, 503, { error: 'DATABASE_URL not configured' }, 0);
  }

  const parts  = Array.isArray(req.query.path) ? req.query.path : (req.query.path || '').split('/').filter(Boolean);
  const joined = parts.join('/');

  try {
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
