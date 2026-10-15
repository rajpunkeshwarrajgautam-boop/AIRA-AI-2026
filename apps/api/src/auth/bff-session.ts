/**
 * AIRA AI 2026 — First-Party Backend-for-Frontend (BFF) Session Security Gateway
 * 
 * Implements production-grade first-party session management for Neon Managed Better Auth:
 * - Issues HttpOnly, Secure, SameSite=Lax first-party session cookies (__Host-aira_auth_session / aira_auth_session).
 * - Shields browser JavaScript from raw long-lived session bearer credentials (mitigates XSS exfiltration).
 * - Enforces CSRF & Origin protection on all state-changing authentication routes.
 * - Bridges cookie sessions to verified ExecutionPrincipal (neon_user_<id>) across all /api/* routes.
 * - Supports seamless server-side token rotation, remote revocation, and guest-to-account linking.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { verifyNeonAuthToken, ManagedPrincipal } from './neon-auth-principal.js';

export const BFF_COOKIE_NAME_PROD = '__Host-aira_auth_session';
export const BFF_COOKIE_NAME_DEV = 'aira_auth_session';
export const BFF_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export interface BffSessionPayload {
  v: 1;
  sessionToken: string;
  userId: string;
  email?: string;
  name?: string;
  jwt: string;
  jwtExpiresAt: number;
  iat: number;
  exp: number;
}

function getSessionSecret(): string {
  const configured = process.env.AIRA_SESSION_SECRET?.trim();
  if (configured && configured.length >= 32) return configured;

  if (process.env.NODE_ENV === 'production') {
    throw new Error('AIRA_SESSION_SECRET must be configured with at least 32 characters in production');
  }

  return 'aira-development-session-secret-change-before-production';
}

function getAuthBaseUrl(): string {
  return process.env.NEON_AUTH_BASE_URL || 'https://ep-empty-field-b36mqqq6.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth';
}

function encodePayload(payload: BffSessionPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function signPayload(encodedPayload: string): string {
  return createHmac('sha256', getSessionSecret())
    .update(encodedPayload)
    .digest('base64url');
}

export function serializeBffToken(payload: BffSessionPayload): string {
  const encodedPayload = encodePayload(payload);
  return `${encodedPayload}.${signPayload(encodedPayload)}`;
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

export function readBffSessionFromCookie(req: Request): BffSessionPayload | null {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[BFF_COOKIE_NAME_PROD] || cookies[BFF_COOKIE_NAME_DEV];
  if (!token) return null;

  const idx = token.lastIndexOf('.');
  if (idx <= 0) return null;

  const encodedPayload = token.slice(0, idx);
  const signature = token.slice(idx + 1);
  const expectedSig = signPayload(encodedPayload);
  if (!safeEqual(signature, expectedSig)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as BffSessionPayload;
    const now = Math.floor(Date.now() / 1000);

    if (
      payload.v !== 1 ||
      !payload.sessionToken ||
      !payload.userId ||
      !payload.jwt ||
      !Number.isInteger(payload.exp) ||
      payload.exp <= now
    ) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

export function setBffSessionCookie(res: Response, payload: BffSessionPayload): void {
  const isSecure = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
  const cookieName = isSecure ? BFF_COOKIE_NAME_PROD : BFF_COOKIE_NAME_DEV;
  const token = serializeBffToken(payload);

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

/**
 * CSRF and Origin protection validator for state-changing BFF requests.
 */
export function verifyCsrfAndOrigin(req: Request): boolean {
  // Safe read-only methods don't require CSRF checks
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return true;
  }

  // 1. Explicit anti-CSRF header protection (standard for SPA clients)
  if (req.headers['x-aira-csrf-protection'] === '1' || req.headers['x-requested-with'] === 'XMLHttpRequest') {
    return true;
  }

  // 2. Browser Sec-Fetch-Site assertion
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite === 'same-origin' || fetchSite === 'same-site') {
    return true;
  }

  // 3. Origin or Referer domain validation
  const origin = (req.headers.origin as string) || (req.headers.referer as string);
  if (origin) {
    try {
      const parsed = new URL(origin);
      const host = parsed.host;
      const expectedHost = req.headers.host;
      if (host === expectedHost || host === 'localhost:5173' || host === '127.0.0.1:5173') {
        return true;
      }
    } catch {
      return false;
    }
  }

  return false;
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

    const payload = readBffSessionFromCookie(req);
    if (!payload) {
      return next();
    }

    try {
      let jwtToVerify = payload.jwt;

      // Proactive JWT refresh if within 60 seconds of expiration
      if (payload.jwtExpiresAt - Date.now() < 60_000) {
        try {
          const fresh = await fetchNeonJwtFromServer(payload.sessionToken);
          payload.jwt = fresh.token;
          payload.jwtExpiresAt = fresh.expiresAt;
          setBffSessionCookie(res, payload);
          jwtToVerify = fresh.token;
        } catch {
          // If refresh fails, try verifying existing JWT before rejecting
        }
      }

      const identity: ManagedPrincipal = await verifyNeonAuthToken(jwtToVerify);

      (req as any).managedIdentity = identity;
      (req as any).user = {
        id: identity.userId,
        sessionId: identity.sessionId,
        roles: ['workspace_user'],
        scopes: ['chat:write', 'runs:read', 'runs:write', 'browser.read', 'files.read']
      };
      (req as any).bffSession = payload;

      next();
    } catch (err: any) {
      console.warn('[BffSession] Invalid or expired BFF cookie session:', err?.message || err);
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

  const now = Math.floor(Date.now() / 1000);
  const payload: BffSessionPayload = {
    v: 1,
    sessionToken,
    userId: user.id,
    email: user.email,
    name: user.name,
    jwt,
    jwtExpiresAt,
    iat: now,
    exp: now + BFF_SESSION_TTL_SECONDS
  };

  setBffSessionCookie(res, payload);

  // Return ONLY public user profile to browser JavaScript (zero session tokens exposed!)
  res.status(200).json({
    status: 'AUTHENTICATED',
    user: {
      id: user.id,
      email: user.email,
      name: user.name
    }
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

  const now = Math.floor(Date.now() / 1000);
  const payload: BffSessionPayload = {
    v: 1,
    sessionToken,
    userId: user.id,
    email: user.email,
    name: user.name,
    jwt,
    jwtExpiresAt,
    iat: now,
    exp: now + BFF_SESSION_TTL_SECONDS
  };

  setBffSessionCookie(res, payload);

  res.status(200).json({
    status: 'AUTHENTICATED',
    user: {
      id: user.id,
      email: user.email,
      name: user.name
    }
  });
}

/**
 * BFF Endpoint: GET /api/auth/session
 */
export function handleBffSession(req: Request, res: Response): void {
  const payload = readBffSessionFromCookie(req);
  res.setHeader('Cache-Control', 'no-store');

  if (!payload) {
    res.status(200).json({ status: 'ANONYMOUS', user: null });
    return;
  }

  res.status(200).json({
    status: 'AUTHENTICATED',
    user: {
      id: payload.userId,
      email: payload.email,
      name: payload.name
    }
  });
}

/**
 * BFF Endpoint: POST /api/auth/sign-out
 */
export async function handleBffSignOut(req: Request, res: Response): Promise<void> {
  if (!verifyCsrfAndOrigin(req)) {
    res.status(403).json({ error: 'CSRF validation failed: missing origin or anti-CSRF header' });
    return;
  }

  const payload = readBffSessionFromCookie(req);
  clearBffSessionCookie(res);

  if (payload?.sessionToken) {
    try {
      const baseUrl = getAuthBaseUrl();
      await fetch(`${baseUrl}/sign-out`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${payload.sessionToken}`,
          'Content-Type': 'application/json'
        }
      });
    } catch (err) {
      console.warn('[BffSignOut] Remote signout notice:', err);
    }
  }

  res.status(200).json({ success: true });
}
