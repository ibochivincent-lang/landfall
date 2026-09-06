/**
 * intent.js — browser mirror of packages/intents/src/solve.ts
 *
 * The site is static and has no bundler, so the TypeScript solver cannot be
 * imported here directly. This is a hand-written mirror of it, deliberately
 * kept small and free of any dependency.
 *
 * Two implementations of the same arithmetic is a real hazard, so it is not
 * left to discipline: packages/intents/test/parity.test.ts loads THIS FILE,
 * runs a shared fixture set through both, and fails if any figure disagrees.
 * If you change the maths here, change it there, and the test will tell you
 * if you only did one.
 *
 * Exposed as window.LandfallIntent so compare.js (a classic script) can use
 * it without a module graph.
 */
(function (root) {
  'use strict';

  var GRADE_ORDER = ['U', 'F', 'D', 'C', 'B', 'A'];
  var LIQUIDITY_ORDER = ['unknown', 'low', 'medium', 'high'];

  function gradeAtLeast(actual, floor) {
    return GRADE_ORDER.indexOf(actual) >= GRADE_ORDER.indexOf(floor);
  }

  function round(n, places) {
    var f = Math.pow(10, places);
    return Math.round(n * f) / f;
  }

  function unpriced(c) {
    return {
      domain: c.domain, name: c.name, grade: c.grade, score: c.score,
      liquidityTier: c.liquidityTier || 'unknown',
      recentPayments: (c.recentPayments === undefined || c.recentPayments === null) ? null : c.recentPayments,
      priced: false, feeSource: null,
      send: null, receive: null, rate: null, fee: null
    };
  }

  /**
   * See packages/intents/src/solve.ts for the derivation. In short:
   *   send basis:     receive = (send - fee) * rate
   *   receive basis:  send    = (receive / rate + feeFixed) / (1 - feePercent/100)
   * and a percentage fee of 100% or more makes the reverse unsolvable rather
   * than merely expensive.
   */
  function solveIntent(intent, candidates, midRate) {
    var solutions = [];
    var rejected = [];

    candidates.forEach(function (c) {
      if (intent.minGrade && !gradeAtLeast(c.grade, intent.minGrade)) {
        var r1 = unpriced(c); r1.rejected = 'below-grade-floor'; rejected.push(r1);
        return;
      }

      if (c.feeSource === null || c.feeSource === undefined) {
        if (intent.requirePricedTerms) {
          var r2 = unpriced(c); r2.rejected = 'unpriced'; rejected.push(r2);
        } else {
          solutions.push(unpriced(c));
        }
        return;
      }

      var rate = round(midRate * c.rateSpread, 4);
      var p = c.feePercent / 100;

      if (intent.basis === 'send') {
        var send = intent.amount;
        var fee = round(send * p + c.feeFixed, 2);
        if (fee >= send) {
          var r3 = unpriced(c); r3.feeSource = c.feeSource; r3.rejected = 'fee-exceeds-principal';
          rejected.push(r3);
          return;
        }
        solutions.push({
          domain: c.domain, name: c.name, grade: c.grade, score: c.score,
          liquidityTier: c.liquidityTier || 'unknown',
          recentPayments: (c.recentPayments === undefined || c.recentPayments === null) ? null : c.recentPayments,
          priced: true, feeSource: c.feeSource,
          send: send, receive: round((send - fee) * rate, 2), rate: rate, fee: fee
        });
      } else {
        if (p >= 1) {
          var r4 = unpriced(c); r4.feeSource = c.feeSource; r4.rejected = 'fee-exceeds-principal';
          rejected.push(r4);
          return;
        }
        var receive = intent.amount;
        var principal = receive / rate;
        // Rounded UP to the cent — see packages/intents/src/solve.ts. Rounding
        // to nearest under-delivers the target about half the time, and a
        // receive-first intent that pays less than it promised has failed.
        var sendAmt = Math.ceil(((principal + c.feeFixed) / (1 - p)) * 100) / 100;
        solutions.push({
          domain: c.domain, name: c.name, grade: c.grade, score: c.score,
          liquidityTier: c.liquidityTier || 'unknown',
          recentPayments: (c.recentPayments === undefined || c.recentPayments === null) ? null : c.recentPayments,
          priced: true, feeSource: c.feeSource,
          send: sendAmt, receive: receive, rate: rate, fee: round(sendAmt - principal, 2)
        });
      }
    });

    // Best means most delivered when sending a fixed amount, least spent when
    // delivering a fixed amount. Ranking a receive-first result by payout
    // would tie every anchor, since they all deliver exactly the target.
    function byAmount(a, b) {
      return intent.basis === 'send' ? (b.receive || 0) - (a.receive || 0) : (a.send || 0) - (b.send || 0);
    }

    solutions.sort(function (a, b) {
      var d;
      if (a.priced !== b.priced) return a.priced ? -1 : 1;
      if (!a.priced) return (b.score || 0) - (a.score || 0);

      if (intent.sortBy === 'verified') {
        // Evidence before price — see packages/intents/src/solve.ts for the
        // full reasoning. Grade decides first, liquidity breaks a grade tie,
        // amount only breaks a tie in both. Never blended into one number.
        d = GRADE_ORDER.indexOf(b.grade) - GRADE_ORDER.indexOf(a.grade);
        if (d !== 0) return d;
        d = LIQUIDITY_ORDER.indexOf(b.liquidityTier) - LIQUIDITY_ORDER.indexOf(a.liquidityTier);
        if (d !== 0) return d;
        return byAmount(a, b) || a.domain.localeCompare(b.domain);
      }

      return byAmount(a, b) || a.domain.localeCompare(b.domain);
    });
    rejected.sort(function (a, b) { return a.domain.localeCompare(b.domain); });

    var pricedCount = solutions.filter(function (s) { return s.priced; }).length;

    return {
      intent: intent,
      midRate: midRate,
      solutions: solutions,
      rejected: rejected,
      unsatisfiable: pricedCount === 0
    };
  }

  /**
   * Mirror of packages/intents/src/plan.ts — see that file for why every
   * step carries an actor and why "landfall" never appears on one that
   * moves value.
   *
   * Lives here rather than in a third hand-written copy inside
   * api/[...path].js: that file imports THIS one for side effects and reads
   * globalThis.LandfallIntent, so the browser and the API run the same
   * plain-JS implementation and packages/intents/test/parity.test.ts holds
   * both of them to the TypeScript package.
   */
  var CAUTION_AT_OR_BELOW = ['D', 'F', 'U'];

  function buildPlan(input) {
    var solution = input.solution;
    var from = input.from;
    var to = input.to;
    var steps = [];
    var order = 1;

    function push(step) {
      step.order = order++;
      steps.push(step);
    }

    push({
      id: 'verify-counterparty',
      actor: 'landfall',
      title: 'Check ' + solution.domain + ' before committing',
      detail:
        "Read what the ledger shows about the anchor's own declared accounts — observed history, " +
        'counterparty concentration, and any pass-through pattern — before sending anything to them.',
      endpoint: '/api/v1/trust-check?address=' + solution.domain
    });

    push({
      id: 'open-anchor-flow',
      actor: 'user',
      title: 'Start a withdrawal with ' + solution.name,
      detail: input.anchorUrl
        ? 'Open ' + input.anchorUrl + ' and begin a SEP-24 withdrawal. The anchor runs its own KYC and quoting; ' +
          'Landfall is not in this exchange and never sees those details.'
        : "Open the anchor's own withdrawal flow. The anchor runs its own KYC and quoting; Landfall is not in " +
          'this exchange and never sees those details.'
    });

    push({
      id: 'establish-trustline',
      actor: 'wallet',
      conditional: true,
      title: 'Establish a trustline for ' + from + ' if you do not already hold one',
      detail:
        'Sending ' + from + " requires a trustline to that asset's issuer. Most wallets do this automatically " +
        'when needed; it is listed because it is a real on-chain operation with its own fee and reserve.'
    });

    push({
      id: 'send-payment',
      actor: 'wallet',
      title: solution.send !== null && solution.send !== undefined
        ? 'Send ' + solution.send + ' ' + from + ' to the address and memo the anchor gives you'
        : 'Send ' + from + ' to the address and memo the anchor gives you',
      detail:
        "The destination address and memo come from the anchor's own SEP-24 response, never from Landfall — " +
        'a memo taken from the wrong place is how deposits get lost. Sign and submit from your own wallet; ' +
        'Landfall holds no keys and cannot submit this for you.'
    });

    push({
      id: 'await-settlement',
      actor: 'anchor',
      title: input.speed ? 'Wait for payout (' + input.speed + ')' : 'Wait for the anchor to pay out',
      detail: solution.receive !== null && solution.receive !== undefined
        ? 'The anchor converts and pays out roughly ' + solution.receive + ' ' + to + '. The exact figure is the ' +
          "anchor's to quote at execution — the number here is computed from its published terms, not a guarantee."
        : 'The anchor converts and pays out in local currency, at a rate it quotes at execution.'
    });

    push({
      id: 'confirm-receipt',
      actor: 'user',
      title: 'Confirm whether the money actually arrived',
      detail:
        'This is the only step that produces evidence the fiat leg completed. Nothing on-chain shows a bank ' +
        'deposit, so without a recipient saying so, the payout is invisible to Landfall and to everyone else ' +
        'reading the ledger.',
      endpoint: '/api/v1/fiat-confirmations'
    });

    var weakEvidence = CAUTION_AT_OR_BELOW.indexOf(solution.grade) !== -1;

    return {
      anchor: solution.name,
      anchorDomain: solution.domain,
      from: from,
      to: to,
      send: solution.send,
      receive: solution.receive,
      steps: steps,
      executionNote:
        'This is a plan, not an execution. Landfall holds no keys, no funds and no custody, and every step ' +
        'that moves value is performed by your own wallet or by the anchor. No step here can be triggered by ' +
        'calling a Landfall endpoint.',
      caution: weakEvidence
        ? "This route's settlement evidence is graded " + solution.grade +
          (solution.score !== null && solution.score !== undefined ? ' (' + solution.score + '/100)' : ' (untracked)') +
          '. That is a statement about how much settlement history the ledger shows for this anchor, not an ' +
          'allegation about the operator — but it is thin evidence on which to send a large amount.'
        : null
    };
  }

  root.LandfallIntent = {
    solveIntent: solveIntent,
    buildPlan: buildPlan,
    gradeAtLeast: gradeAtLeast,
    GRADE_ORDER: GRADE_ORDER,
    LIQUIDITY_ORDER: LIQUIDITY_ORDER
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
