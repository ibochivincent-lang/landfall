/**
 * SEP-10 Stellar Web Authentication.
 *
 * Why this exists: the developer portal authenticates with an email and a
 * password that has nothing to do with anything on-chain. For an anchor
 * operator, that is the wrong proof entirely. Landfall scores their Stellar
 * accounts; the question worth answering at login is "do you control the
 * account being scored", and a password cannot answer it.
 *
 * The dispute path already got this right — it proves control of a Stellar
 * address with a signed message rather than a shared secret
 * (packages/fraud-reports/src/dispute.ts). SEP-10 is the standardised,
 * interoperable version of the same idea: an anchor signs in with the wallet
 * it already uses, and Landfall never holds a credential that can be phished,
 * reused or leaked.
 *
 * Implemented here as one plain-JS module rather than a TypeScript package
 * plus a hand-written mirror in api/[...path].js. The mirror pattern used
 * elsewhere in this repo is a deliberate trade for pure, easily-restated
 * logic; SEP-10's verification rules — signer weights against account
 * thresholds, operation source rules, time bounds — are exactly the kind of
 * intricate that a second hand-maintained copy would eventually get wrong,
 * and getting it wrong means accepting a forged login.
 *
 * Spec: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md
 *
 * Degrades like everything else here: with no SEP10_SERVER_SECRET configured,
 * the routes report that web auth is not enabled rather than half-working.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  Account,
  Keypair,
  Networks,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-base';

/** Spec: 15 minutes is the recommended challenge lifetime. */
export const CHALLENGE_TIMEOUT_SECONDS = 900;

/** Spec: 48 random bytes, which base64-encode to the required 64 characters. */
const NONCE_BYTES = 48;

const BASE_FEE = '100';

export class Sep10Error extends Error {
  constructor(message, code = 'invalid_challenge') {
    super(message);
    this.name = 'Sep10Error';
    this.code = code;
  }
}

/**
 * Config comes from the environment, but is read through this so a missing
 * key is one clear error rather than a confusing failure deep inside XDR.
 */
export function sep10Config(env = process.env) {
  const secret = env.SEP10_SERVER_SECRET;
  if (!secret) return null;
  return {
    serverKeypair: Keypair.fromSecret(secret),
    homeDomain: env.SEP10_HOME_DOMAIN || 'landfall-chi.vercel.app',
    webAuthDomain: env.SEP10_WEB_AUTH_DOMAIN || env.SEP10_HOME_DOMAIN || 'landfall-chi.vercel.app',
    networkPassphrase: env.SEP10_NETWORK_PASSPHRASE || Networks.PUBLIC,
    jwtIssuer: env.SEP10_JWT_ISSUER || 'https://landfall-chi.vercel.app',
    jwtLifetimeSeconds: Number(env.SEP10_JWT_LIFETIME_SECONDS || 86_400),
  };
}

/**
 * Builds the challenge transaction the client signs.
 *
 * Sequence number 0 is the load-bearing detail: a real Stellar transaction
 * can never have one, so this is unsubmittable. A challenge that could be
 * replayed onto the network would turn a login into an authorisation to move
 * value, which is the failure mode the whole design avoids.
 */
export function buildChallenge(clientAccount, config, now = new Date()) {
  if (!StrKey.isValidEd25519PublicKey(clientAccount)) {
    throw new Sep10Error('account must be a Stellar public key (G...).', 'invalid_account');
  }

  const nonce = randomBytes(NONCE_BYTES).toString('base64');
  // Sequence "-1" so TransactionBuilder increments it to 0.
  const serverAccount = new Account(config.serverKeypair.publicKey(), '-1');
  const start = Math.floor(now.getTime() / 1000);

  const tx = new TransactionBuilder(serverAccount, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(
      Operation.manageData({
        name: `${config.homeDomain} auth`,
        value: nonce,
        source: clientAccount,
      }),
    )
    .addOperation(
      Operation.manageData({
        name: 'web_auth_domain',
        value: config.webAuthDomain,
        source: config.serverKeypair.publicKey(),
      }),
    )
    .setTimebounds(start, start + CHALLENGE_TIMEOUT_SECONDS)
    .build();

  tx.sign(config.serverKeypair);

  return {
    transaction: tx.toEnvelope().toXDR('base64'),
    network_passphrase: config.networkPassphrase,
  };
}

/**
 * Verifies a signed challenge and returns the authenticated account.
 *
 * `accountSigners` is how the caller supplies on-chain reality: the account's
 * signers and its medium threshold, fetched from Horizon. Passing null means
 * the account does not exist on the network, which the spec handles
 * separately — an unfunded account has no signers, so the master key must
 * sign and exactly one client signature is allowed.
 *
 * Every failure is a throw with a reason. There is no partial success: a
 * challenge either proves control of the account or it does not.
 */
export function verifyChallenge(xdr, config, accountSigners = null, now = new Date()) {
  let tx;
  try {
    tx = new Transaction(xdr, config.networkPassphrase);
  } catch {
    throw new Sep10Error('transaction is not valid base64-encoded XDR for this network.');
  }

  if (tx.sequence !== '0') {
    throw new Sep10Error('challenge sequence number must be 0.');
  }
  if (tx.source !== config.serverKeypair.publicKey()) {
    throw new Sep10Error('challenge source account is not this server.');
  }

  const bounds = tx.timeBounds;
  if (!bounds || !bounds.minTime || !bounds.maxTime) {
    throw new Sep10Error('challenge has no time bounds.', 'expired');
  }
  const nowSec = Math.floor(now.getTime() / 1000);
  // Allow a small clock skew on the lower bound only. A generous upper bound
  // would extend the replay window, which is the side that matters.
  if (nowSec < Number(bounds.minTime) - 5 || nowSec > Number(bounds.maxTime)) {
    throw new Sep10Error('challenge has expired. Request a new one.', 'expired');
  }

  if (tx.operations.length === 0) {
    throw new Sep10Error('challenge has no operations.');
  }

  const [first, ...rest] = tx.operations;
  if (first.type !== 'manageData') {
    throw new Sep10Error('first operation must be a manageData operation.');
  }
  if (!first.source) {
    throw new Sep10Error('first operation has no source account.');
  }
  if (first.name !== `${config.homeDomain} auth`) {
    throw new Sep10Error('challenge is for a different home domain.');
  }
  // The operation's raw value is the base64 TEXT of the nonce — 48 random
  // bytes encode to 64 characters, which is also manageData's value limit.
  // Checked rather than assumed: a short nonce is less entropy than the spec
  // requires, and this is the field that makes a challenge unguessable.
  const nonceText = first.value?.toString('utf8') ?? '';
  if (nonceText.length !== 64 || Buffer.from(nonceText, 'base64').length !== NONCE_BYTES) {
    throw new Sep10Error('challenge nonce is malformed.');
  }

  const clientAccount = first.source;

  for (const op of rest) {
    if (op.type !== 'manageData') {
      throw new Sep10Error('every challenge operation must be a manageData operation.');
    }
    // client_domain is the one op allowed a non-server source. This server
    // does not issue client_domain challenges, so any such op here did not
    // come from us.
    if (op.source !== config.serverKeypair.publicKey()) {
      throw new Sep10Error('additional operations must have the server as their source.');
    }
    if (op.name === 'web_auth_domain' && op.value?.toString() !== config.webAuthDomain) {
      throw new Sep10Error('web_auth_domain does not match this server.');
    }
  }

  const serverKey = config.serverKeypair.publicKey();
  const txHash = tx.hash();

  const serverSigned = tx.signatures.some((sig) => signedBy(txHash, sig, serverKey));
  if (!serverSigned) {
    throw new Sep10Error('challenge is not signed by this server — it was not issued here.');
  }

  // Signatures that are not the server's are candidate client signatures.
  const clientSignatures = tx.signatures.filter((sig) => !signedBy(txHash, sig, serverKey));
  if (clientSignatures.length === 0) {
    throw new Sep10Error('challenge is not signed by the client account.', 'unauthorized');
  }

  if (accountSigners === null) {
    // Unfunded account: no signers exist on-chain, so the master key is the
    // only thing that can prove control, and exactly one signature is allowed.
    if (clientSignatures.length !== 1) {
      throw new Sep10Error('an account that does not exist on the network must provide exactly one signature.', 'unauthorized');
    }
    if (!signedBy(txHash, clientSignatures[0], clientAccount)) {
      throw new Sep10Error('signature does not verify against the client account.', 'unauthorized');
    }
    return { account: clientAccount, weight: null, threshold: null, existsOnNetwork: false };
  }

  // Funded account: sum the weights of the distinct signers that actually
  // signed, and require the account's own medium threshold. Using the
  // account's real threshold is what makes multisig work here — a 2-of-3
  // anchor account cannot be authenticated by one of its three keys.
  const counted = new Set();
  let weight = 0;
  for (const sig of clientSignatures) {
    for (const signer of accountSigners.signers) {
      if (counted.has(signer.key)) continue;
      if (signedBy(txHash, sig, signer.key)) {
        counted.add(signer.key);
        weight += signer.weight;
        break;
      }
    }
  }

  if (counted.size === 0) {
    throw new Sep10Error('no signature matches a signer on that account.', 'unauthorized');
  }
  if (weight < accountSigners.threshold) {
    throw new Sep10Error(
      `signature weight ${weight} is below the account's medium threshold of ${accountSigners.threshold}.`,
      'unauthorized',
    );
  }

  return { account: clientAccount, weight, threshold: accountSigners.threshold, existsOnNetwork: true };
}

/** True when `sig` is a valid signature over `txHash` by `publicKey`. */
function signedBy(txHash, sig, publicKey) {
  let keypair;
  try {
    keypair = Keypair.fromPublicKey(publicKey);
  } catch {
    return false;
  }
  // The hint is a cheap pre-filter, not a check — verify() is what decides.
  const hint = keypair.signatureHint();
  const sigHint = sig.hint();
  if (hint.length === sigHint.length && !timingSafeEqual(hint, sigHint)) return false;
  try {
    return keypair.verify(txHash, sig.signature());
  } catch {
    return false;
  }
}

/* ── JWT ────────────────────────────────────────────────────────────────────
   Signed with the server's own Ed25519 Stellar key (JWS "EdDSA"), rather than
   an unrelated HMAC secret. That means the token is verifiable by anyone
   holding the server's published SEP-10 public key, using the same signature
   scheme the rest of this project already leans on, and there is one fewer
   secret to manage. */

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function issueJwt(account, config, now = new Date()) {
  const iat = Math.floor(now.getTime() / 1000);
  const header = { alg: 'EdDSA', typ: 'JWT', crv: 'Ed25519' };
  const payload = {
    iss: config.jwtIssuer,
    sub: account,
    iat,
    exp: iat + config.jwtLifetimeSeconds,
    // Not part of SEP-10. Included so a consumer can tell a web-auth token
    // apart from any other token this project might issue later.
    scope: 'sep10',
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = config.serverKeypair.sign(Buffer.from(signingInput, 'utf8'));
  return `${signingInput}.${b64url(sig)}`;
}

/** Verifies a token this server issued. Fails closed, never throws. */
export function verifyJwt(token, config, now = new Date()) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  try {
    const sig = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (!config.serverKeypair.verify(Buffer.from(`${h}.${p}`, 'utf8'), sig)) return null;
    const payload = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(now.getTime() / 1000)) return null;
    if (payload.iss !== config.jwtIssuer) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Reads the account a challenge was issued to, straight out of the challenge.
 *
 * The caller must take the account from here rather than from the request
 * body: a request that named its own account would let someone sign a
 * challenge with a key they do control and have it checked against that,
 * while claiming to be somebody else. The same reasoning is why the dispute
 * route reads its subject from the stored report.
 */
export function readChallengeClientAccount(xdr, config) {
  return readChallengeIdentity(xdr, config).account;
}

/**
 * The account a challenge names, and its nonce.
 *
 * The nonce is what makes single-use enforceable. Without it a signed
 * challenge is a bearer credential for its whole 15-minute window: anyone who
 * captures one — from a log, a proxy, a shared machine — can replay it for as
 * many tokens as they like. Redeeming the nonce exactly once closes that.
 */
export function readChallengeIdentity(xdr, config) {
  let tx;
  try {
    tx = new Transaction(xdr, config.networkPassphrase);
  } catch {
    throw new Sep10Error('transaction is not valid base64-encoded XDR for this network.');
  }
  const first = tx.operations[0];
  if (!first || first.type !== 'manageData' || !first.source) {
    throw new Sep10Error('challenge does not name a client account.');
  }
  const nonce = first.value?.toString('utf8') ?? '';
  if (!nonce) throw new Sep10Error('challenge has no nonce.');
  return { account: first.source, nonce, expiresAt: new Date(Number(tx.timeBounds?.maxTime ?? 0) * 1000) };
}

/** Stable, non-reversible id for a Stellar account, for use as a portal key. */
export function accountIdentityHash(account) {
  return createHash('sha256').update(`sep10:${account}`).digest('hex');
}
