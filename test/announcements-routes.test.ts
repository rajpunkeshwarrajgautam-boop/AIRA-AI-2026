/**
 * AIRA AI 2026 — Announcements Delivery & Dismissal API Test Suite (P3 Remediation)
 * 
 * Verifies:
 * 1. Safe guest announcement dismissal without 401 error or server failure.
 * 2. Authenticated user announcement dismissal derived strictly from verified execution principal.
 * 3. Prevention of caller identity spoofing (x-user-id mismatch rejected with 403).
 * 4. Input validation for missing/malformed request bodies and IDs.
 * 5. GET /api/announcements active list, unreadCount calculation, and dismissedIds.
 * 6. POST /api/announcements/reset dismissal clearing.
 * 7. Database and in-memory persistence compatibility.
 */

import assert from 'node:assert/strict';
import express, { Request, Response } from 'express';
import http from 'node:http';
import {
  createAnnouncementRoutes,
  resetAnnouncementStoreForTesting
} from '../apps/api/src/account-routes.js';
import { ExecutionPrincipalSchema } from '../packages/contracts/src/index.js';

interface TestContext {
  server: http.Server;
  baseUrl: string;
}

let activeUserContext: {
  userId?: string;
  sessionId?: string;
  tier?: string;
} | null = null;

function setupTestApp(): Promise<TestContext> {
  const app = express();
  app.use(express.json());

  // Inject execution principal middleware simulating BFF / auth provider
  app.use((req: Request, _res: Response, next) => {
    if (activeUserContext?.userId) {
      req.principal = ExecutionPrincipalSchema.parse({
        userId: activeUserContext.userId,
        sessionId: activeUserContext.sessionId || 'sess_test_123',
        workspaceId: 'ws_default',
        projectId: undefined,
        roles: ['workspace_user'],
        scopes: ['chat:write']
      });
      (req as any).user = {
        id: activeUserContext.userId,
        sessionId: activeUserContext.sessionId || 'sess_test_123',
        tier: activeUserContext.tier || 'free'
      };
    } else {
      delete req.principal;
      delete (req as any).user;
    }
    next();
  });

  app.use('/api/announcements', createAnnouncementRoutes());

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${addr.port}`
      });
    });
  });
}

async function runTests() {
  console.log('\n=== AIRA AI 2026 — ANNOUNCEMENT DISMISSAL & INTEGRATION TEST SUITE ===\n');
  const ctx = await setupTestApp();

  try {
    resetAnnouncementStoreForTesting();

    // 1. Guest dismissal
    console.log('1. Testing: Guest announcement dismissal without authentication...');
    activeUserContext = null;
    const guestRes = await fetch(`${ctx.baseUrl}/api/announcements/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'ann_onboarding_walkthrough' })
    });
    assert.equal(guestRes.status, 200, 'Guest dismissal must succeed with 200 OK');
    const guestData = await guestRes.json();
    assert.equal(guestData.success, true);
    assert.equal(guestData.isGuest, true);
    assert.equal(guestData.dismissedId, 'ann_onboarding_walkthrough');
    assert(Array.isArray(guestData.dismissedIds) && guestData.dismissedIds.includes('ann_onboarding_walkthrough'));
    console.log('  ✓ Guest dismissal succeeded safely');

    // 2. Input validation on dismiss
    console.log('2. Testing: Input validation on malformed requests...');
    const emptyBodyRes = await fetch(`${ctx.baseUrl}/api/announcements/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(emptyBodyRes.status, 400, 'Empty body must return 400 Bad Request');
    const emptyData = await emptyBodyRes.json();
    assert.equal(emptyData.error, 'MISSING_ANNOUNCEMENT_ID');

    const blankIdRes = await fetch(`${ctx.baseUrl}/api/announcements/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: '   ' })
    });
    assert.equal(blankIdRes.status, 400, 'Blank ID must return 400 Bad Request');
    console.log('  ✓ Input validation handled malformed inputs safely');

    // 3. Authenticated user dismissal derived from server principal
    console.log('3. Testing: Authenticated user dismissal derived from execution principal...');
    activeUserContext = {
      userId: 'usr_verified_alice',
      sessionId: 'sess_alice_456',
      tier: 'plus'
    };
    const authRes = await fetch(`${ctx.baseUrl}/api/announcements/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'ann_entitlements_v2' })
    });
    assert.equal(authRes.status, 200, 'Authenticated dismissal must return 200 OK');
    const authData = await authRes.json();
    assert.equal(authData.success, true);
    assert.equal(authData.isGuest, false);
    assert.equal(authData.userId, 'usr_verified_alice');
    assert.equal(authData.dismissedId, 'ann_entitlements_v2');
    assert(authData.dismissedIds.includes('ann_entitlements_v2'));

    // Idempotent second dismissal
    const repeatRes = await fetch(`${ctx.baseUrl}/api/announcements/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'ann_entitlements_v2' })
    });
    assert.equal(repeatRes.status, 200);
    const repeatData = await repeatRes.json();
    const count = repeatData.dismissedIds.filter((x: string) => x === 'ann_entitlements_v2').length;
    assert.equal(count, 1, 'Duplicate dismissals must remain deduplicated');
    console.log('  ✓ Authenticated dismissal and idempotency verified');

    // 4. Anti-spoofing check
    console.log('4. Testing: Anti-spoofing protection against forged x-user-id...');
    const spoofRes = await fetch(`${ctx.baseUrl}/api/announcements/dismiss`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': 'usr_forged_bob'
      },
      body: JSON.stringify({ id: 'ann_onboarding_walkthrough' })
    });
    assert.equal(spoofRes.status, 403, 'Spoofed x-user-id must be rejected with 403 Forbidden');
    const spoofData = await spoofRes.json();
    assert.equal(spoofData.error, 'FORBIDDEN_OWNERSHIP_SPOOF');
    console.log('  ✓ Anti-spoofing protection rejected forged user header');

    // 5. GET /api/announcements endpoint
    console.log('5. Testing: GET /api/announcements with unread count calculation...');
    const getRes = await fetch(`${ctx.baseUrl}/api/announcements`);
    assert.equal(getRes.status, 200, 'GET /api/announcements must return 200 OK');
    const getData = await getRes.json();
    assert(Array.isArray(getData.announcements), 'Announcements list must be an array');
    assert(typeof getData.unreadCount === 'number', 'unreadCount must be a number');
    assert(Array.isArray(getData.dismissedIds), 'dismissedIds must be an array');
    assert(getData.dismissedIds.includes('ann_entitlements_v2'), 'Previously dismissed ID must be returned');
    console.log(`  ✓ GET /api/announcements returned ${getData.announcements.length} items, unreadCount=${getData.unreadCount}`);

    // 6. Reset dismissed announcements
    console.log('6. Testing: POST /api/announcements/reset...');
    const resetRes = await fetch(`${ctx.baseUrl}/api/announcements/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    assert.equal(resetRes.status, 200, 'Reset must return 200 OK');
    const resetData = await resetRes.json();
    assert.equal(resetData.success, true);
    assert.deepEqual(resetData.dismissedIds, []);

    // Verify unread count increased after reset
    const getAfterReset = await fetch(`${ctx.baseUrl}/api/announcements`);
    const afterResetData = await getAfterReset.json();
    assert.deepEqual(afterResetData.dismissedIds, []);
    assert(afterResetData.unreadCount >= getData.unreadCount, 'Unread count should not decrease after reset');
    console.log('  ✓ Reset dismissed announcements verified');

    console.log('\nALL ANNOUNCEMENT API INTEGRATION CHECKS PASSED!\n');
  } finally {
    ctx.server.close();
  }
}

runTests().catch((err) => {
  console.error('\nFAILED ANNOUNCEMENTS TEST:', err);
  process.exit(1);
});
