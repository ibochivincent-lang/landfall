import assert from "node:assert/strict";
import { generateKeyPairSync, sign as ed25519Sign } from "node:crypto";
import { test } from "node:test";

import {
  DISPUTE_WINDOW_MS,
  decodeStellarPublicKey,
  disputeMessage,
  verifyDispute,
  type DisputeSubmission,
} from "../src/dispute.js";

/* ── StrKey encoding, so the tests can mint a real G-address for a real key ──
   This mirrors the decoder rather than importing it, so a bug in the decoder
   cannot hide by being used on both sides of the test. */

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function crc16(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc & 0xffff;
}

function base32Encode(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function encodeStellarAddress(rawKey: Uint8Array): string {
  const payload = new Uint8Array(33);
  payload[0] = 0x30;
  payload.set(rawKey, 1);
  const sum = crc16(payload);
  const full = new Uint8Array(35);
  full.set(payload, 0);
  full[33] = sum & 0xff;
  full[34] = (sum >> 8) & 0xff;
  return base32Encode(full);
}

/** A real Ed25519 keypair, with its Stellar address and a signing helper. */
function makeAccount() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPub = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  return {
    address: encodeStellarAddress(rawPub),
    sign: (msg: string) => ed25519Sign(null, Buffer.from(msg, "utf8"), privateKey).toString("base64"),
  };
}

const NOW = new Date("2026-01-01T12:00:00.000Z");

function submission(acct: ReturnType<typeof makeAccount>, over: Partial<DisputeSubmission> = {}): DisputeSubmission {
  const reportId = over.reportId ?? "42";
  const subject = over.subject ?? acct.address;
  const issuedAt = over.issuedAt ?? NOW.toISOString();
  return {
    reportId,
    subject,
    issuedAt,
    note: "We paid this out on 3 January, reference 88213.",
    signature: acct.sign(disputeMessage(reportId, subject, issuedAt)),
    ...over,
  };
}

test("a genuine signature from the reported address verifies", () => {
  const acct = makeAccount();
  const r = verifyDispute(submission(acct), NOW);
  assert.equal(r.ok, true, r.message);
});

test("the address this test mints round-trips through the real decoder", () => {
  const acct = makeAccount();
  const decoded = decodeStellarPublicKey(acct.address);
  assert.ok(decoded, "a freshly minted address must decode");
  assert.equal(decoded!.length, 32);
});

test("a signature from a DIFFERENT key is refused", () => {
  const victim = makeAccount();
  const impostor = makeAccount();
  // Impostor signs the right message, but the report is about the victim.
  const sub = submission(victim, {
    signature: impostor.sign(disputeMessage("42", victim.address, NOW.toISOString())),
  });
  const r = verifyDispute(sub, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "signature-mismatch");
});

test("a signature over a different report id does not transfer to this one", () => {
  const acct = makeAccount();
  // Genuine signature, but for report 41 — replayed against report 42.
  const sub = submission(acct, {
    reportId: "42",
    signature: acct.sign(disputeMessage("41", acct.address, NOW.toISOString())),
  });
  const r = verifyDispute(sub, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "signature-mismatch");
});

test("a signature over a different subject does not transfer either", () => {
  const acct = makeAccount();
  const other = makeAccount();
  const sub = submission(acct, {
    signature: acct.sign(disputeMessage("42", other.address, NOW.toISOString())),
  });
  assert.equal(verifyDispute(sub, NOW).reason, "signature-mismatch");
});

test("a stale signature is refused once past the window", () => {
  const acct = makeAccount();
  const old = new Date(NOW.getTime() - DISPUTE_WINDOW_MS - 1000).toISOString();
  const sub = submission(acct, { issuedAt: old });
  const r = verifyDispute(sub, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "stale-timestamp");
});

test("a signature just inside the window still verifies", () => {
  const acct = makeAccount();
  const recent = new Date(NOW.getTime() - DISPUTE_WINDOW_MS + 1000).toISOString();
  assert.equal(verifyDispute(submission(acct, { issuedAt: recent }), NOW).ok, true);
});

test("a signature dated in the future is refused rather than accepted early", () => {
  const acct = makeAccount();
  const future = new Date(NOW.getTime() + DISPUTE_WINDOW_MS + 1000).toISOString();
  assert.equal(verifyDispute(submission(acct, { issuedAt: future }), NOW).reason, "future-timestamp");
});

test("a malformed subject address is refused before any crypto runs", () => {
  const acct = makeAccount();
  assert.equal(verifyDispute(submission(acct, { subject: "not-an-address" }), NOW).reason, "invalid-subject");
});

test("a subject with a broken checksum is refused", () => {
  const acct = makeAccount();
  // Flip the last character — the CRC16 no longer matches.
  const broken = acct.address.slice(0, -1) + (acct.address.endsWith("A") ? "B" : "A");
  assert.equal(verifyDispute(submission(acct, { subject: broken }), NOW).reason, "invalid-subject");
});

test("a signature of the wrong length is refused as an encoding error", () => {
  const acct = makeAccount();
  assert.equal(verifyDispute(submission(acct, { signature: "aGVsbG8=" }), NOW).reason, "invalid-signature-encoding");
});

test("an empty response is refused — a dispute has to say something", () => {
  const acct = makeAccount();
  assert.equal(verifyDispute(submission(acct, { note: "   " }), NOW).reason, "note-empty");
});

test("an over-long response is refused", () => {
  const acct = makeAccount();
  assert.equal(verifyDispute(submission(acct, { note: "x".repeat(1001) }), NOW).reason, "note-too-long");
});

test("decodeStellarPublicKey rejects obvious junk without throwing", () => {
  for (const bad of ["", "G", "not-an-address", "M".repeat(56), "G".repeat(56), "1".repeat(56)]) {
    assert.equal(decodeStellarPublicKey(bad), null, `expected null for ${JSON.stringify(bad.slice(0, 12))}`);
  }
});

test("decodeStellarPublicKey accepts a known-good real mainnet address", () => {
  // Circle's USDC issuer — a real, widely published account.
  const decoded = decodeStellarPublicKey("GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");
  assert.ok(decoded, "a real mainnet address must decode");
  assert.equal(decoded!.length, 32);
});

test("the signed message is built identically for the same inputs", () => {
  const a = disputeMessage("42", "GABC", "2026-01-01T00:00:00.000Z");
  const b = disputeMessage("42", "GABC", "2026-01-01T00:00:00.000Z");
  assert.equal(a, b);
  assert.match(a, /^Landfall dispute response\n/);
  assert.match(a, /report: 42/);
});
