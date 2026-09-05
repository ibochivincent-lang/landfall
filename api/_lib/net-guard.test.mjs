import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedIp } from './net-guard.js';

test('blocks RFC1918 private ranges', () => {
  assert.equal(isBlockedIp('10.0.0.1'), true);
  assert.equal(isBlockedIp('172.16.5.4'), true);
  assert.equal(isBlockedIp('172.31.255.255'), true);
  assert.equal(isBlockedIp('192.168.1.1'), true);
});

test('blocks loopback', () => {
  assert.equal(isBlockedIp('127.0.0.1'), true);
  assert.equal(isBlockedIp('127.255.255.255'), true);
  assert.equal(isBlockedIp('::1'), true);
});

test('blocks link-local, including the cloud metadata address', () => {
  assert.equal(isBlockedIp('169.254.169.254'), true);
  assert.equal(isBlockedIp('169.254.0.1'), true);
  assert.equal(isBlockedIp('fe80::1'), true);
});

test('blocks IPv6 unique-local', () => {
  assert.equal(isBlockedIp('fc00::1'), true);
  assert.equal(isBlockedIp('fd12:3456:789a::1'), true);
});

test('blocks IPv4-mapped IPv6 addresses that wrap a blocked v4 address', () => {
  assert.equal(isBlockedIp('::ffff:169.254.169.254'), true);
  assert.equal(isBlockedIp('::ffff:10.0.0.1'), true);
  assert.equal(isBlockedIp('::ffff:127.0.0.1'), true);
});

test('does not block ordinary public addresses', () => {
  assert.equal(isBlockedIp('8.8.8.8'), false);
  assert.equal(isBlockedIp('1.1.1.1'), false);
  assert.equal(isBlockedIp('93.184.216.34'), false);
  assert.equal(isBlockedIp('2606:4700:4700::1111'), false); // Cloudflare public v6
});
