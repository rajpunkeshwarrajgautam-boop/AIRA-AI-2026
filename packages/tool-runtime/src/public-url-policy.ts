import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

type Resolver = (hostname: string) => Promise<Array<{ address: string }>>;
function reject(): never { throw new Error('SECURITY_REJECTED: Destination is not a permitted public HTTP(S) URL.'); }

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    const first = Number.parseInt(normalized.split(':')[0], 16);
    const second = Number.parseInt(normalized.split(':')[1] || '0', 16);
    // Permit global unicast only. Reject mapped IPv4, translation/tunneling,
    // documentation, loopback, link-local, unique-local and multicast ranges.
    return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 && first !== 0x3ffe &&
      !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
  }
  return false;
}

export async function assertPublicUrl(raw: string, options: { allowLoopbackFixture?: boolean; resolve?: Resolver } = {}): Promise<void> {
  let url: URL;
  try { url = new URL(raw); } catch { return reject(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return reject();
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const isFixture = (address: string) => options.allowLoopbackFixture && (address === '::1' || /^127\./.test(address));
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.internal') || hostname.endsWith('.local')) return reject();
  if (isIP(hostname)) {
    if (!isPublicAddress(hostname) && !isFixture(hostname)) return reject();
    return;
  }
  const resolve = options.resolve || ((host: string) => lookup(host, { all: true, verbatim: true }));
  let addresses: Array<{ address: string }>;
  try { addresses = await resolve(hostname); } catch { return reject(); }
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address) && !isFixture(item.address))) return reject();
}
