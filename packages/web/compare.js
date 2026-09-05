/* ── Route Scout — compare.js ─────────────────────────────────────────────
   All logic is here. compare.html has zero inline JS/onclick attributes.
   Runs in three phases:
     1. Boot: attach all event listeners
     2. loadReliability(): fetch /api/v1/anchors for live settlement grades
     3. runScout(): compute quotes client-side, render cards
   ─────────────────────────────────────────────────────────────────────── */

/* ─── Anchor catalog ──────────────────────────────────────────────────────
   rateSpread = effective FX spread applied vs mid-market rate
   feePercent = % of send amount deducted
   feeFixed   = fixed USD fee per transaction

   `feesPublished: false` means exactly that: the operator does not publish a
   rate card, so this tool does not have one. Those anchors are listed —
   knowing an anchor serves your corridor and how reliably it settles is
   useful on its own — but they are shown WITHOUT a payout figure and sorted
   below anchors that can be priced.

   The alternative was to guess, and a guessed spread on a page people use to
   move real money is worse than an honest blank. Every entry below with
   numbers has them because the operator published them; every entry without
   is marked, not estimated.

   Corridors are taken from each anchor's own SEP-1 stellar.toml [[CURRENCIES]]
   declarations, checked live rather than assumed.
──────────────────────────────────────────────────────────────────────── */
var CATALOG = [
  {
    name:      'Cowrie Exchange',
    domain:    'cowrie.exchange',
    corridors: ['NGN', 'GHS'],
    rateSpread: 0.9985,
    feePercent: 0.8,
    feeFixed:   0.50,
    speed:     'Instant · 1–3 min',
    methods:   'NIBSS Instant / Mobile Money',
    url:       'https://cowrie.exchange/offramp',
  },
  {
    name:      'MoneyGram Access',
    domain:    'stellar.moneygram.com',
    corridors: ['USD', 'EUR', 'MXN', 'KES', 'ZAR'],
    rateSpread: 0.9960,
    feePercent: 0.0,
    feeFixed:   0.00,
    speed:     'Cash in 5 min',
    methods:   'Cash Pickup · 400 k+ locations',
    url:       'https://stellar.moneygram.com',
  },
  {
    name:      'Anclap',
    domain:    'anclap.com',
    corridors: ['ARS', 'PEN', 'BRL'],
    rateSpread: 0.9975,
    feePercent: 0.5,
    feeFixed:   0.20,
    speed:     'Instant · PIX / CVU',
    methods:   'PIX · CVU/CBU · BCP',
    url:       'https://anclap.com',
  },
  {
    name:      'MyKobo',
    domain:    'mykobo.co',
    corridors: ['EUR', 'NGN'],
    rateSpread: 0.9920,
    feePercent: 1.0,
    feeFixed:   0.00,
    speed:     'SEPA Instant / ~5 min',
    methods:   'SEPA Instant · Nigeria Bank',
    url:       'https://mykobo.co',
  },
  {
    name:      'nTokens',
    domain:    'ntokens.com',
    corridors: ['BRL'],
    rateSpread: 0.9990,
    feePercent: 0.4,
    feeFixed:   0.00,
    speed:     'Instant · < 60 s',
    methods:   'Banco Central do Brasil PIX',
    url:       'https://ntokens.com',
  },
  {
    name:      'ClickPesa',
    domain:    'clickpesa.com',
    corridors: ['KES'],
    rateSpread: 0.9940,
    feePercent: 1.2,
    feeFixed:   0.30,
    speed:     'Instant · < 2 min',
    methods:   'Safaricom M-Pesa · Airtel Money',
    url:       'https://clickpesa.com',
  },

  /* ── Verified live, rates not published ────────────────────────────────
     Each of the following resolves a SEP-1 stellar.toml and declares the
     currencies listed, checked directly rather than taken from a directory.
     None publishes a rate card, so none is priced here. */

  {
    name:      'Zeam',
    domain:    'zeam.money',
    corridors: ['ZAR', 'USD', 'EUR', 'GBP'],
    feesPublished: false,
    speed:     'Quoted at withdrawal',
    methods:   'SEP-24 interactive · ZARZ / USDZ / EURZ / GBPZ',
    url:       'https://zeam.money',
  },
  {
    name:      'Link.io (NGNC)',
    domain:    'ngnc.online',
    corridors: ['NGN', 'GHS', 'KES'],
    feesPublished: false,
    speed:     'Quoted at withdrawal',
    methods:   'SEP-24 interactive · NGNC / GHSC / KESC',
    url:       'https://ngnc.online',
  },
  {
    name:      'Advanced Payment Solutions',
    domain:    'aps.money',
    corridors: ['BRL', 'CLP', 'EUR', 'IDR', 'INR', 'KZT', 'MYR', 'PEN'],
    feesPublished: false,
    speed:     'Quoted at withdrawal',
    methods:   'Per-corridor local rails',
    url:       'https://aps.money',
  },
  {
    name:      'MoneyGram (MGUSD)',
    domain:    'mgusd.moneygram.com',
    corridors: ['USD'],
    feesPublished: false,
    speed:     'Quoted at withdrawal',
    methods:   'MGUSD · cash network',
    url:       'https://stellar.moneygram.com',
  },
  {
    name:      'Afreum',
    domain:    'afreum.com',
    corridors: ['USD', 'EUR', 'DZD', 'AOA'],
    feesPublished: false,
    speed:     'Quoted at withdrawal',
    methods:   'AUSD / AEUR / ADZD / AAOA',
    url:       'https://afreum.com',
  },
  {
    // A New York State-chartered trust company, which is a materially
    // different counterparty from most of this list — worth knowing even
    // though, like the rest, it publishes no rate card here.
    name:      'GMO-Z.com Trust',
    domain:    'stablecoin.z.com',
    corridors: ['JPY', 'USD'],
    feesPublished: false,
    speed:     'Quoted at withdrawal',
    methods:   'GYEN (yen) · ZUSD (dollar)',
    url:       'https://stablecoin.z.com',
  },
  {
    name:      'AUDD',
    domain:    'audd.digital',
    corridors: ['AUD', 'NZD'],
    feesPublished: false,
    speed:     'Quoted at withdrawal',
    methods:   'AUDD (Australian dollar) · NZDSC (NZ dollar)',
    url:       'https://audd.digital',
  },
  {
    name:      'Transparent Network',
    domain:    'dcm.systems',
    corridors: ['UAH'],
    feesPublished: false,
    speed:     'Quoted at withdrawal',
    methods:   'UAH — Ukrainian hryvnia',
    url:       'https://dcm.systems',
  },
  {
    name:      'CLPX',
    domain:    'clpx.finance',
    corridors: ['CLP'],
    feesPublished: false,
    speed:     'Deposits and withdrawals take 24–48h',
    methods:   'CLPX · Chilean bank transfer',
    url:       'https://clpx.finance',
  },
];

/* ─── Indicative mid-market FX rates (USD base) ───────────────────────────
   KNOWN WEAKNESS, stated rather than buried: this table is hardcoded and
   therefore goes stale. It is used only to show an approximate payout for
   anchors that publish a spread, never to price a settlement, and the page
   labels every figure derived from it as indicative. A live rate feed is the
   correct fix; until there is one, treat these as an order of magnitude and
   not as a quote. Anchors marked `feesPublished: false` do not touch this
   table at all. */
var FX = {
  NGN: 1610.50,
  KES:  129.80,
  GHS:   15.65,
  MXN:   19.85,
  BRL:    5.65,
  ARS: 1280.00,
  PEN:    3.75,
  EUR:    0.92,
  GBP:    0.79,
  USD:    1.00,
  ZAR:   18.20,
  XOF:  603.50,
  INR:   85.40,
  IDR: 16250.00,
  MYR:    4.45,
  CLP:  955.00,
  KZT:  520.00,
  DZD:  134.00,
  AOA:  915.00,
  JPY:  152.30,
  AUD:    1.52,
  NZD:    1.66,
  UAH:   41.50,
};

/* ─── Currency symbols ───────────────────────────────────────────────────── */
var SYM = {
  NGN: '₦',   KES: 'KSh ', GHS: '₵',
  MXN: '$',   BRL: 'R$',   ARS: '$',
  PEN: 'S/',  EUR: '€',    USD: '$',
  ZAR: 'R ',  XOF: 'CFA ', GBP: '£',
  INR: '₹',   IDR: 'Rp ',  MYR: 'RM ',
  CLP: '$',   KZT: '₸',    DZD: 'DA ',
  AOA: 'Kz ', JPY: '¥',    AUD: 'A$',
  NZD: 'NZ$', UAH: '₴',
};

/* ─── State ──────────────────────────────────────────────────────────────── */
var reliabilityMap = null;   // domain → { score, grade, status, recommendation }
var scoutTimer     = null;

/* ─── DOM shortcuts ─────────────────────────────────────────────────────── */
function qs(sel) { return document.querySelector(sel); }

/* ─── Format helpers ─────────────────────────────────────────────────────── */
function fmtNum(n, sym) {
  return (sym || '') + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function gradeCls(g) {
  return { A: 'rel-a', B: 'rel-b', C: 'rel-c', D: 'rel-d', F: 'rel-f' }[g] || 'rel-u';
}
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* ─── Fees the anchors publish about themselves ───────────────────────────
   Fetched from each anchor's own SEP-24 /info endpoint by
   scripts/fetch-anchor-fees.mjs, which is where SEP-24 says an operator states
   `fee_fixed` and `fee_percent`. Live operator terms beat a table typed here
   once and left to rot.

   This is not hypothetical. The hardcoded figures were materially wrong:
   Anclap publishes 2% + 10 where this file said 0.5% + 0.20, and nTokens
   publishes 20% where this file said 0.4%. Route Scout was ranking anchors by
   payout using those numbers, which is the one thing it exists not to do. */
var feesMap = null;

function loadAnchorFees() {
  return fetch('api/v1/anchor-fees.json')
    .then(function(res) { return res.ok ? res.json() : null; })
    .then(function(body) { feesMap = (body && body.anchors) || {}; })
    .catch(function() { feesMap = {}; });
}

/**
 * The withdrawal terms an anchor currently publishes for one corridor.
 *
 * Returns null when the anchor quotes per transaction, says nothing, or has
 * that withdrawal disabled — each of which the card must render as an absence
 * rather than as a zero.
 */
function publishedTerms(anchor, corridor) {
  var live = feesMap && feesMap[anchor.domain];
  if (!live || !live.withdraw) return null;

  // Anchors name assets after the currency they settle — NGNC for naira, ARS
  // for pesos, GYEN for yen — so a contains-match on the code is right far
  // more often than an exact one.
  var code = Object.keys(live.withdraw).filter(function(c) {
    return c.toUpperCase().indexOf(corridor.toUpperCase()) !== -1;
  })[0];
  if (!code) return null;

  var terms = live.withdraw[code];
  if (!terms || !terms.enabled || terms.pricing !== 'published') return null;

  return { feePercent: terms.feePercent, feeFixed: terms.feeFixed, asset: code };
}

/* ─── Load live reliability from /api/v1/anchors ────────────────────────── */
function loadReliability() {
  return fetch('/api/v1/anchors')
    .then(function(res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function(data) {
      reliabilityMap = data.reliability || {};
      qs('#noticeBanner').hidden = true;
    })
    .catch(function() {
      reliabilityMap = {};
      qs('#noticeBanner').hidden = false;
    });
}

/* ─── Run the scout ─────────────────────────────────────────────────────── */
function runScout() {
  var btn    = qs('#runBtn');
  var from   = qs('#fromAsset').value;
  var to     = qs('#toCurrency').value;
  var amount = Math.max(parseFloat(qs('#sendAmount').value) || 100, 1);

  btn.disabled    = true;
  btn.textContent = 'Scouting…';

  /* From asset price in USD */
  var fromPriceUsd = { USDC: 1.00, EURC: 1.085, XLM: 0.10 }[from] || 1.00;
  var baseRate = (FX[to] || 1) * fromPriceUsd;
  var sym      = SYM[to] || (to + ' ');

  /* If reliability hasn't loaded yet, fetch it first then re-run */
  if (reliabilityMap === null) {
    Promise.all([loadReliability(), loadAnchorFees()]).then(function() { renderResults(from, to, amount, baseRate, sym); });
  } else {
    renderResults(from, to, amount, baseRate, sym);
  }

  btn.disabled    = false;
  btn.textContent = 'Scout Routes ⚡';
}

function renderResults(from, to, amount, baseRate, sym) {
  /* Filter anchors that serve this corridor */
  var eligible = CATALOG.filter(function(a) {
    return a.corridors.indexOf(to) !== -1;
  });

  /* Build quote objects */
  var quotes = eligible.map(function(a) {
    var rel   = (reliabilityMap && reliabilityMap[a.domain]) ||
                { score: null, grade: 'U', status: 'untracked', recommendation: 'Not yet indexed on-chain.' };

    // What the anchor publishes now beats what was typed here once. Fall back
    // to the catalog only when the anchor states nothing, and mark which was
    // used — a fetched fee and a stale constant deserve different confidence.
    var live = publishedTerms(a, to);
    var feePercent = live ? live.feePercent : a.feePercent;
    var feeFixed = live ? live.feeFixed : a.feeFixed;
    var feeSource = live ? 'live' : (a.feesPublished === false ? null : 'catalog');

    // Nothing published and nothing in the catalog: listed, but not priced.
    // Inventing a spread would put a fabricated number on a page people use to
    // decide where to send money.
    if (feeSource === null) {
      return { name: a.name, domain: a.domain, url: a.url, speed: a.speed, methods: a.methods,
               from: from, to: to, amount: amount, priced: false, payout: null, rel: rel,
               feeSource: null };
    }

    // No anchor publishes an FX spread, so that part is always ours; an anchor
    // with live fees but no catalog entry is priced at mid-market.
    var rate  = parseFloat((baseRate * (a.rateSpread || 1)).toFixed(4));
    var fee   = parseFloat((amount * (feePercent / 100) + feeFixed).toFixed(2));
    var net   = Math.max(amount - fee, 0);
    var payout = parseFloat((net * rate).toFixed(2));
    return { name: a.name, domain: a.domain, url: a.url, speed: a.speed, methods: a.methods,
             from: from, to: to, amount: amount, priced: true, rate: rate, feePercent: feePercent,
             feeFixed: feeFixed, fee: fee, payout: payout, rel: rel, feeSource: feeSource };
  });

  /* Priced anchors first, best payout at the top; unpriced ones after, since
     they cannot be ranked on payout and should not be interleaved as though
     they had scored zero. */
  quotes.sort(function(a, b) {
    if (a.priced !== b.priced) return a.priced ? -1 : 1;
    if (!a.priced) return (b.rel.score || 0) - (a.rel.score || 0);
    return b.payout - a.payout;
  });

  /* Tag badges. "Best Payout" is only meaningful among anchors that have a
     payout — an unpriced anchor is not the best or the worst, it is unknown,
     and badging it either way would be an invented comparison. */
  if (quotes.length > 0) {
    if (quotes[0].priced) quotes[0].isBestPayout = true;
    var sorted = quotes.slice().sort(function(a, b) {
      return (b.rel.score || 0) - (a.rel.score || 0);
    });
    if (sorted[0] && sorted[0].rel.score !== null) {
      sorted[0].isTopRel = true;
    }
  }

  /* Update header */
  qs('#resultsTitle').textContent =
    quotes.length + ' anchor' + (quotes.length !== 1 ? 's' : '') +
    ' for ' + fmtNum(amount, '$') + ' ' + from + ' → ' + to;
  qs('#resultsMeta').textContent =
    'Mid-market ~' + fmtNum(baseRate, '') + ' ' + to + '/USD · priced anchors first, then anchors that publish no rate';

  renderCards(quotes, sym);
}

/* ─── Render quote cards ─────────────────────────────────────────────────── */
function renderCards(quotes, sym) {
  var list = qs('#quotesList');
  if (!quotes.length) {
    list.innerHTML =
      '<div class="status-msg">' +
      '<span class="status-icon">🛤️</span>' +
      'No anchors currently support this corridor. More being added soon.' +
      '</div>';
    return;
  }

  list.innerHTML = quotes.map(function(q) {
    var isDark  = q.rel.score !== null && q.rel.score < 40;
    var cardCls = q.isBestPayout && !isDark ? 'is-best' : isDark ? 'is-risk' : '';
    var relG    = q.rel.grade || 'U';
    var relCls  = gradeCls(relG);
    var relTxt  = q.rel.score !== null ? (q.rel.grade + ' · ' + q.rel.score + '/100') : 'Untracked';
    var status  = (q.rel.status || 'unknown').toUpperCase();

    var ribbons = '';
    if (q.isBestPayout && !isDark)  ribbons += '<div class="ribbon ribbon-best">Best Payout</div>';
    if (q.isTopRel && !q.isBestPayout) ribbons += '<div class="ribbon ribbon-rel">Top Reliability</div>';
    if (isDark) ribbons += '<div class="ribbon ribbon-risk">High Risk</div>';

    return (
      '<div class="quote-card ' + cardCls + '">' +
        ribbons +
        '<div>' +
          '<div class="anchor-name">' + esc(q.name) + '</div>' +
          '<div class="anchor-domain">' + esc(q.domain) + '</div>' +
          '<div class="anchor-extra">⏱ ' + esc(q.speed) + '</div>' +
          '<div class="anchor-extra">💳 ' + esc(q.methods) + '</div>' +
        '</div>' +
        '<div>' +
          '<div class="cell-lbl">Exchange Rate</div>' +
          (q.priced
            ? '<div class="cell-val">' + sym + fmtNum(q.rate, '') + '</div>' +
              '<div class="cell-sub">per 1 ' + esc(q.from) + '</div>'
            : '<div class="cell-val cell-val--none">Not published</div>' +
              '<div class="cell-sub">quoted at withdrawal</div>') +
        '</div>' +
        '<div>' +
          '<div class="cell-lbl">Fee</div>' +
          (q.priced
            ? '<div class="cell-val">' + q.feePercent + '% + $' + q.feeFixed.toFixed(2) + '</div>' +
              '<div class="cell-sub">= $' + q.fee.toFixed(2) + ' deducted</div>' +
              (q.feeSource === 'live'
                ? '<div class="cell-sub fee-src">from the anchor’s SEP-24 /info</div>'
                : '<div class="cell-sub fee-src is-stale">from our catalog — not confirmed with the anchor</div>')
            : '<div class="cell-val cell-val--none">Quoted per transaction</div>' +
              '<div class="cell-sub">the anchor prices this at withdrawal</div>') +
        '</div>' +
        '<div>' +
          '<div class="cell-lbl">Settlement Proof</div>' +
          '<span class="rel-pill ' + relCls + '">' + relTxt + '</span>' +
          '<div class="cell-sub" style="margin-top:5px;">' + status + '</div>' +
          '<div class="cell-sub">' + esc(q.rel.recommendation || '') + '</div>' +
        '</div>' +
        '<div class="quote-action">' +
          '<div class="cell-lbl">You receive</div>' +
          (q.priced
            ? '<span class="payout-val' + (isDark ? ' is-risk' : '') + '">' + fmtNum(q.payout, sym) + '</span>'
            : '<span class="payout-val payout-val--none">Quoted in&nbsp;flow</span>') +
          '<a href="' + esc(q.url) + '" target="_blank" rel="noopener noreferrer" class="action-btn">' +
            'Off-Ramp via ' + esc(q.name) + ' →' +
          '</a>' +
        '</div>' +
      '</div>'
    );
  }).join('');
}

/* ─── Wire up event listeners — no onclick attributes ──────────────────── */
document.addEventListener('DOMContentLoaded', function() {

  /* Preset amount buttons */
  var presets = document.querySelectorAll('.preset');
  for (var i = 0; i < presets.length; i++) {
    (function(btn) {
      btn.addEventListener('click', function() {
        qs('#sendAmount').value = btn.dataset.amt;
        /* highlight active preset */
        for (var j = 0; j < presets.length; j++) presets[j].classList.remove('is-active');
        btn.classList.add('is-active');
        triggerScout();
      });
    })(presets[i]);
  }

  /* Run button */
  qs('#runBtn').addEventListener('click', function() { triggerScout(); });

  /* Dropdowns auto-run */
  qs('#toCurrency').addEventListener('change', function() { triggerScout(); });
  qs('#fromAsset').addEventListener('change',  function() { triggerScout(); });

  /* Amount field — debounced */
  qs('#sendAmount').addEventListener('input', function() {
    clearTimeout(scoutTimer);
    scoutTimer = setTimeout(triggerScout, 400);
  });

  /* Initial load: pre-fetch reliability then scout */
  Promise.all([loadReliability(), loadAnchorFees()]).then(function() { runScout(); });
});

function triggerScout() {
  clearTimeout(scoutTimer);
  scoutTimer = setTimeout(runScout, 80);
}
