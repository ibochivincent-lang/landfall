#!/usr/bin/env node
// ===========================================================
// Landfall — raise an alert when the hourly scan degrades
//
// The problem this exists for: almost every step in scan.yml is
// `continue-on-error`, deliberately. A Horizon hiccup in the cross-chain
// scan must not block the snapshot commit, and a blocked scan still has an
// audit artifact worth publishing. The cost of that choice is that a step
// can fail every hour for a week and the workflow stays green, because
// nothing was ever wired to notice. `if: failure()` does not help — with
// continue-on-error the job's conclusion is success, so it never fires.
//
// docs/SECURITY_ASSESSMENT.md finding 4 (OWASP A09:2025, Security Logging
// and Alerting Failures). For a project whose entire authority rests on an
// unbroken, current settlement record, a silent stop is as damaging as a
// wrong number — and harder to notice, because nothing looks wrong.
//
// So this reads the outcome of every identified step out of `toJSON(steps)`
// and decides:
//
//   failures, no open alert  -> open one
//   failures, alert open     -> comment, but only if the failing set changed,
//                               so an hourly cron cannot generate 24 comments
//                               a day about the same broken step
//   no failures, alert open  -> close it, because recovery is the other half
//                               of an alert nobody should have to check by hand
//   no failures, none open   -> say nothing
//
// Never exits non-zero for an alerting problem. Failing the job because the
// alerter could not reach the API would convert a missing notification into a
// broken pipeline, which is strictly worse than the gap it is reporting.
//
// Usage (from the workflow):
//   STEPS_JSON='${{ toJSON(steps) }}' GITHUB_TOKEN=... node scripts/alert-on-failure.mjs
// ===========================================================

const TITLE = 'Hourly scan is degraded';
const LABEL = 'scan-alert';

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const runId = process.env.GITHUB_RUN_ID;
const server = process.env.GITHUB_SERVER_URL || 'https://github.com';
const api = process.env.GITHUB_API_URL || 'https://api.github.com';

/** Step outcomes, as GitHub reports them. Only steps with an `id` appear. */
export function failedSteps(stepsJson) {
  let steps;
  try {
    steps = JSON.parse(stepsJson || '{}');
  } catch {
    return [];
  }
  // JSON.parse('null') is null, and Object.entries(null) throws — which would
  // take the scan job down with the alerter. Arrays and primitives parse fine
  // too and are equally not a steps map.
  if (steps === null || typeof steps !== 'object' || Array.isArray(steps)) return [];
  return Object.entries(steps)
    .filter(([, v]) => v && v.outcome === 'failure')
    .map(([k]) => k)
    .sort();
}

/** The issue body. Deterministic, so an unchanged failure set produces identical text. */
export function issueBody(failed, { repo: r, runId: id, server: s } = {}) {
  const runUrl = r && id ? `${s}/${r}/actions/runs/${id}` : '(run url unavailable)';
  return [
    `The hourly ledger scan completed with ${failed.length} failing step(s):`,
    '',
    ...failed.map((f) => `- \`${f}\``),
    '',
    `Run: ${runUrl}`,
    '',
    'These steps are `continue-on-error`, so the workflow itself is green and the',
    'snapshot was still committed. That is intended — a partial failure should not',
    'block publishing what did succeed. But it means the published record is now',
    'missing or stale in the areas above, and nothing else will say so.',
    '',
    'Every payload carries `asOf`/`staleHours`, so a consumer reading it directly',
    'can still see the age. This issue exists because nobody is reading it directly.',
    '',
    'It closes automatically on the next run where these steps pass.',
  ].join('\n');
}

async function gh(path, init = {}) {
  const res = await fetch(`${api}${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? null : res.json();
}

async function main() {
  const failed = failedSteps(process.env.STEPS_JSON);

  if (!token || !repo) {
    console.log(`No GITHUB_TOKEN/GITHUB_REPOSITORY — cannot alert. Failing steps: ${failed.join(', ') || 'none'}`);
    return;
  }

  const open = await gh(`/repos/${repo}/issues?state=open&labels=${LABEL}&per_page=1`);
  const existing = Array.isArray(open) ? open[0] : null;

  if (failed.length === 0) {
    if (!existing) {
      console.log('All identified steps passed; no open alert. Nothing to do.');
      return;
    }
    await gh(`/repos/${repo}/issues/${existing.number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: `Recovered: every identified step passed in ${server}/${repo}/actions/runs/${runId}. Closing.` }),
    });
    await gh(`/repos/${repo}/issues/${existing.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
    console.log(`Recovered — closed #${existing.number}.`);
    return;
  }

  const body = issueBody(failed, { repo, runId, server });

  if (!existing) {
    const created = await gh(`/repos/${repo}/issues`, {
      method: 'POST',
      body: JSON.stringify({ title: `${TITLE}: ${failed.join(', ')}`, body, labels: [LABEL] }),
    });
    console.log(`Opened #${created.number} for: ${failed.join(', ')}`);
    return;
  }

  // Comment only when the failing set changed. An hourly cron against a
  // persistently broken step would otherwise post 24 identical comments a day,
  // which trains everyone to ignore the label — the failure mode an alert is
  // supposed to prevent.
  const previously = (existing.title.slice(TITLE.length + 2) || '').split(', ').filter(Boolean).sort();
  if (previously.join(',') === failed.join(',')) {
    console.log(`#${existing.number} already open for the same steps (${failed.join(', ')}). Not commenting.`);
    return;
  }

  await gh(`/repos/${repo}/issues/${existing.number}`, {
    method: 'PATCH',
    body: JSON.stringify({ title: `${TITLE}: ${failed.join(', ')}` }),
  });
  await gh(`/repos/${repo}/issues/${existing.number}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
  console.log(`Updated #${existing.number}: ${previously.join(', ') || 'none'} -> ${failed.join(', ')}`);
}

// Only run when invoked directly, so the tests can import the pure helpers.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('alert-on-failure.mjs')) {
  main().catch((err) => {
    // Deliberately exit 0: see the header. A broken alerter must not break the scan.
    console.error(`[alert-on-failure] ${err.message}`);
  });
}
