import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createRecipientConfirmationBinder,
  evaluateConfirmation,
  RECIPIENT_CONFIRMATION_KIND,
  type ConfirmationClaim,
  type ConfirmationLookup,
  type NormalizedTransfer,
} from "../src/fiatConfirmation.js";

const TRANSFER: NormalizedTransfer = { reference: "tx-abc123", observedAt: "2026-09-01T12:00:00.000Z" };

function claim(overrides: Partial<ConfirmationClaim> = {}): ConfirmationClaim {
  return {
    chain: "solana",
    reference: "tx-abc123",
    respondent: "recipient",
    outcome: "received",
    submittedAt: "2026-09-01T13:00:00.000Z", // one hour after the transfer
    ...overrides,
  };
}

test("a well-formed recipient confirmation binds", () => {
  const result = evaluateConfirmation(claim(), TRANSFER);
  assert.equal(result.ok, true);
  assert.deepEqual(result.proof, { kind: RECIPIENT_CONFIRMATION_KIND, ref: "solana:tx-abc123" });
});

test("a reference that does not match the transfer is rejected before anything else is checked", () => {
  const result = evaluateConfirmation(claim({ reference: "some-other-tx" }), TRANSFER);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "reference-mismatch");
});

test("a sender's own report can never bind — it is not evidence the recipient got anything", () => {
  const result = evaluateConfirmation(claim({ respondent: "sender" }), TRANSFER);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "sender-not-binding");
});

test("a truthful 'not received' must never produce a positive proof", () => {
  const result = evaluateConfirmation(claim({ outcome: "not_received" }), TRANSFER);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-received");
});

test("'partial' is also not eligible to bind — the binder only ever upgrades tier, never asserts a mixed outcome", () => {
  const result = evaluateConfirmation(claim({ outcome: "partial" }), TRANSFER);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-received");
});

test("a confirmation dated before the transfer happened cannot be about it", () => {
  const result = evaluateConfirmation(
    claim({ submittedAt: "2026-09-01T11:59:59.000Z" }),
    TRANSFER,
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "too-early");
});

test("a confirmation arriving exactly at the transfer's own timestamp is not 'too early'", () => {
  const result = evaluateConfirmation(claim({ submittedAt: TRANSFER.observedAt }), TRANSFER);
  assert.equal(result.ok, true);
});

test("a confirmation past the max age window is rejected", () => {
  const result = evaluateConfirmation(
    claim({ submittedAt: "2026-10-15T12:00:00.000Z" }), // 44 days later
    TRANSFER,
    { maxAgeDays: 30 },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "too-late");
});

test("the max age window is configurable", () => {
  const result = evaluateConfirmation(
    claim({ submittedAt: "2026-09-05T12:00:00.000Z" }), // 4 days later
    TRANSFER,
    { maxAgeDays: 3 },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "too-late");
});

test("the default window is 30 days", () => {
  const justInside = evaluateConfirmation(claim({ submittedAt: "2026-10-01T11:59:00.000Z" }), TRANSFER);
  const justOutside = evaluateConfirmation(claim({ submittedAt: "2026-10-01T12:01:00.000Z" }), TRANSFER);
  assert.equal(justInside.ok, true);
  assert.equal(justOutside.ok, false);
});

test("createRecipientConfirmationBinder returns null when no claim has been submitted for the transfer", async () => {
  const lookup: ConfirmationLookup = { async find() { return null; } };
  const binder = createRecipientConfirmationBinder(
    "solana",
    lookup,
    (t: { signature: string; observedAt: string }) => ({ reference: t.signature, observedAt: t.observedAt }),
  );
  const proof = await binder.bind({ signature: "sig-1", observedAt: TRANSFER.observedAt });
  assert.equal(proof, null);
});

test("createRecipientConfirmationBinder adapts a chain-native transfer shape via the extractor", async () => {
  const stored = claim({ chain: "solana", reference: "sig-1" });
  const lookup: ConfirmationLookup = {
    async find(chain, reference) {
      return chain === "solana" && reference === "sig-1" ? stored : null;
    },
  };
  const binder = createRecipientConfirmationBinder(
    "solana",
    lookup,
    (t: { signature: string; observedAt: string }) => ({ reference: t.signature, observedAt: t.observedAt }),
  );
  const proof = await binder.bind({ signature: "sig-1", observedAt: TRANSFER.observedAt });
  assert.deepEqual(proof, { kind: RECIPIENT_CONFIRMATION_KIND, ref: "solana:sig-1" });
});

test("createRecipientConfirmationBinder never leaks a rejected claim as a proof", async () => {
  const stored = claim({ chain: "tron", reference: "tx-2", outcome: "not_received" });
  const lookup: ConfirmationLookup = { async find() { return stored; } };
  const binder = createRecipientConfirmationBinder(
    "tron",
    lookup,
    (t: { transactionId: string; observedAt: string }) => ({ reference: t.transactionId, observedAt: t.observedAt }),
  );
  const proof = await binder.bind({ transactionId: "tx-2", observedAt: TRANSFER.observedAt });
  assert.equal(proof, null);
});

test("a lookup scoped to the wrong chain does not leak a same-reference claim from another chain", async () => {
  // Two chains could coincidentally produce the same reference string. The
  // binder is constructed with a fixed chain and the lookup is expected to
  // scope by (chain, reference) — this pins that the binder passes its own
  // chain through rather than a hardcoded or wrong one.
  let calledWith: [string, string] | null = null;
  const lookup: ConfirmationLookup = {
    async find(chain, reference) {
      calledWith = [chain, reference];
      return null;
    },
  };
  const binder = createRecipientConfirmationBinder(
    "tron",
    lookup,
    (t: { transactionId: string; observedAt: string }) => ({ reference: t.transactionId, observedAt: t.observedAt }),
  );
  await binder.bind({ transactionId: "shared-ref", observedAt: TRANSFER.observedAt });
  assert.deepEqual(calledWith, ["tron", "shared-ref"]);
});
