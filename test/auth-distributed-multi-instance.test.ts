/**
 * AIRA AI 2026 — Distributed BFF Multi-Instance Session Verification Suite
 * 
 * Verifies that the PostgreSQL-backed BffSessionStore reliably coordinates
 * session state, revocation, and CSRF protection across independent application
 * instances (such as serverless Vercel lambdas or multi-container deployments).
 */

import assert from 'node:assert/strict';
import {
  BffSessionStore,
  BffServerSession,
  generateSessionId,
  generateCsrfToken,
  serializeBffToken,
  parseSignedSessionId,
  readBffSessionFromCookieAsync,
  createBffSessionMiddleware,
  BFF_COOKIE_NAME_DEV
} from '../apps/api/src/auth/bff-session.js';
import { db } from '../packages/db/src/index.js';

async function runDistributedSessionTests() {
  console.log('\n=== AIRA AI 2026 — DISTRIBUTED BFF MULTI-INSTANCE VERIFICATION ===\n');

  process.env.AIRA_SESSION_SECRET = 'distributed-session-test-secret-at-least-32-chars';

  // Ensure DB table is clean for testing
  await db('bff_sessions').delete();

  // 1. Simulate two independent instances with isolated memory caches
  console.log('Testing: Multi-instance session propagation across isolated memory spaces...');
  const instanceAStore = new BffSessionStore();
  const instanceBStore = new BffSessionStore();

  const sessionId = generateSessionId();
  const csrfToken = generateCsrfToken();
  const now = Date.now();

  const originalSession: BffServerSession = {
    id: sessionId,
    userId: 'usr_distributed_neon_789',
    email: 'distributed@example.com',
    name: 'Distributed User',
    sessionToken: 'sess_tok_distributed_abc',
    jwt: 'test.jwt.distributed',
    jwtExpiresAt: now + 600_000,
    csrfToken,
    createdAt: now,
    expiresAt: now + 3600_000,
    lastRotatedAt: now
  };

  // Instance A writes session
  await instanceAStore.setAsync(originalSession);

  // Assert Instance B initially has empty in-memory cache
  assert.equal(instanceBStore.get(sessionId), null, 'Instance B memory cache must be empty initially');

  // Instance B resolves session asynchronously from shared PostgreSQL store
  const resolvedOnB = await instanceBStore.getAsync(sessionId);
  assert(resolvedOnB !== null, 'Instance B must successfully hydrate session from PostgreSQL');
  assert.equal(resolvedOnB?.userId, 'usr_distributed_neon_789');
  assert.equal(resolvedOnB?.csrfToken, csrfToken);
  assert.equal(resolvedOnB?.sessionToken, 'sess_tok_distributed_abc');
  console.log('  ✓ Multi-instance session propagation verified (Instance A write -> Instance B read)');

  // 2. Distributed Revocation
  console.log('Testing: Distributed session revocation propagation across instances...');
  // Instance B executes sign-out / revocation
  const revoked = await instanceBStore.deleteAsync(sessionId);
  assert.equal(revoked, true, 'Instance B must successfully record revocation in PostgreSQL');

  // Instance A attempts to read session via getAsync
  // Force Instance A memory cache clear to simulate fresh lambda
  instanceAStore.clear();
  const resolvedOnAAfterRevoke = await instanceAStore.getAsync(sessionId);
  assert.equal(resolvedOnAAfterRevoke, null, 'Instance A must reject revoked session across instances');
  console.log('  ✓ Distributed revocation verified (Instance B revoke -> Instance A reject)');

  // 3. Multi-instance Cookie Resolution through Request Middleware
  console.log('Testing: Cookie-to-Principal resolution across independent instances...');
  const freshSessionId = generateSessionId();
  const freshCsrf = generateCsrfToken();
  const freshSession: BffServerSession = {
    id: freshSessionId,
    userId: 'usr_cross_lambda_456',
    email: 'crosslambda@example.com',
    name: 'Cross Lambda',
    sessionToken: 'sess_cross_lambda_xyz',
    jwt: 'test.jwt.crosslambda',
    jwtExpiresAt: now + 600_000,
    csrfToken: freshCsrf,
    createdAt: now,
    expiresAt: now + 3600_000,
    lastRotatedAt: now
  };

  await instanceAStore.setAsync(freshSession);

  const serializedCookie = serializeBffToken(freshSession);
  const mockReqInstanceB = {
    headers: {
      cookie: `${BFF_COOKIE_NAME_DEV}=${encodeURIComponent(serializedCookie)}`
    }
  } as any;

  const sessionOnBFromCookie = await readBffSessionFromCookieAsync(mockReqInstanceB);
  assert(sessionOnBFromCookie !== null, 'readBffSessionFromCookieAsync must resolve across instances');
  assert.equal(sessionOnBFromCookie?.userId, 'usr_cross_lambda_456');
  assert.equal(sessionOnBFromCookie?.csrfToken, freshCsrf);
  console.log('  ✓ Cookie-to-Principal resolution verified across simulated independent lambdas');

  // 4. Clean up test table
  await db('bff_sessions').delete();
  await db.destroy();

  console.log('\nALL DISTRIBUTED MULTI-INSTANCE BFF SESSION CHECKS PASSED!\n');
}

runDistributedSessionTests().catch(err => {
  console.error('Distributed session test failure:', err);
  process.exit(1);
});
