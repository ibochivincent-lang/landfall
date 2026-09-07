/**
 * nav.js — the mobile menu, for every page using the .topnav header.
 *
 * There was no mobile navigation on these pages at all. dashboard.css hides
 * `.topnav__pill` below 780px and nothing revealed it again, so on a phone the
 * dashboard, Route Scout, Trust Check, Cross-chain, Docs and Portal had no way
 * to reach any other page — you could only get back by editing the URL.
 *
 * The landing page had the opposite failure: a hamburger that toggled an
 * `.is-open` class which no stylesheet defined, so the button was there,
 * animated its aria-expanded state correctly, and did nothing at all.
 *
 * Kept as its own file rather than added to each page's bundle because two of
 * these pages (docs, anchors) load no script whatsoever, and a header that
 * only works where a bundle happens to exist is how this broke the first time.
 */
(function () {
  'use strict';

  function init() {
    var header = document.querySelector('.topnav');
    if (!header) return;

    var pill = header.querySelector('.topnav__pill');
    if (!pill) return;

    // Build the toggle rather than expecting it in the markup: it has to
    // appear on every page carrying this header, and six separate copies of
    // the same button is six chances for one to go missing.
    var btn = document.createElement('button');
    btn.className = 'topnav__burger';
    btn.id = 'topnavBurger';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Open navigation');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', pill.id || 'topnavPill');
    if (!pill.id) pill.id = 'topnavPill';
    btn.innerHTML = '<i></i><i></i><i></i>';

    var inner = header.querySelector('.topnav__in') || header;
    inner.appendChild(btn);

    function setOpen(open) {
      pill.classList.toggle('is-open', open);
      btn.classList.toggle('is-open', open);
      btn.setAttribute('aria-expanded', String(open));
      btn.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
    }

    btn.addEventListener('click', function () {
      setOpen(!pill.classList.contains('is-open'));
    });

    // Following a link should close the panel. Without this the menu stays
    // open across an in-page anchor jump and covers what you navigated to.
    pill.addEventListener('click', function (ev) {
      if (ev.target.closest('a')) setOpen(false);
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') setOpen(false);
    });

    // A resize back to desktop must clear the open state, or the panel's
    // mobile styles linger on a layout that no longer has a toggle to undo them.
    var mq = window.matchMedia('(min-width: 781px)');
    var onChange = function (e) { if (e.matches) setOpen(false); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
