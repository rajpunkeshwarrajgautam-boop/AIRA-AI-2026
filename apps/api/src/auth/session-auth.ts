import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const SESSION_COOKIE = 'aira_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const SESSION_REFRESH_WINDOW_SECONDS = 60 * 60 * 24 * 7;

interface SessionPayload {
  v: 1;
  uid: string;
  sid: string;
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

function encodePayload(payload: SessionPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function signPayload(encodedPayload: string): string {
  return createHmac('sha256', getSessionSecret())
    .update(encodedPayload)
    .digest('base64url');
}

function serializeToken(payload: SessionPayload): string {
  const encodedPayload = encodePayload(payload);
  return `${encodedPayload}.${signPayload(encodedPayload)}`;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};

  return cookieHeader.split(';').reduce<Record<string, string>>((cookies, part) => {
    const separator = part.indexOf('=');
    if (separator <= 0) return cookies;

    const key = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();
    try {
      cookies[key] = decodeURIComponent(rawValue);
    } catch {
      cookies[key] = rawValue;
    }
    return cookies;
  }, {});
}

function readSessionPayload(req: Request): SessionPayload | null {
  const token = parseCookieHeader(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;

  const separator = token.lastIndexOf('.');
  if (separator <= 0) return null;

  const encodedPayload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expectedSignature = signPayload(encodedPayload);
  if (!safeEqual(signature, expectedSignature)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as SessionPayload;
    const now = Math.floor(Date.now() / 1000);

    if (
      payload.v !== 1 ||
      typeof payload.uid !== 'string' ||
      !payload.uid ||
      typeof payload.sid !== 'string' ||
      !payload.sid ||
      !Number.isInteger(payload.iat) ||
      !Number.isInteger(payload.exp) ||
      payload.iat > now + 60 ||
      payload.exp <= now
    ) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

function attachUser(req: Request, payload: SessionPayload): void {
  (req as any).user = {
    id: payload.uid,
    sessionId: payload.sid,
    roles: ['workspace_user'],
    scopes: ['chat:write', 'runs:read', 'runs:write', 'browser.read', 'files.read'],
  };
}

function setSessionCookie(res: Response, payload: SessionPayload): void {
  const token = serializeToken(payload);
  const secure = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${SESSION_TTL_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax',
  ];

  if (secure) attributes.push('Secure');
  res.setHeader('Set-Cookie', attributes.join('; '));
}

function clearSessionCookie(res: Response): void {
  const secure = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
  const attributes = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
  ];

  if (secure) attributes.push('Secure');
  res.setHeader('Set-Cookie', attributes.join('; '));
}

function createSessionPayload(): SessionPayload {
  const now = Math.floor(Date.now() / 1000);
  return {
    v: 1,
    uid: `user_${randomUUID()}`,
    sid: `session_${randomUUID()}`,
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
  };
}

export function createSessionAuthMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    if ((req as any).user?.id && (req as any).user?.sessionId) {
      next();
      return;
    }

    const hasSessionCookie = Boolean(parseCookieHeader(req.headers.cookie)[SESSION_COOKIE]);
    const payload = readSessionPayload(req);

    if (payload) {
      attachUser(req, payload);
    } else if (hasSessionCookie) {
      clearSessionCookie(res);
    }

    next();
  };
}

export function ensureAuthenticatedSession(req: Request, res: Response) {
  let payload = readSessionPayload(req);
  const now = Math.floor(Date.now() / 1000);

  if (!payload) {
    payload = createSessionPayload();
    setSessionCookie(res, payload);
  } else if (payload.exp - now <= SESSION_REFRESH_WINDOW_SECONDS) {
    payload = {
      ...payload,
      iat: now,
      exp: now + SESSION_TTL_SECONDS,
    };
    setSessionCookie(res, payload);
  }

  attachUser(req, payload);

  return {
    userId: payload.uid,
    sessionId: payload.sid,
    expiresAt: payload.exp * 1000,
  };
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;
