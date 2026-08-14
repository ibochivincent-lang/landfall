/**
 * dispatch-webhooks.mjs
 *
 * Runs after every scan (.github/workflows/scan.yml, right after
 * scan-to-api.mjs). Diffs the two most recent scans' per-account liveness
 * state; for every account that just transitioned into "dark", HMAC-signs
 * and POSTs a payload to every active, subscribed webhook.
 *
 * No-ops cleanly (exit 0, clear log line) when DATABASE_URL is unset or
 * there isn't yet a prior scan to diff against — this project's stated
 * "failures are visible" rule means that should be a log line, not silence.
 *
 * Can also be run manually: node scripts/dispatch-webhooks.mjs
 */

import { createHmac } from 'node:crypto';
import { assertPublicHostname } from '../api/_lib/net-guard.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.log('DATABASE_URL not set — skipping webhook dispatch.');
  process.exit(0);
}

// Imported lazily, after the DATABASE_URL guard above, so this script has
// zero dependency on `pg` being installed on the no-op path.
const { default: pg } = await import('pg');
const { Pool } = pg;

// Mirrors api/[...path].js's pool() — see the comment there for why sslmode
// is stripped and rejectUnauthorized is false (Supabase pooler TLS).
const poolConnectionString = DATABASE_URL.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, '');
const pool = new Pool({
  connectionString: poolConnectionString,
  max: 2,
  connectionTimeoutMillis: 8_000,
  ssl: { rejectUnauthorized: false },
});

const RETRY_DELAYS_MS = [0, 1000, 3000];
const DELIVERY_TIMEOUT_MS = 5000;

function sign(secret, payloadJson) {
  return 'sha256=' + createHmac('sha256', secret).update(payloadJson).digest('hex');
}

async function deliver(webhook, payload) {
  const payloadJson = JSON.stringify(payload);
  const signature = sign(webhook.secret, payloadJson);

  let lastStatus = null;
  for (let attempt = 1; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (RETRY_DELAYS_MS[attempt - 1] > 0) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]));
    }
    try {
      const res = await fetch(webhook.target_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Landfall-Event': payload.event,
          'X-Landfall-Signature': signature,
        },
        body: payloadJson,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      lastStatus = res.status;
      if (res.ok) return { status: 'delivered', attempts: attempt, responseStatus: res.status };
    } catch {
      lastStatus = null;
    }
  }
  return { status: 'failed', attempts: RETRY_DELAYS_MS.length, responseStatus: lastStatus };
}

async function main() {
  const { rows: scans } = await pool.query(
    `SELECT id FROM scans WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 2`,
  );
  if (scans.length < 2) {
    console.log('Fewer than 2 finished scans — nothing to diff yet. Skipping.');
    return;
  }
  const [currentScanId, previousScanId] = [scans[0].id, scans[1].id];

  const { rows: current } = await pool.query(
    `SELECT account_id, state FROM account_metrics WHERE scan_id = $1`,
    [currentScanId],
  );
  const { rows: previous } = await pool.query(
    `SELECT account_id, state FROM account_metrics WHERE scan_id = $1`,
    [previousScanId],
  );
  const previousState = new Map(previous.map((r) => [r.account_id, r.state]));

  const { rows: accountDomains } = await pool.query(
    `SELECT account_id, domain FROM anchor_accounts`,
  );
  const domainByAccount = new Map(accountDomains.map((r) => [r.account_id, r.domain]));

  const transitions = current.filter(
    (r) => r.state === 'dark' && previousState.get(r.account_id) && previousState.get(r.account_id) !== 'dark',
  );

  if (!transitions.length) {
    console.log('No dark transitions this scan.');
    return;
  }

  const { rows: webhooks } = await pool.query(
    `SELECT id, target_url, secret FROM user_webhooks WHERE active = true AND 'anchor.dark' = ANY(events)`,
  );

  let delivered = 0;
  let failed = 0;

  for (const t of transitions) {
    const domain = domainByAccount.get(t.account_id) || null;
    for (const webhook of webhooks) {
      let hostname;
      try {
        hostname = new URL(webhook.target_url).hostname;
        // Re-check at delivery time, not just at registration time — DNS
        // can be repointed after a webhook is registered (rebinding), so a
        // one-time check at POST /developer/webhooks isn't sufficient alone.
        await assertPublicHostname(hostname);
      } catch (err) {
        failed++;
        await pool.query(
          `INSERT INTO webhook_deliveries (webhook_id, event, account_id, domain, status, attempts, response_status)
           VALUES ($1, 'anchor.dark', $2, $3, 'failed', 0, NULL)`,
          [webhook.id, t.account_id, domain],
        ).catch(() => {});
        console.error(`Skipped delivery to webhook ${webhook.id}: ${err.message}`);
        continue;
      }

      const payload = {
        event: 'anchor.dark',
        account: t.account_id,
        domain,
        previousState: previousState.get(t.account_id),
        currentState: 'dark',
        scanId: currentScanId,
        occurredAt: new Date().toISOString(),
      };

      const result = await deliver(webhook, payload);
      if (result.status === 'delivered') delivered++; else failed++;

      await pool.query(
        `INSERT INTO webhook_deliveries (webhook_id, event, account_id, domain, status, attempts, response_status)
         VALUES ($1, 'anchor.dark', $2, $3, $4, $5, $6)`,
        [webhook.id, t.account_id, domain, result.status, result.attempts, result.responseStatus],
      ).catch(() => {});
    }
  }

  console.log(`Dispatched ${transitions.length} dark-transition webhook(s): ${delivered} delivered, ${failed} failed.`);
}

try {
  await main();
} catch (err) {
  console.error('Webhook dispatch failed:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
