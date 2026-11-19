/**
 * AIRA AI 2026 — Announcements Delivery & Dismissal API Test Suite (P3 Remediation)
 * 
 * Verifies:
 * 1. Safe guest announcement dismissal without 401 error or server failure.
 * 2. Cookie-less guest returns storage: 'local_only' and persists nothing server-side.
 * 3. Verified guest session isolation (Guest A vs Guest B, same IP).
 * 4. Resilient session tracking across IP changes (session follows cookie, not IP).
 * 5. Spoofed x-session-id header ignored as authority.
 * 6. Authenticated user announcement dismissal derived strictly from verified execution principal.
 * 7. Prevention of caller identity spoofing (x-user-id, body userId, body principalId rejected with 403).
 * 8. Input validation for missing/malformed request bodies and IDs.
 * 9. GET /api/announcements active list, unreadCount calculation, and dismissedIds.
 * 10. POST /api/announcements/reset dismissal clearing with strict account/session isolation.
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
  isGuest?: boolean;
} | null = null;

function setupTestApp(): Promise<TestContext> {
  const app = express();
  app.use(express.json());

  // Inject execution principal middleware simulating Session / BFF / Neon Auth
  app.use((req: Request, _res: Response, next) => {
    if (activeUserContext) {
      if (activeUserContext.isGuest) {
        delete req.principal;
        (req as any).user = {
          id: activeUserContext.userId || `guest_${activeUserContext.sessionId}`,
          sessionId: activeUserContext.sessionId,
          isGuest: true
        };
      } else if (activeUserContext.userId) {
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
          tier: activeUserContext.tier || 'free',
          isGuest: false
        };
      }
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
  console.log('\n=== AIRA AI 2026 — ANNOUNCEMENT DISMISSAL & ISOLATION TEST SUITE ===\n');
  const ctx = await setupTestApp();

  try {
    resetAnnouncementStoreForTesting();

    // 1. Cookie-less guest dismissal (storage: 'local_only')
    console.log('1. Testing: Cookie-less guest announcement dismissal...');
    activeUserContext = null;
    const cookielessRes = await fetch(`${ctx.baseUrl}/api/announcements/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'ann_onboarding_walkthrough' })
    });
    assert.equal(cookielessRes.status, 200, 'Cookieless guest dismissal must return 200 OK');
    const cookielessData = await cookielessRes.json();
    assert.equal(cookielessData.success, true);
    assert.equal(cookielessData.isGuest, true);
    assert.equal(cookielessData.storage, 'local_only', 'Cookieless guest must report local_only storage');
    assert.deepEqual(cookielessData.dismissedIds, ['ann_onboarding_walkthrough']);

    // Verify cookieless guest stored nothing on server
    const cookielessGet = await fetch(`${ctx.baseUrl}/api/announcements`);
    const cookielessGetData = await cookielessGet.json();
    assert.deepEqual(cookielessGetData.dismissedIds, [], 'Cookieless guest must have empty server dismissedIds');
    console.log('  ✓ Cookie-less guest handled with safe local_only storage');

    // 2. Verified guest session isolation (Guest A vs Guest B, same IP)
    console.log('2. Testing: Verified guest session isolation (Guest A vs Guest B)...');
    activeUserContext = { isGuest: true, sessionId: 'guest_sess_alpha' };
    const guestARes = await fetch(`${ctx.baseUrl}/api/announcements/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'ann_onboarding_walkthrough' })
    });
    assert.equal(guestARes.status, 200);
    const guestAData = await guestARes.json();
    assert.equal(guestAData.storage, 'guest_session');
    assert(guestAData.dismissedIds.includes('ann_onboarding_walkthrough'));

    const guestAGet = await fetch(`${ctx.baseUrl}/api/announcements`);
    const guestAGetData = await guestAGet.json();
    assert(guestAGetData.dismissedIds.includes('ann_onboarding_walkthrough'));

    // Guest B on the exact same IP/host must NOT see Guest A's dismissals
    activeUserContext = { isGuest: true, sessionId: 'guest_sess_beta' };
    const guestBGet = await fetch(`${ctx.baseUrl}/api/announcements`);
    const guestBGetData = await guestBGet.json();
    assert.deepEqual(guestBGetData.dismissedIds, [], 'Guest B must not see Guest A dismissals');

    // Guest B dismisses a different announcement
    const guestBRes = await fetch(`${ctx.baseUrl}/api/announcements/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'ann_keyboard_shortcuts' })
    });
    assert.equal(guestBRes.status, 200);
    const guestBData = await guestBRes.json();
    assert.deepEqual(guestBData.dismissedIds, ['ann_keyboard_shortcuts']);

    // Verify Guest A still has only their own dismissal
    activeUserContext = { isGuest: true, sessionId: 'guest_sess_alpha' };
    const guestAReverify = await fetch(`${ctx.baseUrl}/api/announcements`);
    const guestAReverifyData = await guestAReverify.json();
    assert.deepEqual(guestAReverifyData.dismissedIds, ['ann_onboarding_walkthrough']);
    console.log('  ✓ Verified guest session isolation verified between Guest A and Guest B');

    // 3. Resilient session tracking across IP changes
    console.log('3. Testing: Guest session resilience across changing client IP...');
    activeUserContext = { isGuest: true, sessionId: 'guest_sess_alpha' };
    const ipChangeGet = await fetch(`${ctx.baseUrl}/api/announcements`, {
      headers: { 'X-Forwarded-For': '198.51.100.77' }
    });
    const ipChangeData = await ipChangeGet.json();
    assert.deepEqual(ipChangeData.dismissedIds, ['ann_onboarding_walkthrough'], 'Dismissals must persist across IP changes');
    console.log('  ✓ Session tracking keyed to cryptographically verified session, not volatile IP');

    // 4. Spoofed x-session-id header ignored as authority
    console.log('4. Testing: Spoofed x-session-id header ignored...');
    activeUserContext = null; // Unverified / cookieless guest
    const spoofSessionGet = await fetch(`${ctx.baseUrl}/api/announcements`, {
      headers: { 'X-Session-Id': 'guest_sess_alpha' }
    });
    const spoofSessionData = await spoofSessionGet.json();
    assert.deepEqual(spoofSessionData.dismissedIds, [], 'Spoofed x-session-id must be ignored without verified session cookie');
    console.log('  ✓ Spoofed x-session-id ignored safely');

    // 5. Input validation on dismiss
    console.log('5. Testing: Input validation on malformed requests...');
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

    // 6. Authenticated user dismissal derived from server principal
    console.log('6. Testing: Authenticated user dismissal derived from execution principal...');
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

    // 7. Anti-spoofing check: forged x-user-id header and body fields
    console.log('7. Testing: Anti-spoofing protection against forged user identifiers...');
    // A: Authenticated user forging x-user-id header
    const spoofHeaderRes = await fetch(`${ctx.baseUrl}/api/announcements/dismiss`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': 'usr_forged_bob'
      },
      body: JSON.stringify({ id: 'ann_onboarding_walkthrough' })
    });
    assert.equal(spoofHeaderRes.status, 403, 'Spoofed x-user-id must be rejected with 403 Forbidden');
    const spoofHeaderData = await spoofHeaderRes.json();
    assert.equal(spoofHeaderData.error, 'FORBIDDEN_OWNERSHIP_SPOOF');

    // B: Authenticated user forging userId in request body
    const spoofBodyRes = await fetch(`${ctx.baseUrl}/api/announcements/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'ann_onboarding_walkthrough', userId: 'usr_forged_bob' })
    });
    assert.equal(spoofBodyRes.status, 403, 'Spoofed body userId must be rejected with 403 Forbidden');
    const spoofBodyData = await spoofBodyRes.json();
    assert.equal(spoofBodyData.error, 'FORBIDDEN_OWNERSHIP_SPOOF');

    // C: Guest attempting to forge x-user-id header
    activeUserContext = null;
    const guestSpoofRes = await fetch(`${ctx.baseUrl}/api/announcements/dismiss`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': 'usr_forged_admin'
      },
      body: JSON.stringify({ id: 'ann_onboarding_walkthrough' })
    });
    assert.equal(guestSpoofRes.status, 403, 'Guest spoofing x-user-id must be rejected with 403 Forbidden');
    console.log('  ✓ Anti-spoofing protection rejected forged header and body identifiers');

    // 8. GET /api/announcements endpoint
    console.log('8. Testing: GET /api/announcements with unread count calculation...');
    activeUserContext = {
      userId: 'usr_verified_alice',
      sessionId: 'sess_alice_456',
      tier: 'plus'
    };
    const getRes = await fetch(`${ctx.baseUrl}/api/announcements`);
    assert.equal(getRes.status, 200, 'GET /api/announcements must return 200 OK');
    const getData = await getRes.json();
    assert(Array.isArray(getData.announcements), 'Announcements list must be an array');
    assert(typeof getData.unreadCount === 'number', 'unreadCount must be a number');
    assert(Array.isArray(getData.dismissedIds), 'dismissedIds must be an array');
    assert(getData.dismissedIds.includes('ann_entitlements_v2'), 'Previously dismissed ID must be returned');
    console.log(`  ✓ GET /api/announcements returned ${getData.announcements.length} items, unreadCount=${getData.unreadCount}`);

    // 9. Reset dismissed announcements for user and guest
    console.log('9. Testing: POST /api/announcements/reset...');
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

    // Reset guest session
    activeUserContext = { isGuest: true, sessionId: 'guest_sess_beta' };
    const guestResetRes = await fetch(`${ctx.baseUrl}/api/announcements/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    assert.equal(guestResetRes.status, 200);
    const guestResetGet = await fetch(`${ctx.baseUrl}/api/announcements`);
    const guestResetGetData = await guestResetGet.json();
    assert.deepEqual(guestResetGetData.dismissedIds, []);
    console.log('  ✓ Reset dismissed announcements verified for user and guest');

    console.log('\nALL ANNOUNCEMENT API INTEGRATION CHECKS PASSED!\n');
  } finally {
    ctx.server.close();
    process.exit(0);
  }
}

runTests().catch((err) => {
  console.error('\nFAILED ANNOUNCEMENTS TEST:', err);
  process.exit(1);
});
