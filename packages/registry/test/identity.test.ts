import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveAnchorIdentity } from "../src/identity.js";

const DOMAIN = "example-anchor.test";
const DECLARED = "G" + "A".repeat(55);
const OWN_ISSUER = "G" + "B".repeat(55);
const THIRD_PARTY_ISSUER = "G" + "C".repeat(55);
const HORIZON = "https://horizon.test";

const SAMPLE_TOML = `
ORG_NAME = "Test Anchor"
ACCOUNTS = [
  "${DECLARED}"
]

[[CURRENCIES]]
code = "OWN"
issuer = "${OWN_ISSUER}"

[[CURRENCIES]]
code = "USDC"
issuer = "${THIRD_PARTY_ISSUER}"
`;

/**
 * Dispatches on URL: the stellar.toml fetch returns `toml`, and a Horizon
 * accounts lookup returns `home_domain` per account — mirroring the two
 * network calls resolveAnchorIdentity now makes (discoverDomain fetches the
 * toml, then confirms each currency issuer against its own home_domain).
 */
function fakeFetch(opts: {
  toml: { status: number; body: string };
  homeDomains?: Record<string, string>;
}): typeof fetch {
  return (async (url: string | URL) => {
    const href = String(url);
    if (href.includes(".well-known/stellar.toml")) {
      return new Response(opts.toml.body, { status: opts.toml.status });
    }
    const match = /\/accounts\/([^/]+)$/.exec(href);
    const account = match?.[1];
    const homeDomain = account ? opts.homeDomains?.[account] : undefined;
    if (!homeDomain) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({ home_domain: homeDomain }), { status: 200 });
  }) as typeof fetch;
}

test("resolveAnchorIdentity uses the domain itself as anchorId", async () => {
  const identity = await resolveAnchorIdentity(
    DOMAIN,
    fakeFetch({ toml: { status: 200, body: SAMPLE_TOML } }),
    HORIZON,
  );
  assert.equal(identity.anchorId, DOMAIN);
  assert.equal(identity.domain, DOMAIN);
});

test("resolveAnchorIdentity surfaces declared accounts and issuers confirmed by their own home_domain", async () => {
  const identity = await resolveAnchorIdentity(
    DOMAIN,
    fakeFetch({
      toml: { status: 200, body: SAMPLE_TOML },
      homeDomains: { [OWN_ISSUER]: DOMAIN, [THIRD_PARTY_ISSUER]: "circle.com" },
    }),
    HORIZON,
  );
  assert.equal(identity.error, undefined);
  const byAccount = new Map(identity.stellarAccounts.map((a) => [a.account, a]));
  assert.equal(byAccount.get(DECLARED)?.role, "declared");
  assert.equal(byAccount.get(OWN_ISSUER)?.role, "issuer");
});

test("resolveAnchorIdentity drops a currency issuer whose home_domain belongs to someone else", async () => {
  // Regression: two production anchors both cited Circle's real USDC issuer
  // in [[CURRENCIES]], and it was surfaced as if it were each anchor's own
  // account — scanning Circle's global USDC settlement volume under both
  // names. The issuer's home_domain (circle.com) never matched either
  // anchor's domain, which is exactly what this check now catches.
  const identity = await resolveAnchorIdentity(
    DOMAIN,
    fakeFetch({
      toml: { status: 200, body: SAMPLE_TOML },
      homeDomains: { [OWN_ISSUER]: DOMAIN, [THIRD_PARTY_ISSUER]: "circle.com" },
    }),
    HORIZON,
  );
  const accounts = identity.stellarAccounts.map((a) => a.account);
  assert.ok(!accounts.includes(THIRD_PARTY_ISSUER));
});

test("resolveAnchorIdentity drops a currency issuer with no home_domain set at all", async () => {
  const identity = await resolveAnchorIdentity(
    DOMAIN,
    fakeFetch({
      toml: { status: 200, body: SAMPLE_TOML },
      homeDomains: { [OWN_ISSUER]: DOMAIN }, // THIRD_PARTY_ISSUER has none
    }),
    HORIZON,
  );
  const accounts = identity.stellarAccounts.map((a) => a.account);
  assert.ok(!accounts.includes(THIRD_PARTY_ISSUER));
  assert.ok(accounts.includes(OWN_ISSUER));
});

test("resolveAnchorIdentity reports an unreachable domain as an error, not a crash", async () => {
  const identity = await resolveAnchorIdentity(
    "gone.test",
    fakeFetch({ toml: { status: 404, body: "" } }),
    HORIZON,
  );
  assert.equal(identity.anchorId, "gone.test");
  assert.deepEqual(identity.stellarAccounts, []);
  assert.ok(identity.error);
});
