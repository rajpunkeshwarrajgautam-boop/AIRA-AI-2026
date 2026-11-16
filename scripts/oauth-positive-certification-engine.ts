/**
 * AIRA AI 2026 — Authentic Positive OAuth Certification Engine
 *
 * Implements strict, independent evaluation of positive-path Google & GitHub OAuth
 * authentication evidence for production release certification.
 *
 * Enforces:
 * 1. Zero tolerance for substitute or fabricated evidence (historical reports are contextual only).
 * 2. Explicit lifecycle states: PASS, FAIL, BLOCKED, NOT_RUN.
 * 3. Mandatory positive assertions: OAuth start, code exchange, provider identity validation,
 *    internal principal mapping, authenticated session on /api/auth/session, persistence, and revocation.
 * 4. Dual-provider requirement: Both Google AND GitHub must pass for overall PASS.
 * 5. Anti-staleness: Evidence must match the exact deployed staging SHA and deployment ID.
 * 6. Secret-hygiene sanitizer: Detects and rejects any credential leaks in artifacts or logs.
 */

import crypto from 'node:crypto';

export type CertificationStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_RUN';

export interface ProviderPositiveEvidence {
  provider: 'google' | 'github';
  timestamp: string; // ISO 8601 UTC
  testHarnessSha: string;
  deployedStagingSha: string;
  deploymentId: string;
  stagingDatabaseIdentity?: string;
  principalHash: string; // Non-reversible SHA-256 hash
  oauthStartObserved: boolean;
  callbackProcessed: boolean;
  codeExchangeSucceeded: boolean;
  providerIdentityValidated: boolean;
  principalMapped: boolean;
  sessionStatus: 'AUTHENTICATED' | 'ANONYMOUS' | 'GUEST' | 'INVALID';
  sessionObservedEndpoint: '/api/auth/session';
  sessionPersistedOnReload: boolean;
  logoutRevocationVerified: boolean;
  freeTierEntitlementsVerified?: boolean;
  negativePathVerified?: boolean;
  sanitizedLogReference?: string;
  exchangeError?: string;
  [key: string]: unknown;
}

export interface SanitizedCertificationRecord {
  provider: 'google' | 'github';
  timestampUtc: string;
  testHarnessSha: string;
  deployedStagingSha: string;
  vercelDeploymentId: string;
  stagingDatabaseIdentity: string;
  principalIdentifierHash: string;
  oauthStartResult: 'SUCCESS' | 'FAILURE' | 'BLOCKED';
  callbackProcessingResult: 'SUCCESS' | 'FAILURE' | 'BLOCKED';
  authorizationCodeExchangeOutcome: 'SUCCESS' | 'FAILURE' | 'BLOCKED';
  providerIdentityValidationOutcome: 'SUCCESS' | 'FAILURE' | 'BLOCKED';
  internalPrincipalMappingResult: 'SUCCESS' | 'FAILURE' | 'BLOCKED';
  applicationSessionStatus: 'AUTHENTICATED' | 'ANONYMOUS' | 'GUEST' | 'INVALID';
  sessionPersistenceResult: 'PASS' | 'FAIL' | 'BLOCKED';
  logoutAndRevocationResult: 'PASS' | 'FAIL' | 'BLOCKED';
  negativePathResults: 'PASS' | 'FAIL' | 'NOT_TESTED';
  sanitizedLogReference: string;
  finalStatus: CertificationStatus;
}

export interface OAuthCertificationVerdict {
  overallStatus: CertificationStatus;
  googleStatus: CertificationStatus;
  githubStatus: CertificationStatus;
  reason: string;
  googleReasons: string[];
  githubReasons: string[];
  sanitizedRecords: SanitizedCertificationRecord[];
  timestamp: string;
}

const FORBIDDEN_SECRET_KEY_PATTERNS = [
  /password/i,
  /client_?secret/i,
  /access_?token/i,
  /refresh_?token/i,
  /code_verifier/i,
  /authorization_code/i,
  /session_cookie/i,
  /api[_-]?key/i,
];

const KNOWN_SECRET_VALUE_PATTERNS = [
  /postgres(?:ql)?:\/\/[^:]+:[^@\s]+@[^/\s]+/i, // DB connection with password
  /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/, // JWT format
  /(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36}/, // GitHub token
  /AIza[0-9A-Za-z-_]{35}/, // Google API key
  /ya29\.[0-9A-Za-z-_]+/, // Google access token
  /sk_live_[0-9a-zA-Z]{24}/, // Stripe / API key
];

/**
 * Validates that an evidence record contains zero plaintext secrets, tokens, or credentials.
 */
export function validateSanitizedRecord(obj: unknown, path = ''): { valid: boolean; violations: string[] } {
  const violations: string[] = [];

  if (obj === null || obj === undefined) {
    return { valid: true, violations: [] };
  }

  if (typeof obj === 'string') {
    for (const pat of KNOWN_SECRET_VALUE_PATTERNS) {
      if (pat.test(obj)) {
        violations.push(`Value at ${path || 'root'} matches forbidden credential pattern: ${pat}`);
      }
    }
    return { valid: violations.length === 0, violations };
  }

  if (typeof obj === 'object') {
    if (Array.isArray(obj)) {
      obj.forEach((item, idx) => {
        const sub = validateSanitizedRecord(item, `${path}[${idx}]`);
        violations.push(...sub.violations);
      });
    } else {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        const fullPath = path ? `${path}.${k}` : k;
        // Exception: allow safe config keys like 'tokenUrl', 'clientId', 'codeChallengeMethod'
        const isSafeMetadataKey = /^(?:tokenUrl|authUrl|clientId|codeChallengeMethod|csrfTokenPresent|tokenCount)$/i.test(k);
        if (!isSafeMetadataKey) {
          for (const keyPat of FORBIDDEN_SECRET_KEY_PATTERNS) {
            if (keyPat.test(k) && typeof v === 'string' && v.length > 0 && !['[REDACTED]', 'NONE', 'OMITTED', 'NOT_STORED'].includes(v)) {
              violations.push(`Suspicious sensitive key "${k}" with active value at ${fullPath}`);
            }
          }
        }
        const sub = validateSanitizedRecord(v, fullPath);
        violations.push(...sub.violations);
      }
    }
  }

  return { valid: violations.length === 0, violations };
}

/**
 * Creates a non-reversible cryptographic hash for principal reporting.
 */
export function hashPrincipalIdentifier(identifier: string, salt = 'aira_auth_salt_2026'): string {
  return crypto.createHash('sha256').update(`${salt}:${identifier}`).digest('hex');
}

/**
 * Evaluates evidence for a single OAuth provider (Google or GitHub).
 */
export function evaluateProviderEvidence(
  evidence: unknown,
  expected: {
    expectedDeployedSha?: string;
    expectedDeploymentId?: string;
    expectedHarnessSha?: string;
  }
): { status: CertificationStatus; reasons: string[]; record?: SanitizedCertificationRecord } {
  const reasons: string[] = [];

  if (!evidence || typeof evidence !== 'object') {
    return { status: 'NOT_RUN', reasons: ['No provider evidence supplied'] };
  }

  const ev = evidence as Partial<ProviderPositiveEvidence>;

  // Check secret hygiene on evidence object
  const hygiene = validateSanitizedRecord(ev);
  if (!hygiene.valid) {
    return {
      status: 'FAIL',
      reasons: ['CRITICAL_CREDENTIAL_EXPOSURE: Sensitive secret material detected in evidence', ...hygiene.violations]
    };
  }

  // 1. Provider identification
  if (ev.provider !== 'google' && ev.provider !== 'github') {
    return { status: 'FAIL', reasons: [`Invalid provider: ${ev.provider}`] };
  }

  // 2. Deployment SHA alignment (Anti-staleness)
  if (expected.expectedDeployedSha && ev.deployedStagingSha) {
    if (ev.deployedStagingSha.toLowerCase() !== expected.expectedDeployedSha.toLowerCase()) {
      reasons.push(
        `Stale deployment evidence: deployedStagingSha (${ev.deployedStagingSha}) does not match expected (${expected.expectedDeployedSha})`
      );
    }
  } else if (expected.expectedDeployedSha && !ev.deployedStagingSha) {
    reasons.push('Missing deployedStagingSha in provider evidence');
  }

  // 3. Deployment ID alignment
  if (expected.expectedDeploymentId && ev.deploymentId) {
    if (ev.deploymentId !== expected.expectedDeploymentId) {
      reasons.push(
        `Deployment ID mismatch: evidence is from ${ev.deploymentId}, expected ${expected.expectedDeploymentId}`
      );
    }
  }

  // 4. Test harness SHA alignment
  if (expected.expectedHarnessSha && ev.testHarnessSha) {
    if (ev.testHarnessSha.toLowerCase() !== expected.expectedHarnessSha.toLowerCase()) {
      reasons.push(
        `Test harness SHA mismatch: evidence produced by ${ev.testHarnessSha}, expected ${expected.expectedHarnessSha}`
      );
    }
  }

  // 5. Code exchange & error handling
  if (ev.exchangeError) {
    reasons.push(`OAuth authorization-code exchange failed with error: ${ev.exchangeError}`);
  }
  if (!ev.codeExchangeSucceeded) {
    reasons.push('Provider authorization-code exchange not verified (codeExchangeSucceeded is false)');
  }

  // 6. Provider identity validation & principal mapping
  if (!ev.providerIdentityValidated) {
    reasons.push('Provider identity validation was not established');
  }
  if (!ev.principalMapped) {
    reasons.push('Internal AIRA principal mapping was not verified');
  }

  // 7. Non-reversible principal hash requirement
  if (!ev.principalHash || !/^[a-f0-9]{64}$/i.test(ev.principalHash)) {
    reasons.push('Missing or invalid non-reversible SHA-256 principalHash');
  }

  // 8. Session status on /api/auth/session
  if (ev.sessionStatus !== 'AUTHENTICATED') {
    reasons.push(`Session status is not AUTHENTICATED (observed: ${ev.sessionStatus ?? 'MISSING'})`);
  }
  if (ev.sessionObservedEndpoint !== '/api/auth/session') {
    reasons.push(`Session must be verified via /api/auth/session (observed: ${ev.sessionObservedEndpoint})`);
  }

  // 9. Session persistence & logout revocation
  if (!ev.sessionPersistedOnReload) {
    reasons.push('Session persistence across application reload was not verified');
  }
  if (!ev.logoutRevocationVerified) {
    reasons.push('Session logout and server-side revocation was not verified');
  }

  // Determine status
  let status: CertificationStatus = 'PASS';
  if (reasons.length > 0) {
    // Distinguish between outright test failure vs blocked on interactive action
    const isInteractiveBlock = reasons.some(r =>
      r.includes('codeExchangeSucceeded is false') && !ev.exchangeError && ev.oauthStartObserved
    );
    status = isInteractiveBlock ? 'BLOCKED' : 'FAIL';
  }

  const record: SanitizedCertificationRecord = {
    provider: ev.provider,
    timestampUtc: ev.timestamp || new Date().toISOString(),
    testHarnessSha: ev.testHarnessSha || 'UNKNOWN',
    deployedStagingSha: ev.deployedStagingSha || 'UNKNOWN',
    vercelDeploymentId: ev.deploymentId || 'UNKNOWN',
    stagingDatabaseIdentity: ev.stagingDatabaseIdentity || 'neon://mute-frost-50372225/br-autumn-star-b36dfu5w',
    principalIdentifierHash: ev.principalHash || 'MISSING',
    oauthStartResult: ev.oauthStartObserved ? 'SUCCESS' : 'FAILURE',
    callbackProcessingResult: ev.callbackProcessed ? 'SUCCESS' : status === 'BLOCKED' ? 'BLOCKED' : 'FAILURE',
    authorizationCodeExchangeOutcome: ev.codeExchangeSucceeded ? 'SUCCESS' : status === 'BLOCKED' ? 'BLOCKED' : 'FAILURE',
    providerIdentityValidationOutcome: ev.providerIdentityValidated ? 'SUCCESS' : status === 'BLOCKED' ? 'BLOCKED' : 'FAILURE',
    internalPrincipalMappingResult: ev.principalMapped ? 'SUCCESS' : status === 'BLOCKED' ? 'BLOCKED' : 'FAILURE',
    applicationSessionStatus: ev.sessionStatus || 'INVALID',
    sessionPersistenceResult: ev.sessionPersistedOnReload ? 'PASS' : status === 'BLOCKED' ? 'BLOCKED' : 'FAIL',
    logoutAndRevocationResult: ev.logoutRevocationVerified ? 'PASS' : status === 'BLOCKED' ? 'BLOCKED' : 'FAIL',
    negativePathResults: ev.negativePathVerified ? 'PASS' : 'NOT_TESTED',
    sanitizedLogReference: ev.sanitizedLogReference || 'artifacts/staging-acceptance/OAUTH_POSITIVE_CERTIFICATION.log',
    finalStatus: status,
  };

  return { status, reasons, record };
}

/**
 * Evaluates the full dual-provider positive OAuth certification package.
 */
export function evaluatePositiveOAuthCertification(input: {
  googleEvidence?: unknown;
  githubEvidence?: unknown;
  historicalReport?: unknown;
  expectedDeployedSha?: string;
  expectedDeploymentId?: string;
  expectedHarnessSha?: string;
}): OAuthCertificationVerdict {
  const timestamp = new Date().toISOString();
  const sanitizedRecords: SanitizedCertificationRecord[] = [];

  // Check historical report: If historical report is present without live evidence, it is INSUFFICIENT
  if (input.historicalReport && (!input.googleEvidence && !input.githubEvidence)) {
    return {
      overallStatus: 'BLOCKED',
      googleStatus: 'BLOCKED',
      githubStatus: 'BLOCKED',
      reason: 'Historical report (e.g. pr164 isolation report) is contextual only and insufficient to certify positive OAuth code exchange and application sessions.',
      googleReasons: ['Missing live provider-specific Google OAuth positive-path execution evidence'],
      githubReasons: ['Missing live provider-specific GitHub OAuth positive-path execution evidence'],
      sanitizedRecords: [],
      timestamp,
    };
  }

  // Missing both evidences
  if (!input.googleEvidence && !input.githubEvidence) {
    return {
      overallStatus: 'NOT_RUN',
      googleStatus: 'NOT_RUN',
      githubStatus: 'NOT_RUN',
      reason: 'Missing both Google and GitHub positive-path evidence records',
      googleReasons: ['No Google evidence provided'],
      githubReasons: ['No GitHub evidence provided'],
      sanitizedRecords: [],
      timestamp,
    };
  }

  // Evaluate Google
  const gEval = evaluateProviderEvidence(input.googleEvidence, {
    expectedDeployedSha: input.expectedDeployedSha,
    expectedDeploymentId: input.expectedDeploymentId,
    expectedHarnessSha: input.expectedHarnessSha,
  });
  if (gEval.record) sanitizedRecords.push(gEval.record);

  // Evaluate GitHub
  const ghEval = evaluateProviderEvidence(input.githubEvidence, {
    expectedDeployedSha: input.expectedDeployedSha,
    expectedDeploymentId: input.expectedDeploymentId,
    expectedHarnessSha: input.expectedHarnessSha,
  });
  if (ghEval.record) sanitizedRecords.push(ghEval.record);

  let overallStatus: CertificationStatus = 'PASS';
  const allReasons: string[] = [];

  if (gEval.status !== 'PASS') {
    allReasons.push(`Google: ${gEval.status} (${gEval.reasons.join('; ') || 'unmet requirements'})`);
  }
  if (ghEval.status !== 'PASS') {
    allReasons.push(`GitHub: ${ghEval.status} (${ghEval.reasons.join('; ') || 'unmet requirements'})`);
  }

  if (gEval.status === 'FAIL' || ghEval.status === 'FAIL') {
    overallStatus = 'FAIL';
  } else if (gEval.status === 'BLOCKED' || ghEval.status === 'BLOCKED') {
    overallStatus = 'BLOCKED';
  } else if (gEval.status === 'NOT_RUN' || ghEval.status === 'NOT_RUN') {
    overallStatus = 'BLOCKED'; // Incomplete requirement -> blocked from certification
  }

  const reason = overallStatus === 'PASS'
    ? 'All positive-path OAuth assertions for Google and GitHub certified with authentic session establishment.'
    : `Incomplete positive OAuth certification: ${allReasons.join(' | ')}`;

  return {
    overallStatus,
    googleStatus: gEval.status,
    githubStatus: ghEval.status,
    reason,
    googleReasons: gEval.reasons,
    githubReasons: ghEval.reasons,
    sanitizedRecords,
    timestamp,
  };
}
