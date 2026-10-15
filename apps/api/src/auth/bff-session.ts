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
import { verifyNeonAuthToken, ManagedPrincipal } from './neon-auth-principal.js';

export const BFF_COOKIE_NAME_PROD = '__Host-aira_auth_session';
export const BFF_COOKIE_NAME_DEV = 'aira_auth_session';
export const BFF_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export interface BffServerSession {
  id: string; // Opaque 256-bit session ID
  userId: string;
  email?: string;
  name?: string;
  sessionToken: string; // Better Auth session token (server-side only)
  jwt: string; // EdDSA JWT (server-side only)
  jwtExpiresAt: number;
  csrfToken: string; // Per-session cryptographic CSRF token
  createdAt: number;
  expiresAt: number;
  lastRotatedAt: number;
}

// Retained for backward-compatible test fixtures if needed
export type BffSessionPayload = BffServerSession;

export class BffSessionStore {
  private sessions = new Map<string, BffServerSession>();

  constructor() {
    // Periodic sweep for expired sessions every 10 minutes
    const timer = setInterval(() => this.pruneExpired(), 10 * 60 * 1000);
    if (timer.unref) timer.unref();
  }

  public get(sessionId: string): BffServerSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (Date.now() >= session.expiresAt) {
      this.sessions.delete(sessionId);
      return null;
    }
    return session;
  }

  public set(session: BffServerSession): void {
    this.sessions.set(session.id, session);
  }

  public delete(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  public clear(): void {
    this.sessions.clear();
  }

  public pruneExpired(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      if (now >= session.expiresAt) {
        this.sessions.delete(id);
      }
    }
  }

  public size(): number {
    return this.sessions.size;
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

  return 'https://ep-empty-field-b36mqqq6.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth';
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
  if (typeof sessionOrId !== 'string') {
    bffSessionStore.set(sessionOrId);
  }
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

export function readBffSessionFromCookie(req: Request): BffServerSession | null {
  const cookies = parseCookies(req.headers.cookie);
  const rawToken = cookies[BFF_COOKIE_NAME_PROD] || cookies[BFF_COOKIE_NAME_DEV];
  if (!rawToken) return null;

  const sessionId = parseSignedSessionId(rawToken);
  if (!sessionId) return null;

  const session = bffSessionStore.get(sessionId);
  if (!session) return null;

  return session;
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

  res.setHeader('Set-Cookie', attributes.join('; '));
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

  res.setHeader('Set-Cookie', headers);
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
  if (!custom) return TRUSTED_ORIGINS_DEFAULT;
  const list = custom.split(',').map(s => s.trim()).filter(Boolean);
  return [...new Set([...TRUSTED_ORIGINS_DEFAULT, ...list])];
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
    // If neither Origin nor Referer is present, block unless sec-fetch-site confirms same-origin
    if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'same-site') {
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
async function fetchNeonJwtFromServer(sessionToken: string): Promise<{ token: string; expiresAt: number }> {
  const baseUrl = getAuthBaseUrl();
  const res = await fetch(`${baseUrl}/token`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${sessionToken}`,
      'Content-Type': 'application/json'
    }
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

    const session = readBffSessionFromCookie(req);
    if (!session) {
      return next();
    }

    try {
      let jwtToVerify = session.jwt;

      // Proactive JWT refresh if within 60 seconds of expiration
      if (session.jwtExpiresAt - Date.now() < 60_000) {
        try {
          const fresh = await fetchNeonJwtFromServer(session.sessionToken);
          session.jwt = fresh.token;
          session.jwtExpiresAt = fresh.expiresAt;
          session.lastRotatedAt = Date.now();
          bffSessionStore.set(session);
          jwtToVerify = fresh.token;
        } catch {
          // If refresh fails, try verifying existing JWT before rejecting
        }
      }

      const identity: ManagedPrincipal = await verifyNeonAuthToken(jwtToVerify);

      // Mutual consistency check: verify that JWT subject matches the server-side session's userId
      const expectedSubject = identity.userId.replace(/^neon_user_/, '');
      if (expectedSubject !== session.userId && identity.userId !== session.userId) {
        console.warn(`[BffSession] CRITICAL: JWT subject mismatch! JWT sub=${identity.userId}, Session userId=${session.userId}`);
        bffSessionStore.delete(session.id);
        clearBffSessionCookie(res);
        return next();
      }

      (req as any).managedIdentity = identity;
      (req as any).user = {
        id: identity.userId,
        sessionId: identity.sessionId || session.id,
        roles: ['workspace_user'],
        scopes: ['chat:write', 'runs:read', 'runs:write', 'browser.read', 'files.read']
      };
      (req as any).bffSession = session;

      next();
    } catch (err: any) {
      console.warn('[BffSession] Invalid or expired BFF cookie session:', err?.message || err);
      bffSessionStore.delete(session.id);
      clearBffSessionCookie(res);
      next();
    }
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
  const upstreamRes = await fetch(`${baseUrl}/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: String(email).trim(), password: String(password) })
  });

  if (!upstreamRes.ok) {
    const err = await upstreamRes.json().catch(() => ({ message: 'Sign in failed' }));
    res.status(upstreamRes.status).json({ error: err.message || 'Authentication rejected' });
    return;
  }

  const data = await upstreamRes.json();
  const sessionToken = data.token;
  const user = data.user;

  // Obtain initial EdDSA JWT
  const { token: jwt, expiresAt: jwtExpiresAt } = await fetchNeonJwtFromServer(sessionToken);

  const sessionId = generateSessionId();
  const csrfToken = generateCsrfToken();
  const now = Date.now();

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

  bffSessionStore.set(session);
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
  const upstreamRes = await fetch(`${baseUrl}/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

  const data = await upstreamRes.json();
  const sessionToken = data.token;
  const user = data.user;

  const { token: jwt, expiresAt: jwtExpiresAt } = await fetchNeonJwtFromServer(sessionToken);

  const sessionId = generateSessionId();
  const csrfToken = generateCsrfToken();
  const now = Date.now();

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

  bffSessionStore.set(session);
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
 * BFF Endpoint: GET /api/auth/session
 */
export function handleBffSession(req: Request, res: Response): void {
  const session = readBffSessionFromCookie(req);
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
      name: session.name
    },
    csrfToken: session.csrfToken
  });
}

/**
 * BFF Endpoint: POST /api/auth/sign-out
 */
export async function handleBffSignOut(req: Request, res: Response): Promise<void> {
  const session = readBffSessionFromCookie(req);
  if (!verifyCsrfAndOrigin(req, session)) {
    res.status(403).json({ error: 'CSRF validation failed: missing origin or anti-CSRF token' });
    return;
  }

  clearBffSessionCookie(res);

  if (session) {
    bffSessionStore.delete(session.id);
    try {
      const baseUrl = getAuthBaseUrl();
      await fetch(`${baseUrl}/sign-out`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.sessionToken}`,
          'Content-Type': 'application/json'
        }
      });
    } catch (err) {
      console.warn('[BffSignOut] Remote signout notice:', err);
    }
  }

  res.status(200).json({ success: true });
}
