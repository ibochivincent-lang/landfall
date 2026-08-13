/**
 * Landfall API — read-only HTTP over the indexed dataset.
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
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Pool } from "pg";

const PORT = Number(process.env["PORT"] ?? 8787);
const DATABASE_URL = process.env["DATABASE_URL"];
const ORIGIN = process.env["CORS_ORIGIN"] ?? "*";

if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set. See .env.example.");
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 8, connectionTimeoutMillis: 8_000 });

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

/** Postgres NUMERIC arrives as a string; keep precision, drop the nulls. */
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

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

  "GET /api/v1/dark": async (_req, res) => {
    const scan = await latestScan();
    if (!scan) return send(res, 503, { error: "No completed scan yet." }, 0);
    const accounts = (await accountRows()).filter((a) => a["state"] === "dark");
    send(res, 200, { asOf: scan.finishedAt, staleHours: scan.staleHours, count: accounts.length, accounts });
  },
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": ORIGIN,
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    return res.end();
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
      endpoints: ["/health", "/api/v1/summary", "/api/v1/anchors", "/api/v1/anchors/{domain}", "/api/v1/dark"],
    }, 0);
  }

  try {
    await handler(req, res, url);
  } catch (e) {
    send(res, 500, { error: (e as Error).message }, 0);
  }
});

server.listen(PORT, () => {
  console.log(`landfall api listening on :${PORT}`);
});

const shutdown = async () => {
  server.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
