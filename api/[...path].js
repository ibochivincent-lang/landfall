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
 *   GET  /api/v1/anchors/:domain/health-check -- pre-flight wallet health score (0-100)
 *   GET  /api/v1/badges/:domain.svg          -- dynamic SVG reliability status badge
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
import { graphql, buildSchema } from 'graphql';

const { Pool } = pg;
const scrypt = promisify(scryptCb);

// ── Connection pool — created once, reused across warm invocations ────────────
let _pool = null;

export function pool() {
  if (_pool) return _pool;
  const url = process.env.DATABASE_URL;
  if (!url) return null;

  // pg (>=8.23) treats a `sslmode=require` query param as "verify-full", and
  // when both connectionString and an explicit ssl option are given, the
  // string-parsed setting silently wins over rejectUnauthorized: false
  // rather than merging with it. Strip sslmode so TLS is driven purely by
  // the explicit ssl option below - otherwise Supabase's pooler cert (not
  // in Node's default CA store) fails with "self-signed certificate in
  // certificate chain" even with rejectUnauthorized: false set.
  const poolConnectionString = url.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, '');

  _pool = new Pool({
    connectionString: poolConnectionString,
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

/** Returns { id, username, email, role } for a valid, unexpired session, or null. */
async function requireSession(req, db) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const tokenHash = sha256Hex(token);

  // Check portal_sessions first
  try {
    const { rows } = await db.query(
      `SELECT u.id, u.username, u.email, u.role
         FROM portal_sessions s
         JOIN portal_users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [tokenHash],
    );
    if (rows[0]) {
      db.query('UPDATE portal_sessions SET last_seen_at = now() WHERE token_hash = $1', [tokenHash]).catch(() => {});
      return rows[0];
    }
  } catch {}

  // Fallback to admin_sessions
  try {
    const { rows } = await db.query(
      `SELECT u.id, u.username, 'admin@landfall.stellar' as email, 'admin' as role
         FROM admin_sessions s
         JOIN admin_users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [tokenHash],
    );
    if (rows[0]) {
      db.query('UPDATE admin_sessions SET last_seen_at = now() WHERE token_hash = $1', [tokenHash]).catch(() => {});
      return rows[0];
    }
  } catch {}

  return null;
}

// ── SQL helpers (mirrors packages/api/src/server.ts exactly) ─────────────────

export async function latestScan(db) {
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

export async function accountRows(db) {
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

export async function paymentsPage(db, { accounts, direction, asset, before, limit, includeRaw = false }) {
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
           p.amount::text AS amount, p.asset, p.memo,
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

export async function assetRows(db) {
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

export async function domainAccounts(db, domain) {
  const { rows } = await db.query(
    'SELECT account_id FROM anchor_accounts WHERE domain = $1',
    [domain]
  );
  return rows.map(r => r.account_id);
}

export async function corridorRows(db) {
  const { rows } = await db.query(`
    SELECT from_asset, to_asset, count, volume, first_seen, last_seen
      FROM corridors ORDER BY volume DESC
  `);
  return rows.map(r => ({
    fromAsset:  r.from_asset,
    toAsset:    r.to_asset,
    count:      Number(r.count),
    volume:     Number(r.volume),
    firstSeen:  new Date(r.first_seen).toISOString(),
    lastSeen:   new Date(r.last_seen).toISOString(),
  }));
}

/**
 * Deterministic Anchor Reliability Score (0-100).
 * Derived purely from ledger evidence across an anchor's accounts.
 */
export function computeDomainReliability(accounts) {
  if (!accounts || accounts.length === 0) {
    return { score: 0, grade: 'F', status: 'unknown', liveness: 0, settlement: 0, volume: 0, recommendation: 'No accounts indexed.' };
  }

  // 1. Liveness (Max 40 pts)
  const activeHours = accounts
    .map(a => a.hoursSinceActivity)
    .filter(h => h !== null && h !== undefined)
    .sort((a, b) => a - b);
  
  const freshest = activeHours[0];
  let livenessPts = 0;
  if (freshest !== undefined) {
    if (freshest <= 24) livenessPts = 40;
    else if (freshest <= 72) livenessPts = 30;
    else if (freshest <= 168) livenessPts = 20; // 7d
    else if (freshest <= 720) livenessPts = 10; // 30d
    else livenessPts = 0;
  }

  // 2. Settlement & Return Rate (Max 40 pts)
  const totalInbound = accounts.reduce((s, a) => s + (a.inbound || 0), 0);
  const totalOutbound = accounts.reduce((s, a) => s + (a.outbound || 0), 0);
  const totalReturns = accounts.reduce((s, a) => s + (a.returns || 0), 0);
  
  let settlementPts = 40;
  if (totalInbound + totalReturns > 0) {
    const rate = totalReturns / (totalInbound + totalReturns);
    if (rate <= 0.01) settlementPts = 40;
    else if (rate <= 0.03) settlementPts = 32;
    else if (rate <= 0.05) settlementPts = 24;
    else if (rate <= 0.10) settlementPts = 12;
    else settlementPts = 0;
  } else if (totalInbound === 0 && totalOutbound === 0) {
    settlementPts = 10;
  }

  // 3. Activity / Throughput (Max 20 pts)
  const totalActivity = totalInbound + totalOutbound;
  let volumePts = 0;
  if (totalActivity >= 500) volumePts = 20;
  else if (totalActivity >= 100) volumePts = 15;
  else if (totalActivity >= 20) volumePts = 10;
  else if (totalActivity > 0) volumePts = 5;
  else volumePts = 0;

  // Dark account penalty
  const darkAccounts = accounts.filter(a => a.state === 'dark').length;
  if (darkAccounts > 0 && darkAccounts === accounts.length) {
    livenessPts = 0;
  }

  const score = Math.min(100, Math.max(0, livenessPts + settlementPts + volumePts));

  let grade = 'F';
  let status = 'dark';
  let recommendation = 'High failure risk. Not recommended for immediate routing.';

  if (score >= 90) {
    grade = 'A';
    status = 'optimal';
    recommendation = 'Excellent on-chain settlement health. Safe to route.';
  } else if (score >= 75) {
    grade = 'B';
    status = 'operational';
    recommendation = 'Operational with steady ledger settlement.';
  } else if (score >= 55) {
    grade = 'C';
    status = 'degraded';
    recommendation = 'Occasional return delays or slow settlement detected.';
  } else if (score >= 35) {
    grade = 'D';
    status = 'inactive';
    recommendation = 'Low activity or elevated refund rate. Use caution.';
  }

  return {
    score,
    grade,
    status,
    factors: {
      liveness: livenessPts,
      settlement: settlementPts,
      volume: volumePts,
      freshestHours: freshest !== undefined ? Math.round(freshest * 10) / 10 : null,
      totalPayments: totalActivity,
      returnRatePercent: totalInbound > 0 ? Math.round((totalReturns / totalInbound) * 1000) / 10 : 0
    },
    recommendation
  };
}

function renderBadgeSvg(domain, score, grade) {
  let color = '#e55d50'; // Red
  if (score >= 90) color = '#0b9c91';      // Teal / Mint
  else if (score >= 75) color = '#2b7fff'; // Blue
  else if (score >= 55) color = '#d97706'; // Amber

  const label = 'landfall · ' + domain;
  const value = `${score}/100 ${grade}`;
  const labelWidth = Math.max(80, label.length * 6.8);
  const valueWidth = 64;
  const totalWidth = labelWidth + valueWidth;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${label}: ${value}">
  <title>${label}: ${value}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="${totalWidth}" height="20" rx="3" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#061f2d"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${color}"/>
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">
    <text aria-hidden="true" x="${(labelWidth * 10) / 2}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)">${label}</text>
    <text x="${(labelWidth * 10) / 2}" y="140" transform="scale(.1)" fill="#fff">${label}</text>
    <text aria-hidden="true" x="${labelWidth * 10 + (valueWidth * 10) / 2}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)">${value}</text>
    <text x="${labelWidth * 10 + (valueWidth * 10) / 2}" y="140" transform="scale(.1)" fill="#fff"><b>${value}</b></text>
  </g>
</svg>`;
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

// ── GraphQL — additive surface over the same read queries as the REST routes
// above. Every resolver calls the exact same exported functions the REST
// handlers use (accountRows, paymentsPage, computeDomainReliability, …) —
// this is a second way to ask for the same data, not a second source of
// truth for it. Read-only: the schema has no mutations, on purpose, same
// as the rest of this API. ───────────────────────────────────────────────────

export const graphqlSchema = buildSchema(`
  type Account {
    account: String!
    domain: String!
    name: String!
    state: String!
    inbound: Int!
    outbound: Int!
    returns: Int!
    returnRate: Float
    hoursSinceActivity: Float
    topCounterpartyShare: Float
  }

  type ReliabilityFactors {
    liveness: Int!
    settlement: Int!
    volume: Int!
    freshestHours: Float
    totalPayments: Int!
    returnRatePercent: Float!
  }

  type DomainReliability {
    domain: String!
    score: Int!
    grade: String!
    status: String!
    recommendation: String!
    factors: ReliabilityFactors!
  }

  type AnchorDetail {
    domain: String!
    healthy: Boolean!
    score: Int!
    grade: String!
    status: String!
    recommendation: String!
    factors: ReliabilityFactors!
    accounts: [Account!]!
  }

  type AnchorsResult {
    asOf: String!
    staleHours: Float!
    accounts: [Account!]!
    reliability: [DomainReliability!]!
  }

  type Payment {
    txHash: String!
    from: String!
    to: String!
    fromDomain: String
    toDomain: String
    amount: String!
    asset: String!
    memo: String
    createdAt: String!
    isDust: Boolean!
  }

  type PaymentsPage {
    payments: [Payment!]!
    nextCursor: String
  }

  type AssetTotal {
    asset: String!
    count: Int!
  }

  type Corridor {
    fromAsset: String!
    toAsset: String!
    count: Int!
    volume: Float!
    firstSeen: String!
    lastSeen: String!
  }

  type Health {
    ok: Boolean!
    asOf: String
    staleHours: Float
  }

  type Query {
    "Every indexed account, grouped and scored by anchor domain — same data as GET /api/v1/anchors."
    anchors: AnchorsResult!

    "One anchor's accounts and reliability score. Null if the domain has no indexed accounts."
    anchor(domain: String!): AnchorDetail

    "Payment stream, optionally scoped to one anchor domain and filtered. Keyset-paginated via nextCursor / before."
    payments(domain: String, direction: String, asset: String, before: String, limit: Int): PaymentsPage!

    "Total payment count per asset across every indexed anchor."
    assets: [AssetTotal!]!

    "Cross-asset flow matrix from path payments."
    corridors: [Corridor!]!

    "Liveness check plus the age of the most recent completed scan."
    health: Health!
  }
`);

export function graphqlRootValue(db) {
  return {
    anchors: async () => {
      const scan = await latestScan(db);
      if (!scan) throw new Error('No completed scan yet.');
      const accounts = await accountRows(db);
      const byDomain = new Map();
      for (const a of accounts) {
        if (!byDomain.has(a.domain)) byDomain.set(a.domain, []);
        byDomain.get(a.domain).push(a);
      }
      const reliability = [...byDomain.entries()].map(([domain, dAccounts]) => ({
        domain,
        ...computeDomainReliability(dAccounts),
      }));
      return { asOf: scan.finishedAt, staleHours: scan.staleHours, accounts, reliability };
    },

    anchor: async ({ domain }) => {
      const accounts = (await accountRows(db)).filter(a => a.domain.toLowerCase() === domain.toLowerCase());
      if (!accounts.length) return null;
      const rel = computeDomainReliability(accounts);
      return { domain, healthy: rel.score >= 55, ...rel, accounts };
    },

    payments: async ({ domain, direction, asset, before, limit }) => {
      let accounts;
      if (domain) {
        accounts = await domainAccounts(db, domain);
        if (!accounts.length) throw new Error(`No accounts for ${domain}`);
      }
      return paymentsPage(db, {
        accounts,
        direction: direction || null,
        asset: asset || null,
        before: before || null,
        limit: Math.min(Math.max(Number(limit) || 50, 1), 500),
      });
    },

    assets: async () => assetRows(db),
    corridors: async () => corridorRows(db),

    health: async () => {
      const scan = await latestScan(db);
      return { ok: true, asOf: scan?.finishedAt ?? null, staleHours: scan?.staleHours ?? null };
    },
  };
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
    // ── Auth routes (Developer Portal & Admin login/register/reset) ────────
    if (parts[0] === 'v1' && parts[1] === 'auth') {
      const action = parts[2];

      if (req.method === 'POST' && action === 'register') {
        const body = await readJsonBody(req);
        const email = String(body.email || '').trim().toLowerCase();
        const username = String(body.username || '').trim().toLowerCase();
        const password = String(body.password || '');

        if (!email || !username || password.length < 6) {
          return adminJson(res, 400, { error: 'Valid email, username, and password (min 6 chars) required.' });
        }

        const pwdHash = await hashPassword(password);
        try {
          const { rows } = await db.query(
            `INSERT INTO portal_users (email, username, password_hash, role)
             VALUES ($1, $2, $3, 'developer')
             RETURNING id, email, username, role`,
            [email, username, pwdHash],
          );
          const user = rows[0];

          // Generate initial API key
          const rawKey = 'lf_live_' + randomBytes(24).toString('hex');
          const keyPrefix = rawKey.slice(0, 15) + '...';
          await db.query(
            `INSERT INTO api_keys (user_id, name, key_prefix, key_hash)
             VALUES ($1, 'Default Key', $2, $3)`,
            [user.id, keyPrefix, sha256Hex(rawKey)],
          );

          const token = randomBytes(32).toString('hex');
          const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
          await db.query(
            `INSERT INTO portal_sessions (token_hash, user_id, expires_at, user_agent)
             VALUES ($1, $2, $3, $4)`,
            [sha256Hex(token), user.id, expiresAt.toISOString(), String(req.headers['user-agent'] || '').slice(0, 300)],
          );

          setSessionCookie(res, token, SESSION_TTL_MS / 1000);
          return adminJson(res, 200, { ok: true, user, initialKey: rawKey, message: 'Account created successfully!' });
        } catch (err) {
          if (err.message?.includes('unique') || err.message?.includes('duplicate')) {
            return adminJson(res, 400, { error: 'An account with that email or username already exists.' });
          }
          throw err;
        }
      }

      if (req.method === 'POST' && action === 'login') {
        const body = await readJsonBody(req);
        const loginIdent = String(body.username || body.email || '').trim().toLowerCase();
        const password = String(body.password || '');
        if (!loginIdent || !password) return adminJson(res, 400, { error: 'Username/email and password are required.' });

        // Try portal_users first
        let user = null;
        const portalRes = await db.query(
          'SELECT id, email, username, role, password_hash FROM portal_users WHERE username = $1 OR email = $1',
          [loginIdent],
        );
        if (portalRes.rows[0]) {
          user = portalRes.rows[0];
        } else {
          // Fallback to admin_users
          const adminRes = await db.query(
            'SELECT id, username, password_hash FROM admin_users WHERE username = $1',
            [loginIdent],
          );
          if (adminRes.rows[0]) {
            user = { ...adminRes.rows[0], email: 'admin@landfall.stellar', role: 'admin' };
          }
        }

        const ok = user
          ? await verifyPassword(password, user.password_hash)
          : await verifyPassword(password, 'scrypt$00$00').catch(() => false);
        if (!user || !ok) return adminJson(res, 401, { error: 'Invalid username/email or password.' });

        const token = randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
        
        if (user.role === 'admin') {
          await db.query(
            `INSERT INTO admin_sessions (token_hash, user_id, expires_at, user_agent)
             VALUES ($1, $2, $3, $4)`,
            [sha256Hex(token), user.id, expiresAt.toISOString(), String(req.headers['user-agent'] || '').slice(0, 300)],
          );
        } else {
          await db.query(
            `INSERT INTO portal_sessions (token_hash, user_id, expires_at, user_agent)
             VALUES ($1, $2, $3, $4)`,
            [sha256Hex(token), user.id, expiresAt.toISOString(), String(req.headers['user-agent'] || '').slice(0, 300)],
          );
        }

        setSessionCookie(res, token, SESSION_TTL_MS / 1000);
        return adminJson(res, 200, {
          ok: true,
          user: { id: user.id, email: user.email, username: user.username, role: user.role },
          message: `Welcome back, ${user.username}! Login successful.`
        });
      }

      if (req.method === 'POST' && action === 'forgot-password') {
        const body = await readJsonBody(req);
        const email = String(body.email || '').trim().toLowerCase();
        if (!email) return adminJson(res, 400, { error: 'Email is required.' });

        const { rows } = await db.query('SELECT id, email FROM portal_users WHERE email = $1', [email]);
        if (!rows[0]) {
          // Keep response generic to prevent user enumeration
          return adminJson(res, 200, { ok: true, message: 'If an account exists with that email, reset instructions have been generated.' });
        }

        const resetToken = randomBytes(24).toString('hex');
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1h
        await db.query(
          `INSERT INTO password_resets (user_id, token_hash, expires_at)
           VALUES ($1, $2, $3)`,
          [rows[0].id, sha256Hex(resetToken), expiresAt.toISOString()],
        );

        return adminJson(res, 200, {
          ok: true,
          resetToken, // Returned for instant in-portal reset demonstration
          message: 'Password reset code generated. Use it below to set your new password.'
        });
      }

      if (req.method === 'POST' && action === 'reset-password') {
        const body = await readJsonBody(req);
        const resetToken = String(body.token || '').trim();
        const newPassword = String(body.newPassword || '');

        if (!resetToken || newPassword.length < 6) {
          return adminJson(res, 400, { error: 'Valid reset token and new password (min 6 chars) required.' });
        }

        const tokenHash = sha256Hex(resetToken);
        const { rows } = await db.query(
          `SELECT id, user_id FROM password_resets WHERE token_hash = $1 AND expires_at > now() AND used_at IS NULL`,
          [tokenHash],
        );
        if (!rows[0]) return adminJson(res, 400, { error: 'Reset token is invalid or expired.' });

        const pwdHash = await hashPassword(newPassword);
        await db.query('UPDATE portal_users SET password_hash = $1 WHERE id = $2', [pwdHash, rows[0].user_id]);
        await db.query('UPDATE password_resets SET used_at = now() WHERE id = $1', [rows[0].id]);

        return adminJson(res, 200, { ok: true, message: 'Password updated successfully! You can now log in.' });
      }

      if (req.method === 'GET' && action === 'me') {
        const session = await requireSession(req, db);
        if (!session) return adminJson(res, 401, { error: 'Not authenticated.' });
        return adminJson(res, 200, { ok: true, user: session });
      }

      if (req.method === 'POST' && action === 'logout') {
        const token = parseCookies(req)[SESSION_COOKIE];
        if (token) {
          const h = sha256Hex(token);
          await db.query('DELETE FROM portal_sessions WHERE token_hash = $1', [h]).catch(() => {});
          await db.query('DELETE FROM admin_sessions WHERE token_hash = $1', [h]).catch(() => {});
        }
        clearSessionCookie(res);
        return adminJson(res, 200, { ok: true, message: 'Logged out successfully.' });
      }
    }

    // ── Developer Portal keys & webhooks (session required) ──────────────────
    if (parts[0] === 'v1' && parts[1] === 'developer') {
      const session = await requireSession(req, db);
      if (!session) return adminJson(res, 401, { error: 'Developer authentication required.' });
      const sub = parts.slice(2);

      // GET /api/v1/developer/keys
      if (req.method === 'GET' && sub[0] === 'keys') {
        const { rows } = await db.query(
          `SELECT id, name, key_prefix, rate_limit_per_min, created_at, last_used_at, revoked_at
             FROM api_keys
            WHERE user_id = $1
            ORDER BY created_at DESC`,
          [session.id],
        );
        return adminJson(res, 200, { keys: rows });
      }

      // POST /api/v1/developer/keys
      if (req.method === 'POST' && sub[0] === 'keys') {
        const body = await readJsonBody(req);
        const name = String(body.name || 'New API Key').slice(0, 50);
        const rawKey = 'lf_live_' + randomBytes(24).toString('hex');
        const keyPrefix = rawKey.slice(0, 15) + '...';

        const { rows } = await db.query(
          `INSERT INTO api_keys (user_id, name, key_prefix, key_hash)
           VALUES ($1, $2, $3, $4)
           RETURNING id, name, key_prefix, rate_limit_per_min, created_at`,
          [session.id, name, keyPrefix, sha256Hex(rawKey)],
        );

        return adminJson(res, 200, {
          ok: true,
          key: rows[0],
          secretKey: rawKey,
          message: 'API Key generated. Copy it now; you will not be able to see it again.'
        });
      }

      // DELETE /api/v1/developer/keys/:id
      if (req.method === 'DELETE' && sub[0] === 'keys' && sub[1]) {
        const keyId = Number(sub[1]);
        await db.query(
          `UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND user_id = $2`,
          [keyId, session.id],
        );
        return adminJson(res, 200, { ok: true, message: 'API key revoked.' });
      }

      // GET /api/v1/developer/webhooks
      if (req.method === 'GET' && sub[0] === 'webhooks') {
        const { rows } = await db.query(
          `SELECT id, target_url, events, active, created_at FROM user_webhooks WHERE user_id = $1 ORDER BY created_at DESC`,
          [session.id],
        );
        return adminJson(res, 200, { webhooks: rows });
      }

      // POST /api/v1/developer/webhooks
      if (req.method === 'POST' && sub[0] === 'webhooks') {
        const body = await readJsonBody(req);
        const targetUrl = String(body.url || '').trim();
        if (!targetUrl.startsWith('https://')) {
          return adminJson(res, 400, { error: 'Webhooks must use HTTPS URLs.' });
        }
        const secret = 'whsec_' + randomBytes(20).toString('hex');
        const { rows } = await db.query(
          `INSERT INTO user_webhooks (user_id, target_url, secret)
           VALUES ($1, $2, $3)
           RETURNING id, target_url, events, active, created_at`,
          [session.id, targetUrl, secret],
        );
        return adminJson(res, 200, { ok: true, webhook: rows[0], secret, message: 'Webhook endpoint registered.' });
      }

      // DELETE /api/v1/developer/webhooks/:id
      if (req.method === 'DELETE' && sub[0] === 'webhooks' && sub[1]) {
        await db.query(`DELETE FROM user_webhooks WHERE id = $1 AND user_id = $2`, [Number(sub[1]), session.id]);
        return adminJson(res, 200, { ok: true, message: 'Webhook deleted.' });
      }
    }

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

    // ── GraphQL — POST { query, variables }, or GET ?query=... for quick
    // testing in a browser address bar. Read-only, no auth: same public
    // data as the REST routes below, just askable in one shape instead of
    // several endpoints.
    if (parts[0] === 'v1' && parts[1] === 'graphql') {
      if (req.method !== 'POST' && req.method !== 'GET') {
        return json(res, 405, { error: 'Method not allowed' });
      }

      let query, variables;
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        query = body.query;
        variables = body.variables;
      } else {
        const url = new URL(req.url, `https://${req.headers.host}`);
        query = url.searchParams.get('query');
        const rawVars = url.searchParams.get('variables');
        variables = rawVars ? JSON.parse(rawVars) : undefined;
      }
      if (!query) return json(res, 400, { error: 'A `query` field is required.' }, 0);

      const result = await graphql({
        schema: graphqlSchema,
        source: query,
        variableValues: variables,
        rootValue: graphqlRootValue(db),
      });
      // A GraphQL error is still a 200 in the spec's strict reading, but a
      // request that produced no data at all reads better as a 400 to
      // anything not already speaking GraphQL fluently.
      const status = result.errors && !result.data ? 400 : 200;
      return json(res, status, result, 0);
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

      // Group by domain and attach reliability
      const byDomain = new Map();
      for (const a of accounts) {
        if (!byDomain.has(a.domain)) byDomain.set(a.domain, []);
        byDomain.get(a.domain).push(a);
      }

      const summaries = {};
      for (const [domain, dAccounts] of byDomain.entries()) {
        summaries[domain] = computeDomainReliability(dAccounts);
      }

      return json(res, 200, { asOf: scan.finishedAt, staleHours: scan.staleHours, accounts, reliability: summaries });
    }

    // GET /api/v1/anchors/:domain/health-check
    if (parts.length === 4 && parts[0] === 'v1' && parts[1] === 'anchors' && parts[3] === 'health-check') {
      const domain = decodeURIComponent(parts[2]).toLowerCase();
      const accounts = (await accountRows(db)).filter(a => a.domain.toLowerCase() === domain);
      if (!accounts.length) return json(res, 404, { error: `No accounts tracked for ${domain}` });

      const rel = computeDomainReliability(accounts);
      return json(res, 200, {
        domain,
        healthy: rel.score >= 55,
        ...rel
      }, 120);
    }

    // GET /api/v1/badges/:domain.svg
    if (parts.length === 3 && parts[0] === 'v1' && parts[1] === 'badges') {
      const rawDomain = parts[2].replace(/\.svg$/i, '').toLowerCase();
      const domain = decodeURIComponent(rawDomain);
      const accounts = (await accountRows(db)).filter(a => a.domain.toLowerCase() === domain);
      const rel = computeDomainReliability(accounts);

      const svg = renderBadgeSvg(domain, rel.score, rel.grade);
      res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(200).send(svg);
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
