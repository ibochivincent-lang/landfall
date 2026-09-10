/**
 * api/routes/trust-check.js
 *
 * Route controller for Landfall Trust Check: counterparty risk analysis on Stellar addresses.
 * Author: ibochivincent-lang
 */

import { json, readJsonBody, clientIp, rateLimit } from '../_lib/helpers.js';

export async function handleTrustCheckRoute(req, res, db, parts, joined, context = {}) {
  const { trustCheckResolveAddress, trustCheckFetchInput, analyzeTrustCheck } = context;

  // GET /api/v1/trust-check?address=G...|MED...|C...|txHash
  if (req.method === 'GET' && joined === 'v1/trust-check') {
    try {
      const url = new URL(req.url, `https://${req.headers.host}`);
      const raw = url.searchParams.get('address') || '';

      const address = await trustCheckResolveAddress(raw);
      if (!address) {
        return json(res, 400, { error: 'address must be a Stellar public key (G...), Muxed Account (MED...), Contract (C...), or transaction hash.' }, 0);
      }

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

  // POST /api/v1/trust-check/batch
  if (req.method === 'POST' && joined === 'v1/trust-check/batch') {
    try {
      const body = await readJsonBody(req);
      const addresses = Array.isArray(body.addresses) ? body.addresses : null;
      if (!addresses || addresses.length === 0) {
        return json(res, 400, { error: 'Body must include a non-empty "addresses" array.' }, 0);
      }
      if (addresses.length > 25) {
        return json(res, 400, { error: 'At most 25 addresses per batch call.' }, 0);
      }

      if (db) {
        const bucket = `trustcheck:batch:${clientIp(req)}`;
        const { allowed } = await rateLimit(db, bucket, 10);
        if (!allowed) return json(res, 429, { error: 'Too many batch checks. Try again in a minute.' }, 0);
      }

      const results = [];
      for (const raw of addresses) {
        try {
          const address = await trustCheckResolveAddress(String(raw || ''));
          if (!address) {
            results.push({ raw, ok: false, error: 'Invalid Stellar address' });
            continue;
          }
          const input = await trustCheckFetchInput(address, new Date().toISOString());
          results.push({ raw, address, ok: true, report: analyzeTrustCheck(input) });
        } catch (err) {
          results.push({
            raw,
            ok: false,
            error: err.status === 404 ? 'Account not found' : 'Horizon lookup error',
          });
        }
      }

      return json(res, 200, { ok: true, count: results.length, results }, 30);
    } catch (err) {
      return json(res, 500, { error: err.message }, 0);
    }
  }

  return false;
}
