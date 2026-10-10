import assert from 'node:assert/strict';
import express from 'express';
import { createAccountLoginHandler, createAccountLogoutHandler, createAccountMiddleware } from '../apps/api/src/auth/firebase-account.js';
import { createSessionAuthMiddleware, ensureAuthenticatedSession } from '../apps/api/src/auth/session-auth.js';
import type { DecodedIdToken } from 'firebase-admin/auth';

// Scripted Admin SDK boundary fixture; not real Firebase login certification.
process.env.NODE_ENV = 'test';
process.env.AIRA_SESSION_SECRET = 'fixture-account-session-secret-at-least-32-characters';
process.env.AIRA_AUTH_ALLOWED_ORIGINS = 'https://fixture.aira.test';
let revoked = false;
let revokeCalls = 0;
let idClaims = { uid: 'owner-a', exp: Math.floor(Date.now() / 1000) + 3600, auth_time: Math.floor(Date.now() / 1000), firebase: { sign_in_provider: 'google.com' } } as DecodedIdToken;
const sdk = {
  verifyIdToken: async (token: string, checkRevoked?: boolean) => {
    assert.equal(checkRevoked, true);
    if (token !== 'owned-token-fixture') throw new Error('Fixture rejects invalid identity');
    return idClaims;
  },
  createSessionCookie: async () => 'owned-session-fixture',
  verifySessionCookie: async (token: string, checkRevoked?: boolean) => {
    assert.equal(checkRevoked, true);
    if (token !== 'owned-session-fixture' || revoked) throw new Error('Fixture revoked or forged session');
    return idClaims;
  },
  revokeRefreshTokens: async (uid: string) => { assert.equal(uid, 'owner-a'); revoked = true; revokeCalls++; }
};
const app = express();
app.use(express.json());
app.use(createAccountMiddleware(() => sdk));
app.use(createSessionAuthMiddleware());
app.post('/api/auth/account', createAccountLoginHandler(() => sdk));
app.post('/api/auth/logout', createAccountLogoutHandler(() => sdk));
app.post('/api/auth/session', (req, res) => res.json(ensureAuthenticatedSession(req, res)));
app.get('/api/health', (_req, res) => res.json({ status: 'HEALTHY' }));
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
const login = (body: unknown, origin = 'https://fixture.aira.test') => fetch(`${base}/api/auth/account`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
try {
  assert.equal((await login({ idToken: 'owned-token-fixture' }, 'https://attacker.invalid')).status, 403);
  assert.equal((await login({ userId: 'owner-a' })).status, 400);
  assert.equal((await login({ idToken: 'forged-token' })).status, 401);
  idClaims = { ...idClaims, auth_time: Math.floor(Date.now() / 1000) - 301 };
  assert.equal((await login({ idToken: 'owned-token-fixture' })).status, 401);
  idClaims = { ...idClaims, auth_time: Math.floor(Date.now() / 1000), firebase: { ...idClaims.firebase, sign_in_provider: 'anonymous' } };
  assert.equal((await login({ idToken: 'owned-token-fixture' })).status, 401);
  idClaims = { ...idClaims, firebase: { ...idClaims.firebase, sign_in_provider: 'google.com' } };
  const signedIn = await login({ idToken: 'owned-token-fixture', userId: 'spoofed-owner' });
  assert.equal(signedIn.status, 200);
  assert.equal((await signedIn.json()).userId, 'firebase:owner-a');
  assert.match(signedIn.headers.get('set-cookie')!, /HttpOnly/);
  assert.match(signedIn.headers.get('set-cookie')!, /SameSite=Strict/);
  const cookie = 'aira_account_session=owned-session-fixture';
  const session = await fetch(`${base}/api/auth/session`, { method: 'POST', headers: { Cookie: cookie } });
  assert.equal((await session.json()).userId, 'firebase:owner-a', 'guest bootstrap must preserve verified account identity');
  assert.equal(session.headers.get('set-cookie'), null, 'guest session must not overwrite the account cookie');
  const crossSiteLogout = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://attacker.invalid' } });
  assert.equal(crossSiteLogout.status, 403);
  assert.equal(revokeCalls, 0);
  const logout = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://fixture.aira.test' } });
  assert.equal(logout.status, 200);
  assert.equal(revokeCalls, 1);
  assert.match(logout.headers.get('set-cookie')!, /Max-Age=0/);
  const replay = await fetch(`${base}/api/auth/session`, { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(replay.status, 401, 'revoked account cookie must not downgrade silently to guest');
  assert.equal((await fetch(`${base}/api/health`, { headers: { Cookie: cookie } })).status, 200, 'health stays public with invalid account cookie');
  console.log('PASS: account origin, identity, recent sign-in, anonymous rejection, account bootstrap, revocation and cookie replay policies (SDK fixture)');
} finally { await new Promise<void>(resolve => server.close(() => resolve())); }
