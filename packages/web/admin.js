/**
 * Landfall admin board — vanilla JS, no framework, matches the rest of
 * packages/web. Session state lives entirely server-side (httpOnly cookie);
 * this file never reads or stores the session token itself.
 */
'use strict';

const API = ''; // same-origin; the admin API only ever answers same-origin requests

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  let body = null;
  try { body = await res.json(); } catch { /* empty body, e.g. 204 */ }
  if (!res.ok) {
    const err = new Error((body && body.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Auth ───────────────────────────────────────────────────────────────────

async function checkSession() {
  try {
    const me = await api('/api/v1/admin/me');
    showBoard(me.username);
  } catch {
    showLogin();
  }
}

function showLogin() {
  $('#loginPanel').hidden = false;
  $('#board').hidden = true;
  $('#topActions').innerHTML = '';
}

function showBoard(username) {
  $('#loginPanel').hidden = true;
  $('#board').hidden = false;
  $('#whoami').textContent = username;
  $('#topActions').innerHTML = '<button class="dash-btn dash-btn--ghost" id="logoutBtn">Sign out</button>';
  $('#logoutBtn').addEventListener('click', async () => {
    await api('/api/v1/admin/logout', { method: 'POST' }).catch(() => {});
    location.reload();
  });
  loadHealth();
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('#loginError');
  errEl.hidden = true;
  try {
    const { username } = await api('/api/v1/admin/login', {
      method: 'POST',
      body: JSON.stringify({
        username: $('#loginUsername').value,
        password: $('#loginPassword').value,
      }),
    });
    $('#loginPassword').value = '';
    showBoard(username);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});

// ── Tabs ───────────────────────────────────────────────────────────────────

$$('.admin-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.admin-tab').forEach(b => b.classList.toggle('is-on', b === btn));
    $$('.admin-panel').forEach(p => { p.hidden = p.id !== `tab-${btn.dataset.tab}`; });
    if (btn.dataset.tab === 'payments' && !paymentsLoaded) loadPayments();
    if (btn.dataset.tab === 'anchors') loadAnchors();
  });
});

// ── Backend health ───────────────────────────────────────────────────────────

async function loadHealth() {
  let data;
  try {
    data = await api('/api/v1/admin/health');
  } catch (err) {
    $('#healthStats').innerHTML = `<div class="admin-stat admin-stat--error">Could not load health: ${esc(err.message)}</div>`;
    return;
  }

  const scan = data.latestScan;
  $('#healthStats').innerHTML = [
    stat('DB round-trip', `${data.dbLatencyMs} ms`),
    stat('Latest scan', scan ? fmtDate(scan.finishedAt) : 'never'),
    stat('Staleness', scan ? `${scan.staleHours}h` : '—'),
    stat('Oracle last publish', data.oracle ? fmtDate(data.oracle.publishedAt) : 'never published'),
  ].join('');

  $('#scansTable tbody').innerHTML = data.recentScans.map(s => `
    <tr>
      <td class="mono">${s.id}</td>
      <td>${fmtDate(s.startedAt)}</td>
      <td>${fmtDate(s.finishedAt)}</td>
      <td><span class="admin-badge admin-badge--${s.status === 'finished' ? 'ok' : 'warn'}">${esc(s.status)}</span></td>
      <td class="num">${s.accountsSeen ?? '—'}</td>
      <td class="mono">${esc(s.horizon)}</td>
    </tr>`).join('') || emptyRow(6);

  $('#tableSizes tbody').innerHTML = Object.entries(data.approxRowCounts)
    .map(([name, count]) => `<tr><td class="mono">${esc(name)}</td><td class="num">${count.toLocaleString()}</td></tr>`)
    .join('');

  $('#cursorsTable tbody').innerHTML = data.resumeCursors.map(c => `
    <tr>
      <td class="mono">${esc(c.stream)}</td>
      <td class="mono">${esc(c.key.slice(0, 12))}…</td>
      <td class="mono">${esc(c.cursor.slice(0, 16))}…</td>
      <td>${fmtDate(c.updatedAt)}</td>
    </tr>`).join('') || emptyRow(4);
}

function stat(label, value) {
  return `<div class="admin-stat"><span class="admin-stat__label">${esc(label)}</span><span class="admin-stat__value">${esc(value)}</span></div>`;
}
function emptyRow(cols) {
  return `<tr><td colspan="${cols}" class="admin-empty-row">Nothing yet.</td></tr>`;
}

// ── Payment browser ───────────────────────────────────────────────────────────

let paymentsLoaded = false;
let paymentsCursor = null;
let paymentsDirection = '';

async function loadPayments(append = false) {
  paymentsLoaded = true;
  const limit = Number($('#paymentsLimit').value);
  const params = new URLSearchParams({ limit: String(limit) });
  if (paymentsDirection) params.set('direction', paymentsDirection);
  if (append && paymentsCursor) params.set('before', paymentsCursor);

  const data = await api(`/api/v1/admin/payments?${params}`);
  const rows = data.payments.map(p => `
    <tr>
      <td class="mono">${esc(p.id)}</td>
      <td class="admin-nowrap">${fmtDate(p.createdAt)}</td>
      <td class="mono">${esc(p.source)}</td>
      <td class="mono">${esc(p.opType)}</td>
      <td class="mono" title="${esc(p.from)}">${esc(p.fromDomain || short(p.from))}</td>
      <td class="mono" title="${esc(p.to)}">${esc(p.toDomain || short(p.to))}</td>
      <td class="num mono">${esc(p.amount)}</td>
      <td class="mono" title="${esc(p.asset)}">${esc(shortAsset(p.asset))}</td>
      <td class="mono" title="${esc(p.memo || '')}">${esc(shortMemo(p.memo))}</td>
      <td>${p.isDust ? '<span class="admin-badge admin-badge--warn">dust</span>' : ''}</td>
      <td><a href="https://stellar.expert/explorer/public/tx/${esc(p.txHash)}" target="_blank" rel="noopener">↗</a></td>
    </tr>`).join('');

  $('#paymentsBody').innerHTML = append ? $('#paymentsBody').innerHTML + rows : (rows || emptyRow(11));
  paymentsCursor = data.nextCursor;
  $('#paymentsMore').hidden = !paymentsCursor;
  $('#paymentsCount').textContent = `${$('#paymentsBody').children.length} row(s) shown`;
}
function short(account) { return account ? `${account.slice(0, 4)}…${account.slice(-4)}` : '—'; }

// Non-native assets are 'CODE:ISSUER' with ISSUER a full 56-char Stellar
// account id - shown in full it blows out the table width and pushes the
// dust/tx columns off-screen. Truncate the issuer (never the code, that's
// the part a human actually reads) and keep the full value in a title
// tooltip, same pattern as the From/To columns - the point of this table
// is to let an admin tell two same-code, different-issuer assets apart,
// which the public dashboard's code-only view can't do.
function shortAsset(asset) {
  if (!asset || asset === 'native') return asset || '—';
  const i = asset.indexOf(':');
  if (i === -1) return asset;
  const code = asset.slice(0, i);
  const issuer = asset.slice(i + 1);
  return issuer.length > 10 ? `${code}:${issuer.slice(0, 4)}…${issuer.slice(-4)}` : asset;
}

// Hash memos (SEP-24 correlation ids) are 64 hex chars - truncate the same
// way, full value stays in the title tooltip.
function shortMemo(memo) {
  return memo && memo.length > 20 ? `${memo.slice(0, 10)}…${memo.slice(-6)}` : (memo || '—');
}

$$('.filters [data-dir]', $('#tab-payments')).forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.filters [data-dir]', $('#tab-payments')).forEach(b => b.classList.toggle('is-on', b === btn));
    paymentsDirection = btn.dataset.dir;
    paymentsCursor = null;
    loadPayments();
  });
});
$('#paymentsRefresh').addEventListener('click', () => { paymentsCursor = null; loadPayments(); });
$('#paymentsLimit').addEventListener('change', () => { paymentsCursor = null; loadPayments(); });
$('#paymentsMore').addEventListener('click', () => loadPayments(true));

// ── Anchor management ─────────────────────────────────────────────────────────

async function loadAnchors() {
  const data = await api('/api/v1/admin/anchors');
  $('#anchorsTable tbody').innerHTML = data.anchors.map(a => `
    <tr data-domain="${esc(a.domain)}">
      <td class="mono">${esc(a.domain)}</td>
      <td><span class="admin-badge admin-badge--${a.active ? 'ok' : 'warn'}">${a.active ? 'active' : 'paused'}</span></td>
      <td class="mono">${esc(a.addedBy || '—')}</td>
      <td>${esc(a.notes || '—')}</td>
      <td>${fmtDate(a.updatedAt)}</td>
      <td class="admin-row-actions">
        <button class="dash-btn dash-btn--ghost" data-action="toggle">${a.active ? 'Pause' : 'Resume'}</button>
        <button class="dash-btn dash-btn--ghost" data-action="remove">Remove</button>
      </td>
    </tr>`).join('') || emptyRow(6);
}

$('#anchorsTable').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const row = btn.closest('tr');
  const domain = row.dataset.domain;
  if (btn.dataset.action === 'remove') {
    if (!confirm(`Remove ${domain} from the tracked list? It stays untouched in the seed anchors.json file.`)) return;
    await api(`/api/v1/admin/anchors/${encodeURIComponent(domain)}`, { method: 'DELETE' });
  } else {
    const isActive = row.querySelector('.admin-badge--ok') !== null;
    await api(`/api/v1/admin/anchors/${encodeURIComponent(domain)}`, {
      method: 'PATCH',
      body: JSON.stringify({ active: !isActive }),
    });
  }
  loadAnchors();
});

$('#addAnchorForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('#addAnchorError');
  errEl.hidden = true;
  try {
    await api('/api/v1/admin/anchors', {
      method: 'POST',
      body: JSON.stringify({ domain: $('#newDomain').value.trim(), notes: $('#newNotes').value.trim() }),
    });
    $('#newDomain').value = '';
    $('#newNotes').value = '';
    loadAnchors();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});

checkSession();
