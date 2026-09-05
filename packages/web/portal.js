/**
 * Landfall — Developer & Admin Portal Controller
 */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  let currentUser = null;

  /* ------------------------------------------------------------------ toast */

  function toast(msg, isError = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast ' + (isError ? 'toast--error' : 'toast--success');
    t.hidden = false;
    setTimeout(() => { t.hidden = true; }, 4000);
  }

  /* ------------------------------------------------------------------ api */

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(opts.headers || {}),
      },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'HTTP ' + res.status);
    return body;
  }

  /* ------------------------------------------------------------------ boot */

  async function checkSession() {
    try {
      const data = await api('/api/v1/auth/me');
      if (data.ok && data.user) {
        currentUser = data.user;
        renderLoggedIn();
        return;
      }
    } catch {}
    renderAuthView();
  }

  function renderAuthView() {
    $('#authView').hidden = false;
    $('#portalView').hidden = true;
    $('#userMenu').hidden = true;
  }

  function renderLoggedIn() {
    $('#authView').hidden = true;
    $('#portalView').hidden = false;
    $('#userMenu').hidden = false;
    $('#userBadge').textContent = currentUser.username + ' (' + currentUser.role + ')';

    if (currentUser.role === 'admin') {
      $('#adminTabBtn').hidden = false;
    } else {
      $('#adminTabBtn').hidden = true;
    }

    loadKeys();
  }

  /* ----------------------------------------------------------- auth tabs */

  $$('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.auth-tab').forEach(t => t.classList.remove('is-active'));
      tab.classList.add('is-active');

      const target = tab.dataset.tab;
      $('#loginForm').hidden = target !== 'login';
      $('#registerForm').hidden = target !== 'register';
      $('#forgotForm').hidden = target !== 'forgot';
    });
  });

  // Login
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#loginIdent').value.trim();
    const password = $('#loginPassword').value;

    try {
      const res = await api('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      currentUser = res.user;
      toast(res.message || '✓ Logged in successfully!');
      renderLoggedIn();
    } catch (err) {
      toast(err.message, true);
    }
  });

  // Register
  $('#registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#regEmail').value.trim();
    const username = $('#regUsername').value.trim();
    const password = $('#regPassword').value;

    try {
      const res = await api('/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, username, password }),
      });
      currentUser = res.user;
      toast('✓ Account registered! Initial API Key generated.');
      renderLoggedIn();
      if (res.initialKey) {
        showKeyReveal(res.initialKey);
      }
    } catch (err) {
      toast(err.message, true);
    }
  });

  // Forgot Password
  $('#forgotForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#forgotEmail').value.trim();

    try {
      const res = await api('/api/v1/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      // The API never returns the reset token itself (see docs/gaps.md) —
      // that used to be a full account-takeover primitive: anyone who knew
      // a victim's email could read the token straight off this response
      // and reset their password. The code now only ever arrives by email;
      // reveal the "paste your code" step once it's been sent.
      toast(res.message);
      $('#resetStep2').hidden = false;
    } catch (err) {
      toast(err.message, true);
    }
  });

  // Confirm Reset
  $('#confirmResetBtn').addEventListener('click', async () => {
    const token = $('#resetToken').value.trim();
    const newPassword = $('#newPassword').value;

    try {
      const res = await api('/api/v1/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ token, newPassword }),
      });
      toast(res.message);
      $('#forgotForm').reset();
      $('#resetStep2').hidden = true;
      $$('.auth-tab')[0].click(); // Switch to login
    } catch (err) {
      toast(err.message, true);
    }
  });

  // Logout
  $('#logoutBtn').addEventListener('click', async () => {
    try {
      await api('/api/v1/auth/logout', { method: 'POST' });
      currentUser = null;
      toast('Logged out successfully.');
      renderAuthView();
    } catch (err) {
      toast(err.message, true);
    }
  });

  /* --------------------------------------------------------- portal views */

  $$('.portal-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.portal-nav-btn').forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');

      const view = btn.dataset.view;
      $$('.portal-section').forEach(sec => {
        sec.hidden = sec.id !== 'view-' + view;
      });

      if (view === 'keys') loadKeys();
      if (view === 'webhooks') loadWebhooks();
      if (view === 'admin' && currentUser?.role === 'admin') loadAdminView();
    });
  });

  /* ------------------------------------------------------------- api keys */

  async function loadKeys() {
    const tbody = $('#keysTableBody');
    try {
      const res = await api('/api/v1/developer/keys');
      if (!res.keys || res.keys.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="muted">No API keys generated yet. Click "+ Create New Key" above.</td></tr>';
        return;
      }

      tbody.innerHTML = '';
      for (const k of res.keys) {
        const tr = document.createElement('tr');
        const isRevoked = Boolean(k.revoked_at);
        tr.innerHTML = `
          <td><strong>${esc(k.name)}</strong></td>
          <td><code class="mono">${esc(k.key_prefix)}</code></td>
          <td><span class="mono">${k.rate_limit_per_min}/min</span></td>
          <td>${new Date(k.created_at).toLocaleDateString()}</td>
          <td><span class="${isRevoked ? 'badge-revoked' : 'badge-active'}">${isRevoked ? 'Revoked' : 'Active'}</span></td>
          <td>
            ${isRevoked ? '—' : `<button class="dash-btn dash-btn--ghost btn-sm revoke-btn" data-id="${k.id}">Revoke</button>`}
          </td>
        `;
        tbody.appendChild(tr);
      }

      $$('.revoke-btn').forEach(btn => {
        btn.addEventListener('click', () => revokeKey(btn.dataset.id));
      });
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6" class="muted">Failed to load keys: ${esc(err.message)}</td></tr>`;
    }
  }

  function showKeyReveal(rawKey) {
    const box = $('#keyRevealBox');
    $('#revealedKey').textContent = rawKey;
    box.hidden = false;
    $('#copyKeyBtn').onclick = () => {
      navigator.clipboard.writeText(rawKey);
      toast('✓ Copied API key to clipboard!');
    };
  }

  $('#newKeyBtn').addEventListener('click', async () => {
    const name = prompt('Enter a label for this API key:', 'Production Key');
    if (!name) return;

    try {
      const res = await api('/api/v1/developer/keys', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      toast('✓ ' + res.message);
      showKeyReveal(res.secretKey);
      loadKeys();
    } catch (err) {
      toast(err.message, true);
    }
  });

  async function revokeKey(id) {
    if (!confirm('Are you sure you want to revoke this API key? Any applications using it will be blocked.')) return;
    try {
      await api('/api/v1/developer/keys/' + id, { method: 'DELETE' });
      toast('API key revoked.');
      loadKeys();
    } catch (err) {
      toast(err.message, true);
    }
  }

  /* ------------------------------------------------------------- webhooks */

  async function loadWebhooks() {
    const tbody = $('#webhooksTableBody');
    try {
      const res = await api('/api/v1/developer/webhooks');
      if (!res.webhooks || res.webhooks.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="muted">No webhooks registered yet. Click "+ Add Webhook Endpoint" above.</td></tr>';
        return;
      }

      tbody.innerHTML = '';
      for (const w of res.webhooks) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><code class="mono">${esc(w.target_url)}</code></td>
          <td><span class="mono">${(w.events || []).join(', ')}</span></td>
          <td><span class="badge-active">Active</span></td>
          <td>${new Date(w.created_at).toLocaleDateString()}</td>
          <td><button class="dash-btn dash-btn--ghost btn-sm del-wh-btn" data-id="${w.id}">Delete</button></td>
        `;
        tbody.appendChild(tr);
      }

      $$('.del-wh-btn').forEach(btn => {
        btn.addEventListener('click', () => deleteWebhook(btn.dataset.id));
      });
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5" class="muted">Failed to load webhooks: ${esc(err.message)}</td></tr>`;
    }
  }

  $('#newWebhookBtn').addEventListener('click', () => {
    $('#webhookFormBox').hidden = !$('#webhookFormBox').hidden;
  });

  $('#saveWebhookBtn').addEventListener('click', async () => {
    const url = $('#webhookUrlInput').value.trim();
    if (!url.startsWith('https://')) {
      toast('Webhook URL must begin with https://', true);
      return;
    }

    try {
      const res = await api('/api/v1/developer/webhooks', {
        method: 'POST',
        body: JSON.stringify({ url }),
      });
      toast('✓ ' + res.message);
      $('#webhookUrlInput').value = '';
      $('#webhookFormBox').hidden = true;
      loadWebhooks();
    } catch (err) {
      toast(err.message, true);
    }
  });

  async function deleteWebhook(id) {
    try {
      await api('/api/v1/developer/webhooks/' + id, { method: 'DELETE' });
      toast('Webhook removed.');
      loadWebhooks();
    } catch (err) {
      toast(err.message, true);
    }
  }

  /* ------------------------------------------------------------- explorer */

  $('#runExplorerBtn').addEventListener('click', async () => {
    const ep = $('#explorerEndpoint').value;
    const resBox = $('#explorerResult');
    resBox.textContent = 'Executing request to ' + ep + '…';

    try {
      const body = await api(ep);
      resBox.textContent = JSON.stringify(body, null, 2);
    } catch (err) {
      resBox.textContent = '// Error: ' + err.message;
    }
  });

  /* ------------------------------------------------------------- quickstart */

  $$('.code-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.code-tab').forEach(t => t.classList.remove('is-active'));
      tab.classList.add('is-active');

      const lang = tab.dataset.lang;
      const pre = $('#quickstartCode');

      if (lang === 'curl') {
        pre.textContent = `curl -X GET "https://landfall-ib.vercel.app/api/v1/anchors/cowrie.exchange/health-check" \\
  -H "x-api-key: YOUR_API_KEY"`;
      } else if (lang === 'js') {
        pre.textContent = `const res = await fetch('https://landfall-ib.vercel.app/api/v1/anchors/cowrie.exchange/health-check', {
  headers: { 'x-api-key': 'YOUR_API_KEY' }
});
const { healthy, score, recommendation } = await res.json();
if (!healthy) console.warn('Anchor settlement degraded:', recommendation);`;
      } else if (lang === 'python') {
        pre.textContent = `import requests

res = requests.get(
  "https://landfall-ib.vercel.app/api/v1/anchors/cowrie.exchange/health-check",
  headers={"x-api-key": "YOUR_API_KEY"}
)
data = res.json()
print(f"Health: {data['healthy']} | Score: {data['score']}/100")`;
      }
    });
  });

  /* ----------------------------------------------------------- super admin */

  async function loadAdminView() {
    // Tracked anchors
    try {
      const { anchors } = await api('/api/v1/admin/anchors');
      const container = $('#trackedDomainsList');
      container.innerHTML = anchors.map(a => `<div class="mono" style="padding:4px 0">• <b>${esc(a.domain)}</b> ${a.active ? '(active)' : '(paused)'}</div>`).join('');
    } catch {}

    // Health
    try {
      const health = await api('/api/v1/admin/health');
      $('#adminHealthStats').innerHTML = `
        <div>Scans Completed: <b>${health.scansCount || 0}</b></div>
        <div>Payments Indexed: <b>${(health.tableCounts?.payments || 0).toLocaleString()}</b></div>
        <div>Oracle Status: <b>${health.oracle ? 'Published' : 'Pending'}</b></div>
      `;
    } catch {}
  }

  $('#addDomainBtn')?.addEventListener('click', async () => {
    const domain = $('#adminDomainInput').value.trim();
    if (!domain) return;
    try {
      await api('/api/v1/admin/anchors', {
        method: 'POST',
        body: JSON.stringify({ domain }),
      });
      toast('✓ Tracked anchor domain added.');
      $('#adminDomainInput').value = '';
      loadAdminView();
    } catch (err) {
      toast(err.message, true);
    }
  });

  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  checkSession();
})();
