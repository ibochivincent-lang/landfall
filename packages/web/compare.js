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
];

/* ─── Indicative mid-market FX rates (USD base) ─────────────────────────── */
var FX = {
  NGN: 1610.50,
  KES:  129.80,
  GHS:   15.65,
  MXN:   19.85,
  BRL:    5.65,
  ARS: 1280.00,
  PEN:    3.75,
  EUR:    0.92,
  USD:    1.00,
  ZAR:   18.20,
  XOF:  603.50,
};

/* ─── Currency symbols ───────────────────────────────────────────────────── */
var SYM = {
  NGN: '₦',   KES: 'KSh ', GHS: '₵',
  MXN: '$',   BRL: 'R$',   ARS: '$',
  PEN: 'S/',  EUR: '€',    USD: '$',
  ZAR: 'R ',  XOF: 'CFA ',
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

  var baseRate = FX[to] || 1;
  var sym      = SYM[to] || (to + ' ');

  /* If reliability hasn't loaded yet, fetch it first then re-run */
  if (reliabilityMap === null) {
    loadReliability().then(function() { renderResults(from, to, amount, baseRate, sym); });
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
    var rate  = parseFloat((baseRate * a.rateSpread).toFixed(4));
    var fee   = parseFloat((amount * (a.feePercent / 100) + a.feeFixed).toFixed(2));
    var net   = Math.max(amount - fee, 0);
    var payout = parseFloat((net * rate).toFixed(2));
    return { name: a.name, domain: a.domain, url: a.url, speed: a.speed, methods: a.methods,
             from: from, to: to, amount: amount, rate: rate, feePercent: a.feePercent,
             feeFixed: a.feeFixed, fee: fee, payout: payout, rel: rel };
  });

  /* Sort by payout descending */
  quotes.sort(function(a, b) { return b.payout - a.payout; });

  /* Tag badges */
  if (quotes.length > 0) {
    quotes[0].isBestPayout = true;
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
    'Mid-market ~' + fmtNum(baseRate, '') + ' ' + to + '/USD · sorted by payout';

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
          '<div class="cell-val">' + sym + fmtNum(q.rate, '') + '</div>' +
          '<div class="cell-sub">per 1 ' + esc(q.from) + '</div>' +
        '</div>' +
        '<div>' +
          '<div class="cell-lbl">Fee</div>' +
          '<div class="cell-val">' + q.feePercent + '% + $' + q.feeFixed.toFixed(2) + '</div>' +
          '<div class="cell-sub">= $' + q.fee.toFixed(2) + ' deducted</div>' +
        '</div>' +
        '<div>' +
          '<div class="cell-lbl">Settlement Proof</div>' +
          '<span class="rel-pill ' + relCls + '">' + relTxt + '</span>' +
          '<div class="cell-sub" style="margin-top:5px;">' + status + '</div>' +
          '<div class="cell-sub">' + esc(q.rel.recommendation || '') + '</div>' +
        '</div>' +
        '<div class="quote-action">' +
          '<div class="cell-lbl">You receive</div>' +
          '<span class="payout-val' + (isDark ? ' is-risk' : '') + '">' +
            fmtNum(q.payout, sym) +
          '</span>' +
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
  loadReliability().then(function() { runScout(); });
});

function triggerScout() {
  clearTimeout(scoutTimer);
  scoutTimer = setTimeout(runScout, 80);
}
