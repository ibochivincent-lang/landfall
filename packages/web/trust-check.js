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
      '</div>' +
      // Reports live in their own card, not inside the one above. The API
      // refuses to blend third-party claims into the ledger-derived score;
      // rendering them in the same box would undo that separation visually
      // even though the data kept it.
      '<div id="reportsSection"></div>';

    loadReports(r.address);
  }

  /* ─── Fraud reports — a separate card, never folded into the score ─────── */

  var CATEGORY_LABEL = {
    did_not_receive: 'Did not receive',
    wrong_amount: 'Wrong amount',
    impersonation: 'Impersonation',
    unauthorized_debit: 'Unauthorized debit',
    other: 'Other'
  };

  function loadReports(address) {
    var box = qs('#reportsSection');
    if (!box) return;
    box.innerHTML = '<div class="reports-card"><div class="reports-head">Reports from other people</div>' +
      '<div class="flag-detail">Loading…</div></div>';

    fetch('/api/v1/fraud-reports/' + encodeURIComponent(address))
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (body) {
        if (!body) { box.innerHTML = ''; return; }
        renderReports(address, body);
      })
      .catch(function () { box.innerHTML = ''; });
  }

  function renderReports(address, body) {
    var box = qs('#reportsSection');

    var list = body.reports.length
      ? body.reports.map(function (rep) {
          return (
            '<div class="report-card' + (rep.status === 'disputed' ? ' is-disputed' : '') + '">' +
              '<div class="report-top">' +
                '<span class="report-cat">' + esc(CATEGORY_LABEL[rep.category] || rep.category) + '</span>' +
                '<span class="report-date">' + esc(String(rep.submittedAt).slice(0, 10)) + '</span>' +
              '</div>' +
              '<div class="report-note">' + esc(rep.note) + '</div>' +
              '<div class="report-evidence">Evidence: ' +
                '<a href="https://stellar.expert/explorer/public/tx/' + esc(rep.evidenceTxHash) + '" target="_blank" rel="noopener">' +
                  esc(rep.evidenceTxHash.slice(0, 16)) + '…' +
                '</a>' +
                ' — verified to exist and involve this address' +
              '</div>' +
              (rep.disputeNote
                ? '<div class="report-dispute"><strong>Response from the reported party:</strong> ' + esc(rep.disputeNote) + '</div>'
                : '') +
            '</div>'
          );
        }).join('')
      : '';

    box.innerHTML =
      '<div class="reports-card">' +
        '<div class="reports-head">Reports from other people ' +
          '<span class="reports-count">' + body.total + '</span></div>' +
        '<div class="reports-summary">' + esc(body.summary) + '</div>' +
        list +
        '<div class="reports-disclaimer">' + esc(body.disclaimer) + '</div>' +
        '<button type="button" class="report-btn" id="openReportForm">Report this address</button>' +
        '<div id="reportFormBox" hidden></div>' +
      '</div>';

    qs('#openReportForm').addEventListener('click', function () {
      renderReportForm(address);
    });
  }

  function renderReportForm(address) {
    var box = qs('#reportFormBox');
    var trigger = qs('#openReportForm');
    if (!box) return;
    trigger.hidden = true;
    box.hidden = false;
    box.innerHTML =
      '<div class="report-form">' +
        '<div class="report-form-note">' +
          'A report must cite a transaction hash. Landfall checks against the ledger that the transaction ' +
          'exists and involves this address before storing anything — a report it cannot verify is rejected, ' +
          'not filed quietly. What gets verified is the transaction, not your account of what happened.' +
        '</div>' +
        '<label class="field-label" for="repTx">Transaction hash</label>' +
        '<input class="field-input" id="repTx" placeholder="64-character hash of a transaction involving this address" autocomplete="off" spellcheck="false">' +
        '<label class="field-label" for="repCat">What happened</label>' +
        '<select class="field-input" id="repCat">' +
          Object.keys(CATEGORY_LABEL).map(function (k) {
            return '<option value="' + k + '">' + esc(CATEGORY_LABEL[k]) + '</option>';
          }).join('') +
        '</select>' +
        '<label class="field-label" for="repNote">Describe it</label>' +
        '<textarea class="field-textarea" id="repNote" maxlength="1000" placeholder="What did you send, what did you expect back, and what actually happened?"></textarea>' +
        '<div class="report-actions">' +
          '<button type="button" class="report-btn" id="submitReport">Submit report</button>' +
          '<button type="button" class="report-cancel" id="cancelReport">Cancel</button>' +
        '</div>' +
        '<div id="reportResult"></div>' +
      '</div>';

    qs('#cancelReport').addEventListener('click', function () {
      box.hidden = true;
      box.innerHTML = '';
      trigger.hidden = false;
    });

    qs('#submitReport').addEventListener('click', function () {
      submitReport(address);
    });
  }

  function submitReport(address) {
    var btn = qs('#submitReport');
    var out = qs('#reportResult');
    btn.disabled = true;
    btn.textContent = 'Submitting…';
    out.innerHTML = '';

    fetch('/api/v1/fraud-reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject: address,
        evidenceTxHash: qs('#repTx').value.trim(),
        category: qs('#repCat').value,
        note: qs('#repNote').value.trim()
      })
    })
      .then(function (res) { return res.json().then(function (b) { return { status: res.status, body: b }; }); })
      .then(function (r) {
        if (r.status === 201) {
          out.innerHTML = '<div class="report-ok">' + esc(r.body.note || 'Recorded.') + '</div>';
          setTimeout(function () { loadReports(address); }, 800);
        } else {
          out.innerHTML = '<div class="report-err">' + esc((r.body && r.body.error) || 'Could not file that report.') + '</div>';
        }
      })
      .catch(function () {
        out.innerHTML = '<div class="report-err">Could not reach the server. Try again shortly.</div>';
      })
      .finally(function () {
        btn.disabled = false;
        btn.textContent = 'Submit report';
      });
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
