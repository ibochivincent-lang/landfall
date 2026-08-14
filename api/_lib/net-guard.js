/**
 * net-guard.js — blocks webhook targets that resolve to private, loopback,
 * link-local, or cloud-metadata address ranges.
 *
 * Extracted from api/[...path].js because it's a pure function with no
 * req/res/db coupling, and it's exactly the kind of security-critical logic
 * worth unit-testing independently (see api/_lib/net-guard.test.mjs).
 *
 * Prefixed with `_` so Vercel's Node builder does not treat this directory
 * as routable — only api/[...path].js and other non-underscore files under
 * api/ become endpoints.
 */

import { lookup } from 'node:dns/promises';

// IPv4 ranges that must never be a webhook target: private (RFC1918),
// loopback, link-local (includes the 169.254.169.254 cloud metadata
// address), and the "this network" block.
const BLOCKED_V4_RANGES = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],   // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],  // link-local, includes the 169.254.169.254 metadata IP
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],    // IETF protocol assignments
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],   // benchmarking
];

function v4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isBlockedV4(ip) {
  const n = v4ToInt(ip);
  if (n === null) return true; // unparseable — fail closed
  return BLOCKED_V4_RANGES.some(([base, prefix]) => {
    const baseInt = v4ToInt(base);
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (n & mask) === (baseInt & mask);
  });
}

/**
 * IPv6 blocklist: loopback (::1), unique-local (fc00::/7), link-local
 * (fe80::/10, which is also where IPv6 cloud-metadata addressing lives on
 * some providers), and IPv4-mapped/IPv4-compatible addresses — those must be
 * unwrapped and re-checked against the v4 list, otherwise
 * ::ffff:169.254.169.254 walks straight past a naive v6-only check.
 */
function isBlockedV6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;

  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedV4(mapped[1]);

  // Expand enough to read the leading hextet for prefix checks. Good enough
  // for fc00::/7 and fe80::/10 without a full-blown IPv6 parser.
  const firstHextet = lower.split('::')[0].split(':')[0].padStart(4, '0');
  const firstByte = parseInt(firstHextet.slice(0, 2), 16);
  if (Number.isNaN(firstByte)) return true; // unparseable — fail closed

  if ((firstByte & 0xfe) === 0xfc) return true; // fc00::/7 (unique local)
  if (firstByte === 0xfe) {
    const secondByte = parseInt(firstHextet.slice(2, 4), 16);
    if ((secondByte & 0xc0) === 0x80) return true; // fe80::/10 (link-local)
  }
  return false;
}

function isBlockedIp(ip) {
  return ip.includes(':') ? isBlockedV6(ip) : isBlockedV4(ip);
}

/**
 * Resolves `hostname` and throws if it has zero addresses or if ANY resolved
 * address is blocked (not just the first — DNS can return multiple records
 * in any order, and checking only one is a bypass).
 */
async function assertPublicHostname(hostname) {
  let addresses;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    throw new Error(`Could not resolve ${hostname}: ${err.message}`);
  }
  if (!addresses.length) throw new Error(`${hostname} did not resolve to any address.`);
  for (const { address } of addresses) {
    if (isBlockedIp(address)) {
      throw new Error(`${hostname} resolves to ${address}, which is a blocked private/internal range.`);
    }
  }
}

export { isBlockedIp, assertPublicHostname };
