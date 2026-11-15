import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import { issueSessionToken, SESSION_COOKIE_NAME } from '../apps/api/src/auth/session-auth.js';
import { verifyGuestMigrationClaim } from '../apps/api/src/auth/guest-migration-claim.js';

const user1 = 'neon_user_workspace_v3_account1';
const user2 = 'neon_user_workspace_v3_account2';
const guestId = 'guest_workspace_v3_signed';
const guestSession = 'session_workspace_v3_signed';

before(() => { process.env.AIRA_SESSION_SECRET = 'test-only-workspace-v3-guest-claim-key-' + 'a'.repeat(48); });

const cookieFor = (principal: string, session: string) => {
  const { token } = issueSessionToken({ uid: principal, sid: session });
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`;
};

describe('Workspace V3 guest migration ownership', () => {
  it('accepts a valid signed guest cookie and real authenticated principal', () => {
    const verified = verifyGuestMigrationClaim({
      cookieHeader: cookieFor(guestId, guestSession),
      authenticatedPrincipalId: user1,
      claimedGuestToken: guestId,
    });
    assert.deepEqual(verified, {
      ok: true,
      guestPrincipalId: guestId,
      guestSessionId: guestSession,
      targetPrincipalId: user1,
    });
  });

  it('rejects missing or forged signed guest cookies', () => {
    assert.equal(verifyGuestMigrationClaim({ authenticatedPrincipalId: user1 }).ok, false);
    const forged = cookieFor(guestId, guestSession).replace(/.$/, 'X');
    assert.deepEqual(verifyGuestMigrationClaim({ cookieHeader: forged, authenticatedPrincipalId: user1 }), {
      ok: false, httpStatus: 400, code: 'INVALID_GUEST_SESSION',
    });
  });

  it('rejects guest or anonymous target identities', () => {
    for (const principal of ['guest_forged', 'anonymous', '']) {
      assert.deepEqual(verifyGuestMigrationClaim({
        cookieHeader: cookieFor(guestId, guestSession),
        authenticatedPrincipalId: principal,
      }), { ok: false, httpStatus: 401, code: 'AUTHENTICATION_REQUIRED' });
    }
  });

  it('rejects mismatched guest-token AND guest-user-id claims', () => {
    for (const key of ['claimedGuestToken', 'claimedGuestUserId'] as const) {
      assert.deepEqual(verifyGuestMigrationClaim({
        cookieHeader: cookieFor(guestId, guestSession),
        authenticatedPrincipalId: user1,
        [key]: 'guest_other_person',
      }), { ok: false, httpStatus: 403, code: 'GUEST_SESSION_OWNERSHIP_MISMATCH' });
    }
  });

  it('rejects an authenticated account cookie used as guest ownership proof', () => {
    assert.deepEqual(verifyGuestMigrationClaim({
      cookieHeader: cookieFor(user2, guestSession),
      authenticatedPrincipalId: user1,
    }), { ok: false, httpStatus: 400, code: 'INVALID_GUEST_SESSION' });
  });
});
