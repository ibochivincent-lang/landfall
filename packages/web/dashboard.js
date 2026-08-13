/**
 * Landfall transaction dashboard.
 *
 * Live only. Unlike the landing page, this ships no snapshot: a stale list of
 * "every transaction" would be actively misleading in a way a stale headline
 * figure is not. If the API is unreachable the page says so and shows nothing.
 */
(() => {
  'use strict';

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const API = (
    document.querySelector('meta[name="landfall-api"]')?.content || ''
  ).replace(/\/$/, '');

  const state = {
    domain: null,
    accounts: [],      // account ids for the selected domain
    direction: '',
    asset: '',
    limit: 50,
    cursor: null,
    rows: 0,
  };

  /* ------------------------------------------------------------------ utils */

  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined) n.innerHTML = html;
    return n;
  };

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const short = (a) => (a ? a.slice(0, 4) + '…' + a.slice(-4) : '—');

  /** Group digits without touching the decimals — these are exact values. */
  function amount(v) {
    const [whole, frac] = String(v).split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    if (!frac) return grouped;
    const trimmed = frac.replace(/0+$/, '');
    return trimmed ? grouped + '.' + trimmed : grouped;
  }

  const assetName = (a) => (a === 'native' ? 'XLM' : String(a).split(':')[0]);

  function ago(iso) {
    const ms = Date.now() - Date.parse(iso);
    const m = Math.round(ms / 60000);
    if (m < 60) return m + 'm ago';
    const h = Math.round(m / 60);
    if (h < 48) return h + 'h ago';
    return Math.round(h / 24) + 'd ago';
  }

  async function api(path) {
    const res = await fetch(API + path, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' on ' + path);
    return res.json();
  }

  /* ------------------------------------------------------------------ boot */

  async function boot() {
    // Try live API first, fall back to bundled snapshot.
    let body = null;
    let isSnapshot = false;

    try {
      body = await api('/api/v1/anchors');
      if (!body.accounts?.length) throw new Error('No accounts in response');
    } catch (_liveErr) {
      try {
        const res = await fetch('snapshot.json');
        if (!res.ok) throw new Error('snapshot.json not found');
        body = await res.json();
        isSnapshot = true;
      } catch (snapErr) {
        $('#live').hidden = true;
        $('#offline').hidden = false;
        $('#offlineDetail').textContent = String(snapErr.message || snapErr);
        const f = $('#freshness');
        f.textContent = 'Data unavailable';
        f.className = 'freshness';
        return;
      }
    }

    $('#live').hidden = false;
    $('#offline').hidden = true;
    stampFreshness(body, isSnapshot);
    renderAnchors(body.accounts);
    if (!isSnapshot) loadAssets();
    state.isSnapshot = isSnapshot;

    selectDomain(defaultDomain(body.accounts));
  }

  function stampFreshness(body, isSnapshot) {
    const f = $('#freshness');
    if (isSnapshot) {
      f.textContent = 'Scan · 12 Aug 2026';
      f.className = 'freshness';
      return;
    }
    const h = Number(body.staleHours ?? 0);
    const age = h < 1 ? 'under an hour'
              : h < 48 ? Math.round(h) + 'h'
              : Math.round(h / 24) + 'd';
    f.textContent = 'Live · scan ' + age + ' old';
    f.className = 'freshness is-live';
  }

  /**
   * Which anchor to open on.
   *
   * The strip sorts dark anchors first — they are the finding. But this is the
   * transactions page, and opening it on an anchor with nothing to list means
   * the first thing a visitor sees is an empty table, which reads as a broken
   * page rather than as a dormant anchor. So the strip keeps its ordering and
   * the default selection goes to whichever anchor has the most indexed
   * activity. The dark ones are one click away and visibly labelled.
   */
  function defaultDomain(accounts) {
    const totals = new Map();
    for (const a of accounts) {
      const n = (a.inbound ?? 0) + (a.outbound ?? 0);
      totals.set(a.domain, (totals.get(a.domain) ?? 0) + n);
    }
    let best = accounts[0].domain;
    let most = -1;
    for (const [domain, n] of totals) if (n > most) { most = n; best = domain; }
    return best;
  }

  /* ------------------------------------------------------- anchor selection */

  let ANCHORS = [];

  function renderAnchors(accounts) {
    ANCHORS = accounts;
    const byDomain = new Map();
    for (const a of accounts) {
      const g = byDomain.get(a.domain) ?? { domain: a.domain, accounts: [], dark: 0, live: 0 };
      g.accounts.push(a);
      if (a.state === 'dark') g.dark++;
      if (a.state === 'live') g.live++;
      byDomain.set(a.domain, g);
    }

    const strip = $('#anchorStrip');
    strip.innerHTML = '';
    // Dark anchors first — they are the reason anyone opens this page.
    const groups = [...byDomain.values()].sort((a, b) => b.dark - a.dark || a.domain.localeCompare(b.domain));

    for (const g of groups) {
      const allDark = g.dark > 0 && g.live === 0;
      const btn = el('button', 'anchor-card' + (allDark ? ' is-dark' : ''));
      btn.dataset.domain = g.domain;
      btn.innerHTML =
        '<span class="anchor-card__name">' + esc(g.domain) + '</span>' +
        '<span class="anchor-card__meta">' + g.accounts.length + ' account' +
        (g.accounts.length === 1 ? '' : 's') +
        (g.dark ? ' · <b>' + g.dark + ' dark</b>' : '') + '</span>';
      btn.addEventListener('click', () => selectDomain(g.domain));
      strip.appendChild(btn);
    }
  }

  function selectDomain(domain) {
    state.domain = domain;
    state.cursor = null;
    state.rows = 0;
    $$('.anchor-card').forEach((c) => c.classList.toggle('is-on', c.dataset.domain === domain));

    const accounts = ANCHORS.filter((a) => a.domain === domain);
    state.accounts = accounts.map((a) => a.account);
    state.meta = accounts;
    renderStats(accounts);

    $('#txBody').innerHTML = '';
    loadPage(true);
  }

  function renderStats(accounts) {
    const dark = accounts.filter((a) => a.state === 'dark').length;
    const inbound = accounts.reduce((s, a) => s + (a.inbound ?? 0), 0);
    const outbound = accounts.reduce((s, a) => s + (a.outbound ?? 0), 0);
    const returns = accounts.reduce((s, a) => s + (a.returns ?? 0), 0);
    const freshest = accounts
      .map((a) => a.hoursSinceActivity)
      .filter((h) => h !== null && h !== undefined)
      .sort((a, b) => a - b)[0];

    const tile = (v, k, n, cls) =>
      '<div class="stat"><div class="stat__v ' + (cls || '') + '">' + v + '</div>' +
      '<div class="stat__k">' + k + '</div><div class="stat__n">' + (n || '') + '</div></div>';

    $('#anchorStats').innerHTML =
      tile(accounts.length, accounts.length === 1 ? 'Account' : 'Accounts',
           dark ? dark + ' dark' : 'none dark', dark ? 'pop' : '') +
      tile(inbound.toLocaleString(), 'Inbound', 'payments received') +
      tile(outbound.toLocaleString(), 'Outbound', 'payments sent') +
      tile(
        freshest === undefined ? '—' : freshest < 48 ? freshest.toFixed(1) + 'h' : (freshest / 24).toFixed(1) + 'd',
        'Last settlement',
        returns ? returns + ' returned' : 'no returns seen',
      );
  }

  /* ---------------------------------------------------------- transactions */

  async function loadAssets() {
    try {
      const { assets } = await api('/api/v1/assets');
      const sel = $('#assetFilter');
      for (const a of assets) {
        const o = el('option');
        o.value = a.asset;
        o.textContent = assetName(a.asset) + ' (' + a.count.toLocaleString() + ')';
        sel.appendChild(o);
      }
    } catch { /* filter stays on "All assets" — not worth failing the page over */ }
  }

  async function loadPage(reset) {
    if (!state.domain) return;
    const btn = $('#moreBtn');

    // Snapshot mode: no payments endpoint available.
    if (state.isSnapshot) {
      if (reset) { $('#txBody').innerHTML = ''; state.rows = 0; }
      if (state.rows === 0) {
        $('#txBody').appendChild(el('tr', '',
          '<td colspan="7" class="tx-none">' +
          'Row-level transactions are available when the live API is connected. ' +
          'Anchor summaries above reflect the 12 August 2026 ledger scan.' +
          '</td>'));
        $('#txCount').textContent = '';
      }
      btn.hidden = true;
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Loading…';

    const q = new URLSearchParams({ limit: String(state.limit) });
    if (state.direction) q.set('direction', state.direction);
    if (state.asset) q.set('asset', state.asset);
    if (!reset && state.cursor) q.set('before', state.cursor);

    try {
      const body = await api('/api/v1/anchors/' + encodeURIComponent(state.domain) + '/payments?' + q);
      if (reset) { $('#txBody').innerHTML = ''; state.rows = 0; }

      for (const p of body.payments) appendRow(p);
      state.rows += body.payments.length;
      state.cursor = body.nextCursor;

      $('#txCount').textContent =
        state.rows.toLocaleString() + ' transaction' + (state.rows === 1 ? '' : 's') +
        (body.nextCursor ? ' (more available)' : ' (all)');

      btn.hidden = !body.nextCursor;
      if (state.rows === 0) {
        $('#txBody').appendChild(el('tr', '', '<td colspan="7" class="tx-none">' + emptyMessage() + '</td>'));
      }
    } catch (err) {
      $('#txBody').appendChild(
        el('tr', '', '<td colspan="7" class="tx-none">Could not load: ' + esc(err.message) + '</td>'),
      );
      btn.hidden = true;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Load more';
    }
  }

  /**
   * An empty table means one of two entirely different things, and saying
   * "no results" for both throws away the more interesting one.
   *
   * With a filter on, it is a filter result. With no filter on, an anchor with
   * nothing to show has settled nothing — which is the finding this whole
   * project exists to surface, not an absence of data.
   */
  function emptyMessage() {
    const filtered = Boolean(state.direction || state.asset);
    if (filtered) return 'No transactions match these filters.';

    const meta = state.meta ?? [];
    const dormant = meta.length > 0 && meta.every((a) => a.state === 'dark' || a.state === 'no_activity');
    if (!dormant) return 'Nothing indexed for this anchor yet.';

    const hours = meta
      .map((a) => a.hoursSinceActivity)
      .filter((h) => h !== null && h !== undefined)
      .sort((a, b) => a - b)[0];

    if (hours === undefined) {
      return 'No settlement on record, ever. These accounts are declared in the ' +
             'anchor&rsquo;s stellar.toml and have never moved value.';
    }
    const days = Math.floor(hours / 24);
    return 'Nothing settled in ' + days + ' days. The empty table is the finding &mdash; ' +
           'these accounts are declared as operational and the ledger shows no activity.';
  }

  function appendRow(p) {
    // Direction is relative to the anchor: did value arrive, or leave?
    const inbound = state.accounts.includes(p.to);
    const counterparty = inbound ? p.from : p.to;
    const counterDomain = inbound ? p.fromDomain : p.toDomain;

    const tr = el('tr', p.isDust ? 'is-dust' : '');
    tr.innerHTML =
      '<td><span class="tx-when">' + esc(ago(p.createdAt)) + '</span>' +
        '<span class="tx-abs mono">' + esc(p.createdAt.slice(0, 16).replace('T', ' ')) + '</span></td>' +
      '<td><span class="dir ' + (inbound ? 'dir--in' : 'dir--out') + '">' +
        (inbound ? '↓ in' : '↑ out') + '</span></td>' +
      '<td class="mono">' + esc(short(counterparty)) +
        (counterDomain ? '<span class="tx-domain">' + esc(counterDomain) + '</span>' : '') + '</td>' +
      '<td class="num mono">' + esc(amount(p.amount)) +
        (p.isDust ? '<span class="tx-dust" title="Below the dust threshold; excluded from metrics">dust</span>' : '') +
      '</td>' +
      '<td>' + esc(assetName(p.asset)) + '</td>' +
      '<td class="mono tx-memo">' + (p.memo ? esc(p.memo) : '<span class="muted">—</span>') + '</td>' +
      '<td><a class="tx-link mono" target="_blank" rel="noopener"' +
        ' href="https://stellar.expert/explorer/public/tx/' + encodeURIComponent(p.txHash) + '">' +
        esc(p.txHash.slice(0, 6)) + '↗</a></td>';
    $('#txBody').appendChild(tr);
  }

  /* ------------------------------------------------------------------ wire */

  $$('.chip[data-dir]').forEach((c) =>
    c.addEventListener('click', () => {
      $$('.chip[data-dir]').forEach((x) => x.classList.toggle('is-on', x === c));
      state.direction = c.dataset.dir;
      state.cursor = null;
      loadPage(true);
    }));

  $('#assetFilter').addEventListener('change', (e) => {
    state.asset = e.target.value;
    state.cursor = null;
    loadPage(true);
  });

  $('#limitFilter').addEventListener('change', (e) => {
    state.limit = Number(e.target.value);
    state.cursor = null;
    loadPage(true);
  });

  $('#moreBtn').addEventListener('click', () => loadPage(false));
  $('#refreshBtn').addEventListener('click', () => { state.cursor = null; loadPage(true); });

  boot();
})();
