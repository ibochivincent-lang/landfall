/**
 * redeliver-webhooks.mjs
 *
 * Drains the webhook dead-letter queue.
 *
 * dispatch-webhooks.mjs gives each delivery three attempts across about four
 * seconds and then gives up. That is a narrow window — a subscriber
 * restarting a process during it used to lose a degradation notification
 * permanently, with no way to ever hand it back. Since migration 014 the
 * failed row carries the payload that was sent, so it can be.
 *
 * What this deliberately does NOT do:
 *
 *   * Rebuild the event. It resends the stored payload verbatim. The account
 *     may have changed state again since it failed; delivering current state
 *     under the original event's `occurredAt` would be a fresh inaccuracy
 *     replacing the one being fixed.
 *
 *   * Rewrite the original row. A replay is a new row pointing at the
 *     delivery it retries, so "failed, then succeeded on replay" stays two
 *     legible facts rather than one edited one.
 *
 *   * Retry forever. Past MAX_AGE_HOURS a missed degradation is stale enough
 *     that the API is the better answer, and re-POSTing week-old events to an
 *     endpoint that has been down that long is noise, not recovery.
 *
 * No-ops cleanly when DATABASE_URL is unset, same as the dispatcher.
 *
 *   node scripts/redeliver-webhooks.mjs
 *   node scripts/redeliver-webhooks.mjs --dry-run
 */

import { createHmac } from 'node:crypto';
import { assertPublicHostname } from '../api/_lib/net-guard.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.log('DATABASE_URL not set — skipping webhook redelivery.');
  process.exit(0);
}

const DRY_RUN = process.argv.includes('--dry-run');

/** Older than this and the API is the better answer than a late webhook. */
const MAX_AGE_HOURS = 48;
/** Bounded so one run cannot hammer a recovering endpoint. */
const MAX_PER_RUN = 100;
const DELIVERY_TIMEOUT_MS = 5000;

const { default: pg } = await import('pg');
const { Pool } = pg;

const poolConnectionString = DATABASE_URL.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, '');
// Mirrors the host detection in api/[...path].js's pool(). Hardcoding
// `ssl` made these scripts unable to talk to a local Postgres at all — it
// refuses TLS — so the delivery path could only ever be exercised against a
// hosted database. A dead-letter worker that cannot be run locally is one
// that gets tested in production.
const needsTls = /sslmode=require|neon\.tech|supabase\.|railway\.app|render\.com|rds\.amazonaws/.test(DATABASE_URL);

const pool = new Pool({
  connectionString: poolConnectionString,
  max: 2,
  connectionTimeoutMillis: 8_000,
  // rejectUnauthorized: false because hosted poolers present certs issued by
  // intermediaries Node does not ship. Encrypted; chain unverified.
  ssl: needsTls ? { rejectUnauthorized: false } : false,
});

function sign(secret, payloadJson) {
  return 'sha256=' + createHmac('sha256', secret).update(payloadJson).digest('hex');
}

/**
 * One attempt only. This is already the retry — a nested retry loop here
 * would turn a slow endpoint into a thundering herd on every scheduled run.
 */
async function deliverOnce(targetUrl, secret, payload) {
  const payloadJson = JSON.stringify(payload);
  try {
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Landfall-Event': payload.event,
        'X-Landfall-Signature': sign(secret, payloadJson),
        // Lets a subscriber distinguish a replay from a first delivery, so an
        // idempotent handler can skip work it already did.
        'X-Landfall-Redelivery': 'true',
      },
      body: payloadJson,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: null };
  }
}

async function main() {
  // Candidates: failed, still has its payload, inside the window, and not
  // already replayed successfully. The NOT EXISTS is what stops a permanently
  // dead endpoint accumulating one replay per run forever.
  const { rows } = await pool.query(
    `SELECT d.id, d.event, d.account_id, d.domain, d.payload,
            w.id AS webhook_id, w.target_url, w.secret, w.active
       FROM webhook_deliveries d
       JOIN user_webhooks w ON w.id = d.webhook_id
      WHERE d.status = 'failed'
        AND d.payload IS NOT NULL
        AND d.replay_of IS NULL
        AND d.created_at > now() - ($1 || ' hours')::interval
        AND w.active
        AND NOT EXISTS (
          SELECT 1 FROM webhook_deliveries r
           WHERE r.replay_of = d.id AND r.status = 'delivered'
        )
      ORDER BY d.created_at ASC
      LIMIT $2`,
    [String(MAX_AGE_HOURS), MAX_PER_RUN],
  );

  if (rows.length === 0) {
    console.log('No replayable failed deliveries. Nothing to do.');
    return;
  }

  if (DRY_RUN) {
    console.log(`${rows.length} replayable failed deliver(ies):`);
    for (const r of rows) {
      console.log(`  delivery ${r.id}  ${r.event}  ${r.domain ?? r.account_id}  -> webhook ${r.webhook_id}`);
    }
    return;
  }

  let delivered = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of rows) {
    // Re-checked at replay time, not trusted from when the subscription was
    // created: a hostname that resolved publicly then may resolve to a
    // private address now, and this path would follow it.
    try {
      // The guard takes a hostname, not a URL — handing it the whole URL
      // makes every check fail as an unresolvable name, which reads as
      // "blocked" and would have silently disabled replay entirely.
      await assertPublicHostname(new URL(row.target_url).hostname);
    } catch (err) {
      console.error(`Skipped replay of delivery ${row.id}: ${err.message}`);
      skipped++;
      continue;
    }

    const result = await deliverOnce(row.target_url, row.secret, row.payload);
    if (result.ok) delivered++; else failed++;

    await pool.query(
      `INSERT INTO webhook_deliveries
         (webhook_id, event, account_id, domain, status, attempts, response_status, payload, replay_of)
       VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8)`,
      [
        row.webhook_id,
        row.event,
        row.account_id,
        row.domain,
        result.ok ? 'delivered' : 'failed',
        result.status,
        JSON.stringify(row.payload),
        row.id,
      ],
    ).catch(() => {});
  }

  console.log(
    `Replayed ${rows.length} failed deliver(ies): ${delivered} delivered, ${failed} still failing, ${skipped} skipped.`,
  );
}

try {
  await main();
} catch (err) {
  console.error('Webhook redelivery failed:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
