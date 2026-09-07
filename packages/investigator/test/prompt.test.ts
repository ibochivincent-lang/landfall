import assert from "node:assert/strict";
import { test } from "node:test";

import { buildPrompt } from "../src/prompt.js";
import type { RelevantSignal } from "../src/types.js";

test("system prompt forbids fabrication, guilt claims, and using report counts", () => {
  const { system } = buildPrompt([], []);
  assert.match(system, /Never state a fact/);
  assert.match(system, /guilty/);
  assert.match(system, /how many other reports/);
});

test("user prompt includes every cited fact", () => {
  const facts = ["fact one", "fact two"];
  const { user } = buildPrompt(facts, []);
  assert.match(user, /fact one/);
  assert.match(user, /fact two/);
});

test("user prompt says explicitly when there are no relevant signals", () => {
  const { user } = buildPrompt(["fact"], []);
  assert.match(user, /None\. Trust Check found no warning- or high-severity signals/);
});

test("user prompt renders given signals with severity and evidence context", () => {
  const signal: RelevantSignal = {
    id: "concentration",
    severity: "high",
    summary: "Highly concentrated counterparty",
    detail: "82% of volume to one address",
    evidenceTxHashes: ["b".repeat(64)],
  };
  const { user } = buildPrompt(["fact"], [signal]);
  assert.match(user, /\[high\] Highly concentrated counterparty — 82% of volume to one address/);
});
