import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { resolveDeploymentEnvironment, type DeploymentEnvironment } from '../../../../packages/contracts/src/deployment-environment.js';

export const SESSION_COOKIE_NAME = 'aira_session';
export const SESSION_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
export const SESSION_REFRESH_WINDOW_SECONDS = 60 * 60 * 24 * 7;
const SESSION_ISSUER = 'aira-session';
const SESSION_AUDIENCE = 'aira-api';

type SessionPayloadV2 = {
  v: 2;
  iss: typeof SESSION_ISSUER;
  aud: typeof SESSION_AUDIENCE;
  env: DeploymentEnvironment;
  uid: string;
  sid: string;
  iat: number;
  exp: number;
};

type LegacySessionPayloadV1 = {
  v: 1;
  uid: string;
  sid: string;
  iat: number;
  exp: number;
};

type VerifiedSessionPayload = SessionPayloadV2 | (LegacySessionPayloadV1 & { legacyV1: true });

function getSessionSecret(): string {
  const configured = process.env.AIRA_SESSION_SECRET?.trim();
  if (!configured || configured.length < 32) {
    throw new Error('AIRA_SESSION_SECRET must be configured with at least 32 characters.');
  }
  return configured;
}

function encodePayload(payload: SessionPayloadV2 | LegacySessionPayloadV1): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function signPayload(encodedPayload: string): string {
  return createHmac('sha256', getSessionSecret()).update(encodedPayload).digest('base64url');
}

function serializeToken(payload: SessionPayloadV2): string {
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

export function parseGuestV1GraceDeadline(value: string | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const deadline = Date.parse(value);
  return Number.isFinite(deadline) && new Date(deadline).toISOString() === value ? deadline : null;
}

function legacyV1Allowed(environment: DeploymentEnvironment, nowSeconds: number): boolean {
  // Compatibility is opt-in, Production-only, and bounded by a fixed UTC cutoff.
  if (environment !== 'production' || process.env.AIRA_SESSION_ACCEPT_LEGACY_V1 !== 'true') return false;
  const deadline = parseGuestV1GraceDeadline(process.env.AIRA_SESSION_ACCEPT_LEGACY_V1_UNTIL);
  return deadline !== null && nowSeconds * 1000 < deadline;
}

export function issueSessionToken(
  input: { uid: string; sid: string; nowSeconds?: number; ttlSeconds?: number }
): { token: string; payload: SessionPayloadV2 } {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const environment = resolveDeploymentEnvironment();
  const ttlSeconds = input.ttlSeconds ?? SESSION_TOKEN_TTL_SECONDS;
  const payload: SessionPayloadV2 = {
    v: 2,
    iss: SESSION_ISSUER,
    aud: SESSION_AUDIENCE,
    env: environment,
    uid: input.uid,
    sid: input.sid,
    iat: now,
    exp: now + ttlSeconds
  };
  return { token: serializeToken(payload), payload };
}

export function verifySessionToken(
  token: string,
  options: { nowSeconds?: number } = {}
): VerifiedSessionPayload | null {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const separator = token.lastIndexOf('.');
  if (separator <= 0) return null;

  try {
    const encodedPayload = token.slice(0, separator);
    const signature = token.slice(separator + 1);
    const expectedSignature = signPayload(encodedPayload);
    if (!safeEqual(signature, expectedSignature)) return null;

    const parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as Record<string, unknown>;
    const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
    const environment = resolveDeploymentEnvironment();
    const uidIsValid = typeof parsed.uid === 'string' && parsed.uid.length > 0 && parsed.uid.length <= 200;
    const sidIsValid = typeof parsed.sid === 'string' && parsed.sid.length > 0 && parsed.sid.length <= 200;
    const timesAreValid = Number.isInteger(parsed.iat) && Number.isInteger(parsed.exp) &&
      Number(parsed.iat) <= now + 60 && Number(parsed.exp) > now &&
      Number(parsed.exp) > Number(parsed.iat) &&
      Number(parsed.exp) - Number(parsed.iat) <= SESSION_TOKEN_TTL_SECONDS;
    if (!uidIsValid || !sidIsValid || !timesAreValid) return null;

    if (parsed.v === 1) {
      if (!legacyV1Allowed(environment, now)) return null;
      return { ...(parsed as unknown as LegacySessionPayloadV1), legacyV1: true };
    }

    if (
      parsed.v !== 2 ||
      parsed.iss !== SESSION_ISSUER ||
      parsed.aud !== SESSION_AUDIENCE ||
      parsed.env !== environment
    ) return null;

    return parsed as unknown as SessionPayloadV2;
  } catch {
    return null;
  }
}

function readSessionPayload(req: Request): VerifiedSessionPayload | null {
  const token = parseCookieHeader(req.headers.cookie)[SESSION_COOKIE_NAME];
  return token ? verifySessionToken(token) : null;
}

function attachUser(req: Request, payload: VerifiedSessionPayload): void {
  (req as any).user = {
    id: payload.uid,
    sessionId: payload.sid,
    roles: ['workspace_user'],
    scopes: ['chat:write', 'runs:read', 'runs:write', 'browser.read', 'files.read'],
  };
}

function setSessionCookie(res: Response, payload: SessionPayloadV2): void {
  const token = serializeToken(payload);
  const secure = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
  const attributes = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${SESSION_TOKEN_TTL_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) attributes.push('Secure');
  res.setHeader('Set-Cookie', attributes.join('; '));
}

function clearSessionCookie(res: Response): void {
  const secure = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
  const attributes = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) attributes.push('Secure');
  res.setHeader('Set-Cookie', attributes.join('; '));
}

function createSessionPayload(): SessionPayloadV2 {
  const now = Math.floor(Date.now() / 1000);
  return {
    v: 2,
    iss: SESSION_ISSUER,
    aud: SESSION_AUDIENCE,
    env: resolveDeploymentEnvironment(),
    uid: `user_${randomUUID()}`,
    sid: `session_${randomUUID()}`,
    iat: now,
    exp: now + SESSION_TOKEN_TTL_SECONDS,
  };
}

function upgradeLegacySession(payload: VerifiedSessionPayload): SessionPayloadV2 {
  const now = Math.floor(Date.now() / 1000);
  return {
    v: 2,
    iss: SESSION_ISSUER,
    aud: SESSION_AUDIENCE,
    env: resolveDeploymentEnvironment(),
    uid: payload.uid,
    sid: payload.sid,
    iat: now,
    exp: now + SESSION_TOKEN_TTL_SECONDS
  };
}

export function createSessionAuthMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    if ((req as any).user?.id && (req as any).user?.sessionId) {
      next();
      return;
    }

    const hasSessionCookie = Boolean(parseCookieHeader(req.headers.cookie)[SESSION_COOKIE_NAME]);
    const payload = readSessionPayload(req);
    if (payload) {
      attachUser(req, payload);
      if ('legacyV1' in payload) setSessionCookie(res, upgradeLegacySession(payload));
    } else if (hasSessionCookie) {
      clearSessionCookie(res);
    }
    next();
  };
}

export function ensureAuthenticatedSession(req: Request, res: Response) {
  const existing = readSessionPayload(req);
  const now = Math.floor(Date.now() / 1000);
  let payload: SessionPayloadV2;

  if (!existing) {
    payload = createSessionPayload();
    setSessionCookie(res, payload);
  } else if ('legacyV1' in existing || existing.exp - now <= SESSION_REFRESH_WINDOW_SECONDS) {
    payload = upgradeLegacySession(existing);
    setSessionCookie(res, payload);
  } else {
    payload = existing;
  }

  attachUser(req, payload);
  return {
    userId: payload.uid,
    sessionId: payload.sid,
    expiresAt: payload.exp * 1000,
  };
}
