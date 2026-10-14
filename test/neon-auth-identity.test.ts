import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  verifyNeonAuthToken,
  createNeonAuthPrincipalMiddleware
} from '../apps/api/src/auth/neon-auth-principal.js';

const AUTH_ORIGIN = 'https://neon-auth-test.example';
const oldFetch = globalThis.fetch;
const prev = {
  base: process.env.NEON_AUTH_BASE_URL,
  jwks: process.env.NEON_AUTH_JWKS_URL,
  enabled: process.env.AIRA_EXTERNAL_AUTH_ENABLED
};

async function run() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key-1', alg: 'EdDSA', use: 'sig' };
  let jwksFetches = 0;
  globalThis.fetch = async (input: any) => {
    assert.equal(String(input), AUTH_ORIGIN + '/neondb/auth/.well-known/jwks.json');
    jwksFetches++;
    return new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  };
  process.env.NEON_AUTH_BASE_URL = AUTH_ORIGIN + '/neondb/auth';
  process.env.NEON_AUTH_JWKS_URL = AUTH_ORIGIN + '/neondb/auth/.well-known/jwks.json';
  process.env.AIRA_EXTERNAL_AUTH_ENABLED = 'true';

  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'test-key-1', typ: 'JWT' })).toString('base64url');
  const jwt = (payload: Record<string, unknown>) => {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const unsigned = header + '.' + encoded;
    return unsigned + '.' + sign(null, Buffer.from(unsigned), privateKey).toString('base64url');
  };
  const now = Math.floor(Date.now() / 1000);
  const good = jwt({
    iss: AUTH_ORIGIN,
    sub: 'stable-user-123',
    iat: now - 30,
    exp: now + 600
  });
  const verified = await verifyNeonAuthToken(good);
  assert.equal(verified.userId, 'neon_user_stable-user-123');
  assert.ok(verified.sessionId.startsWith('neon_session_'));
  assert.equal((await verifyNeonAuthToken(good)).userId, verified.userId);
  assert.equal(jwksFetches, 1, 'JWKS should cache between requests');

  const other = jwt({ iss: AUTH_ORIGIN, sub: 'separate-account-456', iat: now - 30, exp: now + 600 });
  assert.notEqual((await verifyNeonAuthToken(other)).userId, verified.userId,
    'two independent accounts must get distinct principal IDs');

  const bad = [
    jwt({ iss: AUTH_ORIGIN, sub: 'stable-user-123', iat: now - 30, exp: now - 1 }),
    jwt({ iss: 'https://evil.example', sub: 'stable-user-123', iat: now - 30, exp: now + 600 }),
    jwt({ iss: AUTH_ORIGIN, sub: 'stable-user-123', iat: now - 30, exp: now + 600, is_anonymous: true }),
    good.slice(0, -5) + 'AAAAA',
    Buffer.from(JSON.stringify({ alg: 'none', kid: 'test-key-1' })).toString('base64url') + '.' + good.split('.')[1] + '.' + good.split('.')[2]
  ];
  for (const token of bad) {
    await assert.rejects(verifyNeonAuthToken(token), undefined, 'invalid JWT must fail closed');
  }

  const middleware = createNeonAuthPrincipalMiddleware();
  function invoke(req: any): Promise<{ res: any; nextCalled: boolean }> {
    return new Promise((resolve, reject) => {
      const res: any = { statusCode: 200, body: null, status(code: number) { this.statusCode = code; return this; },
        json(body: any) { this.body = body; resolve({ res: this, nextCalled: false }); } };
      Promise.resolve(middleware(req, res, (error?: Error) => {
        if (error) reject(error);
        else resolve({ res, nextCalled: true });
      })).catch(reject);
    });
  }
  const req: any = { headers: { authorization: 'Bearer ' + good }, user: { id: 'guest-id' } };
  const valid = await invoke(req);
  assert.equal(valid.nextCalled, true);
  assert.equal(req.user.id, verified.userId, 'verified principal must override anonymous cookie identity');
  assert.equal(req.managedIdentity.provider, 'neon_auth');
  const denied = await invoke({ headers: { authorization: 'Bearer invalid' }, user: { id: 'old-valid-cookie' } });
  assert.equal(denied.nextCalled, false);
  assert.equal(denied.res.statusCode, 401, 'invalid bearer must not downgrade to a cookie');
  process.env.AIRA_EXTERNAL_AUTH_ENABLED = 'false';
  const inactive = await invoke({ headers: { authorization: 'Bearer invalid' } });
  assert.equal(inactive.nextCalled, true, 'disabled managed auth does not change current guest behavior');

  console.log('Managed account JWT verification and two-principal isolation: PASS');
}

run().catch(error => {
  console.error('Managed account JWT verification failed:', error);
  process.exitCode = 1;
}).finally(() => {
  globalThis.fetch = oldFetch;
  if (prev.base === undefined) delete process.env.NEON_AUTH_BASE_URL; else process.env.NEON_AUTH_BASE_URL = prev.base;
  if (prev.jwks === undefined) delete process.env.NEON_AUTH_JWKS_URL; else process.env.NEON_AUTH_JWKS_URL = prev.jwks;
  if (prev.enabled === undefined) delete process.env.AIRA_EXTERNAL_AUTH_ENABLED; else process.env.AIRA_EXTERNAL_AUTH_ENABLED = prev.enabled;
});
