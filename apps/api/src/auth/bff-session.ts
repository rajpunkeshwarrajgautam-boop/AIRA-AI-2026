/**
 * AIRA AI 2026 — First-Party Backend-for-Frontend (BFF) Session Security Gateway
 * 
 * Implements production-grade first-party session management for Neon Managed Better Auth:
 * - Issues opaque 256-bit signed HttpOnly cookies (__Host-aira_auth_session / aira_auth_session).
 * - Backed by server-side session store (BffSessionStore); zero bearer credentials in cookies.
 * - Enforces strict Origin allowlisting and per-session cryptographic CSRF tokens on mutating routes.
 * - Bridges cookie sessions to verified ExecutionPrincipal (neon_user_<id>) across all /api/* routes.
 * - Provides mutual consistency validation between JWT subject, session identity, and ExecutionPrincipal.
 * - Supports seamless server-side token rotation, immediate server revocation, and fail-closed security.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { Knex } from 'knex';
import { db } from '../../../../packages/db/src/index.js';
import { verifyNeonAuthToken, ManagedPrincipal } from './neon-auth-principal.js';
import { directOAuthService, verifyFirstPartyJwt, signFirstPartyJwt, OAuthUserProfile } from './direct-oauth.js';

export const BFF_COOKIE_NAME_PROD = '__Host-aira_auth_session';
export const BFF_COOKIE_NAME_DEV = 'aira_auth_session';
export const BFF_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export interface BffServerSession {
  id: string; // Opaque 256-bit session ID
  userId: string;
  email?: string;
  name?: string;
  sessionToken: string; // Better Auth session token (server-side only)
  upstreamCookie?: string; // Captured upstream Set-Cookie header for verified session continuity
  jwt: string; // EdDSA JWT (server-side only)
  jwtExpiresAt: number;
  csrfToken: string; // Per-session cryptographic CSRF token
  createdAt: number;
  expiresAt: number;
  lastRotatedAt: number;
  revokedAt?: number | null;
}

// Retained for backward-compatible test fixtures if needed
export type BffSessionPayload = BffServerSession;

export class BffSessionStore {
  private client: Knex;
  private timer: NodeJS.Timeout | null = null;
  private memorySessions: Map<string, BffServerSession> = new Map();
  private isMemoryOnly: boolean;

  constructor(customClient?: Knex) {
    this.client = customClient || db;
    this.isMemoryOnly = !Boolean(process.env.DATABASE_URL?.trim()) && !customClient;
    // Periodic sweep for expired sessions every 10 minutes
    this.timer = setInterval(() => {
      this.pruneExpired().catch((err) => {
        console.warn('[BffSessionStore] Periodic prune notice:', err?.message || err);
      });
    }, 10 * 60 * 1000);
    if (this.timer.unref) this.timer.unref();
  }

  public async get(sessionId: string): Promise<BffServerSession | null> {
    if (this.isMemoryOnly) {
      const s = this.memorySessions.get(sessionId);
      if (!s) return null;
      if (s.revokedAt) return null;
      if (s.expiresAt <= Date.now()) {
        this.memorySessions.delete(sessionId);
        return null;
      }
      return { ...s };
    }
    try {
      const row = await this.client('bff_sessions')
        .where({ id: sessionId })
        .whereNull('revoked_at')
        .first();

      if (!row) return null;

      const now = Date.now();
      if (Number(row.expires_at) <= now) {
        // Enforce expiration server-side: purge and return null
        await this.delete(sessionId).catch(() => {});
        return null;
      }

      return this.mapRow(row);
    } catch (err) {
      // Fail closed on database error: unauthorized access must NEVER be granted on DB failure
      console.error('[BffSessionStore] Fail-closed: database error during session lookup:', err);
      return null;
    }
  }

  public async set(session: BffServerSession): Promise<void> {
    if (this.isMemoryOnly) {
      this.memorySessions.set(session.id, { ...session, revokedAt: null });
      return;
    }
    await this.client('bff_sessions')
      .insert({
        id: session.id,
        user_id: session.userId,
        email: session.email || null,
        name: session.name || null,
        session_token: session.sessionToken,
        upstream_cookie: session.upstreamCookie || null,
        jwt: session.jwt,
        jwt_expires_at: session.jwtExpiresAt,
        csrf_token: session.csrfToken,
        created_at: session.createdAt,
        expires_at: session.expiresAt,
        last_rotated_at: session.lastRotatedAt,
        revoked_at: null
      })
      .onConflict('id')
      .merge({
        user_id: session.userId,
        email: session.email || null,
        name: session.name || null,
        session_token: session.sessionToken,
        upstream_cookie: session.upstreamCookie || null,
        jwt: session.jwt,
        jwt_expires_at: session.jwtExpiresAt,
        csrf_token: session.csrfToken,
        expires_at: session.expiresAt,
        last_rotated_at: session.lastRotatedAt,
        revoked_at: null
      });
  }

  public async delete(sessionId: string): Promise<boolean> {
    if (this.isMemoryOnly) {
      const existing = this.memorySessions.get(sessionId);
      if (existing && !existing.revokedAt) {
        existing.revokedAt = Date.now();
        existing.sessionToken = '';
        existing.jwt = '';
        return true;
      }
      return false;
    }
    try {
      const now = Date.now();
      // Zero out tokens and mark revoked so credentials cannot be reconstructed
      const updated = await this.client('bff_sessions')
        .where({ id: sessionId })
        .whereNull('revoked_at')
        .update({
          revoked_at: now,
          session_token: '',
          jwt: ''
        });
      return updated > 0;
    } catch (err) {
      console.error('[BffSessionStore] Error revoking session:', err);
      return false;
    }
  }

  public async revoke(sessionId: string): Promise<boolean> {
    return this.delete(sessionId);
  }

  public async clear(): Promise<void> {
    if (this.isMemoryOnly) {
      this.memorySessions.clear();
      return;
    }
    try {
      await this.client('bff_sessions').delete();
    } catch (err) {
      console.error('[BffSessionStore] Error clearing sessions:', err);
    }
  }

  public async pruneExpired(): Promise<number> {
    if (this.isMemoryOnly) {
      const now = Date.now();
      let pruned = 0;
      for (const [id, s] of this.memorySessions.entries()) {
        if (s.expiresAt <= now || s.revokedAt) {
          this.memorySessions.delete(id);
          pruned++;
        }
      }
      return pruned;
    }
    try {
      const now = Date.now();
      const count = await this.client('bff_sessions')
        .where('expires_at', '<=', now)
        .orWhereNotNull('revoked_at')
        .delete();
      return count;
    } catch (err) {
      console.error('[BffSessionStore] Error pruning expired sessions:', err);
      return 0;
    }
  }

  public async size(): Promise<number> {
    if (this.isMemoryOnly) {
      const now = Date.now();
      let count = 0;
      for (const s of this.memorySessions.values()) {
        if (!s.revokedAt && s.expiresAt > now) {
          count++;
        }
      }
      return count;
    }
    try {
      const now = Date.now();
      const rows = await this.client('bff_sessions')
        .whereNull('revoked_at')
        .where('expires_at', '>', now)
        .count({ count: '*' });
      return Number(rows[0]?.count || 0);
    } catch {
      return 0;
    }
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private mapRow(row: any): BffServerSession {
    return {
      id: row.id,
      userId: row.user_id,
      email: row.email || undefined,
      name: row.name || undefined,
      sessionToken: row.session_token,
      upstreamCookie: row.upstream_cookie || undefined,
      jwt: row.jwt,
      jwtExpiresAt: Number(row.jwt_expires_at),
      csrfToken: row.csrf_token,
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      lastRotatedAt: Number(row.last_rotated_at),
      revokedAt: row.revoked_at ? Number(row.revoked_at) : null
    };
  }
}

export const bffSessionStore = new BffSessionStore();

function getSessionSecret(): string {
  const configured = process.env.AIRA_SESSION_SECRET?.trim();
  if (configured && configured.length >= 32) return configured;

  if (process.env.NODE_ENV === 'production') {
    throw new Error('AIRA_SESSION_SECRET must be configured with at least 32 characters in production');
  }

  return 'aira-development-session-secret-change-before-production';
}

function getAuthBaseUrl(): string {
  const configured = process.env.NEON_AUTH_BASE_URL?.trim();
  if (configured) return configured;

  if (process.env.NODE_ENV === 'production') {
    throw new Error('NEON_AUTH_BASE_URL is unconfigured in production environment. Refusing to fallback to staging URL.');
  }

  return 'https://ep-ancient-sound-b3drtnp5.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth';
}

export function generateSessionId(): string {
  return randomBytes(32).toString('base64url');
}

export function generateCsrfToken(): string {
  return randomBytes(32).toString('hex');
}

export function signSessionId(sessionId: string): string {
  return createHmac('sha256', getSessionSecret())
    .update(sessionId)
    .digest('base64url');
}

export function serializeBffToken(sessionOrId: BffServerSession | string): string {
  const id = typeof sessionOrId === 'string' ? sessionOrId : sessionOrId.id;
  return `${id}.${signSessionId(id)}`;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  return cookieHeader.split(';').reduce<Record<string, string>>((acc, part) => {
    const idx = part.indexOf('=');
    if (idx <= 0) return acc;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    try {
      acc[key] = decodeURIComponent(val);
    } catch {
      acc[key] = val;
    }
    return acc;
  }, {});
}

export function parseSignedSessionId(cookieValue: string | undefined): string | null {
  if (!cookieValue) return null;
  const idx = cookieValue.lastIndexOf('.');
  if (idx <= 0) return null;

  const sessionId = cookieValue.slice(0, idx);
  const signature = cookieValue.slice(idx + 1);
  const expectedSig = signSessionId(sessionId);

  if (!safeEqual(signature, expectedSig)) {
    return null;
  }
  return sessionId;
}

export async function readBffSessionFromCookie(req: Request): Promise<BffServerSession | null> {
  const cookies = parseCookies(req.headers.cookie);
  const rawToken = cookies[BFF_COOKIE_NAME_PROD] || cookies[BFF_COOKIE_NAME_DEV];
  if (!rawToken) return null;

  const sessionId = parseSignedSessionId(rawToken);
  if (!sessionId) return null;

  const session = await bffSessionStore.get(sessionId);
  if (!session) return null;

  return session;
}

export const BFF_FLOW_COOKIE_NAME_PROD = '__Host-aira_oauth_flow';
export const BFF_FLOW_COOKIE_NAME_DEV = 'aira_oauth_flow';

function appendSetCookieHeader(res: Response, cookieHeaders: string | string[]): void {
  const toAdd = Array.isArray(cookieHeaders) ? cookieHeaders : [cookieHeaders];
  const existing = typeof res?.getHeader === 'function' ? res.getHeader('Set-Cookie') : undefined;
  if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, ...toAdd]);
  } else if (typeof existing === 'string') {
    res.setHeader('Set-Cookie', [existing, ...toAdd]);
  } else {
    res.setHeader('Set-Cookie', toAdd.length === 1 ? toAdd[0] : toAdd);
  }
}

export function setBffSessionCookie(res: Response, sessionOrId: BffServerSession | string): void {
  const isSecure = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
  const cookieName = isSecure ? BFF_COOKIE_NAME_PROD : BFF_COOKIE_NAME_DEV;
  const token = serializeBffToken(sessionOrId);

  const attributes = [
    `${cookieName}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${BFF_SESSION_TTL_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax'
  ];

  if (isSecure) {
    attributes.push('Secure');
  }

  appendSetCookieHeader(res, attributes.join('; '));
}

export function clearBffSessionCookie(res: Response): void {
  const isSecure = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
  const cookieNames = [BFF_COOKIE_NAME_PROD, BFF_COOKIE_NAME_DEV];

  const headers = cookieNames.map((name) => {
    const attributes = [
      `${name}=`,
      'Path=/',
      'Max-Age=0',
      'HttpOnly',
      'SameSite=Lax'
    ];
    if (isSecure) attributes.push('Secure');
    return attributes.join('; ');
  });

  appendSetCookieHeader(res, headers);
}

export function setBffOAuthFlowCookie(res: Response, flowId: string, timestamp: number): void {
  const isSecure = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
  const cookieName = isSecure ? BFF_FLOW_COOKIE_NAME_PROD : BFF_FLOW_COOKIE_NAME_DEV;
  const payload = `${flowId}:${timestamp}`;
  const signature = signSessionId(payload);
  const cookieVal = `${payload}.${signature}`;

  const attributes = [
    `${cookieName}=${encodeURIComponent(cookieVal)}`,
    'Path=/',
    'Max-Age=900',
    'HttpOnly',
    'SameSite=Lax'
  ];
  if (isSecure) {
    attributes.push('Secure');
  }

  appendSetCookieHeader(res, attributes.join('; '));
}

export function parseBffOAuthFlowCookie(req: Request): { flowId: string; timestamp: number } | null {
  const cookies = parseCookies(req.headers.cookie);
  const rawToken = cookies[BFF_FLOW_COOKIE_NAME_PROD] || cookies[BFF_FLOW_COOKIE_NAME_DEV];
  if (!rawToken) return null;

  const idx = rawToken.lastIndexOf('.');
  if (idx <= 0) return null;

  const payload = rawToken.slice(0, idx);
  const signature = rawToken.slice(idx + 1);
  const expectedSig = signSessionId(payload);

  if (!safeEqual(signature, expectedSig)) {
    return null;
  }

  const parts = payload.split(':');
  if (parts.length !== 2) return null;

  const flowId = parts[0];
  const timestamp = Number(parts[1]);
  if (!flowId || !Number.isFinite(timestamp)) return null;

  const now = Date.now();
  if (now - timestamp > 15 * 60 * 1000 || timestamp > now + 60_000) {
    return null;
  }

  return { flowId, timestamp };
}

export function clearBffOAuthFlowCookie(res: Response): void {
  const isSecure = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
  const cookieNames = [BFF_FLOW_COOKIE_NAME_PROD, BFF_FLOW_COOKIE_NAME_DEV];

  const headers = cookieNames.map((name) => {
    const attributes = [
      `${name}=`,
      'Path=/',
      'Max-Age=0',
      'HttpOnly',
      'SameSite=Lax'
    ];
    if (isSecure) attributes.push('Secure');
    return attributes.join('; ');
  });

  appendSetCookieHeader(res, headers);
}

const TRUSTED_ORIGINS_DEFAULT = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3001'
];

export function getTrustedOrigins(): string[] {
  const custom = process.env.ALLOWED_ORIGINS || process.env.CORS_ORIGIN;
  const vercelUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null;
  const vercelBranchUrl = process.env.VERCEL_BRANCH_URL ? `https://${process.env.VERCEL_BRANCH_URL}` : null;
  const defaults = [...TRUSTED_ORIGINS_DEFAULT];
  if (vercelUrl) defaults.push(vercelUrl);
  if (vercelBranchUrl) defaults.push(vercelBranchUrl);
  if (!custom) return defaults;
  const list = custom.split(',').map(s => s.trim()).filter(Boolean);
  return [...new Set([...defaults, ...list])];
}

export function isAllowedOrigin(originStr: string, hostHeader?: string): boolean {
  try {
    const parsed = new URL(originStr);
    const originHost = parsed.host;
    if (hostHeader && originHost === hostHeader) {
      return true;
    }
    const originNormalized = `${parsed.protocol}//${parsed.host}`;
    const allowed = getTrustedOrigins();
    return allowed.some(a => {
      try {
        const p = new URL(a);
        return `${p.protocol}//${p.host}` === originNormalized;
      } catch {
        return a === originNormalized;
      }
    });
  } catch {
    return false;
  }
}

/**
 * CSRF and Origin protection validator for state-changing BFF requests.
 * Enforces strict origin matching against allowlist and session-bound CSRF token verification.
 */
export function verifyCsrfAndOrigin(req: Request, session?: BffServerSession | null): boolean {
  // Safe read-only methods don't require CSRF checks
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return true;
  }

  // In dev/test environments, allow direct test harness callers with test principal headers
  const isDevOrTest = !process.env.VERCEL_ENV && (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development');
  if (isDevOrTest && req.headers['x-test-user-id']) {
    return true;
  }

  // Pure Bearer-token callers without cookie sessions are immune to CSRF
  // (browsers never attach custom Authorization headers cross-origin)
  if (!session && typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ')) {
    return true;
  }

  // 1. Fetch Metadata check: reject cross-site requests unconditionally on mutations
  const secFetchSite = req.headers['sec-fetch-site'];
  if (secFetchSite === 'cross-site') {
    return false;
  }

  // 2. Strict Origin / Referer validation:
  // If Origin or Referer is supplied, it MUST match the host or trusted allowlist.
  // Rejection is absolute: mismatched origins fail even if custom headers are present!
  const origin = (req.headers.origin as string) || (req.headers.referer as string);
  const host = req.headers.host;

  if (origin) {
    if (!isAllowedOrigin(origin, host)) {
      return false;
    }
  } else {
    // If neither Origin nor Referer is present, block unless sec-fetch-site explicitly confirms same-origin
    if (!secFetchSite || (secFetchSite !== 'same-origin' && secFetchSite !== 'same-site')) {
      return false;
    }
  }

  // 3. Cryptographic CSRF token verification for authenticated state-changing requests:
  if (session?.csrfToken) {
    const clientToken = (req.headers['x-csrf-token'] as string) || (req.headers['x-aira-csrf-token'] as string);
    if (!clientToken) {
      return false;
    }
    const clientBuf = Buffer.from(clientToken);
    const expectedBuf = Buffer.from(session.csrfToken);
    if (clientBuf.length !== expectedBuf.length || !timingSafeEqual(clientBuf, expectedBuf)) {
      return false;
    }
    return true;
  }

  // 4. For unauthenticated login/signup routes where no session exists yet:
  // Require custom anti-CSRF header or same-origin assertion, with valid origin
  const hasAntiCsrfHeader =
    req.headers['x-aira-csrf-protection'] === '1' ||
    req.headers['x-requested-with'] === 'XMLHttpRequest' ||
    Boolean(req.headers['x-csrf-token']);

  if (!hasAntiCsrfHeader && (!secFetchSite || (secFetchSite !== 'same-origin' && secFetchSite !== 'same-site'))) {
    return false;
  }

  return true;
}

/**
 * Fetch a fresh EdDSA JWT token directly from Neon Auth using server-held session token.
 */
async function fetchNeonJwtFromServer(
  sessionToken: string,
  upstreamCookie?: string,
  origin = 'http://localhost:5173'
): Promise<{ token: string; expiresAt: number }> {
  const baseUrl = getAuthBaseUrl();
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${sessionToken}`,
    'Content-Type': 'application/json',
    'Origin': origin
  };
  if (upstreamCookie) {
    headers['Cookie'] = upstreamCookie;
  }
  const res = await fetch(`${baseUrl}/token`, {
    method: 'GET',
    headers
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Failed to obtain JWT from Neon Auth (${res.status}): ${errText}`);
  }

  const data = await res.json();
  if (!data || typeof data.token !== 'string') {
    throw new Error('Malformed JWT response from Neon Auth');
  }

  let expiresAt = Date.now() + 10 * 60 * 1000;
  try {
    const parts = data.token.split('.');
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (typeof payload.exp === 'number') {
        expiresAt = payload.exp * 1000;
      }
    }
  } catch {
    // Default 10m
  }

  return { token: data.token, expiresAt };
}

/**
 * Middleware: Resolves first-party BFF HttpOnly cookie into verified ExecutionPrincipal.
 * Operates prior to down-stream route handlers, providing zero-token frontend protection.
 */
export function createBffSessionMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    // If bearer token or another principal already set, allow it to continue
    if ((req as any).managedIdentity) {
      return next();
    }

    const session = await readBffSessionFromCookie(req);
    if (!session) {
      const cookies = parseCookies(req.headers.cookie);
      if (cookies[BFF_COOKIE_NAME_PROD] || cookies[BFF_COOKIE_NAME_DEV]) {
        clearBffSessionCookie(res);
        delete (req as any).user;
        delete (req as any).managedIdentity;
        delete (req as any).bffSession;
      }
      return next();
    }

    try {
      let identity: ManagedPrincipal;
      let isFirstParty = false;

      if (session.jwt) {
        try {
          const fp = verifyFirstPartyJwt(session.jwt);
          identity = {
            userId: fp.userId,
            sessionId: session.id,
            provider: 'direct_oauth' as any,
            email: fp.email || session.email,
            name: fp.name || session.name
          };
          isFirstParty = true;
        } catch {
          // Fall through to Neon Auth JWT check
        }
      }

      if (!isFirstParty) {
        let jwtToVerify = session.jwt;

        // Proactive JWT refresh if within 60 seconds of expiration (only if upstream session token exists)
        if (session.sessionToken && session.jwtExpiresAt - Date.now() < 60_000) {
          try {
            const fresh = await fetchNeonJwtFromServer(session.sessionToken, session.upstreamCookie);
            session.jwt = fresh.token;
            session.jwtExpiresAt = fresh.expiresAt;
            session.lastRotatedAt = Date.now();
            await bffSessionStore.set(session);
            jwtToVerify = fresh.token;
          } catch {
            // If refresh fails, try verifying existing JWT before rejecting
          }
        }

        identity = await verifyNeonAuthToken(jwtToVerify);
      }

      // Mutual consistency check: verify that JWT subject matches the server-side session's userId
      const expectedSubject = identity.userId.replace(/^neon_user_/, '');
      if (expectedSubject !== session.userId && identity.userId !== session.userId) {
        console.warn(`[BffSession] CRITICAL: JWT subject mismatch! JWT sub=${identity.userId}, Session userId=${session.userId}`);
        await bffSessionStore.delete(session.id);
        clearBffSessionCookie(res);
        delete (req as any).user;
        delete (req as any).managedIdentity;
        delete (req as any).principal;
        delete (req as any).bffSession;
        return next();
      }

      // Stable principal reconstruction bound to durable session ID
      (req as any).managedIdentity = {
        ...identity,
        sessionId: session.id
      };
      (req as any).user = {
        id: identity.userId,
        sessionId: session.id,
        roles: ['workspace_user'],
        scopes: ['chat:write', 'runs:read', 'runs:write', 'browser.read', 'files.read']
      };
      (req as any).principal = {
        userId: identity.userId,
        sessionId: session.id,
        roles: ['workspace_user'],
        scopes: ['chat:write', 'runs:read', 'runs:write', 'browser.read', 'files.read']
      };
      (req as any).bffSession = session;

      next();
    } catch (err: any) {
      console.warn('[BffSession] Invalid or expired BFF cookie session:', err?.message || err);
      await bffSessionStore.delete(session.id);
      clearBffSessionCookie(res);
      delete (req as any).user;
      delete (req as any).managedIdentity;
      delete (req as any).principal;
      delete (req as any).bffSession;
      next();
    }
  };
}

/**
 * Express middleware for state-changing endpoints (POST, PUT, PATCH, DELETE).
 * Enforces strict origin matching, Fetch Metadata verification, and session-bound CSRF token validation.
 */
export function createCsrfProtectionMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      return next();
    }

    const session = (req as any).bffSession as BffServerSession | undefined;
    if (!verifyCsrfAndOrigin(req, session)) {
      res.status(403).json({ error: 'CSRF validation failed: missing origin or anti-CSRF verification' });
      return;
    }

    next();
  };
}

/**
 * BFF Endpoint: POST /api/auth/sign-in
 */
export async function handleBffSignIn(req: Request, res: Response): Promise<void> {
  if (!verifyCsrfAndOrigin(req)) {
    res.status(403).json({ error: 'CSRF validation failed: missing origin or anti-CSRF header' });
    return;
  }

  const { email, password } = req.body || {};
  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }

  const baseUrl = getAuthBaseUrl();
  const clientOrigin = (req.headers.origin as string) || (req.headers.referer as string) || 'http://localhost:5173';
  const upstreamRes = await fetch(`${baseUrl}/sign-in/email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': clientOrigin
    },
    body: JSON.stringify({ email: String(email).trim(), password: String(password) })
  });

  if (!upstreamRes.ok) {
    const err = await upstreamRes.json().catch(() => ({ message: 'Sign in failed' }));
    res.status(upstreamRes.status).json({ error: err.message || 'Authentication rejected' });
    return;
  }

  const upstreamCookie = upstreamRes.headers.get('set-cookie') || undefined;
  const data = await upstreamRes.json();
  const sessionToken = data.token;
  const user = data.user;

  // Obtain initial EdDSA JWT
  const { token: jwt, expiresAt: jwtExpiresAt } = await fetchNeonJwtFromServer(sessionToken, upstreamCookie, clientOrigin);

  const sessionId = generateSessionId();
  const csrfToken = generateCsrfToken();
  const now = Date.now();

  const session: BffServerSession = {
    id: sessionId,
    userId: user.id,
    email: user.email,
    name: user.name,
    sessionToken,
    upstreamCookie,
    jwt,
    jwtExpiresAt,
    csrfToken,
    createdAt: now,
    expiresAt: now + (BFF_SESSION_TTL_SECONDS * 1000),
    lastRotatedAt: now
  };

  await bffSessionStore.set(session);
  setBffSessionCookie(res, sessionId);

  // Return ONLY public user profile and csrfToken to browser JavaScript (zero session tokens exposed!)
  res.status(200).json({
    status: 'AUTHENTICATED',
    user: {
      id: user.id,
      email: user.email,
      name: user.name
    },
    csrfToken
  });
}

/**
 * BFF Endpoint: POST /api/auth/sign-up
 */
export async function handleBffSignUp(req: Request, res: Response): Promise<void> {
  if (!verifyCsrfAndOrigin(req)) {
    res.status(403).json({ error: 'CSRF validation failed: missing origin or anti-CSRF header' });
    return;
  }

  const { email, password, name } = req.body || {};
  if (!email || !password || !name) {
    res.status(400).json({ error: 'Email, password, and name are required' });
    return;
  }

  const baseUrl = getAuthBaseUrl();
  const clientOrigin = (req.headers.origin as string) || (req.headers.referer as string) || 'http://localhost:5173';
  const upstreamRes = await fetch(`${baseUrl}/sign-up/email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': clientOrigin
    },
    body: JSON.stringify({
      email: String(email).trim(),
      password: String(password),
      name: String(name).trim()
    })
  });

  if (!upstreamRes.ok) {
    const err = await upstreamRes.json().catch(() => ({ message: 'Registration failed' }));
    res.status(upstreamRes.status).json({ error: err.message || 'Registration failed' });
    return;
  }

  const upstreamCookie = upstreamRes.headers.get('set-cookie') || undefined;
  const data = await upstreamRes.json();
  const sessionToken = data.token;
  const user = data.user;

  const { token: jwt, expiresAt: jwtExpiresAt } = await fetchNeonJwtFromServer(sessionToken, upstreamCookie, clientOrigin);

  const sessionId = generateSessionId();
  const csrfToken = generateCsrfToken();
  const now = Date.now();

  const session: BffServerSession = {
    id: sessionId,
    userId: user.id,
    email: user.email,
    name: user.name,
    sessionToken,
    upstreamCookie,
    jwt,
    jwtExpiresAt,
    csrfToken,
    createdAt: now,
    expiresAt: now + (BFF_SESSION_TTL_SECONDS * 1000),
    lastRotatedAt: now
  };

  await bffSessionStore.set(session);
  setBffSessionCookie(res, sessionId);

  res.status(200).json({
    status: 'AUTHENTICATED',
    user: {
      id: user.id,
      email: user.email,
      name: user.name
    },
    csrfToken
  });
}

/**
 * BFF Endpoint: POST /api/auth/oauth-exchange
 * 
 * Bridges an upstream Neon Auth OAuth session (e.g. from Google OAuth) into a first-party
 * signed HttpOnly BFF session cookie (__Host-aira_auth_session / aira_auth_session).
 * 
 * Cryptographically verifies the upstream session token with Neon Auth before issuing the BFF cookie.
 */
export async function handleBffOAuthExchange(req: Request, res: Response): Promise<void> {
  if (!verifyCsrfAndOrigin(req)) {
    res.status(403).json({ error: 'CSRF validation failed: missing origin or anti-CSRF header' });
    return;
  }

  const { sessionToken } = req.body || {};
  if (!sessionToken || typeof sessionToken !== 'string') {
    res.status(400).json({ error: 'Valid sessionToken is required for OAuth exchange' });
    return;
  }

  const baseUrl = getAuthBaseUrl();
  const clientOrigin = (req.headers.origin as string) || (req.headers.referer as string) || 'http://localhost:5173';

  // 1. Verify session token with Neon Auth /get-session
  const upstreamCookie = `__Secure-neon-auth.session_token=${sessionToken}; neon-auth.session_token=${sessionToken}`;
  const verifyRes = await fetch(`${baseUrl}/get-session`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${sessionToken}`,
      'Cookie': upstreamCookie,
      'Origin': clientOrigin
    }
  });

  if (!verifyRes.ok) {
    res.status(401).json({ error: 'Upstream Neon Auth session is invalid or expired' });
    return;
  }

  const verifyData = await verifyRes.json();
  if (!verifyData || !verifyData.user || !verifyData.session) {
    res.status(401).json({ error: 'No active session found for supplied token' });
    return;
  }

  const user = verifyData.user;
  const verifiedSessionToken = verifyData.session.token || sessionToken;

  // 2. Obtain EdDSA signed JWT from Neon Auth to guarantee cryptographic provenance
  const { token: jwt, expiresAt: jwtExpiresAt } = await fetchNeonJwtFromServer(
    verifiedSessionToken,
    upstreamCookie,
    clientOrigin
  );

  // 3. Cryptographically verify the EdDSA JWT against JWKS
  const principal = await verifyNeonAuthToken(jwt);
  const expectedSubject = principal.userId.replace(/^neon_user_/, '');
  if (expectedSubject !== user.id && principal.userId !== user.id) {
    res.status(401).json({ error: 'Cryptographic principal mismatch during OAuth exchange' });
    return;
  }

  // 4. Create first-party BFF session in database and set secure first-party HttpOnly cookie
  const sessionId = generateSessionId();
  const csrfToken = generateCsrfToken();
  const now = Date.now();

  const session: BffServerSession = {
    id: sessionId,
    userId: user.id,
    email: user.email,
    name: user.name,
    sessionToken: verifiedSessionToken,
    upstreamCookie,
    jwt,
    jwtExpiresAt,
    csrfToken,
    createdAt: now,
    expiresAt: now + (BFF_SESSION_TTL_SECONDS * 1000),
    lastRotatedAt: now
  };

  await bffSessionStore.set(session);
  setBffSessionCookie(res, sessionId);

  // 5. Respond with public user profile and csrfToken
  res.status(200).json({
    status: 'AUTHENTICATED',
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      image: user.image || null
    },
    csrfToken
  });
}

function sanitizeUpstreamCookie(cookieStr: string, isProduction: boolean): string {
  // Strip Partitioned attribute for consistent first-party handling
  let s = cookieStr.replace(/;\s*Partitioned/gi, '');
  // Normalize SameSite=None to SameSite=Lax for reliable first-party top-level GET return navigation
  if (/SameSite=None/i.test(s)) {
    s = s.replace(/SameSite=None/gi, 'SameSite=Lax');
  }
  if (isProduction && !/;\s*Secure/i.test(s)) {
    s += '; Secure';
  }
  return s;
}

/**
 * BFF endpoints: /api/auth/oauth/{google|github}/start
 * 
 * Initiates allowlisted Google or GitHub OAuth with Neon Auth from the backend:
 * - Generates an opaque random 192-bit flowId.
 * - Sets a signed HttpOnly first-party state cookie (__Host-aira_oauth_flow / aira_oauth_flow).
 * - Issues upstream /sign-in/social request to Neon Auth with the first-party callback URL:
 *   ${origin}/api/auth/oauth/${provider}/callback?flowId=${flowId}
 * - Forwards upstream __Secure-neon-auth.session_challenge cookies to the client browser.
 * - Returns the provider authorization URL or 302-redirects directly.
 */
type BffOAuthProvider = 'google' | 'github';

export async function handleBffOAuthGoogleStart(req: Request, res: Response): Promise<void> {
  return handleBffOAuthStart(req, res, 'google', 'signin');
}

export async function handleBffOAuthGithubStart(req: Request, res: Response): Promise<void> {
  return handleBffOAuthStart(req, res, 'github', 'signin');
}

export async function handleBffOAuthLinkStart(req: Request, res: Response, provider: BffOAuthProvider): Promise<void> {
  return handleBffOAuthStart(req, res, provider, 'link');
}

async function handleBffOAuthStart(
  req: Request,
  res: Response,
  provider: BffOAuthProvider,
  action: 'signin' | 'link' = 'signin'
): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'POST' && !verifyCsrfAndOrigin(req)) {
    res.status(403).json({ error: 'CSRF validation failed: missing origin or anti-CSRF header' });
    return;
  }

  const isProd = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
  let clientOrigin = (req.headers.origin as string) || (req.headers.referer as string);
  if (clientOrigin) {
    try {
      const u = new URL(clientOrigin);
      clientOrigin = `${u.protocol}//${u.host}`;
    } catch {
      clientOrigin = '';
    }
  }
  if (!clientOrigin || !isAllowedOrigin(clientOrigin, req.headers.host)) {
    if (req.headers.host) {
      const proto = (req.headers['x-forwarded-proto'] as string) || (isProd ? 'https' : 'http');
      clientOrigin = `${proto}://${req.headers.host}`;
    } else {
      clientOrigin = getTrustedOrigins()[0] || 'http://localhost:5173';
    }
  }

  let targetUserId: string | undefined = undefined;
  if (action === 'link') {
    const session = await readBffSessionFromCookie(req);
    if (!session?.userId) {
      res.status(401).json({ error: 'Authentication required to link an account' });
      return;
    }
    targetUserId = session.userId;
  }

  let redirectUrl = '';
  if (provider === 'google') {
    redirectUrl = directOAuthService.createGoogleAuthUrl(clientOrigin, res, isProd, action, targetUserId);
  } else if (provider === 'github') {
    redirectUrl = directOAuthService.createGithubAuthUrl(clientOrigin, res, isProd, action, targetUserId);
  } else {
    res.status(400).json({ error: `Unsupported provider: ${provider}` });
    return;
  }

  if (req.method === 'GET') {
    res.redirect(302, redirectUrl);
    return;
  }

  res.status(200).json({ url: redirectUrl, redirect: true });
}

export async function handleBffOAuthGoogleCallback(req: Request, res: Response): Promise<void> {
  return handleBffOAuthCallback(req, res, 'google');
}

export async function handleBffOAuthGithubCallback(req: Request, res: Response): Promise<void> {
  return handleBffOAuthCallback(req, res, 'github');
}

async function handleBffOAuthCallback(req: Request, res: Response, provider: BffOAuthProvider): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const code = req.query.code as string | undefined;
  const stateQuery = req.query.state as string | undefined;
  const queryFlowId = (req.query.flowId as string | undefined) || stateQuery;
  const errorParam = (req.query.error as string | undefined) || (req.query.error_description as string | undefined);

  const isProd = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
  let clientOrigin = '';
  if (req.headers.host) {
    const proto = (req.headers['x-forwarded-proto'] as string) || (isProd ? 'https' : 'http');
    clientOrigin = `${proto}://${req.headers.host}`;
  }
  if (!clientOrigin || !isAllowedOrigin(clientOrigin, req.headers.host)) {
    clientOrigin = getTrustedOrigins()[0] || 'http://localhost:5173';
  }

  // Handle OAuth provider error (e.g. user cancelled login)
  if (errorParam) {
    console.warn(`[handleBffOAuthCallback] OAuth provider (${provider}) returned error:`, errorParam);
    directOAuthService.clearFlowCookie(res, isProd);
    clearBffOAuthFlowCookie(res);
    res.redirect(302, `${clientOrigin}/?auth_error=${encodeURIComponent(errorParam)}`);
    return;
  }

  // Check test mock session / profile fixtures
  const testMockProfile = (req as any).testMockOAuthProfile as OAuthUserProfile | undefined;
  const testMockSession = (req as any).testMockOAuthSession;

  // Validate state cookie unless test mock is explicitly provided
  const flowState = directOAuthService.parseAndClearFlowState(req, res);
  clearBffOAuthFlowCookie(res);

  if (!flowState && !testMockProfile && !testMockSession) {
    console.warn('[handleBffOAuthCallback] CSRF/State validation failed: missing or expired flow state cookie');
    res.redirect(302, `${clientOrigin}/?auth_error=state_mismatch`);
    return;
  }

  if (flowState && queryFlowId && flowState.flowId !== queryFlowId) {
    console.warn('[handleBffOAuthCallback] Flow ID mismatch:', flowState.flowId, 'vs', queryFlowId);
    res.redirect(302, `${clientOrigin}/?auth_error=state_mismatch`);
    return;
  }

  try {
    let profile: OAuthUserProfile;
    if (testMockProfile) {
      profile = testMockProfile;
    } else if (testMockSession) {
      profile = {
        provider,
        providerAccountId: testMockSession.userId,
        email: testMockSession.email,
        emailVerified: true,
        name: testMockSession.name,
        image: testMockSession.image
      };
    } else {
      if (!code) {
        console.error('[handleBffOAuthCallback] Missing OAuth authorization code');
        res.redirect(302, `${clientOrigin}/?auth_error=missing_code`);
        return;
      }
      if (provider === 'google') {
        profile = await directOAuthService.exchangeGoogleCode(clientOrigin, code, flowState?.codeVerifier || '');
      } else {
        profile = await directOAuthService.exchangeGithubCode(clientOrigin, code);
      }
    }

    // Account Linking flow
    if (flowState?.action === 'link' && flowState.targetUserId) {
      await directOAuthService.linkProviderToExistingUser(flowState.targetUserId, profile);
      res.redirect(302, `${clientOrigin}/?auth_success=linked`);
      return;
    }

    // Resolve or create internal user and link OAuth account
    const { user, isNewUser } = await directOAuthService.resolveOrCreateUser(profile);

    // Mint durable first-party BFF session
    const sessionId = generateSessionId();
    const csrfToken = generateCsrfToken();
    const sessionToken = generateSessionId();
    const now = Date.now();
    const { token: jwt, expiresAt: jwtExpiresAt } = signFirstPartyJwt(user.id, sessionId, user.email, user.name);

    const session: BffServerSession = {
      id: sessionId,
      userId: user.id,
      email: user.email,
      name: user.name,
      sessionToken,
      jwt,
      jwtExpiresAt,
      csrfToken,
      createdAt: now,
      expiresAt: now + (BFF_SESSION_TTL_SECONDS * 1000),
      lastRotatedAt: now
    };
    (session as any).image = user.image;

    await bffSessionStore.set(session);
    setBffSessionCookie(res, sessionId);

    const successParam = isNewUser ? 'signup_complete' : '1';
    res.redirect(302, `${clientOrigin}/?auth_success=${successParam}`);
  } catch (err: any) {
    console.error('[handleBffOAuthCallback] OAuth exchange error:', err?.message || err);
    res.redirect(302, `${clientOrigin}/?auth_error=exchange_failed`);
  }
}

/**
 * BFF Endpoint: GET /api/auth/providers
 * Returns all linked OAuth providers for the currently authenticated user.
 */
export async function handleBffGetProviders(req: Request, res: Response): Promise<void> {
  const session = await readBffSessionFromCookie(req);
  res.setHeader('Cache-Control', 'no-store');

  if (!session?.userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const providers = await directOAuthService.getLinkedProviders(session.userId);
    res.status(200).json({ providers });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to fetch linked providers' });
  }
}

/**
 * BFF Endpoint: POST /api/auth/providers/:provider/unlink
 * Unlinks an OAuth provider from the user's account with lockout prevention.
 */
export async function handleBffUnlinkProvider(req: Request, res: Response): Promise<void> {
  const session = await readBffSessionFromCookie(req);
  res.setHeader('Cache-Control', 'no-store');

  if (!session?.userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  if (!verifyCsrfAndOrigin(req, session)) {
    res.status(403).json({ error: 'CSRF validation failed' });
    return;
  }

  const provider = req.params.provider as 'google' | 'github';
  if (!['google', 'github'].includes(provider)) {
    res.status(400).json({ error: 'Invalid provider' });
    return;
  }

  try {
    await directOAuthService.unlinkProviderFromUser(session.userId, provider);
    res.status(200).json({ success: true, unlinked: provider });
  } catch (err: any) {
    if (err.message === 'CANNOT_UNLINK_LAST_AUTHENTICATION_METHOD') {
      res.status(400).json({ error: 'Cannot unlink your last active login method' });
      return;
    }
    res.status(500).json({ error: err.message || 'Failed to unlink provider' });
  }
}

/**
 * BFF Endpoint: POST /api/auth/recovery/request
 * Submits an audited account recovery ticket when a user loses access to providers.
 */
export async function handleBffRecoveryRequest(req: Request, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const { claimedEmail, provider, contactInfo, details } = req.body || {};

  if (!claimedEmail || typeof claimedEmail !== 'string' || !claimedEmail.includes('@')) {
    res.status(400).json({ error: 'Valid email address is required' });
    return;
  }

  try {
    const result = await directOAuthService.submitRecoveryRequest(
      claimedEmail,
      provider || 'all',
      contactInfo,
      details
    );
    res.status(200).json({
      status: 'RECEIVED',
      message: 'Recovery request logged securely. Support will review cryptographic audit logs and verify account ownership.',
      requestId: result.requestId
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to submit recovery request' });
  }
}

/**
 * BFF Endpoint: GET /api/auth/recovery/guidance
 * Returns recovery links and official guidance for Google and GitHub.
 */
export async function handleBffRecoveryGuidance(req: Request, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const guidance = directOAuthService.getRecoveryGuidance();
  res.status(200).json(guidance);
}

/**
 * BFF Endpoint: GET /api/auth/session
 */
export async function handleBffSession(req: Request, res: Response): Promise<void> {
  const session = await readBffSessionFromCookie(req);
  res.setHeader('Cache-Control', 'no-store');

  if (!session) {
    res.status(200).json({ status: 'ANONYMOUS', user: null });
    return;
  }

  res.status(200).json({
    status: 'AUTHENTICATED',
    user: {
      id: session.userId,
      email: session.email,
      name: session.name,
      image: (session as any).image || null
    },
    csrfToken: session.csrfToken
  });
}

/**
 * BFF Endpoint: POST /api/auth/sign-out
 */
export async function handleBffSignOut(req: Request, res: Response): Promise<void> {
  const session = await readBffSessionFromCookie(req);
  if (!verifyCsrfAndOrigin(req, session)) {
    res.status(403).json({ error: 'CSRF validation failed: missing origin or anti-CSRF token' });
    return;
  }

  clearBffSessionCookie(res);

  if (session) {
    await bffSessionStore.delete(session.id);
    try {
      const baseUrl = getAuthBaseUrl();
      const clientOrigin = (req.headers.origin as string) || (req.headers.referer as string) || 'http://localhost:5173';
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${session.sessionToken}`,
        'Content-Type': 'application/json',
        'Origin': clientOrigin
      };
      if (session.upstreamCookie) {
        headers['Cookie'] = session.upstreamCookie;
      }
      await fetch(`${baseUrl}/sign-out`, {
        method: 'POST',
        headers,
        body: JSON.stringify({})
      });
    } catch (err) {
      console.warn('[BffSignOut] Remote signout notice:', err);
    }
  }

  res.status(200).json({ success: true });
}
