import { createHash } from 'node:crypto';
import { cert, getApps, initializeApp, type ServiceAccount } from 'firebase-admin/app';
import { getAuth, type Auth, type DecodedIdToken } from 'firebase-admin/auth';
import type { NextFunction, Request, Response } from 'express';

export const ACCOUNT_COOKIE = 'aira_account_session';
const ACCOUNT_TTL_MS = 5 * 24 * 60 * 60 * 1000;
type AccountAuth = Pick<Auth, 'verifyIdToken' | 'verifySessionCookie' | 'createSessionCookie' | 'revokeRefreshTokens'>;
type AccountRequest = Request & { account?: { uid: string; sessionId: string; expiresAt: number; email?: string } };

export function configuredAccountAuth(): AccountAuth {
  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  const credentialJson = process.env.AIRA_FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!projectId || !credentialJson || projectId === 'aira-workspace-demo') {
    throw new Error('ACCOUNT_AUTH_NOT_CONFIGURED');
  }
  const name = `aira-account-${projectId}`;
  let app = getApps().find(candidate => candidate.name === name);
  if (!app) {
    const credential: ServiceAccount & { project_id?: string } = JSON.parse(credentialJson);
    if ((credential.projectId || credential.project_id) !== projectId) throw new Error('ACCOUNT_AUTH_NOT_CONFIGURED');
    app = initializeApp({ projectId, credential: cert(credential) }, name);
  }
  return getAuth(app);
}

function cookie(req: Request): string | undefined {
  const value = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${ACCOUNT_COOKIE}=`));
  if (!value) return undefined;
  try { return decodeURIComponent(value.slice(ACCOUNT_COOKIE.length + 1)); } catch { return undefined; }
}

function accountCookie(value: string, ttl: number): string {
  const secure = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
  return `${ACCOUNT_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${ttl}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

export function assertAccountOrigin(req: Request): void {
  const explicit = (process.env.AIRA_AUTH_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  const deployed = ['VERCEL_URL', 'VERCEL_BRANCH_URL', 'VERCEL_PROJECT_PRODUCTION_URL']
    .map(key => process.env[key]).filter((value): value is string => Boolean(value)).map(host => `https://${host}`);
  const allowed = [...explicit, ...deployed];
  if (!allowed.length) throw Object.assign(new Error('ACCOUNT_ORIGIN_NOT_CONFIGURED'), { status: 503 });
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !allowed.includes(origin) || req.headers['sec-fetch-site'] === 'cross-site') {
    throw Object.assign(new Error('ACCOUNT_ORIGIN_DENIED'), { status: 403 });
  }
}

export function createAccountMiddleware(resolveAuth: () => AccountAuth = configuredAccountAuth) {
  return async (req: AccountRequest, res: Response, next: NextFunction) => {
    const token = cookie(req);
    if (!token || ['/api/health', '/api/ready'].includes(req.path)) return next();
    try {
      const decoded = await resolveAuth().verifySessionCookie(token, true);
      if (decoded.firebase?.sign_in_provider === 'anonymous') throw new Error('Anonymous identity is not an account');
      const sessionId = `account_${createHash('sha256').update(token).digest('hex').slice(0, 24)}`;
      req.account = { uid: decoded.uid, sessionId, expiresAt: decoded.exp * 1000, email: decoded.email };
      Object.assign(req, { user: { id: `firebase:${decoded.uid}`, sessionId, roles: ['account_user'],
        scopes: ['chat:write', 'runs:read', 'runs:write', 'browser.read'] } });
      next();
    } catch {
      res.setHeader('Set-Cookie', accountCookie('', 0));
      if (['/api/auth/account', '/api/auth/logout'].includes(req.path)) return next();
      res.status(401).json({ error: 'ACCOUNT_SESSION_INVALID', message: 'Sign in again to access this account.' });
    }
  };
}

export function createAccountLoginHandler(resolveAuth: () => AccountAuth = configuredAccountAuth) {
  return async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try { assertAccountOrigin(req); } catch (error) {
      return res.status((error as Error & { status: number }).status).json({ error: (error as Error).message });
    }
    const idToken = req.body?.idToken;
    if (typeof idToken !== 'string' || idToken.length > 16384 || !idToken.trim()) return res.status(400).json({ error: 'ACCOUNT_TOKEN_REQUIRED' });
    let auth: AccountAuth;
    try { auth = resolveAuth(); } catch { return res.status(503).json({ error: 'ACCOUNT_AUTH_NOT_CONFIGURED' }); }
    try {
      const decoded: DecodedIdToken = await auth.verifyIdToken(idToken, true);
      const now = Math.floor(Date.now() / 1000);
      if (!decoded.uid || decoded.firebase?.sign_in_provider === 'anonymous' || !decoded.auth_time || decoded.auth_time > now || now - decoded.auth_time > 300) {
        return res.status(401).json({ error: 'ACCOUNT_RECENT_SIGN_IN_REQUIRED' });
      }
      const token = await auth.createSessionCookie(idToken, { expiresIn: ACCOUNT_TTL_MS });
      res.setHeader('Set-Cookie', [accountCookie(token, ACCOUNT_TTL_MS / 1000), 'aira_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax']);
      return res.status(200).json({ status: 'AUTHENTICATED', account: true, userId: `firebase:${decoded.uid}`, email: decoded.email || null });
    } catch { return res.status(401).json({ error: 'ACCOUNT_TOKEN_INVALID' }); }
  };
}

export function createAccountLogoutHandler(resolveAuth: () => AccountAuth = configuredAccountAuth) {
  return async (req: AccountRequest, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try { assertAccountOrigin(req); } catch (error) {
      return res.status((error as Error & { status: number }).status).json({ error: (error as Error).message });
    }
    if (req.account) {
      try { await resolveAuth().revokeRefreshTokens(req.account.uid); }
      catch { return res.status(503).json({ error: 'ACCOUNT_SIGN_OUT_UNAVAILABLE' }); }
    }
    res.setHeader('Set-Cookie', [accountCookie('', 0), 'aira_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax']);
    return res.status(200).json({ status: 'SIGNED_OUT', allAccountSessions: Boolean(req.account) });
  };
}
