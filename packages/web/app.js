(() => {
  const fallback = [
    { status: 'live' }, { status: 'live' }, { status: 'live' }, { status: 'live' },
    { status: 'slow' }, { status: 'slow' }, { status: 'slow' }, { status: 'dark' },
    { status: 'dark' }, { status: 'dark' }, { status: 'dark' }, { status: 'dark' }, { status: 'none' }
  ];
  const $ = (id) => document.getElementById(id);
  const loader = $('loader');
  addEventListener('load', () => setTimeout(() => loader.classList.add('is-done'), 650));

  function render(accounts) {
    const normalized = accounts.map(a => ({ status: a.status || a.s || 'none' }));
    const total = normalized.length || fallback.length;
    const live = normalized.filter(a => a.status === 'live').length;
    const dark = normalized.filter(a => a.status === 'dark').length;
    const fast = Math.round((live / total) * 100);
    $('anchorCount').textContent = total;
    $('coverageCount').textContent = total;
    $('liveCount').textContent = live;
    $('darkCount').textContent = dark;
    $('fastPct').textContent = fast + '%';
    $('fastMeter').style.width = fast + '%';
  }
  render(fallback);
  fetch('/api/v1/anchors', { headers: { accept: 'application/json' } })
    .then(response => response.ok ? response.json() : Promise.reject())
    .then(body => render(body.anchors || body.data || body))
    .catch(() => {});

  const menu = $('menu');
  const links = $('navLinks');
  menu?.addEventListener('click', () => {
    const open = links.classList.toggle('is-open');
    menu.setAttribute('aria-expanded', String(open));
  });
  $('contactForm')?.addEventListener('submit', event => {
    event.preventDefault();
    $('formMessage').textContent = 'Thanks — we will be in touch when pilot access opens.';
    event.currentTarget.reset();
  });
})();
