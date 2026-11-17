/**
 * Independent, observed staging logout/revocation proof.
 * No PASS can be produced from a prior ledger or a pre-filled boolean.
 */
export interface ObservedLogoutProof {
  principalMatched: boolean;
  providerMatched: boolean;
  authenticatedBefore: boolean;
  oldCookieAuthorizedBefore: boolean;
  signOutStatus: number;
  anonymousAfter: boolean;
  oldCookieRejectedAfter: boolean;
}

export function hasObservedLogoutRevocation(proof: unknown): proof is ObservedLogoutProof {
  if (!proof || typeof proof !== 'object') return false;
  const p = proof as Partial<ObservedLogoutProof>;
  return p.principalMatched === true
    && p.providerMatched === true
    && p.authenticatedBefore === true
    && p.oldCookieAuthorizedBefore === true
    && p.signOutStatus === 200
    && p.anonymousAfter === true
    && p.oldCookieRejectedAfter === true;
}
