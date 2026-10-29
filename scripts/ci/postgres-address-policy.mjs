import { isIP } from 'node:net';

export class SafePreflightError extends Error {}

function invalidAddress() {
  throw new SafePreflightError('PostgreSQL endpoint validation received an invalid IP address');
}

export function normalizeIpAddress(value) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    return invalidAddress();
  }

  const slash = value.indexOf('/');
  if (slash !== -1 && value.indexOf('/', slash + 1) !== -1) return invalidAddress();
  const address = slash === -1 ? value : value.slice(0, slash);
  const prefix = slash === -1 ? null : value.slice(slash + 1);
  if (prefix !== null && (!/^\d+$/.test(prefix) || prefix.length > 3)) return invalidAddress();

  const family = isIP(address);
  if (family === 4) {
    if (prefix !== null && Number(prefix) > 32) return invalidAddress();
    const octets = address.split('.').map(Number);
    return `ipv4:${octets.join('.')}`;
  }
  if (family !== 6 || (prefix !== null && Number(prefix) > 128)) return invalidAddress();

  let expandedInput = address.toLowerCase();
  if (expandedInput.includes('.')) {
    const lastColon = expandedInput.lastIndexOf(':');
    const ipv4Tail = expandedInput.slice(lastColon + 1);
    if (lastColon < 0 || isIP(ipv4Tail) !== 4) return invalidAddress();
    const [a, b, c, d] = ipv4Tail.split('.').map(Number);
    const high = ((a << 8) | b).toString(16);
    const low = ((c << 8) | d).toString(16);
    expandedInput = `${expandedInput.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const compression = expandedInput.indexOf('::');
  let groups;
  if (compression === -1) {
    groups = expandedInput.split(':');
    if (groups.length !== 8) return invalidAddress();
  } else {
    if (expandedInput.indexOf('::', compression + 2) !== -1) return invalidAddress();
    const left = expandedInput.slice(0, compression);
    const right = expandedInput.slice(compression + 2);
    const leftGroups = left ? left.split(':') : [];
    const rightGroups = right ? right.split(':') : [];
    const zeroCount = 8 - leftGroups.length - rightGroups.length;
    if (zeroCount < 1) return invalidAddress();
    groups = [...leftGroups, ...Array(zeroCount).fill('0'), ...rightGroups];
  }

  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) {
    return invalidAddress();
  }
  const words = groups.map((group) => Number.parseInt(group, 16));

  // Treat IPv4-mapped IPv6 spellings as the same endpoint as their IPv4 address.
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return `ipv4:${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`;
  }
  return `ipv6:${words.map((word) => word.toString(16).padStart(4, '0')).join(':')}`;
}

function normalizeAddressSet(addresses, label) {
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new SafePreflightError(`${label} must contain at least one address`);
  }
  return new Set(addresses.map(normalizeIpAddress));
}

export function assertDnsAddressesMatchExpected({ expectedAddresses, dnsAddresses }) {
  const expected = normalizeAddressSet(expectedAddresses, 'expected PostgreSQL container endpoints');
  const resolved = normalizeAddressSet(dnsAddresses, 'postgres DNS answers');
  if ([...resolved].some((address) => !expected.has(address))) {
    throw new SafePreflightError('postgres DNS resolved outside the isolated PostgreSQL container endpoints');
  }
  return true;
}

export function assertConnectedServerAddressMatchesExpected({
  expectedAddresses,
  dnsAddresses,
  serverAddress,
}) {
  assertDnsAddressesMatchExpected({ expectedAddresses, dnsAddresses });
  const expected = normalizeAddressSet(expectedAddresses, 'expected PostgreSQL container endpoints');
  const resolved = normalizeAddressSet(dnsAddresses, 'postgres DNS answers');
  const server = normalizeIpAddress(serverAddress);
  if (!expected.has(server) || !resolved.has(server)) {
    throw new SafePreflightError('connected PostgreSQL server address does not match its isolated container endpoint and postgres DNS');
  }
  return true;
}
