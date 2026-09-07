/**
 * SEP-10 web auth.
 *
 * Weighted heavily toward the failure cases, because this is a login: a bug
 * that rejects a legitimate anchor is an annoyance, and a bug that accepts a
 * forged challenge hands someone else's account to an attacker. Every way a
 * challenge can be wrong gets its own test.
 *
 *   node --test api/_lib/sep10.test.mjs
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Keypair, Networks, Operation, TransactionBuilder, Account, Transaction } from '@stellar/stellar-base';

import {
  buildChallenge,
  verifyChallenge,
  issueJwt,
  verifyJwt,
  sep10Config,
  accountIdentityHash,
  CHALLENGE_TIMEOUT_SECONDS,
  Sep10Error,
} from './sep10.js';

const SERVER = Keypair.random();
const CLIENT = Keypair.random();

const CONFIG = {
  serverKeypair: SERVER,
  homeDomain: 'landfall.test',
  webAuthDomain: 'landfall.test',
  networkPassphrase: Networks.TESTNET,
  jwtIssuer: 'https://landfall.test',
  jwtLifetimeSeconds: 3600,
};

/** Signers shaped the way Horizon reports them. */
const singleSigner = (kp = CLIENT, weight = 1, threshold = 1) => ({
  signers: [{ key: kp.publicKey(), weight }],
  threshold,
});

function signed(challengeXdr, ...keypairs) {
  const tx = new Transaction(challengeXdr, CONFIG.networkPassphrase);
  for (const kp of keypairs) tx.sign(kp);
  return tx.toEnvelope().toXDR('base64');
}

/* ── Challenge construction ─────────────────────────────────────────────── */

test('challenge has sequence 0, so it can never be submitted to the network', () => {
  const { transaction } = buildChallenge(CLIENT.publicKey(), CONFIG);
  const tx = new Transaction(transaction, CONFIG.networkPassphrase);
  assert.equal(tx.sequence, '0');
});

test('challenge is sourced by the server, first op sourced by the client', () => {
  const { transaction, network_passphrase } = buildChallenge(CLIENT.publicKey(), CONFIG);
  const tx = new Transaction(transaction, CONFIG.networkPassphrase);
  assert.equal(network_passphrase, Networks.TESTNET);
  assert.equal(tx.source, SERVER.publicKey());
  assert.equal(tx.operations[0].type, 'manageData');
  assert.equal(tx.operations[0].source, CLIENT.publicKey());
  assert.equal(tx.operations[0].name, 'landfall.test auth');
});

test('nonce is 48 random bytes, per the spec, and differs every call', () => {
  const a = new Transaction(buildChallenge(CLIENT.publicKey(), CONFIG).transaction, CONFIG.networkPassphrase);
  const b = new Transaction(buildChallenge(CLIENT.publicKey(), CONFIG).transaction, CONFIG.networkPassphrase);
  const nonceA = a.operations[0].value.toString('utf8');
  assert.equal(nonceA.length, 64, 'base64 text of a 48-byte nonce is 64 chars');
  assert.equal(Buffer.from(nonceA, 'base64').length, 48);
  assert.notEqual(nonceA, b.operations[0].value.toString('utf8'));
});

test('challenge carries web_auth_domain sourced by the server', () => {
  const tx = new Transaction(buildChallenge(CLIENT.publicKey(), CONFIG).transaction, CONFIG.networkPassphrase);
  const op = tx.operations.find((o) => o.name === 'web_auth_domain');
  assert.ok(op);
  assert.equal(op.source, SERVER.publicKey());
  assert.equal(op.value.toString(), 'landfall.test');
});

test('a malformed account is rejected before any transaction is built', () => {
  assert.throws(() => buildChallenge('not-an-account', CONFIG), Sep10Error);
  assert.throws(() => buildChallenge(SERVER.secret(), CONFIG), Sep10Error);
});

/* ── The happy path ─────────────────────────────────────────────────────── */

test('a challenge signed by the account verifies', () => {
  const { transaction } = buildChallenge(CLIENT.publicKey(), CONFIG);
  const result = verifyChallenge(signed(transaction, CLIENT), CONFIG, singleSigner());
  assert.equal(result.account, CLIENT.publicKey());
  assert.equal(result.existsOnNetwork, true);
  assert.equal(result.weight, 1);
});

test('an account not yet on the network verifies with its master key alone', () => {
  const { transaction } = buildChallenge(CLIENT.publicKey(), CONFIG);
  const result = verifyChallenge(signed(transaction, CLIENT), CONFIG, null);
  assert.equal(result.account, CLIENT.publicKey());
  assert.equal(result.existsOnNetwork, false);
});

/* ── Forgery and misuse — the tests that matter ─────────────────────────── */

test('an UNSIGNED challenge is rejected', () => {
  const { transaction } = buildChallenge(CLIENT.publicKey(), CONFIG);
  assert.throws(() => verifyChallenge(transaction, CONFIG, singleSigner()), /not signed by the client/);
});

test('a challenge signed by the WRONG key is rejected', () => {
  const attacker = Keypair.random();
  const { transaction } = buildChallenge(CLIENT.publicKey(), CONFIG);
  assert.throws(
    () => verifyChallenge(signed(transaction, attacker), CONFIG, singleSigner()),
    /no signature matches a signer/,
  );
});

test('a challenge this server never issued is rejected, however well-formed', () => {
  // An attacker builds their own valid-looking challenge with their own
  // "server" key. Without the real server's signature it must not pass.
  const fakeServer = Keypair.random();
  const forged = buildChallenge(CLIENT.publicKey(), { ...CONFIG, serverKeypair: fakeServer });
  const tx = new Transaction(forged.transaction, CONFIG.networkPassphrase);
  tx.sign(CLIENT);
  assert.throws(
    () => verifyChallenge(tx.toEnvelope().toXDR('base64'), CONFIG, singleSigner()),
    /source account is not this server/,
  );
});

test('an expired challenge is rejected', () => {
  const past = new Date(Date.now() - (CHALLENGE_TIMEOUT_SECONDS + 60) * 1000);
  const { transaction } = buildChallenge(CLIENT.publicKey(), CONFIG, past);
  assert.throws(() => verifyChallenge(signed(transaction, CLIENT), CONFIG, singleSigner()), /expired/);
});

test('a challenge for a different home domain is rejected', () => {
  const { transaction } = buildChallenge(CLIENT.publicKey(), { ...CONFIG, homeDomain: 'evil.test' });
  // Re-sign with the real server so only the domain differs.
  const tx = new Transaction(transaction, CONFIG.networkPassphrase);
  tx.sign(CLIENT);
  assert.throws(
    () => verifyChallenge(tx.toEnvelope().toXDR('base64'), CONFIG, singleSigner()),
    /different home domain/,
  );
});

test('a challenge whose extra operation is not server-sourced is rejected', () => {
  const attacker = Keypair.random();
  const serverAccount = new Account(SERVER.publicKey(), '-1');
  const start = Math.floor(Date.now() / 1000);
  const tx = new TransactionBuilder(serverAccount, { fee: '100', networkPassphrase: CONFIG.networkPassphrase })
    .addOperation(Operation.manageData({
      name: 'landfall.test auth',
      value: Buffer.alloc(48, 7).toString('base64'), // 64 chars, spec-shaped
      source: CLIENT.publicKey(),
    }))
    .addOperation(Operation.manageData({ name: 'sneaky', value: 'x', source: attacker.publicKey() }))
    .setTimebounds(start, start + 900)
    .build();
  tx.sign(SERVER, CLIENT);
  assert.throws(
    () => verifyChallenge(tx.toEnvelope().toXDR('base64'), CONFIG, singleSigner()),
    /must have the server as their source/,
  );
});

test('garbage XDR is rejected without throwing something unhelpful', () => {
  assert.throws(() => verifyChallenge('not-xdr', CONFIG, singleSigner()), Sep10Error);
  assert.throws(() => verifyChallenge('', CONFIG, singleSigner()), Sep10Error);
});

/* ── Multisig: the reason SEP-10 beats a password here ──────────────────── */

test('a 2-of-2 account is NOT authenticated by one of its keys', () => {
  const second = Keypair.random();
  const signers = {
    signers: [{ key: CLIENT.publicKey(), weight: 1 }, { key: second.publicKey(), weight: 1 }],
    threshold: 2,
  };
  const { transaction } = buildChallenge(CLIENT.publicKey(), CONFIG);
  assert.throws(
    () => verifyChallenge(signed(transaction, CLIENT), CONFIG, signers),
    /below the account's medium threshold/,
  );
});

test('a 2-of-2 account IS authenticated when both keys sign', () => {
  const second = Keypair.random();
  const signers = {
    signers: [{ key: CLIENT.publicKey(), weight: 1 }, { key: second.publicKey(), weight: 1 }],
    threshold: 2,
  };
  const { transaction } = buildChallenge(CLIENT.publicKey(), CONFIG);
  const result = verifyChallenge(signed(transaction, CLIENT, second), CONFIG, signers);
  assert.equal(result.weight, 2);
});

test('the same key signing twice cannot reach the threshold on its own', () => {
  const signers = {
    signers: [{ key: CLIENT.publicKey(), weight: 1 }, { key: Keypair.random().publicKey(), weight: 1 }],
    threshold: 2,
  };
  const { transaction } = buildChallenge(CLIENT.publicKey(), CONFIG);
  // Sign twice with the same key — weight must be counted once.
  assert.throws(
    () => verifyChallenge(signed(transaction, CLIENT, CLIENT), CONFIG, signers),
    /below the account's medium threshold/,
  );
});

/* ── JWT ────────────────────────────────────────────────────────────────── */

test('an issued token verifies, and carries the spec-required claims', () => {
  const token = issueJwt(CLIENT.publicKey(), CONFIG);
  const payload = verifyJwt(token, CONFIG);
  assert.ok(payload);
  assert.equal(payload.sub, CLIENT.publicKey());
  assert.equal(payload.iss, CONFIG.jwtIssuer);
  assert.equal(typeof payload.iat, 'number');
  assert.equal(typeof payload.exp, 'number');
});

test('a tampered payload fails verification', () => {
  const token = issueJwt(CLIENT.publicKey(), CONFIG);
  const [h, , s] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ iss: CONFIG.jwtIssuer, sub: 'GATTACKER', exp: 9e9 }))
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(verifyJwt(`${h}.${forged}.${s}`, CONFIG), null);
});

test('a token from a different server key fails verification', () => {
  const other = { ...CONFIG, serverKeypair: Keypair.random() };
  assert.equal(verifyJwt(issueJwt(CLIENT.publicKey(), other), CONFIG), null);
});

test('an expired token fails verification', () => {
  const token = issueJwt(CLIENT.publicKey(), CONFIG, new Date(Date.now() - 7200 * 1000));
  assert.equal(verifyJwt(token, CONFIG), null);
});

test('malformed tokens fail closed rather than throwing', () => {
  for (const bad of ['', 'a.b', 'a.b.c', null, undefined, 'x'.repeat(500)]) {
    assert.equal(verifyJwt(bad, CONFIG), null);
  }
});

/* ── Config ─────────────────────────────────────────────────────────────── */

test('config is null when no server secret is set, so routes can degrade cleanly', () => {
  assert.equal(sep10Config({}), null);
});

test('config reads the server secret and defaults the rest', () => {
  const cfg = sep10Config({ SEP10_SERVER_SECRET: SERVER.secret() });
  assert.equal(cfg.serverKeypair.publicKey(), SERVER.publicKey());
  assert.equal(cfg.networkPassphrase, Networks.PUBLIC);
});

test('the identity hash is stable and does not leak the address', () => {
  const h = accountIdentityHash(CLIENT.publicKey());
  assert.equal(h, accountIdentityHash(CLIENT.publicKey()));
  assert.equal(h.length, 64);
  assert.ok(!h.includes(CLIENT.publicKey()));
});
