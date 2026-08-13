/**
 * Vercel edge-of-the-site proxy for the Landfall API.
 *
 * Why this file exists rather than the dashboard calling the API directly:
 *
 *   1. Content Security Policy. vercel.json ships `connect-src 'self'`. A
 *      cross-origin API means widening that to name a host, which is a change
 *      most people forget to make and then debug for an hour.
 *   2. CORS. Same-origin means no preflight on every paginated request.
 *   3. The API host is configuration, not code. Set LANDFALL_API_URL in the
 *      Vercel project settings and redeploy; nothing in the repository names
 *      your infrastructure.
 *
 * This proxy is deliberately transparent. It does not cache, reshape, or
 * summarise. Every caveat the API attaches to a number — `asOf`, `staleHours`,
 * the return-rate note — has to arrive at the browser intact, and the surest
 * way to guarantee that is to have nothing in the middle that could drop it.
 */

const UPSTREAM = (process.env.LANDFALL_API_URL || '').replace(/\/$/, '');

/** Read-only service. Anything else is a bug or an attempt. */
const ALLOWED = new Set(['GET', 'HEAD', 'OPTIONS']);

export default async function handler(req, res) {
  if (!ALLOWED.has(req.method)) {
    res.setHeader('allow', 'GET, HEAD, OPTIONS');
    return json(res, 405, { error: 'Landfall is read-only.' });
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('allow', 'GET, HEAD, OPTIONS');
    return res.status(204).end();
  }

  if (!UPSTREAM) {
    // Honest failure. The dashboard renders this in its "no API connected"
    // panel, which is the correct thing for a visitor to see — better than a
    // page that looks fine and is quietly showing nothing.
    return json(res, 503, {
      error: 'No API configured for this deployment.',
      detail:
        'Set LANDFALL_API_URL in the Vercel project environment to the origin ' +
        'of a running Landfall API, then redeploy. See docs/deployment.md.',
    });
  }

  // req.url normally arrives as the browser sent it, `/api/v1/...` and query
  // included. Normalising rather than trusting it costs one line and survives
  // a platform that decides to strip the mount prefix.
  const incoming = req.url || '/';
  const path = incoming.startsWith('/api/') ? incoming
             : '/api' + (incoming.startsWith('/') ? incoming : '/' + incoming);
  const target = UPSTREAM + path;

  try {
    const upstream = await fetch(target, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });

    const body = await upstream.text();

    res.status(upstream.status);
    res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json');
    // Pass the upstream's own cache policy through. The API sets 60s on
    // successful reads and no-store on errors; second-guessing it here would
    // mean a stale error page or a needlessly hot database.
    const cc = upstream.headers.get('cache-control');
    if (cc) res.setHeader('cache-control', cc);
    res.setHeader('x-content-type-options', 'nosniff');
    return res.send(body);
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return json(res, 502, {
      error: timedOut ? 'The API did not respond in time.' : 'Could not reach the API.',
      detail: String(err?.message || err),
    });
  }
}

function json(res, status, body) {
  res.status(status);
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  return res.send(JSON.stringify(body, null, 2));
}
