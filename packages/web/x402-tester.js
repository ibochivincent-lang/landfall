/**
 * packages/web/x402-tester.js
 *
 * Author: ibochivincent-lang
 *
 * Client controller for x402 Pre-Flight Inspector.
 * Interacts with POST /api/v1/x402/check-payee to evaluate counterparties
 * before an AI agent or automated wallet signs an HTTP 402 payment.
 */

(function () {
  'use strict';

  function qs(sel) { return document.querySelector(sel); }
  function qsa(sel) { return document.querySelectorAll(sel); }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  const PRESETS = {
    testnet_usdc: {
      accepts: [
        {
          scheme: "exact",
          network: "stellar:testnet",
          asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          amount: "100000",
          payTo: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
          maxTimeoutSeconds: 300,
          extra: { resource: "/api/v1/corridors/export" },
        },
      ],
    },
    muxed_account: {
      accepts: [
        {
          scheme: "exact",
          network: "stellar:testnet",
          asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          amount: "250000",
          payTo: "MA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KAAAAAAAAABQHGNKE",
          maxTimeoutSeconds: 300,
          extra: { depositMemo: "12345" },
        },
      ],
    },
    multi_payee: {
      accepts: [
        {
          scheme: "exact",
          network: "stellar:pubnet",
          asset: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
          amount: "500000",
          payTo: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
          maxTimeoutSeconds: 60,
          extra: {},
        },
        {
          scheme: "exact",
          network: "stellar:testnet",
          asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          amount: "500000",
          payTo: "MA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KAAAAAAAAABQHGNKE",
          maxTimeoutSeconds: 60,
          extra: {},
        },
      ],
    },
    contract_payee: {
      accepts: [
        {
          scheme: "exact",
          network: "stellar:testnet",
          asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          amount: "1000000",
          payTo: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
          maxTimeoutSeconds: 60,
          extra: {},
        },
      ],
    },
  };

  const presetSelect = qs('#presetSelect');
  const x402Input = qs('#x402Input');
  const inspectBtn = qs('#inspectBtn');
  const resultsContainer = qs('#resultsContainer');
  const verdictBadge = qs('#verdictBadge');
  const snippetCode = qs('#snippetCode');

  function loadPreset(key) {
    const data = PRESETS[key] || PRESETS.testnet_usdc;
    x402Input.value = JSON.stringify(data, null, 2);
    updateSnippets();
  }

  presetSelect.addEventListener('change', () => loadPreset(presetSelect.value));

  function updateSnippets() {
    const raw = x402Input.value.trim();
    const activeTab = qs('.snippet-tab.active')?.dataset.lang || 'curl';

    if (activeTab === 'curl') {
      snippetCode.textContent = `curl -X POST https://landfall.stellar.org/api/v1/x402/check-payee \\\n  -H "Content-Type: application/json" \\\n  -d '${raw.replace(/'/g, "'\\''")}'`;
    } else if (activeTab === 'js') {
      snippetCode.textContent = `import { evaluatePaymentRequirements } from '@landfall/x402';\n\nconst reqs = ${raw};\nconst results = await evaluatePaymentRequirements(reqs.accepts, async (addr) => {\n  const res = await fetch(\`https://landfall.stellar.org/api/v1/trust-check?address=\${addr}\`);\n  return { ok: true, trustCheck: await res.json() };\n});\nconsole.log(results);`;
    } else if (activeTab === 'mcp') {
      snippetCode.textContent = `// Call through Antigravity / Claude MCP:\n{\n  "tool": "landfall_x402_check_payee",\n  "arguments": ${raw}\n}`;
    }
  }

  qsa('.snippet-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      qsa('.snippet-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      updateSnippets();
    });
  });

  x402Input.addEventListener('input', updateSnippets);

  async function inspectPayees() {
    let payload;
    try {
      const parsed = JSON.parse(x402Input.value.trim());
      payload = Array.isArray(parsed) ? { accepts: parsed } : (parsed.accepts ? parsed : { accepts: [parsed] });
    } catch (e) {
      alert('Invalid JSON in payment requirements editor: ' + e.message);
      return;
    }

    inspectBtn.disabled = true;
    inspectBtn.textContent = 'Querying Ledger...';
    verdictBadge.textContent = 'INSPECTING';
    verdictBadge.className = 'badge-verdict verdict-flagged';

    try {
      const res = await fetch('/api/v1/x402/check-payee', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error || `HTTP ${res.status}`);
      }

      renderResults(body.results || []);
    } catch (err) {
      resultsContainer.innerHTML = `<div style="color: #f87171; padding: 20px; background: rgba(239,68,68,0.1); border-radius: 8px;">
        <strong>Error checking counterparties:</strong> ${esc(err.message)}
      </div>`;
      verdictBadge.textContent = 'ERROR';
      verdictBadge.className = 'badge-verdict verdict-rejected';
    } finally {
      inspectBtn.disabled = false;
      inspectBtn.textContent = 'Inspect Counterparties →';
    }
  }

  function renderResults(results) {
    if (!results.length) {
      resultsContainer.innerHTML = '<div style="color: #94a3b8; text-align: center; padding: 40px;">No payees evaluated.</div>';
      verdictBadge.textContent = 'EMPTY';
      return;
    }

    let hasHighRisk = false;
    let hasUnsupported = false;

    const cardsHtml = results.map((r, i) => {
      const req = r.requirement;
      if (!r.supported) {
        hasUnsupported = true;
        return `
          <div class="flag-card sev-high" style="margin-bottom: 12px;">
            <div class="flag-summary">
              <span class="flag-sev-tag">UNSUPPORTED</span> Payee #${i + 1}: ${esc(req.payTo)}
              ${r.isContract ? '<span class="badge-muxed" style="color: #60a5fa; border-color: #3b82f6;">CONTRACT</span>' : ''}
            </div>
            <div class="flag-detail">${esc(r.reason)}</div>
          </div>
        `;
      }

      const tc = r.trustCheck;
      if (tc.riskLevel === 'high') hasHighRisk = true;

      const levelClass = tc.riskLevel === 'low' ? 'sev-info' : tc.riskLevel === 'medium' ? 'sev-warning' : 'sev-high';
      const levelLabel = tc.riskLevel === 'low' ? '🟢 LOW RISK' : tc.riskLevel === 'medium' ? '🟡 MEDIUM RISK' : '🔴 HIGH RISK';

      return `
        <div class="flag-card ${levelClass}" style="margin-bottom: 16px;">
          <div class="flag-summary" style="display: flex; justify-content: space-between; align-items: center;">
            <div>
              <strong>${levelLabel}</strong> · Score: ${tc.riskScore || 0}/100 · Conf: ${esc(tc.confidence || 'unknown')}
              ${r.isMuxed ? `<span class="badge-muxed">MUXED ID: ${esc(r.memoId || 'embedded')}</span>` : ''}
            </div>
            <span style="font-family: 'DM Mono', monospace; font-size: 0.8rem; color: #94a3b8;">${esc(req.amount)} micro-units</span>
          </div>
          <div style="font-family: 'DM Mono', monospace; font-size: 0.85rem; color: #cbd5e1; margin: 8px 0;">
            ${esc(req.payTo)}
            ${r.isMuxed ? `<div style="font-size: 0.75rem; color: #a78bfa;">↳ Base Ed25519 Account: ${esc(r.baseAccount)}</div>` : ''}
          </div>
          <div class="flag-detail" style="margin-bottom: 8px;">
            ${esc(tc.recommendation || 'No recommendation available.')}
          </div>
          <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; font-size: 0.75rem; color: #94a3b8; background: rgba(0,0,0,0.2); padding: 8px; border-radius: 6px;">
            <div>Observed Age: <span style="color:#fff;">${tc.age?.observedDays != null ? tc.age.observedDays + 'd' : 'None'}</span></div>
            <div>Payments: <span style="color:#fff;">${tc.paymentCount || 0}</span></div>
            <div>Fast-Forwarded: <span style="color:#fff;">${tc.forwarding?.fastForwardedCount || 0}</span></div>
          </div>
        </div>
      `;
    }).join('');

    resultsContainer.innerHTML = cardsHtml;

    if (hasHighRisk) {
      verdictBadge.textContent = 'REJECT: HIGH RISK';
      verdictBadge.className = 'badge-verdict verdict-rejected';
    } else if (hasUnsupported) {
      verdictBadge.textContent = 'REVIEW NEEDED';
      verdictBadge.className = 'badge-verdict verdict-flagged';
    } else {
      verdictBadge.textContent = 'APPROVED: SAFE TO PAY';
      verdictBadge.className = 'badge-verdict verdict-approved';
    }
  }

  inspectBtn.addEventListener('click', inspectPayees);

  // Initialize
  loadPreset('testnet_usdc');
})();
