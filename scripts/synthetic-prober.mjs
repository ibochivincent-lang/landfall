/**
 * scripts/synthetic-prober.mjs
 *
 * Author: ibochivincent-lang
 *
 * Active Synthetic Health Prober for Stellar Anchors (SEP-6 / SEP-24 / SEP-31 / SEP-38).
 *
 * Checks live anchor web infrastructure:
 *   - HTTP /info and quote endpoint availability and status codes
 *   - Response latency in milliseconds
 *   - TLS/SSL certificate validity and remaining days to expiration
 *   - JSON payload validation
 *
 * Persists results to PostgreSQL `anchor_synthetic_health` (if DATABASE_URL is configured)
 * and writes `packages/web/api/v1/synthetic-health.json` and `out/synthetic-health.json`.
 *
 * Run once:
 *   node scripts/synthetic-prober.mjs
 * Run every 15 minutes:
 *   node scripts/synthetic-prober.mjs --watch --interval 15
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tls from 'node:tls';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SEED_FILE = join(ROOT, 'packages', 'indexer', 'data', 'anchors.json');
const OUT_WEB = join(ROOT, 'packages', 'web', 'api', 'v1', 'synthetic-health.json');
const OUT_FILE = join(ROOT, 'out', 'synthetic-health.json');

const PROBE_TIMEOUT_MS = 10_000;

const SEP_DEFINITIONS = [
  { sep: 'SEP-6', tomlKey: 'TRANSFER_SERVER', path: '/info' },
  { sep: 'SEP-24', tomlKey: 'TRANSFER_SERVER_SEP0024', path: '/info' },
  { sep: 'SEP-31', tomlKey: 'DIRECT_PAYMENT_SERVER', path: '/info' },
  { sep: 'SEP-38', tomlKey: 'ANCHOR_QUOTE_SERVER', path: '/info' },
];

/** Read top-level key from stellar.toml */
function parseTomlKey(toml, key) {
  const line = toml.split(/\r?\n/).find((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
  if (!line) return null;
  const m = line.match(/["']([^"']+)["']/);
  return m ? m[1].replace(/\/$/, '') : null;
}

/** Check SSL certificate expiry in days */
async function checkSslDays(hostname) {
  return new Promise((resolvePromise) => {
    const socket = tls.connect(
      {
        host: hostname,
        port: 443,
        servername: hostname,
        timeout: 5000,
        rejectUnauthorized: false, // measure days even if cert is self-signed/testing
      },
      () => {
        try {
          const cert = socket.getPeerCertificate();
          if (!cert || !cert.valid_to) {
            socket.destroy();
            return resolvePromise(null);
          }
          const validTo = new Date(cert.valid_to);
          const diffMs = validTo.getTime() - Date.now();
          const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
          socket.destroy();
          resolvePromise(days);
        } catch {
          socket.destroy();
          resolvePromise(null);
        }
      },
    );
    socket.on('error', () => {
      socket.destroy();
      resolvePromise(null);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolvePromise(null);
    });
  });
}

/** Fetch URL with timeout and timing */
async function timedGet(url) {
  const start = Date.now();
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'landfall-synthetic-prober/1.0' },
      redirect: 'follow',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const duration = Date.now() - start;
    let isJson = false;
    try {
      await res.json();
      isJson = true;
    } catch {
      isJson = false;
    }
    return { ok: res.ok, status: res.status, ms: duration, isJson };
  } catch (err) {
    return { ok: false, status: null, ms: Date.now() - start, error: err.message };
  }
}

/** Probe single anchor domain */
async function probeAnchor(domain) {
  const tomlUrl = `https://${domain}/.well-known/stellar.toml`;
  const tomlRes = await timedGet(tomlUrl);
  const sslDays = await checkSslDays(domain);

  const results = {
    domain,
    probedAt: new Date().toISOString(),
    sslDaysRemaining: sslDays,
    toml: {
      status: tomlRes.status,
      latencyMs: tomlRes.ms,
      ok: tomlRes.ok,
      error: tomlRes.error || null,
    },
    endpoints: [],
  };

  if (!tomlRes.ok) {
    return results;
  }

  let tomlText = '';
  try {
    const resp = await fetch(tomlUrl, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    tomlText = await resp.text();
  } catch {
    return results;
  }

  for (const def of SEP_DEFINITIONS) {
    const baseUrl = parseTomlKey(tomlText, def.tomlKey);
    if (!baseUrl) continue;

    const probeUrl = baseUrl + def.path;
    const probe = await timedGet(probeUrl);
    results.endpoints.push({
      sep: def.sep,
      url: probeUrl,
      httpStatus: probe.status,
      latencyMs: probe.ms,
      isJson: probe.isJson,
      ok: probe.ok && probe.isJson,
      error: probe.error || (!probe.isJson && probe.ok ? 'Response was not JSON' : null),
    });
  }

  return results;
}

async function getDomains() {
  try {
    const raw = await readFile(SEED_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const domains = Array.isArray(parsed.domains) ? parsed.domains : (parsed.anchors || []).map(a => a.domain).filter(Boolean);
    return [...new Set(domains)];
  } catch {
    return ['circle.com', 'anchorusd.com', 'anclap.com'];
  }
}

async function recordInDb(allResults) {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) return;

  try {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 8000 });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS anchor_synthetic_health (
        id SERIAL PRIMARY KEY,
        domain TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        status TEXT NOT NULL,
        response_time_ms INTEGER,
        ssl_days_remaining INTEGER,
        http_status INTEGER,
        error_details TEXT,
        last_probed_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_anchor_synthetic_health_domain ON anchor_synthetic_health(domain);
    `);

    for (const r of allResults) {
      for (const ep of r.endpoints) {
        await pool.query(
          `INSERT INTO anchor_synthetic_health
             (domain, endpoint, status, response_time_ms, ssl_days_remaining, http_status, error_details, last_probed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            r.domain,
            ep.sep,
            ep.ok ? 'HEALTHY' : 'FAILING',
            ep.latencyMs,
            r.sslDaysRemaining,
            ep.httpStatus,
            ep.error,
            r.probedAt,
          ],
        );
      }
    }
    await pool.end();
  } catch (err) {
    console.error('[prober] DB recording skipped:', err.message);
  }
}

export async function runProbes() {
  const domains = await getDomains();
  console.log(`[prober] Starting synthetic health probe across ${domains.length} anchor(s)...`);

  const results = [];
  for (const d of domains.slice(0, 15)) { // batch probe up to 15 domains per run
    try {
      const res = await probeAnchor(d);
      results.push(res);
      const epOk = res.endpoints.filter(e => e.ok).length;
      console.log(`[prober] ${d}: SSL ${res.sslDaysRemaining ?? '?'}d | ${epOk}/${res.endpoints.length} SEPs answering`);
    } catch (err) {
      console.error(`[prober] Error probing ${d}:`, err.message);
    }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    totalProbed: results.length,
    results,
  };

  await mkdir(join(ROOT, 'out'), { recursive: true });
  await mkdir(dirname(OUT_WEB), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(payload, null, 2), 'utf8');
  await writeFile(OUT_WEB, JSON.stringify(payload, null, 2), 'utf8');
  await recordInDb(results);

  console.log(`[prober] Synthetic probe complete. Snapshot written to out/synthetic-health.json.`);
  return payload;
}

if (process.argv[1] && process.argv[1].endsWith('synthetic-prober.mjs')) {
  const args = process.argv.slice(2);
  const isWatch = args.includes('--watch');
  const intervalIdx = args.indexOf('--interval');
  const intervalMin = intervalIdx !== -1 ? Number(args[intervalIdx + 1]) || 15 : 15;

  runProbes().catch(console.error);

  if (isWatch) {
    console.log(`[prober] Scheduled to run every ${intervalMin} minute(s).`);
    setInterval(() => {
      runProbes().catch(console.error);
    }, intervalMin * 60 * 1000);
  }
}
