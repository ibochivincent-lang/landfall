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

  root.LandfallIntent = {
    solveIntent: solveIntent,
    gradeAtLeast: gradeAtLeast,
    GRADE_ORDER: GRADE_ORDER,
    LIQUIDITY_ORDER: LIQUIDITY_ORDER
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
