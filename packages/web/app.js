(() => {
  /* ============================================================
     LANDFALL · STELLAR — app.js
     GSAP loader: Stellar ledger scan card + counter
     GSAP entrance: hero line reveal, fade-ins, card parallax
     ============================================================ */

  // ── DOM refs ─────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);

  const loaderEl      = $('loader');
  const loaderCard    = $('loaderCard');
  const loaderScan    = $('loaderScan');
  const loaderCounter = $('loaderCounter');
  const loaderBarFill = $('loaderBarFill');
  const loaderDigits  = $('loaderDigits');
  const loaderCheck   = $('loaderCheck');
  const loaderLabel   = $('loaderLabel');

  const lineInners = document.querySelectorAll('.hero__line-inner');
  const fades      = document.querySelectorAll('[data-fade]');
  const visual     = document.querySelector('.visual');
  const ledgerPanel = document.querySelector('.ledger-panel');
  const recordCard  = document.querySelector('.record');
  const floatChips  = document.querySelectorAll('.float-chip');

  const menuBtn  = $('menu');
  const navLinks = $('navLinks');

  // ── Fallback data ─────────────────────────────────────────────
  // Shape-identical to the API (`state`, not `status`) so the fallback cannot
  // drift from the real payload the way it did before: this page previously
  // read `a.status` while the API has always sent `a.state`, so every account
  // classified as "none" — and the fetch handed render() the whole response
  // object instead of its `accounts` array, so `.map` threw and the error was
  // swallowed by an empty `.catch`. The result was a page that showed
  // hardcoded numbers under a "LIVE" badge and never once displayed live data.
  const fallback = [
    { state: 'live' }, { state: 'live' }, { state: 'live' }, { state: 'live' },
    { state: 'slow' }, { state: 'slow' }, { state: 'slow' }, { state: 'dark' },
    { state: 'dark' }, { state: 'dark' }, { state: 'dark' }, { state: 'dark' },
    { state: 'no_activity' }
  ];

  const fmt = (n) => Number(n || 0).toLocaleString('en-US');

  // ── Render anchor stats ────────────────────────────────────────
  function render(accounts, meta) {
    if (!Array.isArray(accounts) || accounts.length === 0) return;

    const total = accounts.length;
    const live  = accounts.filter(a => (a.state || a.status) === 'live').length;
    const dark  = accounts.filter(a => (a.state || a.status) === 'dark').length;
    const fast  = total > 0 ? Math.round((live / total) * 100) : 0;

    if ($('anchorCount'))    $('anchorCount').textContent    = total;
    if ($('coverageCount'))  $('coverageCount').textContent  = total;
    if ($('footerAccounts')) $('footerAccounts').textContent = total;
    if ($('cardAccounts'))   $('cardAccounts').textContent   = total + ' accounts';
    if ($('liveCount'))     $('liveCount').textContent     = live;
    if ($('darkCount'))     $('darkCount').textContent     = dark;
    if ($('heroDark'))      $('heroDark').textContent      = dark + ' of ' + total;
    if ($('fastPct'))       $('fastPct').textContent       = fast + '%';
    if ($('fastMeter'))     $('fastMeter').style.width     = fast + '%';

    // Inbound payment count, summed from the same rows the dashboard shows.
    // This replaces a hardcoded "$1,876,580 observed volume" that was animated
    // to look live and was never derived from anything. A single dollar figure
    // would require converting ARS, EURC, NGNT, BRL, PEN and XLM at rates this
    // project does not have and will not invent — so it reports the thing it
    // can actually prove: how many settlements it indexed.
    const inbound = accounts.reduce((sum, a) => sum + Number(a.inbound || 0), 0);
    if ($('cardVolume') && inbound > 0) $('cardVolume').textContent = fmt(inbound);

    // Scan date comes from the payload, never from a string typed into the
    // HTML — a page that badges itself "LIVE" must not date itself by hand.
    if (meta && meta.asOf && $('scanDate')) {
      const d = new Date(meta.asOf);
      if (!isNaN(d)) {
        $('scanDate').textContent = d.toLocaleDateString('en-GB', {
          day: 'numeric', month: 'long', year: 'numeric',
        });
      }
    }
  }

  render(fallback);
  fetch('/api/v1/anchors', { headers: { accept: 'application/json' } })
    .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
    .then(b => render(b.accounts || b.anchors || b.data, b))
    .catch((err) => {
      // Still quiet for the visitor, but no longer invisible to us: a silent
      // catch is how the two bugs above survived unnoticed.
      if (typeof console !== 'undefined') {
        console.warn('[landfall] live anchor data unavailable, showing snapshot:', err && err.message);
      }
    });

  // ── Set initial GSAP hidden states ────────────────────────────
  if (window.gsap) {
    gsap.set(lineInners, { y: '110%' });
    gsap.set(fades,       { y: 24, opacity: 0 });
    if (ledgerPanel) gsap.set(ledgerPanel, { x: 140, y: -60, rotation: 8, opacity: 0, scale: 0.85 });
    if (recordCard)  gsap.set(recordCard,  { x: 120, opacity: 0, scale: 0.92 });
    if (floatChips)  gsap.set(floatChips,  { y: 12, opacity: 0 });

    // ── LOADER TIMELINE ───────────────────────────────────────────
    const loaderTl = gsap.timeline({ onComplete: playScene });

    // Card drop-in
    loaderTl.from(loaderCard, {
      y: -30, opacity: 0,
      duration: 0.6,
      ease: 'power3.out',
    }, 0);

    // Scan line sweeps across
    loaderTl.fromTo(loaderScan,
      { x: 0 },
      { x: 480, duration: 1.3, ease: 'power2.inOut', repeat: 1 },
      0.3
    );

    // Digit reel (account ID scramble)
    const suffixes = ['WXYZ','GA23','XB4F','7YPN','QRTM','K9VL','ZBHW','0000'];
    let sIdx = 0;
    loaderTl.to({}, {
      duration: 2,
      onUpdate: function() {
        const progress = this.progress();
        const idx = Math.floor(progress * (suffixes.length - 1));
        if (loaderDigits && idx !== sIdx) {
          sIdx = idx;
          loaderDigits.textContent = suffixes[idx];
        }
      }
    }, 0.3);

    // Loader counter — counts up to whatever the page is actually showing,
    // rather than to a hardcoded dollar figure. If live data has not landed
    // yet it counts to the snapshot value, which is still a real number.
    const p = { amount: 0 };
    const loaderTarget = Number(String($('cardVolume')?.textContent || '0').replace(/[^0-9]/g, '')) || 0;
    loaderTl.to(p, {
      amount: loaderTarget,
      duration: 2.1,
      ease: 'power2.out',
      onUpdate: () => {
        if (loaderCounter) {
          loaderCounter.textContent = Math.round(p.amount).toLocaleString('en-US');
        }
      },
    }, 0.3);

    // Progress bar
    loaderTl.to(loaderBarFill, {
      width: '100%',
      duration: 2.1,
      ease: 'power2.out',
    }, 0.3);

    // Settle digits
    loaderTl.call(() => {
      if (loaderDigits) loaderDigits.textContent = 'WXYZ';
    }, null, 2.35);

    // Check overlay
    loaderTl.to(loaderCheck, {
      opacity: 1, duration: 0.4, ease: 'power2.out',
    }, '+=0.08');
    loaderTl.from(loaderCheck.querySelector('svg'), {
      scale: 0, rotation: -45, duration: 0.55, ease: 'back.out(2)',
    }, '<');
    loaderTl.call(() => {
      if (loaderLabel) loaderLabel.textContent = 'Ledger read — 13 anchors';
    }, null, '<');

    // Exit
    loaderTl.to(loaderCard, {
      y: -40, scale: 0.94, duration: 0.45, ease: 'power3.in',
    }, '+=0.35');
    loaderTl.to(loaderEl, {
      opacity: 0, duration: 0.55, ease: 'power2.inOut',
    }, '-=0.15');
    loaderTl.call(() => {
      if (loaderEl) loaderEl.classList.add('is-done');
    });

  } else {
    // No GSAP fallback
    window.addEventListener('load', () =>
      setTimeout(() => loaderEl && loaderEl.classList.add('is-done'), 500)
    );
    playScene();
  }

  // ── MAIN SCENE ENTRANCE ───────────────────────────────────────
  function playScene() {
    if (!window.gsap) return;
    const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });

    // Title lines rise from under mask
    tl.to(lineInners, {
      y: '0%',
      duration: 1.05,
      stagger: 0.14,
      ease: 'power4.out',
    }, 0);

    // Fade-in elements: eyebrow, lede, CTA row, trust strip
    tl.to(fades, {
      y: 0, opacity: 1,
      duration: 0.7,
      stagger: 0.13,
    }, 0.35);

    // Ledger panel slides in
    if (ledgerPanel) {
      tl.to(ledgerPanel, {
        x: 0, y: 0, rotation: 3,
        opacity: 1, scale: 1,
        duration: 1.15,
        ease: 'power4.out',
      }, 0.55);
    }

    // Record card slides in
    if (recordCard) {
      tl.to(recordCard, {
        x: 0, opacity: 1, scale: 1,
        duration: 1.1,
        ease: 'power4.out',
      }, 0.75);
    }

    // Float chips pop in
    tl.to(floatChips, {
      y: 0, opacity: 1,
      duration: 0.55,
      stagger: 0.12,
      ease: 'back.out(2)',
    }, 1.1);

    // Ledger-panel counter — animates up to the real value already rendered
    // into the card by render(), never past it. The animation is decoration;
    // the number underneath it has to survive someone checking it.
    const el = $('cardVolume');
    const cardTarget = Number(String(el?.textContent || '0').replace(/[^0-9]/g, '')) || 0;
    if (el && cardTarget > 0) {
      const vc = { v: 0 };
      tl.to(vc, {
        v: cardTarget,
        duration: 1.6,
        ease: 'power2.out',
        onUpdate: () => { el.textContent = Math.round(vc.v).toLocaleString('en-US'); },
        onComplete: () => { el.textContent = cardTarget.toLocaleString('en-US'); },
      }, 0.9);
    }

    // Signal parallax is ready
    tl.call(() => { parallaxReady = true; }, null, 2.2);
  }

  // ── MOUSE PARALLAX on visual right column ─────────────────────
  let parallaxReady = false;
  let rx = 0, ry = 0, trx = 0, try_ = 0, idleT = 0;

  if (visual && window.gsap) {
    visual.addEventListener('mousemove', (e) => {
      const r = visual.getBoundingClientRect();
      trx = ((e.clientX - r.left)  / r.width  - 0.5) * 2;
      try_ = ((e.clientY - r.top)   / r.height - 0.5) * 2;
    });
    visual.addEventListener('mouseleave', () => { trx = 0; try_ = 0; });

    gsap.ticker.add((time, delta) => {
      if (!parallaxReady) return;
      rx  += (trx  - rx)  * 0.07;
      ry  += (try_ - ry)  * 0.07;
      idleT += delta * 0.001;

      const panelFloat = Math.sin(idleT * 1.1 + 0.8) * 8;
      const cardFloat  = Math.sin(idleT * 1.35) * 5;

      if (ledgerPanel) {
        gsap.set(ledgerPanel, {
          rotationY: rx * 9,
          rotationX: -ry * 5,
          x: rx * 12,
          y: panelFloat,
          transformPerspective: 1200,
          transformOrigin: 'center center',
        });
      }
      if (recordCard) {
        gsap.set(recordCard, {
          rotationY: rx * 5,
          rotationX: -ry * 3,
          x: rx * 5,
          y: cardFloat,
          transformPerspective: 1200,
          transformOrigin: 'center center',
        });
      }
    });
  }

  // ── MOBILE MENU ───────────────────────────────────────────────
  menuBtn?.addEventListener('click', () => {
    const open = navLinks.classList.toggle('is-open');
    menuBtn.setAttribute('aria-expanded', String(open));
  });

  // ── CONTACT FORM ──────────────────────────────────────────────
  // Contact form → a pre-filled GitHub issue.
  //
  // This form used to call preventDefault(), show a green success message and
  // discard the message. That is worse than having no form: someone asking to
  // integrate, or an anchor disputing a figure we published about them, would
  // believe they had reached us. There is no mail backend and inventing an
  // address would be the same lie in a different place, so it routes to the
  // one channel that demonstrably works and that CONTRIBUTING/SECURITY already
  // name. Nothing is claimed to be sent until the user submits on GitHub.
  $('contactForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const form  = e.currentTarget;
    const name  = ($('cname')?.value  || '').trim();
    const email = ($('cmail')?.value  || '').trim();
    const topic = ($('ctopic')?.value || 'Something else').trim();
    const msg   = ($('cmsg')?.value   || '').trim();

    const body = [
      msg,
      '',
      '---',
      `Topic: ${topic}`,
      name  ? `From: ${name}`         : null,
      email ? `Reply-to: ${email}`    : null,
      'Sent from the landfall-ib.vercel.app contact form.',
    ].filter(Boolean).join('\n');

    const url =
      'https://github.com/ibochivincent-lang/landfall/issues/new'
      + '?title=' + encodeURIComponent(`[contact] ${topic}`)
      + '&body='  + encodeURIComponent(body);

    const ok = $('formOk');
    if (ok) {
      ok.style.display = 'block';
      setTimeout(() => { ok.style.display = 'none'; }, 8000);
    }
    window.open(url, '_blank', 'noopener');
    form.reset();
  });

})();
