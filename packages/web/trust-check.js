/**
 * trust-check.js — the form at trust-check.html.
 *
 * Calls GET /api/v1/trust-check?address=... and renders exactly what the
 * API returns. No client-side judgment is layered on top of the server's
 * flags or risk level — the whole point of this page is that the number
 * shown is the number the API computed, traceable back to the ledger.
 */
(function () {
  'use strict';

  function qs(sel) { return document.querySelector(sel); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var LEVEL_LABEL = { low: '🟢 Low risk', medium: '🟡 Medium risk', high: '🔴 High risk', unknown: '⚪ Unknown' };
  var SEV_LABEL = { high: 'High', warning: 'Warning', info: 'Info' };

  function fmtHours(h) {
    if (h == null) return '—';
    if (h < 24) return Math.round(h) + 'h';
    return Math.round(h / 24) + 'd';
  }

  function renderResult(r) {
    var box = qs('#checkResult');
    var levelCls = 'level-' + (r.riskLevel || 'unknown');

    var flagsHtml = r.flags.length
      ? r.flags.map(function (f) {
          return (
            '<div class="flag-card sev-' + f.severity + '">' +
              '<div class="flag-summary"><span class="flag-sev-tag">' + SEV_LABEL[f.severity] + '</span>' + esc(f.summary) + '</div>' +
              '<div class="flag-detail">' + esc(f.detail) + '</div>' +
            '</div>'
          );
        }).join('')
      : '<div class="flag-detail">No flags raised by this check.</div>';

    box.innerHTML =
      '<div class="result-card">' +
        '<div class="result-head">' +
          '<span class="result-level ' + levelCls + '">' + (LEVEL_LABEL[r.riskLevel] || r.riskLevel) + '</span>' +
          '<span class="result-score">Score ' + r.riskScore + '/100 · Confidence: ' + r.confidence + '</span>' +
        '</div>' +
        '<div class="result-address">' + esc(r.address) + '</div>' +
        '<div class="result-recommendation">' + esc(r.recommendation) + '</div>' +
        '<div class="result-signals">' +
          '<div class="signal-box"><span class="signal-lbl">Observed history</span>' +
            '<span class="signal-val">' + (r.age.observedDays != null ? r.age.observedDays + ' day(s)' : 'None') + '</span>' +
            (r.age.isLowerBoundOnly ? '<div class="signal-sub">lower bound — may be older</div>' : '') +
          '</div>' +
          '<div class="signal-box"><span class="signal-lbl">Payments observed</span>' +
            '<span class="signal-val">' + r.paymentCount + '</span>' +
            '<div class="signal-sub">' + r.inboundCount + ' in · ' + r.outboundCount + ' out</div>' +
          '</div>' +
          '<div class="signal-box"><span class="signal-lbl">Top counterparty share</span>' +
            '<span class="signal-val">' + (r.concentration.topCounterpartyShare != null ? Math.round(r.concentration.topCounterpartyShare * 100) + '%' : '—') + '</span>' +
            '<div class="signal-sub">' + r.concentration.distinctCounterparties + ' distinct counterpart(y/ies)</div>' +
          '</div>' +
          '<div class="signal-box"><span class="signal-lbl">Fast-forwarded inbound</span>' +
            '<span class="signal-val">' + r.forwarding.fastForwardedCount + ' / ' + r.forwarding.inboundCount + '</span>' +
            '<div class="signal-sub">within 10 minutes</div>' +
          '</div>' +
        '</div>' +
        '<div class="flags-head">Flags (' + r.flags.length + ')</div>' +
        flagsHtml +
        '<div class="result-limits">' + esc(r.limits) + '</div>' +
      '</div>';
  }

  function renderStatus(msg, isError) {
    qs('#checkResult').innerHTML = '<div class="check-status' + (isError ? ' is-error' : '') + '">' + esc(msg) + '</div>';
  }

  function runCheck(value) {
    var btn = qs('#checkBtn');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    renderStatus('Reading the ledger…', false);

    fetch('/api/v1/trust-check?address=' + encodeURIComponent(value))
      .then(function (res) { return res.json().then(function (body) { return { status: res.status, body: body }; }); })
      .then(function (r) {
        if (r.status === 200) {
          renderResult(r.body);
        } else {
          renderStatus((r.body && r.body.error) || 'Could not check that address.', true);
        }
      })
      .catch(function () {
        renderStatus('Could not reach the server. Check your connection and try again.', true);
      })
      .finally(function () {
        btn.disabled = false;
        btn.textContent = 'Check ⚡';
      });
  }

  document.addEventListener('DOMContentLoaded', function () {
    qs('#checkBtn').addEventListener('click', function () {
      var value = qs('#checkInput').value.trim();
      if (!value) return;
      runCheck(value);
    });

    qs('#checkInput').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') qs('#checkBtn').click();
    });

    var examples = document.querySelectorAll('.check-example');
    for (var i = 0; i < examples.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          qs('#checkInput').value = btn.dataset.addr;
          runCheck(btn.dataset.addr);
        });
      })(examples[i]);
    }
  });
})();
