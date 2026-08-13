/* ===========================================================
   Landfall — site behaviour
   Loader, harbour scene entrance, idle loops, parallax,
   hero carousel, nav, login modal, contact form, data chart.
   Animation structure adapted from the ToolsWaves illustrated
   hero template; scene and content are the product's own.
   =========================================================== */
(() => {
  'use strict';

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hasGsap = typeof window.gsap !== 'undefined';

  /* =========================================================
     1. DATA
     The array below is a snapshot, used only when the API is
     unreachable. When the API answers, it wins and the page
     shows an "as of" stamp with real staleness. A page that
     silently serves month-old numbers as current would be the
     exact failure this project exists to detect.
     ========================================================= */
  const API_BASE =
    document.querySelector('meta[name="landfall-api"]')?.content?.replace(/\/$/, '') || '';

  let ACCOUNTS = [
    { d:'cowrie.exchange',       a:'GDI5…TMNN', days:73.2,  i:10,   o:0,   r:0, s:'dark' },
    { d:'anclap.com',            a:'GA4T…BPEN', days:58.1,  i:5,    o:0,   r:0, s:'dark' },
    { d:'ntokens.com',           a:'GDKL…LMT6', days:34.6,  i:0,    o:0,   r:0, s:'dark', approx:true },
    { d:'ntokens.com',           a:'GCVV…KX6P', days:34.4,  i:15,   o:0,   r:0, s:'dark' },
    { d:'cowrie.exchange',       a:'GBQZ…V3GT', days:34.3,  i:56,   o:3,   r:0, s:'dark' },
    { d:'ntokens.com',           a:'GDVK…VVSP', days:34.2,  i:62,   o:45,  r:0, s:'dark' },
    { d:'anclap.com',            a:'GARD…3HOT', days:1.87,  i:1490, o:755, r:2, s:'live' },
    { d:'mykobo.co',             a:'GAQR…Z7NM', days:1.28,  i:19,   o:4,   r:0, s:'live' },
    { d:'mykobo.co',             a:'GCY3…TKBD', days:1.27,  i:745,  o:580, r:3, s:'live' },
    { d:'cowrie.exchange',       a:'GAWO…CCPD', days:1.14,  i:54,   o:0,   r:0, s:'live' },
    { d:'anclap.com',            a:'GCYE…DARS', days:0.004, i:18,   o:0,   r:0, s:'live' },
    { d:'stellar.moneygram.com', a:'GA5Z…KZVN', days:0.004, i:2157, o:0,   r:0, s:'live' },
    { d:'cowrie.exchange',       a:'GBSK…RE3W', days:null,  i:0,    o:0,   r:0, s:'none' },
  ];
  // Snapshot provenance. Overwritten if the API responds.
  let DATA_AS_OF = '2026-08-12';
  let DATA_LIVE = false;

  const COLOR = { live:'#2f9e44', slow:'#e8940c', dark:'#d03b3b', none:'#c9c9d4' };
  const LABEL = { live:'live', slow:'slow', dark:'dark', none:'no payments' };
  // Icon + hatch are the non-colour channels: green and red sit at CVD ΔE 4.1
  // under deuteranopia, so hue alone cannot carry live vs dark.
  const ICON  = { live:'●', slow:'◐', dark:'▲', none:'○' };
  const MAX_D = 80, TICKS = [0, 20, 40, 60, 80];

  const age = d => d === null ? '—'
    : d < 2 ? (d * 24 < 1 ? Math.round(d * 1440) + 'm' : (d * 24).toFixed(1) + 'h')
    : d.toFixed(1) + 'd';

  /* =========================================================
     2. CHART
     ========================================================= */
  const chart = $('#chart'), tbody = $('#tbody'), tip = $('#tip');

  function buildChart() {
  chart.innerHTML = '';
  tbody.innerHTML = '';
  const thr = document.createElement('div');
  thr.className = 'threshold';
  chart.appendChild(thr);

  ACCOUNTS.forEach(x => {
    const row = document.createElement('div');
    row.className = 'row';

    const lab = document.createElement('div');
    lab.className = 'row-label';
    lab.innerHTML = x.d.replace('stellar.moneygram.com', 'moneygram') + ' <i>' + x.a.slice(0, 4) + '</i>';
    row.appendChild(lab);

    const track = document.createElement('div');
    track.className = 'track';
    const bar = document.createElement('div');
    bar.className = 'bar' + (x.s === 'dark' ? ' is-dark' : '');
    bar.style.backgroundColor = COLOR[x.s];
    bar.dataset.w = x.days === null ? '4px' : 'max(4px,' + (Math.min(x.days / MAX_D, 1) * 100).toFixed(2) + '%)';
    track.appendChild(bar);
    row.appendChild(track);

    const val = document.createElement('div');
    val.innerHTML = '<div class="row-val">' + (x.approx ? '≈' : '') + age(x.days) + '</div>' +
                    '<div class="row-state">' + ICON[x.s] + ' ' + LABEL[x.s] + '</div>';
    row.appendChild(val);

    row.addEventListener('mousemove', e => {
      tip.innerHTML = '<div class="t">' + x.d + '</div>' +
        '<div class="l"><span>account</span><b>' + x.a + '</b></div>' +
        '<div class="l"><span>state</span><b>' + ICON[x.s] + ' ' + LABEL[x.s] + '</b></div>' +
        '<div class="l"><span>last settlement</span><b>' + (x.approx ? '≈' : '') + age(x.days) + ' ago</b></div>' +
        '<div class="l"><span>inbound</span><b>' + x.i.toLocaleString() + '</b></div>' +
        '<div class="l"><span>outbound</span><b>' + x.o.toLocaleString() + '</b></div>' +
        '<div class="l"><span>returned</span><b>' + x.r + '</b></div>';
      tip.style.opacity = 1;
      tip.style.left = Math.min(e.clientX + 16, innerWidth - 280) + 'px';
      tip.style.top  = Math.min(e.clientY + 16, innerHeight - 170) + 'px';
    });
    row.addEventListener('mouseleave', () => { tip.style.opacity = 0; });
    chart.appendChild(row);

    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + x.d + '</td><td>' + x.a + '</td><td>' + x.i.toLocaleString() +
      '</td><td>' + x.o.toLocaleString() + '</td><td>' + x.r + '</td><td>' +
      (x.approx ? '≈' : '') + age(x.days) + '</td><td>' + ICON[x.s] + ' ' + LABEL[x.s] + '</td>';
    tbody.appendChild(tr);
  });

  const axis = document.createElement('div');
  axis.className = 'axis';
  axis.innerHTML = '<div></div><div class="axis-in"></div><div></div>';
  chart.appendChild(axis);
  const axisIn = $('.axis-in', axis);
  TICKS.forEach(t => {
    const s = document.createElement('span');
    s.className = 'tick';
    s.style.left = (t / MAX_D * 100) + '%';
    s.textContent = t === 0 ? '0' : t + 'd';
    axisIn.appendChild(s);
  });
  placeThreshold();
  }

  function placeThreshold() {
    const thr = $('.threshold', chart), t = $('.track', chart);
    if (!t || !thr) return;
    const c = chart.getBoundingClientRect(), r = t.getBoundingClientRect();
    thr.style.left = (r.left - c.left + r.width * 30 / MAX_D) + 'px';
  }
  buildChart();
  addEventListener('resize', placeThreshold);

  /* ---- live data ---------------------------------------------------------
     Best effort. A failed fetch leaves the snapshot in place and says so,
     rather than showing an empty page or pretending the numbers are fresh. */
  async function loadLive() {
    if (!API_BASE) return;
    try {
      const res = await fetch(API_BASE + '/api/v1/anchors', { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const body = await res.json();
      if (!Array.isArray(body.accounts) || body.accounts.length === 0) throw new Error('empty payload');

      ACCOUNTS = body.accounts.map(a => ({
        d: a.domain,
        a: a.account ? a.account.slice(0, 4) + '\u2026' + a.account.slice(-4) : '',
        days: a.hoursSinceActivity === null ? null : a.hoursSinceActivity / 24,
        i: a.inbound ?? 0,
        o: a.outbound ?? 0,
        r: a.returns ?? 0,
        s: a.state === 'no_activity' ? 'none' : a.state,
      }));
      DATA_AS_OF = body.asOf;
      DATA_LIVE = true;
      buildChart();
      chart.querySelectorAll('.bar').forEach((b, n) =>
        setTimeout(() => { b.style.width = b.dataset.w; }, reduce ? 0 : n * 40));
      stampFreshness(body);
    } catch {
      stampFreshness(null);
    }
  }

  function stampFreshness(body) {
    const el = $('#freshness');
    if (!el) return;
    if (DATA_LIVE && body) {
      const stale = Math.round(body.staleHours ?? 0);
      const age = stale < 48 ? stale + 'h old' : Math.round(stale / 24) + 'd old';
      el.textContent = 'Live from the API \u00b7 scan ' + age;
      el.className = 'freshness is-live';
    } else {
      el.textContent = 'Snapshot of 12 Aug 2026 \u00b7 API not connected';
      el.className = 'freshness is-snapshot';
    }
  }
  stampFreshness(null);
  loadLive();

  /* =========================================================
     3. SCROLL REVEALS + counters + bar growth
     ========================================================= */
  function countUp(el, to, ms, fmt) {
    if (reduce) { el.textContent = fmt ? fmt(to) : to; return; }
    const t0 = performance.now();
    (function step(now) {
      const p = Math.min((now - t0) / ms, 1);
      const v = Math.round(to * (1 - Math.pow(1 - p, 3)));
      el.textContent = fmt ? fmt(v) : v;
      if (p < 1) requestAnimationFrame(step);
    })(t0);
  }

  const io = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      e.target.classList.add('in');
      io.unobserve(e.target);

      if (e.target.contains(chart)) {
        $$('.bar', chart).forEach((b, n) =>
          setTimeout(() => { b.style.width = b.dataset.w; }, reduce ? 0 : n * 60));
      }
      if (e.target.querySelector('#c1')) countUp($('#c1'), 6, 900);
      if (e.target.querySelector('#c2')) countUp($('#c2'), 3974, 1200, v => v.toLocaleString());
    });
  }, { threshold: .15, rootMargin: '0px 0px -6% 0px' });
  $$('.rv').forEach(el => io.observe(el));

  /* =========================================================
     4. NAV — sticky, dropdowns, burger
     ========================================================= */
  const nav = $('#topnav');
  addEventListener('scroll', () => nav.classList.toggle('stuck', scrollY > 20), { passive: true });

  $$('[data-dd]').forEach(item => {
    const btn = $('.topnav__link', item);
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const open = item.classList.contains('open');
      $$('[data-dd]').forEach(i => i.classList.remove('open'));
      item.classList.toggle('open', !open);
    });
  });
  document.addEventListener('click', () => $$('[data-dd]').forEach(i => i.classList.remove('open')));

  const burger = $('#burger'), mobile = $('#mobileMenu');
  burger.addEventListener('click', () => {
    const open = mobile.classList.toggle('open');
    burger.classList.toggle('open', open);
    document.body.classList.toggle('is-locked', open);
  });
  $$('#mobileMenu a').forEach(a => a.addEventListener('click', () => {
    mobile.classList.remove('open');
    burger.classList.remove('open');
    document.body.classList.remove('is-locked');
  }));

  /* =========================================================
     5. LOGIN MODAL
     ========================================================= */
  const modal = $('#loginModal');
  const openModal = () => { modal.classList.add('open'); document.body.classList.add('is-locked'); setTimeout(() => $('#lmail').focus(), 260); };
  const closeModal = () => { modal.classList.remove('open'); document.body.classList.remove('is-locked'); };
  $('#loginBtn').addEventListener('click', openModal);
  $('#loginBtnM').addEventListener('click', () => {
    mobile.classList.remove('open'); burger.classList.remove('open'); openModal();
  });
  $$('[data-close]').forEach(el => el.addEventListener('click', closeModal));
  addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  $('#loginForm').addEventListener('submit', e => {
    e.preventDefault();
    $('#loginOk').classList.add('show');
  });

  /* =========================================================
     6. CONTACT FORM
     ========================================================= */
  $('#contactForm').addEventListener('submit', e => {
    e.preventDefault();
    const f = e.currentTarget;
    if (!f.checkValidity()) { f.reportValidity(); return; }
    $('#formOk').classList.add('show');
    f.reset();
  });

  /* =========================================================
     7. HERO CAROUSEL
     ========================================================= */
  const SLIDES = [
    { eyebrow: 'SETTLEMENT RECORD FOR STELLAR ANCHORS', title: ['DID THE MONEY', 'LAND?'],   tag: '6 OF 13 ANCHORS ARE DARK' },
    { eyebrow: 'READ OFF THE LEDGER, NOT THE STATUS PAGE', title: ['WE DON’T ASK.', 'WE LOOK.'], tag: 'NOBODY CAN OPT OUT' },
    { eyebrow: 'FOR WALLETS AND PAYMENT AGENTS',        title: ['ROUTE ON', 'EVIDENCE.'],    tag: 'ONE CALL, THE RIGHT ANCHOR' },
  ];
  let idx = 0;
  const cardLines  = $$('.card__line');
  const cardTag    = $('#cardTag');
  const cardEyebrow= $('#cardEyebrow');
  const cardDots   = $$('#cardDots .card__dot');

  function goTo(n) {
    n = (n + SLIDES.length) % SLIDES.length;
    if (n === idx) return;
    idx = n;
    const s = SLIDES[idx];
    const apply = () => {
      cardEyebrow.textContent = s.eyebrow;
      cardLines[0].textContent = s.title[0];
      cardLines[1].textContent = s.title[1];
      cardTag.textContent = s.tag;
      cardDots.forEach((d, i) => d.classList.toggle('is-active', i === idx));
    };
    if (!hasGsap || reduce) { apply(); return; }

    gsap.timeline({ onComplete: () => {
      apply();
      gsap.set(cardLines, { y: 60 });
      gsap.set(cardTag,   { y: 26, opacity: 0 });
      gsap.to(cardLines, { y: 0, duration: .6, stagger: .07, ease: 'power3.out' });
      gsap.to(cardTag,   { y: 0, opacity: 1, duration: .5, delay: .14, ease: 'power3.out' });
    }})
    .to(cardLines, { y: -60, duration: .32, stagger: .04, ease: 'power2.in' }, 0)
    .to(cardTag,   { y: -20, opacity: 0, duration: .28, ease: 'power2.in' }, 0);

    gsap.fromTo($('#card'), { scale: 1 }, { scale: 1.035, duration: .2, yoyo: true, repeat: 1, ease: 'sine.inOut' });
  }
  $('#prev').addEventListener('click', () => goTo(idx - 1));
  $('#next').addEventListener('click', () => goTo(idx + 1));
  cardDots.forEach((d, i) => d.addEventListener('click', () => goTo(i)));
  addEventListener('keydown', e => {
    if (modal.classList.contains('open')) return;
    if (e.key === 'ArrowLeft')  goTo(idx - 1);
    if (e.key === 'ArrowRight') goTo(idx + 1);
  });
  let auto = setInterval(() => goTo(idx + 1), 7000);
  $('#hero').addEventListener('mouseenter', () => clearInterval(auto));

  /* =========================================================
     8. LOADER + SCENE (GSAP)
     ========================================================= */
  const scene = {
    triL: $('[data-el="tri-left"]'),  triR: $('[data-el="tri-right"]'),
    sun:  $('[data-el="sun"]'),       cloudA: $('[data-el="cloud-a"]'),
    cloudB: $('[data-el="cloud-b"]'), birds: $('[data-el="birds"]'),
    light: $('[data-el="lighthouse"]'), sea: $('[data-el="sea"]'),
    anchors: $('[data-el="anchors"]'), coins: $('[data-el="coins"]'),
    dots: $$('[data-el="dots"]'),
  };
  const navEls = $$('[data-nav-el]'), card = $('#card');
  const loader = $('#loader');

  if (!hasGsap || reduce) {
    // No GSAP or motion is unwelcome: show everything, skip the choreography.
    loader.style.display = 'none';
    [...navEls, card, ...Object.values(scene).flat()].forEach(el => { if (el) el.style.opacity = 1; });
    countUp($('#c1'), 6, 0);
    return;
  }

  gsap.set([scene.triL], { xPercent: -100, opacity: 0 });
  gsap.set([scene.triR], { xPercent: 100,  opacity: 0 });
  gsap.set(scene.sun,    { scale: 0, opacity: 0, transformOrigin: 'center' });
  gsap.set(scene.cloudA, { x: -220, opacity: 0 });
  gsap.set(scene.cloudB, { x: 220,  opacity: 0 });
  gsap.set(scene.birds,  { y: -40,  opacity: 0 });
  gsap.set(scene.light,  { y: 160, opacity: 0, transformOrigin: 'center bottom' });
  gsap.set(scene.sea,    { y: 180, opacity: 0 });
  gsap.set(scene.anchors,{ y: 120, opacity: 0, scale: .8, transformOrigin: 'center bottom' });
  gsap.set(scene.coins,  { scale: 0, opacity: 0, transformOrigin: 'center' });
  gsap.set(scene.dots,   { scale: 0, opacity: 0, transformOrigin: 'center' });
  gsap.set(navEls,       { y: -30, opacity: 0 });
  gsap.set(card,         { y: 120, opacity: 0, scale: .82 });
  gsap.set(cardLines,    { y: 60 });

  const blocks = $$('.loader__block');
  gsap.set(blocks, { y: -220, opacity: 0 });

  const tl = gsap.timeline({ onComplete: playScene });
  blocks.forEach((b, i) => tl.to(b, { y: 0, opacity: 1, duration: .7, ease: 'bounce.out' }, i * .18));

  const prog = { v: 0 };
  const phases = [[30, 'RESOLVING DOMAINS'], [62, 'INDEXING PAYMENTS'], [88, 'COMPUTING LIVENESS'], [100, 'DONE']];
  let ph = 0;
  tl.to(prog, {
    v: 100, duration: 1.8, ease: 'power1.inOut',
    onUpdate() {
      $('#loader-counter').textContent = Math.round(prog.v) + '%';
      while (ph < phases.length && prog.v >= phases[ph][0]) $('#loader-label').textContent = phases[ph++][1];
    }
  }, .1);

  tl.to($('.loader__blocks'), { rotation: -3, duration: .12, yoyo: true, repeat: 3, ease: 'sine.inOut' }, '+=.15');
  tl.to(blocks, {
    y: i => -420 - i * 60, x: i => (i - 1.5) * 130, rotation: i => (i - 1.5) * 120,
    opacity: 0, duration: .9, ease: 'power2.in', stagger: .04
  }, '+=.15');
  tl.to($('.loader__meta'), { opacity: 0, y: -20, duration: .4, ease: 'power2.in' }, '<');
  tl.to($('#loader-cover'), { y: '-100%', height: '100%', duration: 1, ease: 'power4.inOut' }, '-=.3');
  tl.to(loader, { opacity: 0, duration: .3, ease: 'power2.in' }, '+=.05');
  tl.set(loader, { display: 'none' });

  function playScene() {
    const t = gsap.timeline({ defaults: { ease: 'power3.out' } });
    t.to(scene.triL, { xPercent: 0, opacity: 1, duration: .9, ease: 'power4.out' }, 0)
     .to(scene.triR, { xPercent: 0, opacity: 1, duration: .9, ease: 'power4.out' }, .05)
     .to(scene.sea,  { y: 0, opacity: 1, duration: 1, ease: 'power3.out' }, .1)
     .to(scene.sun,  { scale: 1, opacity: 1, duration: 1, ease: 'elastic.out(1,.6)' }, .2)
     .to(scene.cloudA, { x: 0, opacity: 1, duration: 1.2, ease: 'power2.out' }, .25)
     .to(scene.cloudB, { x: 0, opacity: 1, duration: 1.2, ease: 'power2.out' }, .35)
     .to(scene.light, { y: 0, opacity: 1, duration: 1, ease: 'back.out(1.6)' }, .45)
     .to(scene.anchors, { y: 0, opacity: 1, scale: 1, duration: 1, ease: 'back.out(1.7)' }, .65)
     .to(scene.coins, { scale: 1, opacity: 1, duration: .9, ease: 'back.out(2)' }, .8)
     .to(scene.birds, { y: 0, opacity: 1, duration: .7 }, 1)
     .to(scene.dots,  { scale: 1, opacity: 1, duration: .5, stagger: .08, ease: 'back.out(2)' }, 1.1)
     .to(navEls, { y: 0, opacity: 1, duration: .6, stagger: .07 }, .2)
     .to(card,   { y: 0, opacity: 1, scale: 1, duration: .9, ease: 'back.out(1.7)' }, 1.15)
     .to(cardLines, { y: 0, duration: .7, stagger: .08, ease: 'power3.out' }, 1.4)
     .call(idle, null, 1.8);
  }

  function idle() {
    gsap.to(scene.light,   { y: '-=7',  duration: 3,   ease: 'sine.inOut', yoyo: true, repeat: -1 });
    gsap.to(scene.cloudA,  { x: '+=34', duration: 6,   ease: 'sine.inOut', yoyo: true, repeat: -1 });
    gsap.to(scene.cloudB,  { x: '-=26', duration: 7,   ease: 'sine.inOut', yoyo: true, repeat: -1 });
    gsap.to(scene.birds,   { y: '-=9',  duration: 1.5, ease: 'sine.inOut', yoyo: true, repeat: -1 });
    gsap.to(scene.anchors, { y: '-=11', rotation: 1.6, duration: 2.6, ease: 'sine.inOut', yoyo: true, repeat: -1 });

    // The lamp pulses and the beam sweeps — this is the beacon, after all.
    gsap.to('#lamp',  { opacity: .45, duration: 1.4, ease: 'sine.inOut', yoyo: true, repeat: -1 });
    gsap.to('#beam',  { rotation: 8, duration: 4, ease: 'sine.inOut', yoyo: true, repeat: -1 });

    // Waves drift against each other.
    gsap.to('#wave1', { x: 26,  duration: 5.5, ease: 'sine.inOut', yoyo: true, repeat: -1 });
    gsap.to('#wave2', { x: -22, duration: 6.5, ease: 'sine.inOut', yoyo: true, repeat: -1 });

    // Coins arc and land, staggered, forever.
    ['#coin1', '#coin2', '#coin3'].forEach((c, i) => {
      gsap.to(c, { y: -26, rotation: 180, duration: 2 + i * .4, ease: 'sine.inOut', yoyo: true, repeat: -1, delay: i * .5 });
    });

    // The dark anchor lists over, slowly. Small detail, but it is the point.
    gsap.to('#anchor-c', { rotation: 16, duration: 4.5, ease: 'sine.inOut', yoyo: true, repeat: -1 });
  }

  /* =========================================================
     9. GENTLE MOUSE PARALLAX
     ========================================================= */
  let tx = 0, ty = 0, cx = 0, cy = 0, ready = false;
  const hero = $('#hero');
  hero.addEventListener('mousemove', e => {
    const r = hero.getBoundingClientRect();
    tx = ((e.clientX - r.left) / r.width  - .5) * 2;
    ty = ((e.clientY - r.top)  / r.height - .5) * 2;
  });
  hero.addEventListener('mouseleave', () => { tx = 0; ty = 0; });
  gsap.delayedCall(4.2, () => { ready = true; });

  gsap.ticker.add(() => {
    if (!ready) return;
    cx += (tx - cx) * .05;
    cy += (ty - cy) * .05;
    gsap.set(scene.cloudA, { x: cx * 26, y: cy * 12 });
    gsap.set(scene.cloudB, { x: cx * 20, y: cy * 10 });
    gsap.set(scene.birds,  { x: cx * 34 });
    gsap.set(scene.sun,    { x: cx * 10, y: cy * 8 });
    gsap.set(scene.coins,  { x: cx * 18, y: cy * 14 });
    scene.dots.forEach((d, i) => gsap.set(d, { x: cx * (26 + i * 6), y: cy * (18 + i * 5) }));
  });
  // Lighthouse, sea and anchors keep their idle loops — parallax would fight them.
})();
