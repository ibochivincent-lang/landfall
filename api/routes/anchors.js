/**
 * api/routes/anchors.js
 *
 * Route controller for anchor catalogs, health checks, synthetic probing, badges, and corridors.
 * Author: ibochivincent-lang
 */

import { json } from '../_lib/helpers.js';

export async function handleAnchorsRoute(req, res, db, parts, joined, context = {}) {
  const {
    latestScan,
    accountRows,
    computeDomainReliability,
    scanCoverage,
    renderBadgeSvg,
    assetRows,
    corridorRows,
    domainAccounts,
    paymentsPage,
  } = context;

  // GET /api/v1/anchors
  if (joined === 'v1/anchors') {
    const scan = await latestScan(db);
    if (!scan) return json(res, 503, { error: 'No completed scan yet.' }, 0);
    const accounts = await accountRows(db);

    const byDomain = new Map();
    for (const a of accounts) {
      if (!byDomain.has(a.domain)) byDomain.set(a.domain, []);
      byDomain.get(a.domain).push(a);
    }

    const summaries = {};
    for (const [domain, dAccounts] of byDomain.entries()) {
      summaries[domain] = computeDomainReliability(dAccounts);
    }

    const coverage = await scanCoverage(db);

    return json(res, 200, {
      asOf: scan.finishedAt,
      staleHours: scan.staleHours,
      coverage,
      accounts,
      reliability: summaries,
    });
  }

  // GET /api/v1/anchors/:domain/health-check
  if (parts.length === 4 && parts[0] === 'v1' && parts[1] === 'anchors' && parts[3] === 'health-check') {
    const domain = decodeURIComponent(parts[2]).toLowerCase();
    const accounts = (await accountRows(db)).filter(a => a.domain.toLowerCase() === domain);
    if (!accounts.length) return json(res, 404, { error: `No accounts tracked for ${domain}` });

    const rel = computeDomainReliability(accounts);
    return json(res, 200, {
      domain,
      healthy: rel.score >= 55,
      ...rel,
    }, 120);
  }

  // GET /api/v1/anchors/synthetic-health
  if (req.method === 'GET' && joined === 'v1/anchors/synthetic-health') {
    const { rows } = await db.query(
      `SELECT domain, endpoint, status, response_time_ms, ssl_days_remaining, last_probed_at, error_details
       FROM anchor_synthetic_health ORDER BY domain ASC`
    ).catch(() => ({ rows: [] }));
    return json(res, 200, { ok: true, probes: rows }, 60);
  }

  // GET /api/v1/anchors/:domain/synthetic-health
  if (req.method === 'GET' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'anchors' && parts[3] === 'synthetic-health') {
    const domain = decodeURIComponent(parts[2]);
    const { rows } = await db.query(
      `SELECT domain, endpoint, status, response_time_ms, ssl_days_remaining, last_probed_at, error_details
       FROM anchor_synthetic_health WHERE domain = $1 ORDER BY last_probed_at DESC`,
      [domain]
    ).catch(() => ({ rows: [] }));
    return json(res, 200, { ok: true, domain, probes: rows }, 60);
  }

  // GET /api/v1/anchors/:domain/payments
  if (parts.length === 4 && parts[0] === 'v1' && parts[1] === 'anchors' && parts[3] === 'payments') {
    const domain = decodeURIComponent(parts[2]);
    const url = new URL(req.url, `https://${req.headers.host}`);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 50), 1), 500);
    const direction = url.searchParams.get('direction') || null;
    const asset = url.searchParams.get('asset') || null;
    const before = url.searchParams.get('before') || null;

    const accounts = await domainAccounts(db, domain);
    if (!accounts.length) return json(res, 404, { error: `No accounts for ${domain}` });

    return json(res, 200, await paymentsPage(db, { accounts, direction, asset, before, limit }));
  }

  // GET /api/v1/anchors/:domain/slippage (Item 5 integration)
  if (parts.length === 4 && parts[0] === 'v1' && parts[1] === 'anchors' && parts[3] === 'slippage') {
    const domain = decodeURIComponent(parts[2]).toLowerCase();
    const { rows } = await db.query(
      `SELECT domain, asset_in, asset_out, quoted_amount, landed_amount, fee_amount,
              slippage_bps, sample_count, recorded_at
         FROM anchor_slippage_metrics
        WHERE domain = $1
        ORDER BY recorded_at DESC LIMIT 50`,
      [domain],
    ).catch(() => ({ rows: [] }));

    if (rows.length === 0) {
      return json(res, 200, {
        domain,
        sampleCount: 0,
        medianSlippageBps: null,
        status: 'suppressed_below_floor',
        note: 'Slippage metrics require matched SEP-38 quotes and on-chain receipts.',
      }, 300);
    }

    const bpsList = rows.map(r => Number(r.slippage_bps)).sort((a, b) => a - b);
    const medianBps = bpsList[Math.floor(bpsList.length / 2)];
    return json(res, 200, {
      domain,
      sampleCount: rows.length,
      medianSlippageBps: medianBps,
      history: rows,
    }, 300);
  }

  // GET /api/v1/badges/:domain.svg
  if (parts.length === 3 && parts[0] === 'v1' && parts[1] === 'badges') {
    const rawDomain = parts[2].replace(/\.svg$/i, '').toLowerCase();
    const domain = decodeURIComponent(rawDomain);
    const accounts = (await accountRows(db)).filter(a => a.domain.toLowerCase() === domain);
    const rel = computeDomainReliability(accounts);

    const svg = renderBadgeSvg(domain, rel.score, rel.grade);
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).send(svg);
  }

  // GET /api/v1/assets
  if (joined === 'v1/assets') {
    return json(res, 200, { assets: await assetRows(db) });
  }

  // GET /api/v1/corridors
  if (joined === 'v1/corridors') {
    const corridors = await corridorRows(db);
    return json(res, 200, { corridors }, 300);
  }

  return false;
}
