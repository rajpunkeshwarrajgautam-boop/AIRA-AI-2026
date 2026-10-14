import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

type JwtHeader = { alg?: string; kid?: string; typ?: string };
type JwtPayload = { sub?: string; iss?: string; exp?: number; iat?: number; nbf?: number; [key: string]: unknown };
type PublicJwk = JsonWebKey & { kid?: string; alg?: string; use?: string };
type Jwks = { keys: PublicJwk[] };

export type ManagedPrincipal = {
  userId: string;
  sessionId: string;
  provider: 'neon_auth';
  email?: string;
  name?: string;
};

let cachedKeys: Jwks | null = null;
let cacheExpiresAt = 0;

function parseSegment<T>(segment: string): T {
  if (!/^[A-Za-z0-9_-]+$/.test(segment) || segment.length > 8192) {
    throw new Error('INVALID_NEON_AUTH_JWT');
  }
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as T;
}

function authConfig() {
  const base = process.env.NEON_AUTH_BASE_URL;
  const jwks = process.env.NEON_AUTH_JWKS_URL;
  if (!base || !jwks) throw new Error('NEON_AUTH_NOT_CONFIGURED');
  const authUrl = new URL(base);
  const jwksUrl = new URL(jwks);
  if (authUrl.protocol !== 'https:' || jwksUrl.protocol !== 'https:' ||
      jwksUrl.origin !== authUrl.origin ||
      !jwksUrl.pathname.endsWith('/.well-known/jwks.json') ||
      authUrl.username || authUrl.password || jwksUrl.username || jwksUrl.password ||
      jwksUrl.search || jwksUrl.hash) {
    throw new Error('INVALID_NEON_AUTH_ENDPOINT');
  }
  return { issuer: authUrl.origin, jwksUrl };
}

async function loadJwks(jwksUrl: URL): Promise<Jwks> {
  const now = Date.now();
  if (cachedKeys && now < cacheExpiresAt) return cachedKeys;
  const response = await fetch(jwksUrl, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(7000),
    headers: { Accept: 'application/json' }
  });
  if (!response.ok) throw new Error('NEON_AUTH_JWKS_UNAVAILABLE');
  const length = Number(response.headers.get('content-length') || '0');
  if (length > 100_000) throw new Error('NEON_AUTH_JWKS_TOO_LARGE');
  const raw = await response.text();
  if (raw.length > 100_000) throw new Error('NEON_AUTH_JWKS_TOO_LARGE');
  const body = JSON.parse(raw) as Jwks;
  if (!Array.isArray(body.keys) || body.keys.length < 1 || body.keys.length > 20) {
    throw new Error('NEON_AUTH_JWKS_INVALID');
  }
  cachedKeys = body;
  cacheExpiresAt = Date.now() + 3 * 60_000;
  return body;
}

/**
 * Verify Neon Auth JWTs before converting them to AIRA's ExecutionPrincipal.
 * The JWT subject comes ONLY from the verified cryptographic payload.
 */
export async function verifyNeonAuthToken(token: string): Promise<ManagedPrincipal> {
  if (typeof token !== 'string' || token.length > 8192) throw new Error('INVALID_NEON_AUTH_JWT');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('INVALID_NEON_AUTH_JWT');
  const header = parseSegment<JwtHeader>(parts[0]);
  const payload = parseSegment<JwtPayload>(parts[1]);
  const allowed = header.alg === 'EdDSA' || header.alg === 'RS256';
  if (!allowed || typeof header.kid !== 'string' || header.kid.length > 200) {
    throw new Error('INVALID_NEON_AUTH_JWT_HEADER');
  }
  const { issuer, jwksUrl } = authConfig();
  const publicKeys = await loadJwks(jwksUrl);
  const jwk = publicKeys.keys.find(k => k.kid === header.kid &&
    (k.use === undefined || k.use === 'sig') &&
    (k.alg === undefined || k.alg === header.alg));
  if (!jwk) throw new Error('NEON_AUTH_SIGNING_KEY_NOT_FOUND');
  const key = createPublicKey({ key: jwk, format: 'jwk' });
  const data = Buffer.from(parts[0] + '.' + parts[1]);
  const signature = Buffer.from(parts[2], 'base64url');
  const valid = verifySignature(header.alg === 'EdDSA' ? null : 'RSA-SHA256',
    data, key, signature);
  if (!valid) throw new Error('INVALID_NEON_AUTH_JWT_SIGNATURE');

  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== issuer ||
      typeof payload.sub !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(payload.sub) ||
      !Number.isInteger(payload.exp) || payload.exp! <= now ||
      !Number.isInteger(payload.iat) || payload.iat! > now + 60 ||
      (payload.nbf !== undefined && (!Number.isInteger(payload.nbf) || payload.nbf > now + 60))) {
    throw new Error('INVALID_NEON_AUTH_JWT_CLAIMS');
  }
  if (payload.is_anonymous === true || payload.isAnonymous === true) {
    throw new Error('NEON_ANONYMOUS_TOKEN_NOT_ACCOUNT_IDENTITY');
  }

  return {
    userId: 'neon_user_' + payload.sub,
    sessionId: 'neon_session_' + createHash('sha256').update(token).digest('hex').slice(0, 24),
    provider: 'neon_auth',
    email: typeof payload.email === 'string' ? payload.email : undefined,
    name: typeof payload.name === 'string' ? payload.name : undefined
  };
}

/**
 * Optional staging-only bearer-token identity. When disabled, existing
 * first-party signed-cookie sessions retain their original behavior.
 *
 * Invalid bearer credentials are never downgraded to anonymous cookie access.
 */
export function createNeonAuthPrincipalMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (process.env.AIRA_EXTERNAL_AUTH_ENABLED !== 'true') return next();
    const auth = req.headers.authorization;
    if (!auth) return next();
    if (!/^Bearer\s+\S+$/i.test(auth)) {
      res.status(401).json({ error: 'Invalid managed authentication credential' });
      return;
    }
    try {
      const identity = await verifyNeonAuthToken(auth.replace(/^Bearer\s+/i, ''));
      (req as any).managedIdentity = identity;
      (req as any).user = {
        id: identity.userId,
        sessionId: identity.sessionId,
        roles: ['workspace_user'],
        scopes: ['chat:write', 'runs:read', 'runs:write', 'browser.read', 'files.read']
      };
      next();
    } catch {
      res.status(401).json({ error: 'Invalid or expired managed authentication credential' });
    }
  };
}
