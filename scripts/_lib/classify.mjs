/**
 * classify.mjs — shared liveness classification, extracted from
 * scan-to-api.mjs so scripts/dispatch-webhooks.mjs's dark-transition diff
 * and scripts/publish-oracle.mjs's published digest are guaranteed to agree
 * with what the dashboard/API actually show — a single copy, not two that
 * can drift apart.
 */

function classify(m) {
  if (!m.hasLifetimeActivity)           return 'no_activity';
  const h = m.hoursSinceLastActivity ?? Infinity;
  if (h <= 72)                          return 'live';
  if (h <= 720)                         return 'slow';
  return 'dark';
}

/** Maps a raw scan-*.json `metrics` entry to the shape dashboard.js/the API expect. */
function toAccountSummary(m) {
  return {
    account:              m.account,
    domain:                m.domain,
    name:                  m.name ?? m.domain,
    state:                 classify(m),
    inbound:               m.inbound?.count  ?? 0,
    outbound:              m.outbound?.count ?? 0,
    returns:               m.refundCount     ?? 0,
    returnRate:            m.refundRate      ?? null,
    hoursSinceActivity:    m.hoursSinceLastActivity ?? null,
    topCounterpartyShare:  m.topCounterpartyShare ?? null,
  };
}

export { classify, toAccountSummary };
