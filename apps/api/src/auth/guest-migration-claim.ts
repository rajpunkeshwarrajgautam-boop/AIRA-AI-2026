import { isGuestPrincipal } from '../../../../packages/contracts/src/index.js';
import { SESSION_COOKIE_NAME, verifySessionToken } from './session-auth.js';

export type GuestMigrationClaim =
  | { ok: true; guestPrincipalId: string; guestSessionId: string; targetPrincipalId: string }
  | { ok: false; httpStatus: 400 | 401 | 403; code: string };

/**
 * A client-provided guest principal is never proof of ownership.
 * Only the environment-bound HMAC-signed guest cookie can authorize a transfer.
 */
export function verifyGuestMigrationClaim(input: {
  cookieHeader?: string;
  authenticatedPrincipalId?: string | null;
  claimedGuestToken?: unknown;
  claimedGuestUserId?: unknown;
}): GuestMigrationClaim {
  const targetPrincipalId = input.authenticatedPrincipalId;
  if (!targetPrincipalId || targetPrincipalId === 'anonymous' || isGuestPrincipal(targetPrincipalId)) {
    return { ok: false, httpStatus: 401, code: 'AUTHENTICATION_REQUIRED' };
  }
  const cookies = (input.cookieHeader || '').split(';').map(c => c.trim());
  const signedCookie = cookies.find(part => part.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!signedCookie) return { ok: false, httpStatus: 400, code: 'INVALID_GUEST_SESSION' };
  let token: string;
  try {
    token = decodeURIComponent(signedCookie.slice(SESSION_COOKIE_NAME.length + 1));
  } catch {
    return { ok: false, httpStatus: 400, code: 'INVALID_GUEST_SESSION' };
  }
  const guest = verifySessionToken(token);
  if (!guest || !isGuestPrincipal(guest.uid)) {
    return { ok: false, httpStatus: 400, code: 'INVALID_GUEST_SESSION' };
  }
  if ((input.claimedGuestToken !== undefined && input.claimedGuestToken !== guest.uid) ||
      (input.claimedGuestUserId !== undefined && input.claimedGuestUserId !== guest.uid)) {
    return { ok: false, httpStatus: 403, code: 'GUEST_SESSION_OWNERSHIP_MISMATCH' };
  }
  return { ok: true, guestPrincipalId: guest.uid, guestSessionId: guest.sid, targetPrincipalId };
}
