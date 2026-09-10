/**
 * api/_lib/helpers.js
 *
 * Core HTTP response, session, hashing, and rate-limiting helpers.
 * Shared across modular API route controllers.
 *
 * Author: ibochivincent-lang
 */

import { scrypt as scryptCb, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const ORIGIN = process.env.CORS_ORIGIN || '*';
export const SESSION_COOKIE = 'landfall_admin';
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export function json(res, status, body, cacheSeconds = 60) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS, POST, DELETE, PATCH');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Payment, X-Payment-Signature, Cookie');
  res.setHeader('Cache-Control', status === 200 ? `public, s-maxage=${cacheSeconds}` : 'no-store');
  res.status(status).json(body);
}

export function adminJson(res, status, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
}

export async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
  const buffers = [];
  for await (const chunk of req) buffers.push(chunk);
  const raw = Buffer.concat(buffers).toString();
  return raw ? JSON.parse(raw) : {};
}

export function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.socket?.remoteAddress || '127.0.0.1';
}

export async function rateLimit(db, key, limitPerMin) {
  if (!db) return { allowed: true };
  try {
    const { rows } = await db.query(
      `INSERT INTO rate_limits (key, count, reset_at)
       VALUES ($1, 1, now() + interval '1 minute')
       ON CONFLICT (key) DO UPDATE
       SET count = CASE
         WHEN rate_limits.reset_at < now() THEN 1
         ELSE rate_limits.count + 1
       END,
       reset_at = CASE
         WHEN rate_limits.reset_at < now() THEN now() + interval '1 minute'
         ELSE rate_limits.reset_at
       END
       RETURNING count`,
      [key]
    );
    const count = rows[0]?.count || 1;
    return { allowed: count <= limitPerMin };
  } catch {
    return { allowed: true };
  }
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, 64)).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hashHex] = parts;
  const computed = await scrypt(password, salt, 64);
  const expected = Buffer.from(hashHex, 'hex');
  if (computed.length !== expected.length) return false;
  return timingSafeEqual(computed, expected);
}

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function setSessionCookie(res, token, maxAgeSeconds) {
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

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
}

export async function requireSession(req, db) {
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
