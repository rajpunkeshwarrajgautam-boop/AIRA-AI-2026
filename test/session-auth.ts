import assert from 'node:assert/strict';
import type { NextFunction, Request, Response } from 'express';
import {
  createSessionAuthMiddleware,
  ensureAuthenticatedSession,
  SESSION_COOKIE_NAME,
} from '../apps/api/src/auth/session-auth.js';

type MockResponse = Response & {
  headers: Map<string, string>;
};

function makeResponse(): MockResponse {
  const headers = new Map<string, string>();
  return {
    headers,
    setHeader(name: string, value: number | string | readonly string[]) {
      headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value));
      return this;
    },
  } as unknown as MockResponse;
}

function cookiePair(setCookie: string): string {
  return setCookie.split(';', 1)[0];
}

async function hydrate(req: Request, res: Response): Promise<void> {
  const middleware = createSessionAuthMiddleware();
  await new Promise<void>((resolve, reject) => {
    const next: NextFunction = (error?: unknown) => error ? reject(error) : resolve();
    middleware(req, res, next);
  });
}

async function run() {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalSecret = process.env.AIRA_SESSION_SECRET;

  process.env.NODE_ENV = 'test';
  process.env.AIRA_SESSION_SECRET = 'test-session-secret-0123456789-abcdefghijklmnopqrstuvwxyz';

  try {
    console.log('=== AUTH SESSION BRIDGE CERTIFICATION ===');

    const bootstrapReq = { headers: {} } as Request;
    const bootstrapRes = makeResponse();
    const session = ensureAuthenticatedSession(bootstrapReq, bootstrapRes);

    assert.ok(session.userId.startsWith('user_'), 'bootstrap must issue a trusted user id');
    assert.ok(session.sessionId.startsWith('session_'), 'bootstrap must issue a trusted session id');

    const setCookie = bootstrapRes.headers.get('set-cookie');
    assert.ok(setCookie, 'bootstrap must emit Set-Cookie');
    assert.match(setCookie, new RegExp(`^${SESSION_COOKIE_NAME}=`));
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);

    const protectedReq = {
      headers: { cookie: cookiePair(setCookie) },
    } as Request;
    const protectedRes = makeResponse();

    await hydrate(protectedReq, protectedRes);

    const trustedUser = (protectedReq as any).user;
    assert.equal(trustedUser.id, session.userId, 'middleware must recover the signed user identity');
    assert.equal(trustedUser.sessionId, session.sessionId, 'middleware must recover the signed session identity');

    const [name, rawToken] = cookiePair(setCookie).split('=');
    const decoded = decodeURIComponent(rawToken);
    const tampered = decoded.slice(0, -1) + (decoded.endsWith('a') ? 'b' : 'a');
    const tamperedReq = {
      headers: { cookie: `${name}=${encodeURIComponent(tampered)}` },
    } as Request;
    const tamperedRes = makeResponse();

    await hydrate(tamperedReq, tamperedRes);

    assert.equal((tamperedReq as any).user, undefined, 'tampered cookie must not create a trusted identity');
    assert.match(tamperedRes.headers.get('set-cookie') || '', /Max-Age=0/, 'tampered cookie must be cleared');

    process.env.NODE_ENV = 'production';
    const productionReq = { headers: {} } as Request;
    const productionRes = makeResponse();
    ensureAuthenticatedSession(productionReq, productionRes);
    assert.match(productionRes.headers.get('set-cookie') || '', /Secure/i, 'production cookie must be Secure');

    console.log('PASS: signed session issue, verification, tamper rejection, and production cookie flags');
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;

    if (originalSecret === undefined) delete process.env.AIRA_SESSION_SECRET;
    else process.env.AIRA_SESSION_SECRET = originalSecret;
  }
}

run().catch(error => {
  console.error('AUTH SESSION BRIDGE CERTIFICATION FAILED:', error);
  process.exit(1);
});
