/**
 * confirm.js — the form at confirm.html?chain=...&reference=...
 *
 * Submits to POST /api/v1/fiat-confirmations. See
 * packages/adapters/src/fiatConfirmation.ts and
 * docs/architecture/FIAT_CONFIRMATION.md for what this proof kind can and
 * cannot establish — this file only handles getting one honest submission
 * from the page to the API and showing the honest answer back.
 */
(function () {
  'use strict';

  var API = (document.querySelector('meta[name="landfall-api"]')?.content || '').replace(/\/$/, '');

  var params = new URLSearchParams(window.location.search);
  var chain = (params.get('chain') || '').trim().toLowerCase();
  var reference = (params.get('reference') || '').trim();
  var displayAmount = params.get('amount');
  var displayAsset = params.get('asset');

  var state = { respondent: 'recipient', outcome: 'received' };

  function $(sel) { return document.querySelector(sel); }

  function renderRefLine() {
    var el = $('#refLine');
    if (!chain || !reference) {
      el.textContent = 'This link is missing a chain or reference — nothing to confirm.';
      $('#confirmForm').hidden = true;
      return;
    }
    var amountTxt = displayAmount ? (' · ' + displayAmount + (displayAsset ? ' ' + displayAsset : '')) : '';
    el.textContent = chain + ' · ' + reference + amountTxt;
  }

  function wireChoiceGroup(field) {
    var buttons = document.querySelectorAll('.choice-btn[data-field="' + field + '"]');
    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        buttons.forEach(function (b) { b.classList.remove('is-on'); });
        btn.classList.add('is-on');
        state[field] = btn.dataset.value;
      });
    });
  }

  function showResult(cls, html) {
    var box = $('#resultBox');
    box.className = 'result-box ' + cls;
    box.innerHTML = html;
    box.hidden = false;
  }

  var REASON_TEXT = {
    'sender-not-binding': 'Recorded — but a sender’s own report that they paid is not evidence the money arrived, so this cannot become proof on its own.',
    'not-received': 'Recorded as a negative report. This scheme only ever produces positive evidence that a payment landed, so a "no" or "partial" here is kept as a record but does not upgrade anything.',
    'too-early': 'This claim could not be timed correctly.',
    'too-late': 'This claim is outside the window this proof kind accepts.',
    'reference-mismatch': 'Something about this link doesn’t match — try the original link again.'
  };

  document.addEventListener('DOMContentLoaded', function () {
    renderRefLine();
    wireChoiceGroup('respondent');
    wireChoiceGroup('outcome');

    var form = $('#confirmForm');
    if (!form) return;

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var btn = $('#submitBtn');
      btn.disabled = true;
      btn.textContent = 'Submitting…';

      var payload = {
        chain: chain,
        reference: reference,
        respondent: state.respondent,
        outcome: state.outcome,
        reportedAmount: $('#amountInput').value.trim() || undefined,
        note: $('#noteInput').value.trim() || undefined
      };

      fetch(API + '/api/v1/fiat-confirmations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
        .then(function (res) { return res.json().then(function (body) { return { status: res.status, body: body }; }); })
        .then(function (r) {
          form.hidden = true;
          if (r.status === 201) {
            if (r.body.eligible) {
              showResult('is-ok', '<strong>Thank you.</strong> This has been recorded and can count as settlement evidence once the next scan processes this transfer.');
            } else {
              showResult('is-warn', '<strong>Recorded.</strong> ' + (REASON_TEXT[r.body.ineligibleReason] || 'This will not become binding evidence, but the report is kept.'));
            }
          } else if (r.status === 409) {
            showResult('is-warn', 'A confirmation has already been submitted for this transfer. Each transfer can only be confirmed once, to stop an earlier report being overwritten.');
          } else {
            showResult('is-err', (r.body && r.body.error) || 'Something went wrong submitting this.');
            form.hidden = false;
            btn.disabled = false;
            btn.textContent = 'Submit confirmation';
          }
        })
        .catch(function () {
          showResult('is-err', 'Could not reach the server. Check your connection and try again.');
          form.hidden = false;
          btn.disabled = false;
          btn.textContent = 'Submit confirmation';
        });
    });
  });
})();
