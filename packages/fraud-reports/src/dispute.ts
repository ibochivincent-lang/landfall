/**
 * The dispute response path — how a reported party answers back.
 *
 * The whole problem here is authorisation. A report is an allegation about
 * a named party, and a response carries real weight: it is the reported
 * party's own words attached to the accusation. If anyone could post one,
 * an accuser could post a fake confession, or a third party could post a
 * denial that discredits a real victim. So a response has to prove it came
 * from whoever controls the reported address.
 *
 * There is exactly one thing on Stellar that proves that, and it needs no
 * accounts, passwords, email or identity documents: a signature from the
 * account's own key. Sign a message naming the report, and the ledger's own
 * public key verifies it. This is the same principle as SEP-10, reduced to
 * the single thing needed here.
 *
 * Stateless on purpose. The message the party signs carries its own
 * timestamp and report id, so there is no challenge table to store, expire
 * and clean up, and no server secret to hold. Replay is bounded twice over:
 * the timestamp must be recent, and a report accepts exactly one response,
 * so a captured signature cannot be used to overwrite a response already
 * posted.
 *
 * What this deliberately does NOT solve: an anchor whose reported account
 * is a cold issuer key it will not bring online to sign a web form. That is
 * a real and common case, and it is why DISPUTES.md's human process stays —
 * this is the self-serve path, not the only path. Building only this one
 * would mean a company with the strongest key hygiene has the least ability
 * to answer an accusation, which is precisely backwards.
 */

import { createPublicKey, verify as ed25519Verify } from "node:crypto";

/** Stellar's version byte for an ed25519 public key (G...): 6 << 3. */
const VERSION_BYTE_ED25519_PUBLIC_KEY = 0x30;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** How far from the server's clock a signed response may be dated. */
export const DISPUTE_WINDOW_MS = 10 * 60 * 1000;

/** RFC 4648 base32 decode, no padding — Stellar's StrKey encoding. */
function base32Decode(input: string): Uint8Array | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of input) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** CRC16-XModem, the checksum StrKey appends (little-endian). */
function crc16(bytes: Uint8Array): number {
  let crc = 0x0000;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

/**
 * Decodes a Stellar G... address to its raw 32-byte Ed25519 public key.
 *
 * Returns null rather than throwing for anything malformed — a bad address
 * in a dispute submission is an input error, not an exception, and every
 * caller here treats "cannot decode" the same as "signature does not
 * verify": the response is refused.
 */
export function decodeStellarPublicKey(address: string): Uint8Array | null {
  if (typeof address !== "string" || address.length !== 56 || !address.startsWith("G")) return null;

  const decoded = base32Decode(address);
  // 1 version byte + 32 key bytes + 2 checksum bytes
  if (!decoded || decoded.length !== 35) return null;
  if (decoded[0] !== VERSION_BYTE_ED25519_PUBLIC_KEY) return null;

  const payload = decoded.subarray(0, 33);
  const expected = decoded[33]! | (decoded[34]! << 8); // little-endian
  if (crc16(payload) !== expected) return null;

  return decoded.subarray(1, 33);
}

/**
 * The exact text a reported party signs. Built here rather than accepted
 * from the client so both sides derive it identically — a client that could
 * choose the signed bytes could get a signature over something else
 * entirely and present it here.
 */
export function disputeMessage(reportId: string, subject: string, issuedAt: string): string {
  return [
    "Landfall dispute response",
    `report: ${reportId}`,
    `subject: ${subject}`,
    `issued: ${issuedAt}`,
  ].join("\n");
}

export type DisputeRejection =
  | "invalid-subject"
  | "invalid-signature-encoding"
  | "signature-mismatch"
  | "stale-timestamp"
  | "future-timestamp"
  | "note-empty"
  | "note-too-long";

export interface DisputeVerification {
  ok: boolean;
  reason?: DisputeRejection;
  message?: string;
}

export interface DisputeSubmission {
  reportId: string;
  subject: string;
  issuedAt: string;
  /** base64 Ed25519 signature over disputeMessage(...). */
  signature: string;
  note: string;
}

export const DISPUTE_NOTE_MAX_LENGTH = 1000;

/**
 * Verifies that a dispute response really came from the reported address.
 *
 * Pure apart from the caller-supplied `now` — no clock read inside, so a
 * result is reproducible from its inputs, and tests can pin the window
 * boundaries exactly rather than sleeping.
 */
export function verifyDispute(submission: DisputeSubmission, now: Date): DisputeVerification {
  const note = String(submission.note ?? "").trim();
  if (note.length === 0) {
    return { ok: false, reason: "note-empty", message: "A response needs to say something." };
  }
  if (note.length > DISPUTE_NOTE_MAX_LENGTH) {
    return { ok: false, reason: "note-too-long", message: `Keep the response under ${DISPUTE_NOTE_MAX_LENGTH} characters.` };
  }

  const rawKey = decodeStellarPublicKey(String(submission.subject ?? ""));
  if (!rawKey) {
    return { ok: false, reason: "invalid-subject", message: "The subject is not a valid Stellar public key." };
  }

  const issued = Date.parse(submission.issuedAt);
  if (!Number.isFinite(issued)) {
    return { ok: false, reason: "stale-timestamp", message: "The signed message carries no readable timestamp." };
  }
  const drift = now.getTime() - issued;
  if (drift > DISPUTE_WINDOW_MS) {
    return {
      ok: false,
      reason: "stale-timestamp",
      message: "That signed response is too old. Sign a fresh one — the window is 10 minutes.",
    };
  }
  if (drift < -DISPUTE_WINDOW_MS) {
    return {
      ok: false,
      reason: "future-timestamp",
      message: "That signed response is dated in the future. Check your system clock.",
    };
  }

  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(String(submission.signature ?? ""), "base64");
    if (signatureBytes.length !== 64) {
      return { ok: false, reason: "invalid-signature-encoding", message: "An Ed25519 signature must be 64 bytes, base64-encoded." };
    }
  } catch {
    return { ok: false, reason: "invalid-signature-encoding", message: "The signature is not valid base64." };
  }

  const message = Buffer.from(
    disputeMessage(String(submission.reportId), String(submission.subject), String(submission.issuedAt)),
    "utf8",
  );

  let verified = false;
  try {
    // Raw 32-byte Ed25519 keys are not a format createPublicKey takes
    // directly; JWK is the one shape that accepts them without hand-rolling
    // a DER SPKI wrapper.
    const key = createPublicKey({
      key: {
        kty: "OKP",
        crv: "Ed25519",
        x: Buffer.from(rawKey).toString("base64url"),
      },
      format: "jwk",
    });
    verified = ed25519Verify(null, message, key, signatureBytes);
  } catch {
    verified = false;
  }

  if (!verified) {
    return {
      ok: false,
      reason: "signature-mismatch",
      message:
        "That signature does not verify against the reported address. A response has to be signed by the key " +
        "that controls the account, which is the only thing that makes it more than an anonymous claim.",
    };
  }

  return { ok: true };
}
