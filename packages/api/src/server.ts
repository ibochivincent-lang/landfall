/**
 * Landfall API — read-only HTTP over the indexed dataset, plus a session-gated
 * admin surface for the developer board at packages/web/admin.html.
 *
 * Design rules carried over from the rest of the project:
 *
 *   * A rate computed over no traffic is `null`, never `0`. Postgres stores it
 *     as NULL and it must stay null all the way out to the client; collapsing
 *     it to zero would tell a caller "this anchor never fails" about an anchor
 *     we have no evidence on.
 *   * Every response carries `asOf` and `staleHours`. A consumer must be able
 *     to see that the data is from last month without reading our blog.
 *   * The limitation ships in the payload, not just the docs. A machine
 *     consuming `returnRate` should receive the caveat alongside it.
 *
 * Admin auth mirrors api/[...path].js (the Vercel deployment) exactly:
 * scrypt password hashes, server-side sessions keyed by a SHA-256 of a random
 * token, httpOnly/Secure/SameSite=Strict cookie. See that file's header for
 * why — including the SQL-execution endpoint it used to expose and no longer
 * does.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Pool } from "pg";
import { scrypt as scryptCb, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (password: string, salt: string, keylen: number) => Promise<Buffer>;

const PORT = Number(process.env["PORT"] ?? 8787);
const DATABASE_URL = process.env["DATABASE_URL"];
const ORIGIN = process.env["CORS_ORIGIN"] ?? "*";

if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set. See .env.example.");
  process.exit(1);
}

// Hosted Postgres (Neon, Supabase, Railway, RDS) requires TLS. Their certs are
// issued by intermediaries Node does not ship, so verification is relaxed for
// those hosts only — the connection is still encrypted. A plain local socket
// gets no TLS at all.
const needsTls = /sslmode=require|neon\.tech|supabase\.|railway\.app|render\.com|rds\.amazonaws/.test(DATABASE_URL);
const pool = new Pool({
  connectionString: DATABASE_URL,
  max: Number(process.env["PG_POOL_MAX"] ?? 8),
  connectionTimeoutMillis: 8_000,
  ...(needsTls ? { ssl: { rejectUnauthorized: false } } : {}),
});

/** Stated on every response that reports a return rate. */
const RETURN_RATE_CAVEAT =
  "A return is the honest failure mode. An anchor that accepts value, fails to " +
  "settle and keeps it produces no return event and scores 0. A low rate is the " +
  "absence of one kind of evidence, not evidence of good conduct.";

type Json = Record<string, unknown>;

function send(res: ServerResponse, status: number, body: Json, cache = 60): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": ORIGIN,
    "cache-control": status === 200 ? `public, max-age=${cache}` : "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

/** Admin responses skip access-control-allow-origin entirely — same-origin only, cookie never leaves this host. */
function sendAdmin(res: ServerResponse, status: number, body: Json): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body, null, 2));
}

async function readJsonBody(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Json) : {};
}

/** Postgres NUMERIC arrives as a string; keep precision, drop the nulls. */
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

// ── Auth: password hashing, sessions, cookies (mirrors api/[...path].js) ────

const SESSION_COOKIE = "landfall_admin";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = (await scrypt(password, salt, 64)).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = String(stored || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, hashHex] = parts as [string, string, string];
  const computed = await scrypt(password, salt, 64);
  const expected = Buffer.from(hashHex, "hex");
  if (computed.length !== expected.length) return false;
  return timingSafeEqual(computed, expected);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie ?? "";
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function setSessionCookie(res: ServerResponse, token: string, maxAgeSeconds: number): void {
  res.setHeader(
    "set-cookie",
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`,
  );
}
function clearSessionCookie(res: ServerResponse): void {
  res.setHeader("set-cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
}

async function requireSession(req: IncomingMessage): Promise<{ id: number; username: string } | null> {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const tokenHash = sha256Hex(token);
  const { rows } = await pool.query(
    `SELECT u.id, u.username
       FROM admin_sessions s JOIN admin_users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [tokenHash],
  );
  if (!rows[0]) return null;
  void pool.query("UPDATE admin_sessions SET last_seen_at = now() WHERE token_hash = $1", [tokenHash]).catch(() => {});
  return { id: Number(rows[0].id), username: rows[0].username };
}

async function latestScan(): Promise<{
  id: number; finishedAt: string; horizon: string; options: Json; staleHours: number;
} | null> {
  const { rows } = await pool.query(
    `SELECT id, finished_at, horizon_url, options,
            EXTRACT(EPOCH FROM (now() - finished_at)) / 3600 AS stale_hours
       FROM latest_scan`,
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: Number(r.id),
    finishedAt: new Date(r.finished_at).toISOString(),
    horizon: r.horizon_url,
    options: r.options,
    staleHours: Math.round(Number(r.stale_hours) * 100) / 100,
  };
}

async function accountRows(): Promise<Json[]> {
  const { rows } = await pool.query(
    `SELECT account_id, domain, role, org_name, state, sampled, dust_excluded,
            last_activity_at, hours_since_activity,
            inbound_count, outbound_count, refund_count, refund_rate,
            median_refund_hours, top_counterparty_share
       FROM current_accounts
      ORDER BY CASE state WHEN 'dark' THEN 0 WHEN 'slow' THEN 1
                          WHEN 'no_activity' THEN 2 ELSE 3 END,
               hours_since_activity DESC NULLS LAST`,
  );
  return rows.map((r) => ({
    account: r.account_id,
    domain: r.domain,
    role: r.role,
    orgName: r.org_name,
    state: r.state,
    sampled: r.sampled,
    dustExcluded: r.dust_excluded,
    lastActivityAt: r.last_activity_at ? new Date(r.last_activity_at).toISOString() : null,
    hoursSinceActivity: num(r.hours_since_activity),
    inbound: r.inbound_count,
    outbound: r.outbound_count,
    returns: r.refund_count,
    // Stays null when there was no inbound traffic to divide by.
    returnRate: num(r.refund_rate),
    medianReturnHours: num(r.median_refund_hours),
    topCounterpartyShare: num(r.top_counterparty_share),
  }));
}

function headlineFrom(accounts: Json[]): Json {
  const dark = accounts.filter((a) => a["state"] === "dark");
  const byDomain = new Map<string, Json[]>();
  for (const a of accounts) {
    const d = String(a["domain"]);
    byDomain.set(d, [...(byDomain.get(d) ?? []), a]);
  }
  // A domain counts as fully dark only if it has payment history at all and
  // every such account is dark. One stale account at a multi-account anchor
  // is a different, much weaker finding.
  const fullyDark: string[] = [];
  for (const [domain, accts] of byDomain) {
    const active = accts.filter((a) => a["state"] !== "no_activity");
    if (active.length > 0 && active.every((a) => a["state"] === "dark")) fullyDark.push(domain);
  }

  const eligible = accounts.filter((a) => (a["returnRate"] as number | null) !== null);
  const totalIn = eligible.reduce((s, a) => s + Number(a["inbound"] ?? 0), 0);
  const totalRet = eligible.reduce((s, a) => s + Number(a["returns"] ?? 0), 0);

  return {
    accounts: accounts.length,
    domains: byDomain.size,
    dark: dark.length,
    fullyDarkDomains: fullyDark,
    inboundPayments: totalIn,
    returns: totalRet,
    returnRate: totalIn > 0 ? Math.round((totalRet / totalIn) * 1e6) / 1e6 : null,
    returnSampleSize: totalRet,
    // Below 30 pairs a median is an observation about specific transactions,
    // not a property of the anchor. Say so in the payload.
    returnRateIsEstimate: totalRet >= 30,
    caveat: RETURN_RATE_CAVEAT,
  };
}

/** Clamp a user-supplied limit so one request cannot ask for the whole table. */
function pageLimit(url: URL, fallback = 50, max = 500): number {
  const n = Number(url.searchParams.get("limit") ?? fallback);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), max) : fallback;
}

/**
 * Payment history, newest first.
 *
 * Keyset pagination on the primary key rather than OFFSET: the table grows
 * continuously, and OFFSET would both slow down and silently skip rows as new
 * payments arrive between pages.
 */
async function paymentsPage(opts: {
  accounts?: string[];
  direction?: string | null;
  asset?: string | null;
  before?: string | null;
  limit: number;
  includeRaw?: boolean;
}): Promise<{ rows: Json[]; nextCursor: string | null }> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (opts.accounts && opts.accounts.length > 0) {
    params.push(opts.accounts);
    const i = params.length;
    if (opts.direction === "in") where.push(`p.to_account = ANY($${i})`);
    else if (opts.direction === "out") where.push(`p.from_account = ANY($${i})`);
    else where.push(`(p.to_account = ANY($${i}) OR p.from_account = ANY($${i}))`);
  }
  if (opts.asset) { params.push(opts.asset); where.push(`p.asset = $${params.length}`); }
  if (opts.before) { params.push(opts.before); where.push(`p.id < $${params.length}`); }

  params.push(opts.limit + 1); // one extra row tells us whether another page exists
  const sql = `
    SELECT p.id, p.tx_hash, p.op_type, p.from_account, p.to_account,
           p.amount::text AS amount, p.asset, p.memo, p.created_at, p.is_dust, p.source,
           ai.domain AS to_domain, af.domain AS from_domain
      FROM payments p
      LEFT JOIN anchor_accounts ai ON ai.account_id = p.to_account
      LEFT JOIN anchor_accounts af ON af.account_id = p.from_account
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY p.id DESC
     LIMIT $${params.length}`;

  const { rows } = await pool.query(sql, params);
  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;

  return {
    rows: page.map((r) => ({
      ...(opts.includeRaw ? { id: String(r.id), source: r.source, opType: r.op_type } : {}),
      id: String(r.id),
      txHash: r.tx_hash,
      type: r.op_type,
      from: r.from_account,
      to: r.to_account,
      fromDomain: r.from_domain,
      toDomain: r.to_domain,
      amount: r.amount,
      asset: r.asset,
      memo: r.memo,
      createdAt: new Date(r.created_at).toISOString(),
      isDust: r.is_dust,
      source: r.source,
    })),
    nextCursor: hasMore ? String(page[page.length - 1]!.id) : null,
  };
}

async function accountsFor(domain: string): Promise<string[]> {
  const { rows } = await pool.query<{ account_id: string }>(
    "SELECT account_id FROM anchor_accounts WHERE domain = $1", [domain],
  );
  return rows.map((r) => r.account_id);
}

// ── Admin: ops/backend health ────────────────────────────────────────────────

const HEALTH_TABLES = [
  "anchors", "anchor_accounts", "payments", "ledger_events", "cursors",
  "scans", "account_metrics", "refund_pairs", "attestations",
  "oracle_publications", "tracked_anchors", "admin_users",
];

async function adminHealth(): Promise<Json> {
  const started = Date.now();
  const [scanRows, tableCounts, cursorRows, latest, oracleRow] = await Promise.all([
    pool.query(`SELECT id, started_at, finished_at, horizon_url, accounts_seen, notes FROM scans ORDER BY id DESC LIMIT 10`),
    pool.query(`SELECT relname AS table_name, n_live_tup AS approx_rows FROM pg_stat_user_tables WHERE schemaname = 'public' ORDER BY relname`),
    pool.query(`SELECT stream, key, cursor, updated_at FROM cursors ORDER BY updated_at DESC LIMIT 50`),
    latestScan(),
    pool.query(`SELECT digest, ledger_seq, tx_hash, contract_id, published_at FROM oracle_publications ORDER BY published_at DESC LIMIT 1`),
  ]);
  const dbLatencyMs = Date.now() - started;

  const countsByTable: Record<string, number> = {};
  for (const name of HEALTH_TABLES) countsByTable[name] = 0;
  for (const r of tableCounts.rows) countsByTable[r.table_name] = Number(r.approx_rows);

  return {
    dbLatencyMs,
    latestScan: latest,
    recentScans: scanRows.rows.map((r) => ({
      id: Number(r.id),
      startedAt: new Date(r.started_at).toISOString(),
      finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
      horizon: r.horizon_url,
      accountsSeen: r.accounts_seen,
      notes: r.notes,
      status: r.finished_at ? "finished" : "running-or-crashed",
    })),
    approxRowCounts: countsByTable,
    resumeCursors: cursorRows.rows.map((r) => ({
      stream: r.stream, key: r.key, cursor: r.cursor, updatedAt: new Date(r.updated_at).toISOString(),
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

async function listTrackedAnchors(): Promise<Json[]> {
  const { rows } = await pool.query(
    `SELECT domain, active, added_by, notes, created_at, updated_at FROM tracked_anchors ORDER BY domain`,
  );
  return rows.map((r) => ({
    domain: r.domain, active: r.active, addedBy: r.added_by, notes: r.notes,
    createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
  }));
}

const routes: Record<string, (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>> = {
  "GET /health": async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      send(res, 200, { ok: true }, 0);
    } catch (e) {
      send(res, 503, { ok: false, error: (e as Error).message }, 0);
    }
  },

  "GET /api/v1/summary": async (_req, res) => {
    const scan = await latestScan();
    if (!scan) return send(res, 503, { error: "No completed scan yet." }, 0);
    const accounts = await accountRows();
    send(res, 200, {
      asOf: scan.finishedAt,
      staleHours: scan.staleHours,
      scanId: scan.id,
      headline: headlineFrom(accounts),
      methodology: "https://github.com/ibochivincent-lang/landfall/blob/main/docs/methodology.md",
    });
  },

  "GET /api/v1/anchors": async (_req, res) => {
    const scan = await latestScan();
    if (!scan) return send(res, 503, { error: "No completed scan yet." }, 0);
    const accounts = await accountRows();
    send(res, 200, {
      asOf: scan.finishedAt,
      staleHours: scan.staleHours,
      headline: headlineFrom(accounts),
      accounts,
    });
  },

  "GET /api/v1/payments": async (_req, res, url) => {
    const account = url.searchParams.get("account");
    const page = await paymentsPage({
      accounts: account ? [account] : undefined,
      direction: url.searchParams.get("direction"),
      asset: url.searchParams.get("asset"),
      before: url.searchParams.get("before"),
      limit: pageLimit(url),
    });
    send(res, 200, { count: page.rows.length, nextCursor: page.nextCursor, payments: page.rows }, 30);
  },

  "GET /api/v1/assets": async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT asset, count(*)::int AS count FROM payments
        GROUP BY asset ORDER BY count DESC LIMIT 50`,
    );
    send(res, 200, { assets: rows }, 300);
  },

  "GET /api/v1/dark": async (_req, res) => {
    const scan = await latestScan();
    if (!scan) return send(res, 503, { error: "No completed scan yet." }, 0);
    const accounts = (await accountRows()).filter((a) => a["state"] === "dark");
    send(res, 200, { asOf: scan.finishedAt, staleHours: scan.staleHours, count: accounts.length, accounts });
  },

  // ── Admin: auth ────────────────────────────────────────────────────────
  "POST /api/v1/admin/login": async (req, res) => {
    const body = await readJsonBody(req);
    const username = String(body["username"] ?? "").trim().toLowerCase();
    const password = String(body["password"] ?? "");
    if (!username || !password) return sendAdmin(res, 400, { error: "Username and password are required." });

    const { rows } = await pool.query("SELECT id, password_hash FROM admin_users WHERE username = $1", [username]);
    const user = rows[0];
    const ok = user
      ? await verifyPassword(password, user.password_hash)
      : await verifyPassword(password, "scrypt$00$00").catch(() => false);
    if (!user || !ok) return sendAdmin(res, 401, { error: "Invalid username or password." });

    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await pool.query(
      `INSERT INTO admin_sessions (token_hash, user_id, expires_at, user_agent) VALUES ($1, $2, $3, $4)`,
      [sha256Hex(token), user.id, expiresAt.toISOString(), String(req.headers["user-agent"] ?? "").slice(0, 300)],
    );
    await pool.query("UPDATE admin_users SET last_login_at = now() WHERE id = $1", [user.id]);
    setSessionCookie(res, token, SESSION_TTL_MS / 1000);
    sendAdmin(res, 200, { ok: true, username });
  },

  "POST /api/v1/admin/logout": async (req, res) => {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) await pool.query("DELETE FROM admin_sessions WHERE token_hash = $1", [sha256Hex(token)]);
    clearSessionCookie(res);
    sendAdmin(res, 200, { ok: true });
  },

  "GET /api/v1/admin/me": async (req, res) => {
    const session = await requireSession(req);
    if (!session) return sendAdmin(res, 401, { error: "Not authenticated." });
    sendAdmin(res, 200, { ok: true, username: session.username });
  },

  "GET /api/v1/admin/health": async (req, res) => {
    const session = await requireSession(req);
    if (!session) return sendAdmin(res, 401, { error: "Not authenticated." });
    sendAdmin(res, 200, await adminHealth());
  },

  "GET /api/v1/admin/payments": async (req, res, url) => {
    const session = await requireSession(req);
    if (!session) return sendAdmin(res, 401, { error: "Not authenticated." });
    const page = await paymentsPage({
      direction: url.searchParams.get("direction"),
      asset: url.searchParams.get("asset"),
      before: url.searchParams.get("before"),
      limit: pageLimit(url, 100, 1000),
      includeRaw: true,
    });
    sendAdmin(res, 200, { payments: page.rows, nextCursor: page.nextCursor });
  },

  "GET /api/v1/admin/anchors": async (req, res) => {
    const session = await requireSession(req);
    if (!session) return sendAdmin(res, 401, { error: "Not authenticated." });
    sendAdmin(res, 200, { anchors: await listTrackedAnchors() });
  },

  "POST /api/v1/admin/anchors": async (req, res) => {
    const session = await requireSession(req);
    if (!session) return sendAdmin(res, 401, { error: "Not authenticated." });
    const body = await readJsonBody(req);
    const domain = String(body["domain"] ?? "").trim().toLowerCase();
    if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
      return sendAdmin(res, 400, { error: "A valid domain is required, e.g. example.com." });
    }
    await pool.query(
      `INSERT INTO tracked_anchors (domain, active, added_by, notes)
       VALUES ($1, true, $2, $3)
       ON CONFLICT (domain) DO UPDATE
         SET active = true, updated_at = now(), notes = COALESCE(EXCLUDED.notes, tracked_anchors.notes)`,
      [domain, session.username, body["notes"] ? String(body["notes"]).slice(0, 500) : null],
    );
    sendAdmin(res, 200, { ok: true, anchors: await listTrackedAnchors() });
  },
};

/** PATCH/DELETE /api/v1/admin/anchors/:domain — dynamic segment, handled outside the static route table. */
async function handleAnchorMutation(req: IncomingMessage, res: ServerResponse, domain: string): Promise<void> {
  const session = await requireSession(req);
  if (!session) return sendAdmin(res, 401, { error: "Not authenticated." });
  if (req.method === "DELETE") {
    await pool.query("DELETE FROM tracked_anchors WHERE domain = $1", [domain]);
  } else {
    const body = await readJsonBody(req);
    await pool.query("UPDATE tracked_anchors SET active = $2, updated_at = now() WHERE domain = $1", [domain, Boolean(body["active"])]);
  }
  sendAdmin(res, 200, { ok: true, anchors: await listTrackedAnchors() });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "OPTIONS") {
    const isAdmin = url.pathname.startsWith("/api/v1/admin/");
    res.writeHead(204, {
      "access-control-allow-origin": isAdmin ? "" : ORIGIN,
      "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    return res.end();
  }

  // PATCH/DELETE /api/v1/admin/anchors/<domain>
  const anchorMutationMatch = /^\/api\/v1\/admin\/anchors\/([a-z0-9.-]+)$/i.exec(url.pathname);
  if ((req.method === "PATCH" || req.method === "DELETE") && anchorMutationMatch) {
    try {
      await handleAnchorMutation(req, res, decodeURIComponent(anchorMutationMatch[1]!).toLowerCase());
    } catch (e) {
      sendAdmin(res, 500, { error: (e as Error).message });
    }
    return;
  }

  // Per-anchor payment history: /api/v1/anchors/<domain>/payments
  const paymentsMatch = /^\/api\/v1\/anchors\/([a-z0-9.-]+)\/payments$/i.exec(url.pathname);
  if (req.method === "GET" && paymentsMatch) {
    try {
      const domain = paymentsMatch[1]!;
      const accounts = await accountsFor(domain);
      if (accounts.length === 0) return send(res, 404, { error: "Unknown anchor domain." }, 0);
      const page = await paymentsPage({
        accounts,
        direction: url.searchParams.get("direction"),
        asset: url.searchParams.get("asset"),
        before: url.searchParams.get("before"),
        limit: pageLimit(url),
      });
      return send(res, 200, {
        domain, accounts,
        count: page.rows.length,
        nextCursor: page.nextCursor,
        payments: page.rows,
      }, 30);
    } catch (e) {
      return send(res, 500, { error: (e as Error).message }, 0);
    }
  }

  // Anchor domain lookup: /api/v1/anchors/<domain>
  const domainMatch = /^\/api\/v1\/anchors\/([a-z0-9.-]+)$/i.exec(url.pathname);
  if (req.method === "GET" && domainMatch) {
    try {
      const scan = await latestScan();
      if (!scan) return send(res, 503, { error: "No completed scan yet." }, 0);
      const all = await accountRows();
      const accounts = all.filter((a) => a["domain"] === domainMatch[1]);
      if (accounts.length === 0) return send(res, 404, { error: "Unknown anchor domain." }, 0);
      return send(res, 200, { asOf: scan.finishedAt, staleHours: scan.staleHours, domain: domainMatch[1], accounts });
    } catch (e) {
      return send(res, 500, { error: (e as Error).message }, 0);
    }
  }

  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) {
    return send(res, 404, {
      error: "Not found",
      endpoints: [
        "/health",
        "/api/v1/summary",
        "/api/v1/anchors",
        "/api/v1/anchors/{domain}",
        "/api/v1/anchors/{domain}/payments?limit=&before=&direction=in|out&asset=",
        "/api/v1/payments?account=&limit=&before=&direction=&asset=",
        "/api/v1/assets",
        "/api/v1/dark",
        "/api/v1/admin/login (POST)",
        "/api/v1/admin/logout (POST)",
        "/api/v1/admin/me",
        "/api/v1/admin/health",
        "/api/v1/admin/payments",
        "/api/v1/admin/anchors (GET, POST)",
        "/api/v1/admin/anchors/{domain} (PATCH, DELETE)",
      ],
    }, 0);
  }

  try {
    await handler(req, res, url);
  } catch (e) {
    send(res, 500, { error: (e as Error).message }, 0);
  }
});

/**
 * One startup check, for one specific failure that is otherwise invisible.
 *
 * Migration 002 turns row-level security on for every table so that a hosted
 * Postgres cannot be mutated by whoever holds the project's public API key.
 * The owner bypasses RLS, so the indexer and this service are unaffected —
 * *provided they connect as the owner*. Connect as some other role and
 * Postgres does not error: it returns zero rows. The API comes up healthy, the
 * dashboard renders, and every anchor has apparently vanished.
 *
 * `row_security_active` answers exactly that question for the connected role.
 * We warn rather than exit, because an operator who has deliberately written
 * read policies for a restricted role should not be locked out by our guess.
 */
async function warnIfInvisible(): Promise<void> {
  try {
    const { rows } = await pool.query(
      `SELECT current_user AS role,
              row_security_active('payments') AS blocked,
              (SELECT count(*) FROM pg_policies
                WHERE schemaname = 'public' AND tablename = 'payments') AS policies`,
    );
    const r = rows[0];
    if (r?.blocked && Number(r.policies) === 0) {
      console.warn(
        `\n  WARNING: connected as '${r.role}', which is not the table owner.\n` +
        `  Row-level security is on and no read policy exists, so every query\n` +
        `  will return zero rows without raising an error. Connect with the\n` +
        `  owner role (on Supabase that is 'postgres'), or add read policies.\n` +
        `  See docs/deployment.md.\n`,
      );
    }
  } catch {
    // A database that is unreachable at boot is the pool's problem to report,
    // and /health already surfaces it. Not worth a second, noisier failure.
  }
}

async function warnIfNoAdmin(): Promise<void> {
  try {
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM admin_users");
    if (Number(rows[0]?.n ?? 0) === 0) {
      console.warn(
        "\n  No admin account exists yet. The developer board at /admin has\n" +
        "  nothing to log in with. Create one:\n" +
        "    DATABASE_URL=... node scripts/create-admin.mjs <username>\n",
      );
    }
  } catch {
    // Table may not exist yet on an unmigrated database; migrate first, that
    // failure is already loud elsewhere.
  }
}

server.listen(PORT, () => {
  console.log(`landfall api listening on :${PORT}`);
  void warnIfInvisible();
  void warnIfNoAdmin();
});

const shutdown = async () => {
  server.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
