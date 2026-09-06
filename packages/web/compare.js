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
/* ─── Which side of the payment is fixed ─────────────────────────────────
   "I send $100" and "they receive ₦500,000" are different instructions.
   The second one can be unsatisfiable, and saying so is a real answer —
   see packages/intents/src/types.ts.                                      */
var BASIS = 'send';

var PRESETS = {
  send: [['50','$50'],['100','$100'],['250','$250'],['500','$500'],['1000','$1,000']],
  receive: null   /* built per currency below — a ₦50 preset would be absurd */
};

/* Receive-side presets are derived from the corridor rate so they land on
   round local amounts rather than round dollar amounts. */
function receivePresets(to) {
  var rate = FX[to] || 1;
  var sym = SYM[to] || (to + " ");
  return [50, 100, 250, 500, 1000].map(function (usd) {
    var raw = usd * rate;
    /* round to a sane magnitude so the chip reads as a human amount */
    var mag = Math.pow(10, Math.max(0, String(Math.round(raw)).length - 2));
    var v = Math.round(raw / mag) * mag;
    return [String(v), sym + fmtNum(v, "")];
  });
}

function renderPresets() {
  var to = qs('#toCurrency').value;
  var rows = BASIS === 'send' ? PRESETS.send : receivePresets(to);
  qs('#presetRow').innerHTML = rows.map(function (r) {
    return '<button type="button" class="preset" data-amt="' + r[0] + '">' + esc(r[1]) + '</button>';
  }).join('');
  bindPresets();
}

function bindPresets() {
  var presets = document.querySelectorAll('#presetRow .preset');
  for (var i = 0; i < presets.length; i++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        qs('#sendAmount').value = btn.dataset.amt;
        for (var j = 0; j < presets.length; j++) presets[j].classList.remove('is-active');
        btn.classList.add('is-active');
        triggerScout();
      });
    })(presets[i]);
  }
}

function setBasis(next) {
  if (BASIS === next) return;
  BASIS = next;

  var send = qs('#basisSend'), recv = qs('#basisReceive');
  send.classList.toggle('is-on', next === 'send');
  recv.classList.toggle('is-on', next === 'receive');
  send.setAttribute('aria-checked', String(next === 'send'));
  recv.setAttribute('aria-checked', String(next === 'receive'));

  var to = qs('#toCurrency').value;
  var from = qs('#fromAsset').value;
  qs('#amountLabel').textContent = next === 'send'
    ? 'Amount (' + from + ')'
    : 'They receive (' + to + ')';

  /* Carry the amount across so switching does not silently reprice. */
  var cur = parseFloat(qs('#sendAmount').value) || 0;
  var rate = FX[to] || 1;
  if (cur > 0) qs('#sendAmount').value = next === 'receive'
    ? String(Math.round(cur * rate))
    : String(Math.max(1, Math.round((cur / rate) * 100) / 100));

  renderPresets();
  triggerScout();
}

function runScout() {
  var btn    = qs('#runBtn');
  var from   = qs('#fromAsset').value;
  var to     = qs('#toCurrency').value;
  var amount = Math.max(parseFloat(qs('#sendAmount').value) || 100, 1);
  var basis  = BASIS;

  btn.disabled    = true;
  btn.textContent = 'Scouting…';

  /* From asset price in USD */
  var fromPriceUsd = { USDC: 1.00, EURC: 1.085, XLM: 0.10 }[from] || 1.00;
  var baseRate = (FX[to] || 1) * fromPriceUsd;
  var sym      = SYM[to] || (to + ' ');

  /* If reliability hasn't loaded yet, fetch it first then re-run */
  if (reliabilityMap === null) {
    Promise.all([loadReliability(), loadAnchorFees()]).then(function() { renderResults(from, to, amount, baseRate, sym, basis); });
  } else {
    renderResults(from, to, amount, baseRate, sym, basis);
  }

  btn.disabled    = false;
  btn.textContent = 'Scout Routes ⚡';
}

function renderResults(from, to, amount, baseRate, sym, basis) {
  /* Filter anchors that serve this corridor */
  var eligible = CATALOG.filter(function(a) {
    return a.corridors.indexOf(to) !== -1;
  });

  /* Candidates carry only what the solver needs to price a route. Anchor
     presentation (url, speed, methods) is joined back afterwards, so the
     arithmetic has no opinion about how a card looks. */
  var meta = {};
  var candidates = eligible.map(function(a) {
    var rel = (reliabilityMap && reliabilityMap[a.domain]) ||
              { score: null, grade: 'U', status: 'untracked', recommendation: 'Not yet indexed on-chain.' };

    /* What the anchor publishes now beats what was typed here once. Fall
       back to the catalog only when the anchor states nothing, and mark
       which was used — a fetched fee and a stale constant deserve
       different confidence. */
    var live = publishedTerms(a, to);
    var feeSource = live ? 'live' : (a.feesPublished === false ? null : 'catalog');

    meta[a.domain] = { url: a.url, speed: a.speed, methods: a.methods, rel: rel };
    return {
      domain: a.domain, name: a.name,
      rateSpread: a.rateSpread || 1,
      feePercent: live ? live.feePercent : a.feePercent,
      feeFixed: live ? live.feeFixed : a.feeFixed,
      feeSource: feeSource,
      grade: rel.grade || 'U', score: rel.score
    };
  });

  var result = LandfallIntent.solveIntent(
    { from: from, to: to, basis: basis, amount: amount },
    candidates,
    baseRate
  );

  /* Join the solver output back onto anchor presentation. */
  var quotes = result.solutions.map(function(sol) {
    var m = meta[sol.domain];
    return {
      name: sol.name, domain: sol.domain, url: m.url, speed: m.speed, methods: m.methods,
      from: from, to: to, rel: m.rel,
      priced: sol.priced, feeSource: sol.feeSource,
      rate: sol.rate, fee: sol.fee,
      feePercent: candidates.filter(function(c){return c.domain===sol.domain;})[0].feePercent,
      feeFixed: candidates.filter(function(c){return c.domain===sol.domain;})[0].feeFixed,
      amount: sol.send, payout: sol.receive, basis: basis
    };
  });

  /* Badges. "Best" means most delivered when the send side is fixed, and
     least spent when the receive side is — the solver has already ordered
     them that way, so the top priced row is the best row either way. */
  var firstPriced = quotes.filter(function(q) { return q.priced; })[0];
  if (firstPriced) firstPriced.isBestPayout = true;
  var byRel = quotes.slice().sort(function(a, b) {
    return (b.rel.score || 0) - (a.rel.score || 0);
  });
  if (byRel[0] && byRel[0].rel.score !== null) byRel[0].isTopRel = true;

  /* Header */
  var fixedTxt = basis === 'receive'
    ? 'to deliver ' + fmtNum(amount, sym)
    : 'for ' + fmtNum(amount, '$') + ' ' + from;
  qs('#resultsTitle').textContent =
    quotes.length + ' anchor' + (quotes.length !== 1 ? 's' : '') + ' ' + fixedTxt +
    (basis === 'receive' ? ' in ' + to : ' → ' + to);

  /* An intent with no priced route is unsatisfiable, and that is a real
     answer rather than an empty table. Say so, and say why each route was
     ruled out instead of leaving a blank. */
  var meta2 = 'Mid-market ~' + fmtNum(baseRate, '') + ' ' + to + '/USD · ' +
    (basis === 'receive'
      ? 'cheapest send first, then anchors that publish no rate'
      : 'priced anchors first, then anchors that publish no rate');
  if (result.unsatisfiable) {
    var why = result.rejected.map(function(r) {
      return r.domain + ' (' + REJECTION_TEXT[r.rejected] + ')';
    }).join(', ');
    meta2 = 'No anchor can satisfy this' + (why ? ' — ' + why : '') + '.';
  }
  qs('#resultsMeta').textContent = meta2;

  renderCards(quotes, sym);
}

/* Plain-language reasons, kept next to the codes they explain. */
var REJECTION_TEXT = {
  'unpriced': 'publishes no rate card',
  'below-grade-floor': 'below the reliability floor you set',
  'fee-exceeds-principal': 'its fees exceed the amount'
};

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
    if (q.isBestPayout && !isDark)  ribbons += '<div class="ribbon ribbon-best">' + (q.basis === 'receive' ? 'Cheapest' : 'Best Payout') + '</div>';
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
          // When the receive side is pinned every anchor delivers the same
          // amount, so the figure that distinguishes them is what it costs
          // to deliver it. Showing "you receive ₦500,000" five times would
          // be five identical numbers and no comparison at all.
          '<div class="cell-lbl">' + (q.basis === 'receive' ? 'You send' : 'You receive') + '</div>' +
          (q.priced
            ? '<span class="payout-val' + (isDark ? ' is-risk' : '') + '">' +
                (q.basis === 'receive' ? fmtNum(q.amount, '$') : fmtNum(q.payout, sym)) +
              '</span>' +
              (q.basis === 'receive'
                ? '<div class="cell-sub">to deliver ' + fmtNum(q.payout, sym) + '</div>'
                : '')
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

  /* Preset amount buttons — re-bound whenever the basis changes, since the
     chips themselves are rebuilt in the destination currency. */
  bindPresets();

  qs('#basisSend').addEventListener('click', function() { setBasis('send'); });
  qs('#basisReceive').addEventListener('click', function() { setBasis('receive'); });

  /* Run button */
  qs('#runBtn').addEventListener('click', function() { triggerScout(); });

  /* Dropdowns auto-run */
  qs('#toCurrency').addEventListener('change', function() {
    if (BASIS === 'receive') renderPresets();
    triggerScout();
  });
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
