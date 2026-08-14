(() => {
  /* ============================================================
     LANDFALL · STELLAR — app.js
     GSAP loader: Stellar ledger scan card + counter
     GSAP entrance: hero line reveal, fade-ins, card parallax
     ============================================================ */

  const TARGET_VOLUME = 1876580;

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
  const fallback = [
    { status: 'live' }, { status: 'live' }, { status: 'live' }, { status: 'live' },
    { status: 'slow' }, { status: 'slow' }, { status: 'slow' }, { status: 'dark' },
    { status: 'dark' }, { status: 'dark' }, { status: 'dark' }, { status: 'dark' },
    { status: 'none' }
  ];

  // ── Render anchor stats ────────────────────────────────────────
  function render(accounts) {
    const data  = accounts.map(a => ({ status: a.status || a.s || 'none' }));
    const total = data.length || fallback.length;
    const live  = data.filter(a => a.status === 'live').length;
    const dark  = data.filter(a => a.status === 'dark').length;
    const fast  = Math.round((live / total) * 100);
    if ($('anchorCount'))  $('anchorCount').textContent  = total;
    if ($('coverageCount')) $('coverageCount').textContent = total;
    if ($('liveCount'))    $('liveCount').textContent    = live;
    if ($('darkCount'))    $('darkCount').textContent    = dark;
    if ($('heroDark'))     $('heroDark').textContent     = dark + ' of ' + total;
    if ($('fastPct'))      $('fastPct').textContent      = fast + '%';
    if ($('fastMeter'))    $('fastMeter').style.width    = fast + '%';
  }
  render(fallback);
  fetch('/api/v1/anchors', { headers: { accept: 'application/json' } })
    .then(r => r.ok ? r.json() : Promise.reject())
    .then(b => render(b.anchors || b.data || b))
    .catch(() => {});

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

    // Volume counter
    const p = { amount: 0 };
    loaderTl.to(p, {
      amount: TARGET_VOLUME,
      duration: 2.1,
      ease: 'power2.out',
      onUpdate: () => {
        if (loaderCounter) {
          loaderCounter.textContent = '$' + Math.round(p.amount).toLocaleString('en-US');
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

    // Volume counter on ledger panel card
    const vc = { v: 0 };
    tl.to(vc, {
      v: TARGET_VOLUME,
      duration: 1.6,
      ease: 'power2.out',
      onUpdate: () => {
        const el = $('cardVolume');
        if (el) el.textContent = '$' + Math.round(vc.v).toLocaleString('en-US');
      },
    }, 0.9);

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
  $('contactForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const ok = $('formOk');
    const err = $('formErr');
    if (err) err.style.display = 'none';

    const payload = {
      name: $('cname')?.value.trim() || '',
      email: $('cmail')?.value.trim() || '',
      topic: $('ctopic')?.value || '',
      message: $('cmsg')?.value.trim() || '',
    };

    try {
      const res = await fetch('/api/v1/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Could not send right now.');

      if (ok) {
        ok.textContent = body.message || 'Message sent — we reply to everything.';
        ok.style.display = 'block';
        setTimeout(() => { ok.style.display = 'none'; }, 5000);
      }
      form.reset();
    } catch (sendErr) {
      if (err) {
        err.textContent = sendErr.message;
        err.style.display = 'block';
        setTimeout(() => { err.style.display = 'none'; }, 6000);
      }
    }
  });

})();
