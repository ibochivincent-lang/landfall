/**
 * api/_lib/webhook-redelivery.js
 *
 * Drains and retries the webhook dead-letter queue.
 * Shared between CLI script and authenticated admin route.
 *
 * Author: ibochivincent-lang
 */

import { createHmac } from 'node:crypto';
import { assertPublicHostname } from './net-guard.js';

const MAX_AGE_HOURS = 48;
const MAX_PER_RUN = 100;
const DELIVERY_TIMEOUT_MS = 5000;

function sign(secret, payloadJson) {
  return 'sha256=' + createHmac('sha256', secret).update(payloadJson).digest('hex');
}

async function deliverOnce(targetUrl, secret, payload, timeoutMs = DELIVERY_TIMEOUT_MS) {
  const payloadJson = JSON.stringify(payload);
  try {
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Landfall-Event': payload.event,
        'X-Landfall-Signature': sign(secret, payloadJson),
        'X-Landfall-Redelivery': 'true',
      },
      body: payloadJson,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: null };
  }
}

export async function redeliverFailedWebhooks(pool, opts = {}) {
  const maxAgeHours = opts.maxAgeHours ?? MAX_AGE_HOURS;
  const maxPerRun = opts.maxPerRun ?? MAX_PER_RUN;
  const dryRun = Boolean(opts.dryRun);

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
    [String(maxAgeHours), maxPerRun],
  );

  if (rows.length === 0) {
    return {
      replayed: 0,
      delivered: 0,
      failed: 0,
      skipped: 0,
      message: 'No replayable failed deliveries. Nothing to do.',
    };
  }

  if (dryRun) {
    return {
      replayed: rows.length,
      delivered: 0,
      failed: 0,
      skipped: 0,
      dryRun: true,
      deliveries: rows.map((r) => ({
        id: r.id,
        event: r.event,
        accountOrDomain: r.domain ?? r.account_id,
        webhookId: r.webhook_id,
      })),
    };
  }

  let delivered = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of rows) {
    try {
      await assertPublicHostname(new URL(row.target_url).hostname);
    } catch (err) {
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

  return {
    replayed: rows.length,
    delivered,
    failed,
    skipped,
    message: `Replayed ${rows.length} failed deliver(ies): ${delivered} delivered, ${failed} still failing, ${skipped} skipped.`,
  };
}
