/**
 * api/routes/fiat.js
 *
 * Route controller for fiat confirmations: recipient self-reports of off-chain fiat delivery.
 * Author: ibochivincent-lang
 */

import { json, readJsonBody, clientIp, rateLimit, sha256Hex } from '../_lib/helpers.js';

export async function handleFiatRoute(req, res, db, parts, joined, context = {}) {
  const { evaluateFiatConfirmation } = context;

  // POST /api/v1/fiat-confirmations
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
        return json(res, 409, { error: 'A confirmation has already been submitted for this transfer.' }, 0);
      }
      throw err;
    }

    const submittedAtIso = row.submitted_at.toISOString();
    const claim = { chain: row.chain, reference: row.reference, respondent: row.respondent, outcome: row.outcome, submittedAt: submittedAtIso };
    const preview = evaluateFiatConfirmation ? evaluateFiatConfirmation(claim, { reference: row.reference, observedAt: submittedAtIso }) : { ok: true };

    return json(res, 201, {
      ok: true,
      chain: row.chain,
      reference: row.reference,
      submittedAt: submittedAtIso,
      eligible: preview.ok,
      ineligibleReason: preview.ok ? null : preview.reason,
      note: 'Recorded. Whether this counts as settlement evidence is decided when the next cross-chain scan processes this transfer.',
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
    const preview = evaluateFiatConfirmation ? evaluateFiatConfirmation(claim, { reference: row.reference, observedAt: submittedAtIso }) : { ok: true };

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
      note: 'eligible reflects only the checks that do not depend on the on-chain transfer\'s own timestamp.',
    });
  }

  return false;
}
