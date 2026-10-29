import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertConnectedServerAddressMatchesExpected,
  assertDnsAddressesMatchExpected,
  normalizeIpAddress,
} from './postgres-address-policy.mjs';

test('accepts the Docker-inspected IPv4 endpoint resolved by postgres DNS', () => {
  assert.equal(
    assertDnsAddressesMatchExpected({
      expectedAddresses: ['172.29.0.2'],
      dnsAddresses: ['172.29.0.2'],
    }),
    true,
  );
  assert.equal(
    assertConnectedServerAddressMatchesExpected({
      expectedAddresses: ['172.29.0.2'],
      dnsAddresses: ['172.29.0.2'],
      serverAddress: '172.29.0.2',
    }),
    true,
  );
});

test('normalizes compressed and expanded IPv6 endpoint spellings', () => {
  assert.equal(normalizeIpAddress('2001:db8::2'), normalizeIpAddress('2001:0db8:0:0:0:0:0:2'));
  assert.equal(
    assertConnectedServerAddressMatchesExpected({
      expectedAddresses: ['2001:0db8:0:0:0:0:0:2'],
      dnsAddresses: ['2001:db8::2'],
      serverAddress: '2001:db8:0:0:0:0:0:2/128',
    }),
    true,
  );
});

test('normalizes IPv4-mapped IPv6 to the exact assigned IPv4 endpoint', () => {
  assert.equal(normalizeIpAddress('::ffff:172.29.0.2'), normalizeIpAddress('172.29.0.2'));
  assert.equal(
    assertConnectedServerAddressMatchesExpected({
      expectedAddresses: ['172.29.0.2'],
      dnsAddresses: ['::ffff:172.29.0.2'],
      serverAddress: '::ffff:ac1d:2',
    }),
    true,
  );
});

test('rejects a different private server address even when DNS resolves to the expected container', () => {
  assert.throws(
    () => assertConnectedServerAddressMatchesExpected({
      expectedAddresses: ['10.42.0.2'],
      dnsAddresses: ['10.42.0.2'],
      serverAddress: '10.42.0.9',
    }),
    /does not match its isolated container endpoint/,
  );
});

test('rejects DNS answers outside the Docker-inspected PostgreSQL endpoint set', () => {
  assert.throws(
    () => assertConnectedServerAddressMatchesExpected({
      expectedAddresses: ['10.42.0.2'],
      dnsAddresses: ['10.42.0.2', '10.42.0.9'],
      serverAddress: '10.42.0.2',
    }),
    /DNS resolved outside the isolated PostgreSQL container endpoints/,
  );
});

test('rejects a server address that is DNS-resolved but not assigned to the PostgreSQL container', () => {
  assert.throws(
    () => assertConnectedServerAddressMatchesExpected({
      expectedAddresses: ['10.42.0.2'],
      dnsAddresses: ['10.42.0.9'],
      serverAddress: '10.42.0.9',
    }),
    /DNS resolved outside the isolated PostgreSQL container endpoints/,
  );
});

test('rejects empty endpoint sets, loopback, and malformed IP addresses', () => {
  assert.throws(
    () => assertDnsAddressesMatchExpected({ expectedAddresses: [], dnsAddresses: ['10.42.0.2'] }),
    /expected PostgreSQL container endpoints must contain at least one address/,
  );
  assert.throws(
    () => assertConnectedServerAddressMatchesExpected({
      expectedAddresses: ['10.42.0.2'],
      dnsAddresses: ['10.42.0.2'],
      serverAddress: '127.0.0.1',
    }),
    /does not match its isolated container endpoint/,
  );
  assert.throws(() => normalizeIpAddress('not-an-ip'), /invalid IP address/);
});
