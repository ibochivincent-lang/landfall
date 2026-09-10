/**
 * api/routes/fraud-reports.js
 *
 * Route controller for community fraud reports, on-chain transaction evidence verification,
 * cryptographic disputes, attestations, and Sentinel AI investigations.
 * Author: ibochivincent-lang
 */

import { json, readJsonBody, clientIp, sha256Hex } from '../_lib/helpers.js';

export async function handleFraudReportsRoute(req, res, db, parts, joined, context = {}) {
  const {
    enforceAuthRateLimit,
    validateFraudSubmission,
    fraudVerifyEvidence,
    verifyDispute,
    reportRowsForSubject,
    investigateReport,
  } = context;

  // POST /api/v1/fraud-reports
  if (req.method === 'POST' && joined === 'v1/fraud-reports') {
    if (enforceAuthRateLimit && (await enforceAuthRateLimit(req, res, db, 'fraud-report', 5))) return true;

    const body = await readJsonBody(req);
    const draft = {
      subject: body.subject,
      evidenceTxHash: body.evidenceTxHash,
      category: body.category,
      note: body.note,
      reporterAddress: body.reporterAddress,
    };

    const shape = validateFraudSubmission(draft);
    if (!shape.ok) return json(res, 400, { error: shape.message, reason: shape.reason }, 0);

    const subject = String(draft.subject).trim();
    const txHash = String(draft.evidenceTxHash).trim().toLowerCase();

    let evidence;
    try {
      evidence = await fraudVerifyEvidence(txHash, subject);
    } catch (err) {
      console.error('[fraud-reports]', err.message);
      return json(res, 502, { error: 'Could not reach Horizon to verify that transaction. Try again shortly.' }, 0);
    }
    if (!evidence.ok) return json(res, 400, { error: evidence.message, reason: 'evidence-not-verified' }, 0);

    try {
      const { rows } = await db.query(
        `INSERT INTO fraud_reports (subject, evidence_tx_hash, category, note, reporter_ip_hash)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, subject, evidence_tx_hash, category, note, status, submitted_at`,
        [subject, txHash, String(draft.category).trim(), String(draft.note).trim(), sha256Hex(clientIp(req))],
      );
      const row = rows[0];
      return json(res, 201, {
        ok: true,
        id: String(row.id),
        subject: row.subject,
        status: row.status,
        submittedAt: row.submitted_at.toISOString(),
        note:
          'Recorded as a claim, and shown as one. Landfall verified only that the cited transaction exists ' +
          'and involves this address — it has not established what happened between you and them, and will ' +
          'not say that it has. The reported party can attach a response.',
      }, 0);
    } catch (err) {
      if (err.message?.includes('unique') || err.message?.includes('duplicate')) {
        return json(res, 409, { error: 'You have already filed a report citing this transaction for this address.' }, 0);
      }
      throw err;
    }
  }

  // POST /api/v1/fraud-reports/:id/dispute
  if (req.method === 'POST' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'fraud-reports' && parts[3] === 'dispute') {
    if (enforceAuthRateLimit && (await enforceAuthRateLimit(req, res, db, 'fraud-dispute', 10))) return true;

    const reportId = Number(parts[2]);
    if (!Number.isInteger(reportId) || reportId <= 0) return json(res, 400, { error: 'Invalid report id.' }, 0);

    const { rows: reportRows } = await db.query(
      'SELECT id, subject, category, evidence_tx_hash, status FROM fraud_reports WHERE id = $1',
      [reportId],
    );
    const report = reportRows[0];
    if (!report) return json(res, 404, { error: 'Report not found.' }, 0);

    const body = await readJsonBody(req);
    const statement = String(body.statement || '').trim();
    const signature = String(body.signature || '').trim();
    const signedAt = String(body.signedAt || '').trim();

    const verification = await verifyDispute({
      reportId: String(report.id),
      subject: report.subject,
      statement,
      signature,
      signedAt,
    });
    if (!verification.ok) {
      return json(res, 400, { error: verification.message, reason: verification.reason }, 0);
    }

    await db.query(
      `INSERT INTO fraud_disputes (report_id, respondent_address, statement, signature_b64, signed_at, verified_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (report_id) DO UPDATE
         SET statement = EXCLUDED.statement,
             signature_b64 = EXCLUDED.signature_b64,
             signed_at = EXCLUDED.signed_at,
             verified_at = now()`,
      [report.id, report.subject, statement, signature, new Date(signedAt).toISOString()],
    );
    await db.query(`UPDATE fraud_reports SET status = 'disputed', updated_at = now() WHERE id = $1`, [report.id]);

    return json(res, 200, {
      ok: true,
      reportId: String(report.id),
      status: 'disputed',
      statement,
      verifiedAt: new Date().toISOString(),
      note: 'Response recorded and verified. It is displayed alongside the original claim.',
    }, 0);
  }

  // GET /api/v1/fraud-reports/:id/attestation
  if (req.method === 'GET' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'fraud-reports' && parts[3] === 'attestation') {
    const reportId = Number(parts[2]);
    if (!Number.isInteger(reportId) || reportId <= 0) return json(res, 400, { error: 'Invalid report id.' }, 0);

    const { rows } = await db.query(
      `SELECT d.report_id, d.respondent_address, d.statement, d.signature_b64, d.signed_at, d.verified_at,
              r.subject, r.category, r.evidence_tx_hash
         FROM fraud_disputes d
         JOIN fraud_reports r ON r.id = d.report_id
        WHERE d.report_id = $1`,
      [reportId],
    );
    const row = rows[0];
    if (!row) return json(res, 404, { error: 'No verified dispute attestation for this report.' }, 0);

    return json(res, 200, {
      reportId: String(row.report_id),
      subject: row.subject,
      category: row.category,
      evidenceTxHash: row.evidence_tx_hash,
      respondentAddress: row.respondent_address,
      statement: row.statement,
      signature: row.signature_b64,
      signedAt: row.signed_at,
      verifiedAt: row.verified_at,
    }, 300);
  }

  // POST /api/v1/fraud-reports/:id/investigate
  if (req.method === 'POST' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'fraud-reports' && parts[3] === 'investigate') {
    if (enforceAuthRateLimit && (await enforceAuthRateLimit(req, res, db, 'fraud-investigate', 5))) return true;

    const reportId = Number(parts[2]);
    if (!Number.isInteger(reportId) || reportId <= 0) return json(res, 400, { error: 'Invalid report id.' }, 0);

    const { rows: reportRows } = await db.query(
      'SELECT id, subject, category, evidence_tx_hash, status FROM fraud_reports WHERE id = $1',
      [reportId],
    );
    const report = reportRows[0];
    if (!report) return json(res, 404, { error: 'Report not found.' }, 0);

    const investigation = await investigateReport(report);
    await db.query(
      `INSERT INTO fraud_investigations (report_id, facts, analysis, created_at)
       VALUES ($1, $2, $3, now())`,
      [report.id, JSON.stringify(investigation.facts), investigation.analysis || null],
    ).catch(() => {});

    return json(res, 200, {
      ok: true,
      reportId: String(report.id),
      investigation,
    }, 0);
  }

  // GET /api/v1/fraud-reports/:id/investigation
  if (req.method === 'GET' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'fraud-reports' && parts[3] === 'investigation') {
    const reportId = Number(parts[2]);
    if (!Number.isInteger(reportId) || reportId <= 0) return json(res, 400, { error: 'Invalid report id.' }, 0);

    const { rows } = await db.query(
      'SELECT facts, analysis, created_at FROM fraud_investigations WHERE report_id = $1 ORDER BY created_at DESC LIMIT 1',
      [reportId],
    );
    const inv = rows[0];
    if (!inv) return json(res, 404, { error: 'No investigation on file for this report.' }, 0);

    return json(res, 200, {
      reportId: String(reportId),
      facts: inv.facts,
      analysis: inv.analysis,
      createdAt: inv.created_at,
    }, 300);
  }

  // GET /api/v1/fraud-reports/:subject
  if (req.method === 'GET' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'fraud-reports') {
    const raw = decodeURIComponent(parts[2]).trim();
    const subject = String(raw).toUpperCase();
    const reports = await reportRowsForSubject(db, subject);
    return json(res, 200, {
      subject,
      count: reports.length,
      reports,
      disclaimer:
        'These are unadjudicated community submissions with verified on-chain counterparty evidence. ' +
        'They represent claims by callers, not findings of fact by Landfall.',
    }, 60);
  }

  return false;
}
