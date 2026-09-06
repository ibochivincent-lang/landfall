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
*   POST /api/v1/fiat-confirmations  -- recipient self-report that a fiat leg landed (DERIVED evidence input)
*   GET  /api/v1/fiat-confirmations/:chain/:reference -- status of one confirmation, if any
*   GET  /api/v1/trust-check?address=G...|txHash -- ledger-only counterparty risk signals, no DB needed
*   POST /api/v1/intent             -- Intent + Route Engine: rank routes, return an executable plan
*   POST /api/v1/fraud-reports      -- file an evidence-anchored report about an address
*   GET  /api/v1/fraud-reports/:subject -- reports filed about one address, with disclaimer attached
*   POST /api/v1/fraud-reports/:id/dispute -- reported party responds, gated on a signature from that address
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
import { scrypt as scryptCb, randomBytes, timingSafeEqual, createHash, createPublicKey, verify as ed25519Verify } from 'node:crypto';
import { promisify } from 'node:util';
import { assertPublicHostname } from './_lib/net-guard.js';
import { sendEmail } from './_lib/email.js';
import { graphql, buildSchema } from 'graphql';
// Side-effect import: packages/web/intent.js is a plain script that assigns
// its API to globalThis. Imported rather than mirrored a third time — the
// browser already ships that exact file, and packages/intents/test/parity.test.ts
// holds it to the TypeScript package, so importing it here means the Intent
// Engine's arithmetic exists in one plain-JS place rather than two that can
// disagree. See that file's header.
import { LandfallIntent } from './_lib/intent-bridge.js';

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
const ORIGIN = process.env.CORS_ORIGIN || '*';

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

// ── Rate limiting & password policy ───────────────────────────────────────────
//
// Fixed 60-second-window counters in Postgres (rate_limit_counters, added by
// migration 006) — reused for per-IP auth-endpoint throttling, per-API-key
// elevated limits on the public reads, and anonymous fallback throttling.
// No Redis: this project already pays for one Postgres connection, and the
// counter table is small and self-pruning (see rateLimit() below).

const COMMON_PASSWORDS = new Set([
  'password', 'password1', '123456789', '12345678', 'qwerty123',
  'letmein123', 'welcome123', 'password123', 'abcdefgh12', 'iloveyou12',
  'admin12345', 'passw0rd12', 'trustno1ab', 'monkey12345', 'dragon12345',
  'football12', 'baseball12', 'sunshine12', 'princess12', 'superman12',
]);

function isWeakPassword(pw) {
  return pw.length < 10 || COMMON_PASSWORDS.has(pw.toLowerCase());
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * Upserts a fixed 60-second-window counter and returns whether this call is
 * still within `limitPerMinute`. Opportunistically prunes rows older than an
 * hour on ~2% of calls rather than running a dedicated cleanup job.
 */
async function rateLimit(db, bucketKey, limitPerMinute) {
  const { rows } = await db.query(
    `INSERT INTO rate_limit_counters (bucket_key, window_start, count)
     VALUES ($1, date_trunc('minute', now()), 1)
     ON CONFLICT (bucket_key, window_start)
     DO UPDATE SET count = rate_limit_counters.count + 1
     RETURNING count`,
    [bucketKey],
  );
  if (Math.random() < 0.02) {
    db.query(`DELETE FROM rate_limit_counters WHERE window_start < now() - interval '1 hour'`).catch(() => {});
  }
  const count = rows[0]?.count ?? 1;
  return { allowed: count <= limitPerMinute, count };
}

/**
 * Convenience wrapper for the auth-ish routes (login, register, password
 * reset, admin login, contact). Sends the 429 itself; callers do
 * `if (await enforceAuthRateLimit(...)) return;` as their first line.
 */
async function enforceAuthRateLimit(req, res, db, routeName, limit = 10) {
  const bucket = `auth:${routeName}:${clientIp(req)}`;
  const { allowed } = await rateLimit(db, bucket, limit);
  if (!allowed) {
    adminJson(res, 429, { error: 'Too many attempts. Try again in a minute.' });
    return true;
  }
  return false;
}

/** Looks up a presented x-api-key against api_keys. Returns null if absent/invalid/revoked. */
async function apiKeyContext(req, db) {
  const key = req.headers['x-api-key'];
  if (!key || typeof key !== 'string') return null;
  const { rows } = await db.query(
    `SELECT id, rate_limit_per_min FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL`,
    [sha256Hex(key)],
  );
  if (!rows[0]) return null;
  db.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [rows[0].id]).catch(() => {});
  return { keyId: rows[0].id, limitPerMinute: rows[0].rate_limit_per_min };
}

const ANONYMOUS_READ_LIMIT_PER_MIN = 30;

/**
 * Gate for the six public v1/* read routes. A valid API key raises the limit
 * to that key's own rate_limit_per_min (finally making key generation do
 * something real instead of being decorative); no key, or an invalid one,
 * falls back to a conservative anonymous limit. Reads stay public either
 * way — this only ever changes the *rate*, never whether the request is
 * served, matching this project's no-login-wall public-API framing.
 */
async function enforcePublicReadRateLimit(req, res, db) {
  const ctx = await apiKeyContext(req, db);
  const bucket = ctx ? `apikey:${ctx.keyId}` : `anon:${clientIp(req)}`;
  const limit = ctx ? ctx.limitPerMinute : ANONYMOUS_READ_LIMIT_PER_MIN;
  const { allowed } = await rateLimit(db, bucket, limit);
  if (!allowed) {
    json(res, 429, { error: 'Rate limit exceeded.' }, 0);
    return true;
  }
  return false;
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
 * Recipient-confirmation evaluation — a plain-JS mirror of
 * evaluateConfirmation() in packages/adapters/src/fiatConfirmation.ts.
 *
 * This file has no build step (vercel.json runs `npm install` only, no
 * tsc), so the TypeScript package cannot be imported here at runtime. Two
 * copies of the same eligibility rules is a real drift hazard — the same
 * one packages/web/intent.js has against packages/intents/src/solve.ts —
 * so it gets the same treatment: api/fiat-confirmation.test.mjs imports
 * both this function and the real TypeScript module, runs a shared fixture
 * set through each, and fails on any disagreement. Change the rule in one
 * place, the test names the other.
 *
 * See fiatConfirmation.ts for why each of these checks exists — the short
 * version: this is the weakest of three ways to prove a DERIVED-tier
 * transfer's fiat leg landed, and the only one that needs no counterparty.
 * What keeps it from being worthless is narrow: an exact reference match,
 * "recipient" never "sender", a bounded window timed by this function's
 * caller (never the client), and (enforced at the storage layer by
 * migrations/008_fiat_confirmations.sql, not here) exactly one confirmation
 * per transfer, ever.
 */
export function evaluateFiatConfirmation(claim, transfer, opts = {}) {
  if (claim.reference !== transfer.reference) {
    return { ok: false, reason: 'reference-mismatch' };
  }
  if (claim.respondent !== 'recipient') {
    return { ok: false, reason: 'sender-not-binding' };
  }
  if (claim.outcome !== 'received') {
    return { ok: false, reason: 'not-received' };
  }

  const submitted = Date.parse(claim.submittedAt);
  const observed = Date.parse(transfer.observedAt);
  const maxAgeMs = (opts.maxAgeDays ?? 30) * 24 * 60 * 60 * 1000;

  if (submitted < observed) {
    return { ok: false, reason: 'too-early' };
  }
  if (submitted - observed > maxAgeMs) {
    return { ok: false, reason: 'too-late' };
  }

  return {
    ok: true,
    proof: { kind: 'recipient_confirmation', ref: `${claim.chain}:${claim.reference}` },
  };
}

/**
 * Trust Check — a plain-JS mirror of packages/trust-check/src/analyze.ts.
 *
 * Same reason as evaluateFiatConfirmation above: this file has no build
 * step, so the TypeScript package can't be imported here at runtime.
 * packages/trust-check/test/parity.test.ts loads this exact function from
 * the deployed file and runs it against the real package on shared
 * fixtures, so a change to one side that isn't mirrored on this side fails
 * a test rather than shipping silently different numbers.
 *
 * See the TypeScript source for the full reasoning behind every threshold
 * and, in particular, for why there is no "external intelligence" signal
 * here at all — fabricating one would be exactly the failure mode this
 * project exists to catch elsewhere.
 */
const TRUST_CHECK_FORWARD_MATCH_FRACTION = 0.9;
const TRUST_CHECK_FORWARD_WINDOW_MS = 10 * 60 * 1000;
const TRUST_CHECK_SCORE_DEDUCTIONS = { info: 0, warning: 15, high: 30 };

function trustCheckAssessAge(input) {
  if (!input.oldestRetainedPaymentAt) {
    return { oldestRetainedPaymentAt: null, observedDays: null, isLowerBoundOnly: false };
  }
  const days = (Date.parse(input.checkedAt) - Date.parse(input.oldestRetainedPaymentAt)) / 86400000;
  return {
    oldestRetainedPaymentAt: input.oldestRetainedPaymentAt,
    observedDays: Math.max(0, Math.round(days * 10) / 10),
    isLowerBoundOnly: true,
  };
}

function trustCheckAssessConcentration(address, payments) {
  const scale = 10n ** 7n;
  const toFixed = (s) => {
    const [w = '0', f = ''] = String(s).split('.');
    return BigInt(w) * scale + BigInt((f + '0000000').slice(0, 7));
  };

  const perAsset = new Map();
  const counterparties = new Set();

  for (const p of payments) {
    const counterparty = p.from === address ? p.to : p.from;
    if (counterparty === address) continue;
    counterparties.add(counterparty);

    const byCounterparty = perAsset.get(p.asset) ?? new Map();
    byCounterparty.set(counterparty, (byCounterparty.get(counterparty) ?? 0n) + toFixed(p.amount));
    perAsset.set(p.asset, byCounterparty);
  }

  if (counterparties.size === 0) {
    return { topCounterpartyShare: null, topCounterparty: null, distinctCounterparties: 0 };
  }

  let bestShare = -1;
  let bestCounterparty = null;
  for (const byCounterparty of perAsset.values()) {
    let assetTotal = 0n;
    for (const v of byCounterparty.values()) assetTotal += v;
    if (assetTotal === 0n) continue;
    for (const [counterparty, amount] of byCounterparty) {
      const share = Number(amount) / Number(assetTotal);
      if (share > bestShare) {
        bestShare = share;
        bestCounterparty = counterparty;
      }
    }
  }

  return {
    topCounterpartyShare: bestShare < 0 ? null : bestShare,
    topCounterparty: bestCounterparty,
    distinctCounterparties: counterparties.size,
  };
}

function trustCheckAssessForwarding(address, payments) {
  const inbound = payments.filter((p) => p.to === address && p.from !== address);
  const outbound = payments.filter((p) => p.from === address && p.to !== address);
  const usedOutbound = new Set();

  let fastForwarded = 0;
  for (const inPay of inbound) {
    const inAt = Date.parse(inPay.createdAt);
    const inAmt = Number(inPay.amount);
    if (!Number.isFinite(inAmt) || inAmt <= 0) continue;

    const matchIdx = outbound.findIndex((outPay, idx) => {
      if (usedOutbound.has(idx)) return false;
      if (outPay.asset !== inPay.asset) return false;
      if (outPay.to === inPay.from) return false;
      const outAt = Date.parse(outPay.createdAt);
      if (outAt < inAt || outAt - inAt > TRUST_CHECK_FORWARD_WINDOW_MS) return false;
      const outAmt = Number(outPay.amount);
      return Number.isFinite(outAmt) && outAmt >= inAmt * TRUST_CHECK_FORWARD_MATCH_FRACTION;
    });

    if (matchIdx !== -1) {
      usedOutbound.add(matchIdx);
      fastForwarded++;
    }
  }

  return {
    fastForwardedCount: fastForwarded,
    inboundCount: inbound.length,
    fastForwardedFraction: inbound.length > 0 ? fastForwarded / inbound.length : null,
  };
}

function trustCheckBuildFlags(age, concentration, forwarding, paymentCount) {
  const flags = [];

  if (age.observedDays !== null && age.observedDays < 7 && paymentCount >= 10) {
    flags.push({
      id: 'new-with-high-volume',
      severity: 'warning',
      summary: `Observed history reaches back only ${age.observedDays} day(s), with ${paymentCount} payment(s) in that time.`,
      detail:
        'A short observed history with a lot of activity is not itself wrong — a busy new service looks the same as this. ' +
        'It means there is little track record to judge, not that something is wrong.',
      evidenceTxHashes: [],
    });
  }

  if (forwarding.inboundCount >= 3 && forwarding.fastForwardedFraction !== null && forwarding.fastForwardedFraction >= 0.5) {
    flags.push({
      id: 'pass-through-pattern',
      severity: 'high',
      summary: `${forwarding.fastForwardedCount} of ${forwarding.inboundCount} inbound payments were forwarded onward within ${TRUST_CHECK_FORWARD_WINDOW_MS / 60000} minutes.`,
      detail:
        'This is a ledger fact, not a conclusion about intent: this pattern is consistent with a pass-through account — ' +
        'automated forwarding, a custodial hot wallet, or a sweep service all look identical on-chain to this. ' +
        'It does not by itself establish fraud, and should not be read as an accusation.',
      evidenceTxHashes: [],
    });
  }

  if (concentration.topCounterpartyShare !== null && concentration.topCounterpartyShare >= 0.8 && paymentCount >= 5) {
    flags.push({
      id: 'high-concentration',
      severity: 'info',
      summary: `${Math.round(concentration.topCounterpartyShare * 100)}% of observed volume moves through a single counterparty.`,
      detail:
        'Concentration alone is common and often benign — a personal wallet paying one merchant repeatedly looks the same. ' +
        'It is informational context for the other signals, not a finding on its own.',
      evidenceTxHashes: [],
    });
  }

  return flags;
}

function trustCheckConfidence(paymentCount) {
  if (paymentCount < 5) return 'low';
  if (paymentCount < 25) return 'medium';
  return 'high';
}

function trustCheckRiskLevel(score, confidence) {
  if (confidence === 'low') return 'unknown';
  if (score >= 70) return 'low';
  if (score >= 40) return 'medium';
  return 'high';
}

function trustCheckRecommendation(level, confidence, paymentCount) {
  if (paymentCount === 0) {
    return 'No observed payment history for this address. There is nothing here to assess either way — treat it with the same caution you would any new counterparty.';
  }
  if (confidence === 'low') {
    return `Only ${paymentCount} observed payment(s) — too little history to draw a conclusion. A low count is not itself a warning sign.`;
  }
  switch (level) {
    case 'low':
      return "No concerning patterns observed in this account's ledger history.";
    case 'medium':
      return 'Some patterns worth reviewing before sending a large amount — see the flags below and the evidence behind each.';
    case 'high':
      return 'Multiple patterns consistent with elevated risk were observed. Review the evidence below before proceeding.';
    default:
      return 'Not enough observed activity to assess.';
  }
}

export function analyzeTrustCheck(input) {
  const age = trustCheckAssessAge(input);
  const concentration = trustCheckAssessConcentration(input.address, input.recentPayments);
  const forwarding = trustCheckAssessForwarding(input.address, input.recentPayments);

  const inboundCount = input.recentPayments.filter((p) => p.to === input.address).length;
  const outboundCount = input.recentPayments.filter((p) => p.from === input.address).length;
  const paymentCount = input.recentPayments.length;

  const flags = trustCheckBuildFlags(age, concentration, forwarding, paymentCount);
  const riskScore = Math.max(0, 100 - flags.reduce((sum, f) => sum + TRUST_CHECK_SCORE_DEDUCTIONS[f.severity], 0));
  const confidence = trustCheckConfidence(paymentCount);
  const riskLevel = trustCheckRiskLevel(riskScore, confidence);

  return {
    address: input.address,
    checkedAt: input.checkedAt,
    age,
    concentration,
    forwarding,
    paymentCount,
    inboundCount,
    outboundCount,
    flags,
    riskScore,
    riskLevel,
    confidence,
    recommendation: trustCheckRecommendation(riskLevel, confidence, paymentCount),
    limits:
      'Computed only from Stellar ledger records Horizon still retains for this address — no external ' +
      'fraud reports, scam lists, or reputation feeds are used, because none exist here that this project ' +
      'can independently verify. "Observed days" is a lower bound: the address may be materially older ' +
      'than that.' +
      (input.recentPaymentsTruncated
        ? ` This address has more payment history than the ${input.recentPayments.length} most recent ` +
          'record(s) inspected here — signals are computed from that recent window, not the full history.'
        : ` All ${input.recentPayments.length} payment record(s) Horizon retains for this address were inspected.`) +
      ' Every flag is a ledger fact, not an accusation — see the detail on each.',
  };
}

/**
 * Fraud Reports — validation mirrored from packages/fraud-reports/src/validate.ts.
 *
 * Same no-build-step reason as the trust-check and fiat-confirmation
 * mirrors above; packages/fraud-reports/test/parity.test.ts holds the two
 * sides together.
 *
 * The one thing this file adds beyond that package is the check the package
 * deliberately cannot do: confirming the cited transaction actually exists
 * on the ledger and actually involves the reported address. That is the
 * whole difference between this and a comment box, so it happens before a
 * row is written, not after.
 */
const FRAUD_NOTE_MAX_LENGTH = 1000;
const FRAUD_CATEGORIES = ['did_not_receive', 'wrong_amount', 'impersonation', 'unauthorized_debit', 'other'];
const FRAUD_G_ADDRESS = /^G[A-Z2-7]{55}$/;
const FRAUD_TX_HASH = /^[0-9a-f]{64}$/i;

export function validateFraudSubmission(draft) {
  const subject = String(draft.subject ?? '').trim();
  const txHash = String(draft.evidenceTxHash ?? '').trim();
  const note = String(draft.note ?? '').trim();
  const category = String(draft.category ?? '').trim();

  if (!FRAUD_G_ADDRESS.test(subject)) {
    return { ok: false, reason: 'invalid-subject', message: 'The reported address must be a Stellar public key (G...).' };
  }
  if (!FRAUD_TX_HASH.test(txHash)) {
    return {
      ok: false,
      reason: 'invalid-tx-hash',
      message:
        'A report must cite a transaction hash (64 hex characters). A report with no on-chain evidence ' +
        'cannot be checked by anyone, including you, so it is not accepted.',
    };
  }
  if (!FRAUD_CATEGORIES.includes(category)) {
    return { ok: false, reason: 'invalid-category', message: `Category must be one of: ${FRAUD_CATEGORIES.join(', ')}.` };
  }
  if (note.length === 0) {
    return { ok: false, reason: 'note-empty', message: 'Describe what happened — a category alone is not a report.' };
  }
  if (note.length > FRAUD_NOTE_MAX_LENGTH) {
    return { ok: false, reason: 'note-too-long', message: `Keep the description under ${FRAUD_NOTE_MAX_LENGTH} characters.` };
  }
  const reporter = String(draft.reporterAddress ?? '').trim();
  if (reporter && reporter === subject) {
    return { ok: false, reason: 'self-report', message: 'An address cannot file a report against itself.' };
  }
  return { ok: true };
}

export function summariseFraudReports(subject, all) {
  const visible = all.filter((r) => r.status !== 'withdrawn' && r.status !== 'rejected');
  const disputed = visible.filter((r) => r.status === 'disputed').length;

  let summary;
  if (visible.length === 0) {
    summary =
      'No reports have been filed about this address. That is not a clean bill of health — it may equally ' +
      'mean nobody affected has found this page.';
  } else {
    const plural = visible.length === 1 ? 'report' : 'reports';
    summary =
      `${visible.length} ${plural} filed by ${visible.length === 1 ? 'someone' : 'people'} claiming to have been ` +
      'affected, each citing a transaction that was checked to exist on-chain and involve this address. ' +
      'The transaction is verified; the claim about what it means is not. ' +
      (disputed > 0
        ? `${disputed} of them ${disputed === 1 ? 'has' : 'have'} a response from the reported party attached.`
        : 'None has been disputed by the reported party.');
  }

  return {
    subject,
    reports: visible,
    total: visible.length,
    disputed,
    summary,
    disclaimer:
      'These are claims by third parties, not findings by Landfall. Landfall verifies only that the cited ' +
      'transaction exists and involves this address — it has no way to establish what was agreed between ' +
      'the parties, and does not try. Report volume is never scored, ranked, or blended into any Landfall ' +
      'figure. If a report about you is wrong, see DISPUTES.md; a response will be attached to it here.',
  };
}

/**
 * Dispute responses — mirror of packages/fraud-reports/src/dispute.ts.
 *
 * A response is the reported party's own words attached to an accusation,
 * so it has to prove it came from whoever controls the reported address.
 * On Stellar the only thing that proves that — with no account, password
 * or identity document — is a signature from the account's own key.
 *
 * Stateless: the signed message carries the report id and its own
 * timestamp, so there is no challenge table to store and expire. Replay is
 * bounded twice: the timestamp must be recent, and a report takes exactly
 * one response, so a captured signature cannot overwrite one already
 * posted.
 *
 * See the TypeScript source for why the human path in DISPUTES.md stays:
 * an anchor whose reported account is a cold issuer key cannot sign a web
 * form, and making this the only route would leave the companies with the
 * best key hygiene least able to answer.
 */
const DISPUTE_WINDOW_MS = 10 * 60 * 1000;
const DISPUTE_NOTE_MAX_LENGTH = 1000;
const STRKEY_BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function strkeyBase32Decode(input) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of input) {
    const idx = STRKEY_BASE32.indexOf(ch);
    if (idx === -1) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Uint8Array.from(out);
}

function strkeyCrc16(bytes) {
  let crc = 0x0000;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc & 0xffff;
}

export function decodeStellarPublicKey(address) {
  if (typeof address !== 'string' || address.length !== 56 || !address.startsWith('G')) return null;
  const decoded = strkeyBase32Decode(address);
  if (!decoded || decoded.length !== 35) return null;
  if (decoded[0] !== 0x30) return null;
  const payload = decoded.subarray(0, 33);
  const expected = decoded[33] | (decoded[34] << 8);
  if (strkeyCrc16(payload) !== expected) return null;
  return decoded.subarray(1, 33);
}

export function disputeMessage(reportId, subject, issuedAt) {
  return [
    'Landfall dispute response',
    `report: ${reportId}`,
    `subject: ${subject}`,
    `issued: ${issuedAt}`,
  ].join('\n');
}

export function verifyDispute(submission, now) {
  const note = String(submission.note ?? '').trim();
  if (note.length === 0) return { ok: false, reason: 'note-empty', message: 'A response needs to say something.' };
  if (note.length > DISPUTE_NOTE_MAX_LENGTH) {
    return { ok: false, reason: 'note-too-long', message: `Keep the response under ${DISPUTE_NOTE_MAX_LENGTH} characters.` };
  }

  const rawKey = decodeStellarPublicKey(String(submission.subject ?? ''));
  if (!rawKey) return { ok: false, reason: 'invalid-subject', message: 'The subject is not a valid Stellar public key.' };

  const issued = Date.parse(submission.issuedAt);
  if (!Number.isFinite(issued)) {
    return { ok: false, reason: 'stale-timestamp', message: 'The signed message carries no readable timestamp.' };
  }
  const drift = now.getTime() - issued;
  if (drift > DISPUTE_WINDOW_MS) {
    return { ok: false, reason: 'stale-timestamp', message: 'That signed response is too old. Sign a fresh one — the window is 10 minutes.' };
  }
  if (drift < -DISPUTE_WINDOW_MS) {
    return { ok: false, reason: 'future-timestamp', message: 'That signed response is dated in the future. Check your system clock.' };
  }

  let signatureBytes;
  try {
    signatureBytes = Buffer.from(String(submission.signature ?? ''), 'base64');
    if (signatureBytes.length !== 64) {
      return { ok: false, reason: 'invalid-signature-encoding', message: 'An Ed25519 signature must be 64 bytes, base64-encoded.' };
    }
  } catch {
    return { ok: false, reason: 'invalid-signature-encoding', message: 'The signature is not valid base64.' };
  }

  const message = Buffer.from(
    disputeMessage(String(submission.reportId), String(submission.subject), String(submission.issuedAt)),
    'utf8',
  );

  let verified = false;
  try {
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(rawKey).toString('base64url') },
      format: 'jwk',
    });
    verified = ed25519Verify(null, message, key, signatureBytes);
  } catch {
    verified = false;
  }

  if (!verified) {
    return {
      ok: false,
      reason: 'signature-mismatch',
      message:
        'That signature does not verify against the reported address. A response has to be signed by the key ' +
        'that controls the account, which is the only thing that makes it more than an anonymous claim.',
    };
  }

  return { ok: true };
}

const TRUST_CHECK_HORIZON = 'https://horizon.stellar.org';
const TRUST_CHECK_MAX_RECORDS = 200;
const TRUST_CHECK_TIMEOUT_MS = 12_000;

/** "CODE:ISSUER" or "native" — mirrors packages/indexer/src/horizon.ts's assetId() for the one field this route needs. */
function trustCheckAssetId(rec) {
  const type = rec.asset_type;
  if (type === 'native' || type === undefined) return 'native';
  const code = rec.asset_code;
  const issuer = rec.asset_issuer;
  if (typeof code === 'string' && typeof issuer === 'string') return `${code}:${issuer}`;
  return typeof code === 'string' ? code : 'unknown';
}

/** Payment-shaped operations only — mirrors packages/indexer/src/horizon.ts's normalise() for the fields this route needs. */
function trustCheckNormalisePayment(rec) {
  const type = String(rec.type ?? '');
  const txHash = String(rec.transaction_hash ?? '');
  const createdAt = String(rec.created_at ?? '');

  if (type === 'create_account') {
    if (typeof rec.funder !== 'string' || typeof rec.account !== 'string') return null;
    return { txHash, from: rec.funder, to: rec.account, amount: String(rec.starting_balance ?? '0'), asset: 'native', createdAt };
  }
  if (type === 'payment' || type.startsWith('path_payment')) {
    if (typeof rec.from !== 'string' || typeof rec.to !== 'string') return null;
    return { txHash, from: rec.from, to: rec.to, amount: String(rec.amount ?? '0'), asset: trustCheckAssetId(rec), createdAt };
  }
  return null;
}

async function trustCheckGetJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TRUST_CHECK_TIMEOUT_MS) });
  if (!res.ok) {
    const err = new Error(`Horizon HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const G_ADDRESS = /^G[A-Z2-7]{55}$/;
const TX_HASH = /^[0-9a-fA-F]{64}$/;

/**
 * Resolves whatever the user pasted to a Stellar account: a G... address is
 * used directly, a transaction hash is resolved to its source account. This
 * is the only place this route makes a guess about intent — everything
 * downstream is a straight ledger read on the resolved address.
 */
async function trustCheckResolveAddress(raw) {
  const value = String(raw ?? '').trim();
  if (G_ADDRESS.test(value)) return value;
  if (TX_HASH.test(value)) {
    const tx = await trustCheckGetJson(`${TRUST_CHECK_HORIZON}/transactions/${value}`);
    if (typeof tx.source_account === 'string') return tx.source_account;
    throw new Error('Could not resolve a source account from that transaction hash.');
  }
  return null;
}

/**
 * Fetches exactly what analyzeTrustCheck needs for one address: the oldest
 * payment Horizon still retains (a lower bound on age — see the "limits"
 * text on every result) and up to TRUST_CHECK_MAX_RECORDS of the most
 * recent activity. Two requests, not a full history walk — this is a
 * live, on-demand check, not a batch scan, and an address with years of
 * heavy activity must answer in seconds, not minutes.
 */
async function trustCheckFetchInput(address, checkedAt) {
  const oldestUrl = `${TRUST_CHECK_HORIZON}/accounts/${address}/payments?order=asc&limit=1`;
  const recentUrl = `${TRUST_CHECK_HORIZON}/accounts/${address}/payments?order=desc&limit=${TRUST_CHECK_MAX_RECORDS}`;

  const [oldestBody, recentBody] = await Promise.all([
    trustCheckGetJson(oldestUrl),
    trustCheckGetJson(recentUrl),
  ]);

  const oldestRecords = (oldestBody._embedded?.records ?? []).map(trustCheckNormalisePayment).filter(Boolean);
  const recentRecords = (recentBody._embedded?.records ?? []).map(trustCheckNormalisePayment).filter(Boolean);

  return {
    address,
    oldestRetainedPaymentAt: oldestRecords[0]?.createdAt ?? null,
    recentPayments: recentRecords,
    // A full page back means there is likely more history this fetch never
    // saw — an exact "is there a next page" check would need a third
    // request, which this route deliberately avoids to stay fast.
    recentPaymentsTruncated: recentRecords.length >= TRUST_CHECK_MAX_RECORDS,
    checkedAt,
  };
}

/**
 * Confirms a fraud report's cited transaction actually exists AND actually
 * involves the address being reported.
 *
 * Without this, "cite a transaction hash" is a formality anyone could
 * satisfy with any random hash, and the report becomes an unfalsifiable
 * accusation with a decorative reference number attached. With it, a report
 * is anchored to something a reader can independently look up — which is
 * the only reason this feature is defensible at all.
 *
 * Checks the transaction's own operations rather than its source account:
 * the reported party is usually the *recipient* of a payment, not the
 * account that signed the transaction.
 */
async function fraudVerifyEvidence(txHash, subject) {
  let ops;
  try {
    ops = await trustCheckGetJson(`${TRUST_CHECK_HORIZON}/transactions/${txHash}/operations?limit=200`);
  } catch (err) {
    if (err.status === 404) {
      return { ok: false, message: 'That transaction does not exist on the Stellar ledger.' };
    }
    throw err;
  }

  const records = ops._embedded?.records ?? [];
  const involved = records.some((rec) => {
    const p = trustCheckNormalisePayment(rec);
    if (p) return p.from === subject || p.to === subject;
    // Non-payment operations still name accounts; a report can legitimately
    // cite one (an impersonation via a data entry or account merge, say).
    return rec.source_account === subject || rec.account === subject || rec.into === subject;
  });

  if (!involved) {
    return {
      ok: false,
      message:
        'That transaction exists, but it does not involve the address being reported. Cite a transaction ' +
        'that the reported address actually took part in.',
    };
  }
  return { ok: true };
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

  const urlPath = (req.url || '').split('?')[0];
  const stripped = urlPath.replace(/^\/api\//, '');
  const parts  = stripped.split('/').filter(Boolean);
  const joined = parts.join('/');

  // GET /api/v1/trust-check?address=G...|txHash
  //
  // Deliberately handled before the DATABASE_URL gate below: this route is
  // a live, stateless read straight from Horizon and never touches this
  // app's own Postgres, so it has no reason to fail just because that
  // database happens to be unreachable.
  if (req.method === 'GET' && joined === 'v1/trust-check') {
    try {
      const url = new URL(req.url, `https://${req.headers.host}`);
      const raw = url.searchParams.get('address') || '';

      const address = await trustCheckResolveAddress(raw);
      if (!address) {
        return json(res, 400, { error: 'address must be a Stellar public key (G...) or a transaction hash.' }, 0);
      }

      const db = pool();
      if (db) {
        const bucket = `trustcheck:${clientIp(req)}`;
        const { allowed } = await rateLimit(db, bucket, 20);
        if (!allowed) return json(res, 429, { error: 'Too many checks. Try again in a minute.' }, 0);
      }

      const input = await trustCheckFetchInput(address, new Date().toISOString());
      return json(res, 200, analyzeTrustCheck(input), 60);
    } catch (err) {
      if (err.status === 404) {
        return json(res, 404, { error: 'That address has no account on the Stellar network.' }, 0);
      }
      console.error('[trust-check]', err.message);
      return json(res, 502, { error: 'Could not reach Horizon to check that address. Try again shortly.' }, 0);
    }
  }

  const db = pool();
  if (!db) {
    return json(res, 503, { error: 'DATABASE_URL not configured' }, 0);
  }

  try {
    // ── Auth routes (Developer Portal & Admin login/register/reset) ────────
    if (parts[0] === 'v1' && parts[1] === 'auth') {
      const action = parts[2];

      if (req.method === 'POST' && action === 'register') {
        if (await enforceAuthRateLimit(req, res, db, 'register')) return;

        const body = await readJsonBody(req);
        const email = String(body.email || '').trim().toLowerCase();
        const username = String(body.username || '').trim().toLowerCase();
        const password = String(body.password || '');

        if (!email || !username || isWeakPassword(password)) {
          return adminJson(res, 400, { error: 'Valid email, username, and password (min 10 chars, not a commonly used password) required.' });
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
        if (await enforceAuthRateLimit(req, res, db, 'login')) return;

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
        if (await enforceAuthRateLimit(req, res, db, 'forgot-password')) return;

        const body = await readJsonBody(req);
        const email = String(body.email || '').trim().toLowerCase();
        if (!email) return adminJson(res, 400, { error: 'Email is required.' });

        // SECURITY: this response must be identical whether or not the
        // account exists, and must never contain the reset token itself.
        // It previously returned resetToken directly in the JSON body with
        // no proof the requester controlled that email address — anyone who
        // could guess or find a registered email got a working password
        // reset for that account, and the "no account" branch used a
        // different message, which let a caller enumerate registered emails
        // even without the token leak. An interim fix (5218da3) closed the
        // leak by logging the token server-side for manual admin relay,
        // since no email sender existed yet. This finishes that follow-up:
        // the token is now actually emailed via Resend, never returned in
        // the response, and both branches share this exact wording.
        const GENERIC_MESSAGE = 'If an account exists with that email, a reset code has been sent to it.';

        const { rows } = await db.query('SELECT id, email FROM portal_users WHERE email = $1', [email]);
        if (!rows[0]) {
          return adminJson(res, 200, { ok: true, message: GENERIC_MESSAGE });
        }

        const resetToken = randomBytes(24).toString('hex');
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1h
        await db.query(
          `INSERT INTO password_resets (user_id, token_hash, expires_at)
           VALUES ($1, $2, $3)`,
          [rows[0].id, sha256Hex(resetToken), expiresAt.toISOString()],
        );

        // Fire-and-forget: not awaited, so response timing doesn't become a
        // side channel that distinguishes "account exists, email in flight"
        // from the not-found branch above. sendEmail() itself logs failures
        // to function logs without changing this response — that keeps the
        // admin-visible fallback the interim fix relied on, now backing a
        // real delivery path instead of being the only path.
        sendEmail({
          to: rows[0].email,
          subject: 'Your Landfall password reset code',
          text: `Your password reset code is: ${resetToken}\n\nPaste this into the "Reset Password" form on the Landfall developer portal. It expires in 1 hour. If you did not request this, ignore this email.`,
          html: `<p>Your password reset code is:</p><p style="font-size:20px;font-weight:bold;letter-spacing:1px">${resetToken}</p><p>Paste this into the "Reset Password" form on the Landfall developer portal. It expires in 1 hour.</p><p>If you did not request this, ignore this email.</p>`,
        }).catch(() => {});

        return adminJson(res, 200, { ok: true, message: GENERIC_MESSAGE });
      }

      if (req.method === 'POST' && action === 'reset-password') {
        if (await enforceAuthRateLimit(req, res, db, 'reset-password')) return;

        const body = await readJsonBody(req);
        const resetToken = String(body.token || '').trim();
        const newPassword = String(body.newPassword || '');

        if (!resetToken || isWeakPassword(newPassword)) {
          return adminJson(res, 400, { error: 'Valid reset token and new password (min 10 chars, not a commonly used password) required.' });
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
        let hostname;
        try {
          hostname = new URL(targetUrl).hostname;
        } catch {
          return adminJson(res, 400, { error: 'Invalid webhook URL.' });
        }
        try {
          // Blocks private/loopback/link-local/cloud-metadata targets (SSRF).
          // Re-checked again immediately before every delivery in
          // scripts/dispatch-webhooks.mjs, since DNS can be repointed after
          // this registration-time check passes.
          await assertPublicHostname(hostname);
        } catch {
          return adminJson(res, 400, { error: 'Webhook target resolves to a blocked network range.' });
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
        if (await enforceAuthRateLimit(req, res, db, 'admin-login')) return;

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

    /* ── Everything below is read-only, with three exceptions ──────────────
       This guard predates the write endpoints and used to be an unqualified
       "GET only", which silently stranded every POST route defined after it:
       fiat-confirmations returned 405 from the day it shipped, and intent
       and fraud-reports joined it. The routes existed, were tested, and were
       unreachable — a 405 on a path the docs advertise looks like a platform
       problem, not a routing bug, which is why it survived.

       Listed explicitly rather than loosened to "allow any POST": the point
       of the guard is that an unrecognised write should be rejected here
       rather than falling through to a 404 that implies the path might work
       with different input. Adding a write route means adding it here too —
       which the test in api/_lib/routes.test.mjs now enforces, so the next
       one cannot be forgotten the way these three were. */
    const POST_ROUTES = new Set(['v1/intent', 'v1/fraud-reports', 'v1/fiat-confirmations']);
    /* Parameterised write paths, which an exact set cannot express. Kept as
       a separate list rather than loosening POST_ROUTES to prefixes: a
       prefix would also admit v1/fraud-reports/anything, and the point of
       this guard is that an unrecognised write is rejected here. */
    const POST_ROUTE_PATTERNS = [/^v1\/fraud-reports\/\d+\/dispute$/];
    const postAllowed = POST_ROUTES.has(joined) || POST_ROUTE_PATTERNS.some((re) => re.test(joined));
    if (req.method !== 'GET' && !(req.method === 'POST' && postAllowed)) {
      return json(res, 405, { error: 'Method not allowed' });
    }

    // GET /health
    if (joined === 'health' || joined === '') {
      await db.query('SELECT 1');
      return json(res, 200, { ok: true }, 0);
    }

    // Public v1/* reads below this point share one rate-limit gate: a valid
    // x-api-key raises the limit to that key's own rate_limit_per_min,
    // otherwise a conservative anonymous default applies. Reads stay public
    // either way (see enforcePublicReadRateLimit's docstring).
    if (joined.startsWith('v1/')) {
      if (await enforcePublicReadRateLimit(req, res, db)) return;
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

    // POST /api/v1/intent
    //
    // The Intent Engine and Route Engine as one call: state the outcome you
    // want, get back every route that can satisfy it — ranked — plus an
    // executable plan for the winner.
    //
    // Commercial terms (rate spread, fees) come from the caller, because
    // Landfall does not own them: they are each anchor's own published
    // figures, which the site republishes at /api/v1/anchor-fees.json and
    // /api/v1/anchor-quotes.json for exactly this purpose.
    //
    // The reliability grade does NOT come from the caller. It is overwritten
    // from this database on every request, whatever the caller sent, because
    // a route-ranking API where the ranked party can supply its own score is
    // not a ranking API. That asymmetry is the point of the endpoint.
    if (req.method === 'POST' && joined === 'v1/intent') {
      if (await enforcePublicReadRateLimit(req, res, db)) return;

      const body = await readJsonBody(req);
      const from = String(body.from || '').trim().toUpperCase();
      const to = String(body.to || '').trim().toUpperCase();
      const basis = body.basis === 'receive' ? 'receive' : 'send';
      const amount = Number(body.amount);
      const midRate = Number(body.midRate);

      if (!from || !to) return json(res, 400, { error: '`from` and `to` are required.' }, 0);
      if (!Number.isFinite(amount) || amount <= 0) return json(res, 400, { error: '`amount` must be a positive number.' }, 0);
      if (!Number.isFinite(midRate) || midRate <= 0) {
        return json(res, 400, {
          error: '`midRate` (mid-market rate, `to` per one `from`) is required. Landfall does not carry an FX feed and will not invent one.',
        }, 0);
      }
      if (!Array.isArray(body.candidates) || body.candidates.length === 0) {
        return json(res, 400, {
          error: '`candidates` must be a non-empty array of routes with their published terms. See /api/v1/anchor-fees.json for the tracked anchors\' own figures.',
        }, 0);
      }
      if (body.candidates.length > 50) {
        return json(res, 400, { error: 'At most 50 candidates per request.' }, 0);
      }

      // Landfall's own grades, keyed by domain — the caller cannot influence these.
      // Grouped in one pass rather than re-filtering the whole account list per
      // domain: at 108 accounts over 27 domains the difference is invisible, but
      // this list only grows.
      const allAccounts = await accountRows(db);
      const accountsByDomain = new Map();
      for (const account of allAccounts) {
        const key = String(account.domain || '').toLowerCase();
        if (!key) continue;
        const bucket = accountsByDomain.get(key);
        if (bucket) bucket.push(account);
        else accountsByDomain.set(key, [account]);
      }
      const gradeByDomain = new Map();
      for (const [key, accounts] of accountsByDomain) {
        gradeByDomain.set(key, computeDomainReliability(accounts));
      }

      const candidates = body.candidates.map((c) => {
        const domain = String(c.domain || '').toLowerCase();
        const rel = gradeByDomain.get(domain);
        return {
          domain: c.domain,
          name: String(c.name || c.domain || 'unknown'),
          rateSpread: Number.isFinite(Number(c.rateSpread)) ? Number(c.rateSpread) : 1,
          feePercent: Number.isFinite(Number(c.feePercent)) ? Number(c.feePercent) : 0,
          feeFixed: Number.isFinite(Number(c.feeFixed)) ? Number(c.feeFixed) : 0,
          feeSource: c.feeSource === 'live' || c.feeSource === 'catalog' ? c.feeSource : null,
          // Overwritten, never merged — see the note above this route.
          grade: rel ? rel.grade : 'U',
          score: rel ? rel.score : null,
          liquidityTier: ['high', 'medium', 'low'].includes(c.liquidityTier) ? c.liquidityTier : 'unknown',
          recentPayments: Number.isFinite(Number(c.recentPayments)) ? Number(c.recentPayments) : null,
        };
      });

      const intent = {
        from, to, basis, amount,
        sortBy: body.sortBy === 'verified' ? 'verified' : 'payout',
        ...(body.minGrade ? { minGrade: String(body.minGrade).toUpperCase() } : {}),
        ...(body.requirePricedTerms ? { requirePricedTerms: true } : {}),
      };

      const result = LandfallIntent.solveIntent(intent, candidates, midRate);
      const winner = result.solutions.find((s) => s.priced) || null;
      const chosen = winner
        ? body.candidates.find((c) => String(c.domain).toLowerCase() === String(winner.domain).toLowerCase())
        : null;

      return json(res, 200, {
        intent,
        midRate,
        solutions: result.solutions,
        rejected: result.rejected,
        unsatisfiable: result.unsatisfiable,
        plan: winner
          ? LandfallIntent.buildPlan({
              solution: winner,
              from,
              to,
              anchorUrl: chosen && chosen.url ? String(chosen.url) : undefined,
              speed: chosen && chosen.speed ? String(chosen.speed) : undefined,
            })
          : null,
        gradesFrom: 'Landfall ledger scan — supplied grades in the request were ignored.',
        termsFrom: "The caller's own figures. Landfall does not verify that a rate or fee is what the anchor will actually honour; see /api/v1/anchor-fees.json for each anchor's own published terms.",
      }, 0);
    }

    // POST /api/v1/fraud-reports
    //
    // A stranger publishing an allegation about a named party. Treated with
    // more suspicion than anything else in this file: the cited transaction
    // is verified against the ledger BEFORE a row is written, and a report
    // that fails that check is rejected rather than stored at low weight.
    if (req.method === 'POST' && joined === 'v1/fraud-reports') {
      if (await enforceAuthRateLimit(req, res, db, 'fraud-report', 5)) return;

      const body = await readJsonBody(req);
      const draft = {
        subject: body.subject,
        evidenceTxHash: body.evidenceTxHash,
        category: body.category,
        note: body.note,
        reporterAddress: body.reporterAddress,
      };

      const shape = validateFraudSubmission(draft);
      if (!shape.ok) return json(res, 400, { error: shape.message, reason: shape.reason }, 0);

      const subject = String(draft.subject).trim();
      const txHash = String(draft.evidenceTxHash).trim().toLowerCase();

      let evidence;
      try {
        evidence = await fraudVerifyEvidence(txHash, subject);
      } catch (err) {
        console.error('[fraud-reports]', err.message);
        return json(res, 502, { error: 'Could not reach Horizon to verify that transaction. Try again shortly.' }, 0);
      }
      if (!evidence.ok) return json(res, 400, { error: evidence.message, reason: 'evidence-not-verified' }, 0);

      try {
        const { rows } = await db.query(
          `INSERT INTO fraud_reports (subject, evidence_tx_hash, category, note, reporter_ip_hash)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, subject, evidence_tx_hash, category, note, status, submitted_at`,
          [subject, txHash, String(draft.category).trim(), String(draft.note).trim(), sha256Hex(clientIp(req))],
        );
        const row = rows[0];
        return json(res, 201, {
          ok: true,
          id: String(row.id),
          subject: row.subject,
          status: row.status,
          submittedAt: row.submitted_at.toISOString(),
          note:
            'Recorded as a claim, and shown as one. Landfall verified only that the cited transaction exists ' +
            'and involves this address — it has not established what happened between you and them, and will ' +
            'not say that it has. The reported party can attach a response.',
        }, 0);
      } catch (err) {
        if (err.message?.includes('unique') || err.message?.includes('duplicate')) {
          return json(res, 409, { error: 'You have already filed a report citing this transaction for this address.' }, 0);
        }
        throw err;
      }
    }

    // POST /api/v1/fraud-reports/:id/dispute
    //
    // The reported party answering back. Gated on a signature from the
    // reported address's own key — see verifyDispute above for why that is
    // the only thing that makes a response more than another anonymous
    // claim, and why DISPUTES.md's human path stays for cold-key accounts
    // that cannot sign a web form.
    if (req.method === 'POST' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'fraud-reports' && parts[3] === 'dispute') {
      if (await enforceAuthRateLimit(req, res, db, 'fraud-dispute', 10)) return;

      const reportId = decodeURIComponent(parts[2]);
      if (!/^\d+$/.test(reportId)) return json(res, 400, { error: 'Report id must be numeric.' }, 0);

      const body = await readJsonBody(req);

      const { rows } = await db.query(
        `SELECT id, subject, status, disputed_at FROM fraud_reports WHERE id = $1`,
        [reportId],
      );
      const report = rows[0];
      if (!report) return json(res, 404, { error: 'No report with that id.' }, 0);
      if (report.disputed_at) {
        return json(res, 409, {
          error: 'That report already carries a response. A report takes one, so a later signature cannot overwrite an earlier answer.',
        }, 0);
      }

      // The subject comes from the stored report, never from the request —
      // otherwise a caller could name an address they do control and have
      // the signature check pass against a report about someone else.
      const verification = verifyDispute(
        {
          reportId: String(report.id),
          subject: report.subject,
          issuedAt: body.issuedAt,
          signature: body.signature,
          note: body.note,
        },
        new Date(),
      );
      if (!verification.ok) {
        return json(res, verification.reason === 'signature-mismatch' ? 403 : 400, {
          error: verification.message,
          reason: verification.reason,
        }, 0);
      }

      const { rows: updated } = await db.query(
        `UPDATE fraud_reports
            SET status = 'disputed', disputed_at = now(), dispute_note = $2
          WHERE id = $1 AND disputed_at IS NULL
        RETURNING id, subject, status, disputed_at, dispute_note`,
        [reportId, String(body.note).trim()],
      );
      if (!updated[0]) {
        return json(res, 409, { error: 'That report already carries a response.' }, 0);
      }

      return json(res, 200, {
        ok: true,
        id: String(updated[0].id),
        status: updated[0].status,
        disputedAt: updated[0].disputed_at.toISOString(),
        note:
          'Response recorded and attached to the report. It is shown alongside the accusation wherever that ' +
          'report appears — Landfall does not adjudicate between the two, and does not claim to know which is right.',
      }, 0);
    }

    // GET /api/v1/fraud-reports/:subject
    if (req.method === 'GET' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'fraud-reports') {
      const subject = decodeURIComponent(parts[2]);
      if (!FRAUD_G_ADDRESS.test(subject)) {
        return json(res, 400, { error: 'Subject must be a Stellar public key (G...).' }, 0);
      }

      const { rows } = await db.query(
        `SELECT id, subject, evidence_tx_hash, category, note, status, submitted_at, disputed_at, dispute_note
         FROM fraud_reports WHERE subject = $1 ORDER BY submitted_at DESC LIMIT 200`,
        [subject],
      );

      const reports = rows.map((r) => ({
        id: String(r.id),
        subject: r.subject,
        evidenceTxHash: r.evidence_tx_hash,
        category: r.category,
        note: r.note,
        status: r.status,
        submittedAt: r.submitted_at.toISOString(),
        disputedAt: r.disputed_at ? r.disputed_at.toISOString() : null,
        disputeNote: r.dispute_note ?? null,
      }));

      return json(res, 200, summariseFraudReports(subject, reports), 60);
    }

    // POST /api/v1/fiat-confirmations
    //
    // Recipient self-report that a DERIVED-tier transfer's fiat leg landed —
    // see packages/adapters/src/fiatConfirmation.ts for what this can and
    // cannot prove. This endpoint only ever stores the claim; whether it
    // actually binds as evidence is decided later, at scan time, by
    // scripts/cross-chain-scan.ts — which is the only place that also has
    // the on-chain transfer's own timestamp to check it against. What is
    // checked here (`eligible` in the response) is only the two rules that
    // do not depend on that timestamp, so a submitter finds out immediately
    // if their own claim can never bind, without this endpoint pretending to
    // know more than it does.
    if (req.method === 'POST' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'fiat-confirmations') {
      const bucket = `fiatconfirm:submit:${clientIp(req)}`;
      const { allowed } = await rateLimit(db, bucket, 10);
      if (!allowed) return json(res, 429, { error: 'Too many submissions. Try again in a minute.' }, 0);

      const body = await readJsonBody(req);
      const chain = String(body.chain || '').trim().toLowerCase();
      const reference = String(body.reference || '').trim();
      const respondent = String(body.respondent || '').trim();
      const outcome = String(body.outcome || '').trim();
      const reportedAmount = body.reportedAmount != null ? String(body.reportedAmount).trim().slice(0, 64) : null;
      const reportedCurrency = body.reportedCurrency != null ? String(body.reportedCurrency).trim().slice(0, 10) : null;
      const note = body.note != null ? String(body.note).trim().slice(0, 500) : null;

      if (!chain || chain.length > 40 || !/^[a-z0-9-]+$/.test(chain)) {
        return json(res, 400, { error: 'chain is required (lowercase letters, digits, hyphens, max 40 chars).' }, 0);
      }
      if (!reference || reference.length > 128) {
        return json(res, 400, { error: 'reference is required (the on-chain transfer id/signature, max 128 chars).' }, 0);
      }
      if (respondent !== 'recipient' && respondent !== 'sender') {
        return json(res, 400, { error: 'respondent must be "recipient" or "sender".' }, 0);
      }
      if (outcome !== 'received' && outcome !== 'not_received' && outcome !== 'partial') {
        return json(res, 400, { error: 'outcome must be "received", "not_received", or "partial".' }, 0);
      }

      let row;
      try {
        const submittedIpHash = sha256Hex(clientIp(req));
        const { rows } = await db.query(
          `INSERT INTO fiat_confirmations
             (chain, reference, respondent, outcome, reported_amount, reported_currency, note, submitted_ip_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING chain, reference, respondent, outcome, submitted_at`,
          [chain, reference, respondent, outcome, reportedAmount, reportedCurrency, note, submittedIpHash],
        );
        row = rows[0];
      } catch (err) {
        if (err.message?.includes('unique') || err.message?.includes('duplicate')) {
          // First submission wins, permanently — see 008_fiat_confirmations.sql
          // for why there is deliberately no update path.
          return json(res, 409, { error: 'A confirmation has already been submitted for this transfer.' }, 0);
        }
        throw err;
      }

      // pg returns TIMESTAMPTZ as a JS Date. evaluateFiatConfirmation calls
      // Date.parse() on these, which expects a string — pass one explicitly
      // rather than relying on the implicit toString() coercion.
      const submittedAtIso = row.submitted_at.toISOString();

      // Chain-independent eligibility only — see the comment above this route.
      const claim = { chain: row.chain, reference: row.reference, respondent: row.respondent, outcome: row.outcome, submittedAt: submittedAtIso };
      const preview = evaluateFiatConfirmation(claim, { reference: row.reference, observedAt: submittedAtIso });

      return json(res, 201, {
        ok: true,
        chain: row.chain,
        reference: row.reference,
        submittedAt: submittedAtIso,
        eligible: preview.ok,
        ineligibleReason: preview.ok ? null : preview.reason,
        note: 'Recorded. Whether this counts as settlement evidence is decided when the next cross-chain scan processes this transfer, which is the only place that knows when the transfer itself happened.',
      }, 0);
    }

    // GET /api/v1/fiat-confirmations/:chain/:reference
    if (req.method === 'GET' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'fiat-confirmations') {
      const chain = decodeURIComponent(parts[2]).toLowerCase();
      const reference = decodeURIComponent(parts[3]);

      const { rows } = await db.query(
        `SELECT chain, reference, respondent, outcome, reported_amount, reported_currency, submitted_at
         FROM fiat_confirmations WHERE chain = $1 AND reference = $2`,
        [chain, reference],
      );
      const row = rows[0];
      if (!row) return json(res, 404, { error: 'No confirmation submitted for this reference.' });

      const submittedAtIso = row.submitted_at.toISOString();
      const claim = { chain: row.chain, reference: row.reference, respondent: row.respondent, outcome: row.outcome, submittedAt: submittedAtIso };
      const preview = evaluateFiatConfirmation(claim, { reference: row.reference, observedAt: submittedAtIso });

      return json(res, 200, {
        chain: row.chain,
        reference: row.reference,
        respondent: row.respondent,
        outcome: row.outcome,
        reportedAmount: row.reported_amount,
        reportedCurrency: row.reported_currency,
        submittedAt: submittedAtIso,
        eligible: preview.ok,
        ineligibleReason: preview.ok ? null : preview.reason,
        note: 'eligible reflects only the checks that do not depend on the on-chain transfer\'s own timestamp. The binding decision happens at scan time — see packages/adapters/src/fiatConfirmation.ts.',
      });
    }

    return json(res, 404, { error: `Unknown route: /api/${joined}` });

  } catch (err) {
    console.error('[landfall-api]', err.message);
    return json(res, 500, { error: err.message }, 0);
  }
}
