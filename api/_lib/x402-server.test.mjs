/**
 * api/_lib/x402-server.test.mjs
 *
 * Author: ibochivincent-lang
 * Tests the x402 Payment Required response generation and validation guard.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPaymentRequiredResponse, verifyX402Payment, X402_CONFIG } from './x402-server.js';

test('buildPaymentRequiredResponse generates standard x402 PaymentRequired structure', () => {
  const res = buildPaymentRequiredResponse('/api/v1/corridors/export', {
    title: 'Corridors Export',
    amount: '100000',
  });

  assert.equal(res.error, 'Payment Required');
  assert.equal(res.x402Version, '0.1.0');
  assert.equal(res.accepts.length, 1);

  const req = res.accepts[0];
  assert.equal(req.scheme, 'exact');
  assert.equal(req.network, 'stellar:testnet');
  assert.equal(req.asset, X402_CONFIG.testnetUsdc);
  assert.equal(req.amount, '100000');
  assert.equal(req.payTo, X402_CONFIG.recipientAddress);
  assert.equal(req.extra.resource, '/api/v1/corridors/export');
  assert.equal(req.extra.title, 'Corridors Export');
});

test('verifyX402Payment rejects requests without authorization or payment headers', () => {
  const req = { headers: {} };
  assert.equal(verifyX402Payment(req), false);
});

test('verifyX402Payment accepts testnet bypass token', () => {
  const req = {
    headers: {
      authorization: 'Bearer x402_test_authorized_token',
    },
  };
  assert.equal(verifyX402Payment(req), true);
});

test('verifyX402Payment accepts x-payment-signature proof', () => {
  const req = {
    headers: {
      'x-payment-signature': JSON.stringify({
        txHash: 'a'.repeat(64),
        network: 'stellar:testnet',
        amount: '100000',
      }),
    },
  };
  assert.equal(verifyX402Payment(req), true);
});
