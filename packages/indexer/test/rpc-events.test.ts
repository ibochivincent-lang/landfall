/**
 * packages/indexer/test/rpc-events.test.ts
 *
 * Tests for Protocol 23 / CAP-67 Stellar RPC Contract Event parsing.
 * Author: ibochivincent-lang
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { xdr, Address } from "@stellar/stellar-base";
import {
  parseContractEvent,
  formatSorobanAmount,
  buildCap67TopicFilters,
} from "../src/rpc-events.js";

test("formatSorobanAmount converts 7-decimal integer to standard decimal string", () => {
  assert.equal(formatSorobanAmount(10_000_000n), "1");
  assert.equal(formatSorobanAmount(15_500_000n), "1.55");
  assert.equal(formatSorobanAmount(100n), "0.00001");
  assert.equal(formatSorobanAmount(0n), "0");
  assert.equal(formatSorobanAmount(-50_000_000n), "-5");
});

test("buildCap67TopicFilters generates base64 XDR symbol topics", () => {
  const filters = buildCap67TopicFilters(["mint", "burn", "transfer"]);
  assert.equal(filters.length, 3);
  const mintSymXdr = xdr.ScVal.scvSymbol("mint").toXDR("base64");
  assert.deepEqual(filters[0], [mintSymXdr]);
});

test("parseContractEvent decodes a CAP-67 mint event", () => {
  const adminAddress = Address.fromString("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
  const recipientAddress = Address.fromString("GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");

  const topic0 = xdr.ScVal.scvSymbol("mint").toXDR("base64");
  const topic1 = adminAddress.toScVal().toXDR("base64");
  const topic2 = recipientAddress.toScVal().toXDR("base64");

  const amountScVal = xdr.ScVal.scvI128(
    new xdr.Int128Parts({
      hi: new xdr.Int64(0n),
      lo: new xdr.Uint64(250_000_000n), // 25.0 USDC
    })
  ).toXDR("base64");

  const parsed = parseContractEvent({
    id: "0000000000000000001",
    type: "contract",
    ledger: 1234567,
    ledgerClosedAt: "2026-09-10T00:00:00Z",
    contractId: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    topic: [topic0, topic1, topic2],
    value: amountScVal,
    txHash: "deadbeef00000000000000000000000000000000000000000000000000000000",
  });

  assert.equal(parsed.action, "mint");
  assert.equal(parsed.contractId, "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75");
  assert.equal(parsed.to, "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");
  assert.equal(parsed.amount, "25");
});

test("parseContractEvent decodes a CAP-67 burn event", () => {
  const userAddress = Address.fromString("GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");

  const topic0 = xdr.ScVal.scvSymbol("burn").toXDR("base64");
  const topic1 = userAddress.toScVal().toXDR("base64");

  const amountScVal = xdr.ScVal.scvI128(
    new xdr.Int128Parts({
      hi: new xdr.Int64(0n),
      lo: new xdr.Uint64(10_000_000n), // 1.0 USDC
    })
  ).toXDR("base64");

  const parsed = parseContractEvent({
    id: "0000000000000000002",
    type: "contract",
    ledger: 1234568,
    ledgerClosedAt: "2026-09-10T00:00:05Z",
    contractId: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    topic: [topic0, topic1],
    value: amountScVal,
    txHash: "beefcafe00000000000000000000000000000000000000000000000000000000",
  });

  assert.equal(parsed.action, "burn");
  assert.equal(parsed.from, "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");
  assert.equal(parsed.amount, "1");
});
