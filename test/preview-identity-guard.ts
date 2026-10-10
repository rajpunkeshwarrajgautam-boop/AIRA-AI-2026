
import assert from 'node:assert/strict';
import { DevPrincipalProvider } from '../apps/api/src/auth/principal-provider.js';

async function run() {
  const before = { node: process.env.NODE_ENV, vercel: process.env.VERCEL_ENV };
  try {
    const resolver = new DevPrincipalProvider();
    process.env.NODE_ENV = 'production';
    process.env.VERCEL_ENV = 'preview';
    const spoofed = { headers: { 'x-test-user-id': 'victim-id', 'x-test-session-id': 'victim-session' } };
    await assert.rejects(resolver.resolve(spoofed as any), /Unauthorized/,
      'Preview must never allow impersonation with unauthenticated test headers');
    const real = { ...spoofed, user: {
      id: 'signed-cookie-owner',
      sessionId: 'real-session',
      scopes: ['chat:write']
    }};
    const principal = await resolver.resolve(real as any);
    assert.equal(principal.userId, 'signed-cookie-owner');
    assert.equal(principal.sessionId, 'real-session');

    delete process.env.VERCEL_ENV;
    process.env.NODE_ENV = 'test';
    const testPrincipal = await resolver.resolve(spoofed as any);
    assert.equal(testPrincipal.userId, 'victim-id',
      'explicit test-mode headers remain available only locally/inside CI');
    console.log('PASS: deployed previews reject spoofed principals; CI test headers retained');
  } finally {
    if (before.node === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before.node;
    if (before.vercel === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = before.vercel;
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
