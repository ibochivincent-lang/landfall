import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  loadAnchorsRegistry,
  lookupCrossChainAddresses,
  parseAnchorsRegistry,
} from "../src/crossChainRegistry.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url)); // .../packages/registry/test
const REPO_ROOT = path.resolve(TEST_DIR, "../../.."); // test -> registry -> packages -> repo root
const SHIPPED_REGISTRY_PATH = path.join(REPO_ROOT, "registry", "anchors.registry.json");

const SAMPLE = {
  version: 1,
  anchors: {
    "example-anchor.test": {
      chains: {
        base: { addresses: ["0x" + "11".repeat(20)] },
      },
    },
  },
};

test("parseAnchorsRegistry accepts a well-formed registry", () => {
  const registry = parseAnchorsRegistry(JSON.stringify(SAMPLE));
  assert.deepEqual(
    lookupCrossChainAddresses(registry, "example-anchor.test", "base"),
    ["0x" + "11".repeat(20)],
  );
});

test("lookupCrossChainAddresses returns [] for an anchor or chain not yet curated", () => {
  const registry = parseAnchorsRegistry(JSON.stringify(SAMPLE));
  assert.deepEqual(lookupCrossChainAddresses(registry, "unknown-anchor.test", "base"), []);
  assert.deepEqual(lookupCrossChainAddresses(registry, "example-anchor.test", "tron"), []);
});

test("parseAnchorsRegistry rejects a bad version tag instead of silently accepting it", () => {
  assert.throws(() => parseAnchorsRegistry(JSON.stringify({ version: 2, anchors: {} })));
});

test("parseAnchorsRegistry rejects an entry with an empty addresses array", () => {
  const bad = {
    version: 1,
    anchors: { "x.test": { chains: { base: { addresses: [] } } } },
  };
  assert.throws(() => parseAnchorsRegistry(JSON.stringify(bad)));
});

test("parseAnchorsRegistry rejects malformed JSON loudly rather than resolving to empty", () => {
  assert.throws(() => parseAnchorsRegistry("{not json"));
});

test("the shipped registry/anchors.registry.json file itself is always valid", async () => {
  const registry = await loadAnchorsRegistry(SHIPPED_REGISTRY_PATH);
  assert.equal(registry.version, 1);
});
