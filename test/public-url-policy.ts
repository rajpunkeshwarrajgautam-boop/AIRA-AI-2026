import assert from 'node:assert/strict';
import { assertPublicUrl, isPublicAddress } from '../packages/tool-runtime/src/public-url-policy.js';
import { BrowserAdapter } from '../packages/tool-runtime/src/adapters/browser-adapter.js';

// DNS fixtures validate rejection logic, not live network/browser certification.
for (const address of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.170.2', '172.16.1.1', '192.168.1.1', '198.18.0.1', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001::1', '2001:db8::1', '2002:7f00:1::']) {
  assert.equal(isPublicAddress(address), false, address);
}
for (const address of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isPublicAddress(address), true, address);
const publicDns = async () => [{ address: '93.184.216.34' }];
await assertPublicUrl('https://example.com', { resolve: publicDns });
for (const url of ['file:///etc/passwd', 'ftp://example.com', 'https://user:credential@example.com', 'http://localhost', 'http://127.1', 'http://2130706433', 'http://10.0.0.1', 'http://[::1]', 'http://[::ffff:7f00:1]', 'http://metadata.google.internal', 'http://service.local.']) {
  await assert.rejects(assertPublicUrl(url, { resolve: publicDns }), /SECURITY_REJECTED/);
}
await assert.rejects(assertPublicUrl('https://example.com', { resolve: async () => [{ address: '93.184.216.34' }, { address: '127.0.0.1' }] }), /SECURITY_REJECTED/);
await assert.rejects(assertPublicUrl('https://example.com', { resolve: async () => [] }), /SECURITY_REJECTED/);
await assertPublicUrl('http://127.0.0.1:3000', { allowLoopbackFixture: true });
await assert.rejects(assertPublicUrl('http://10.0.0.1', { allowLoopbackFixture: true }), /SECURITY_REJECTED/);
const originalFetch = globalThis.fetch;
let fetches = 0;
try {
  globalThis.fetch = (async () => {
    fetches++;
    return new Response(null, { status: 302, headers: { location: 'http://169.254.170.2/credentials' } });
  }) as typeof fetch;
  const fallbackFixture = {
    validateUrl: (url: string) => assertPublicUrl(url),
    getSession: async () => { throw new Error('Unit fixture: browser absent'); },
  };
  await assert.rejects(BrowserAdapter.prototype.navigate.call(fallbackFixture as any, {} as any, 'https://93.184.216.34'), /SECURITY_REJECTED/);
  assert.equal(fetches, 1, 'private redirect must be rejected before next request');
} finally { globalThis.fetch = originalFetch; }
console.log('PASS: private/reserved addresses, DNS results, protocols and URL credentials rejected');
