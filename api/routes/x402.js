/**
 * api/routes/x402.js
 *
 * Route controller for x402 payment-gated APIs and payee trust check evaluation.
 * Author: ibochivincent-lang
 */

import { json, readJsonBody, clientIp, rateLimit } from '../_lib/helpers.js';
import { buildPaymentRequiredResponse, verifyX402Payment } from '../_lib/x402-server.js';

export async function handleX402Route(req, res, db, parts, joined, context = {}) {
  // POST /api/v1/corridors/export -- x402 protected premium corridor export
  if (req.method === 'POST' && joined === 'v1/corridors/export') {
    if (!verifyX402Payment(req)) {
      return json(res, 402, buildPaymentRequiredResponse('/api/v1/corridors/export', {
        title: 'Landfall Corridors Intelligence Export',
        description: 'Full unredacted settlement flow matrix across all tracked currency pairs and anchors',
        amount: '100000',
      }), 0);
    }
    const corridors = context.corridorRows ? await context.corridorRows(db) : [];
    return json(res, 200, {
      ok: true,
      exportedAt: new Date().toISOString(),
      tier: 'x402-premium',
      count: corridors.length,
      corridors,
    }, 0);
  }

  // GET /api/v1/dump/ndjson -- x402 protected bulk settlement dump
  if (req.method === 'GET' && joined === 'v1/dump/ndjson') {
    if (!verifyX402Payment(req)) {
      return json(res, 402, buildPaymentRequiredResponse('/api/v1/dump/ndjson', {
        title: 'Landfall Historical NDJSON Dump',
        description: 'Complete streaming ledger snapshot of tracked anchor accounts and reliability metrics',
        amount: '500000',
      }), 0);
    }
    const accounts = context.accountRows ? await context.accountRows(db) : [];
    const lines = accounts.map(a => JSON.stringify(a)).join('\n');
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Content-Disposition': 'attachment; filename="landfall-dump.ndjson"',
      'Cache-Control': 'no-store',
    });
    res.end(lines);
    return true;
  }

  // POST /api/v1/x402/check-payee
  if (req.method === 'POST' && joined === 'v1/x402/check-payee') {
    const body = await readJsonBody(req);
    const accepts = Array.isArray(body.accepts) ? body.accepts : null;
    if (!accepts || accepts.length === 0) {
      return json(res, 400, { error: 'Body must include a non-empty "accepts" array — the same shape as an x402 PaymentRequired response.' }, 0);
    }
    if (accepts.length > 20) {
      return json(res, 400, { error: 'At most 20 payment requirements per call.' }, 0);
    }
    for (const r of accepts) {
      if (typeof r?.network !== 'string' || typeof r?.payTo !== 'string') {
        return json(res, 400, { error: 'Every entry in "accepts" must have at least "network" and "payTo" fields.' }, 0);
      }
    }

    const bucket = `x402check:${clientIp(req)}`;
    const { allowed } = await rateLimit(db, bucket, 20);
    if (!allowed) return json(res, 429, { error: 'Too many checks. Try again in a minute.' }, 0);

    const evaluatePaymentRequirements = context.evaluatePaymentRequirements;
    const trustCheckFetchInput = context.trustCheckFetchInput;
    const analyzeTrustCheck = context.analyzeTrustCheck;

    if (!evaluatePaymentRequirements) {
      return json(res, 500, { error: 'Evaluation engine not configured.' }, 0);
    }

    const results = await evaluatePaymentRequirements(accepts, async (address) => {
      try {
        const input = await trustCheckFetchInput(address, new Date().toISOString());
        return { ok: true, trustCheck: analyzeTrustCheck(input) };
      } catch (err) {
        if (err.status === 404 || err.status === 400) {
          return {
            ok: false,
            retryable: false,
            reason:
              'no account for this address exists on the Stellar network. An address that has never been ' +
              'funded has no settlement history at all — treat this as a reason not to pay, not as a missing check.',
          };
        }
        console.error('[x402]', address, err.message);
        return {
          ok: false,
          retryable: true,
          reason: 'could not reach Horizon to check this payee. This is a temporary failure, not a finding about the address — retry before drawing any conclusion.',
        };
      }
    });

    return json(res, 200, { results }, 0);
  }

  return false;
}
