import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import type { Request } from 'express';
import type { ExecutionPrincipal } from '../../../../packages/contracts/src/index.js';

export async function resolveFirebasePrincipal(req: Request): Promise<ExecutionPrincipal | undefined> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error('Firebase authentication is not configured on the API.');
  if (process.env.NODE_ENV === 'production' && process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error('Firebase auth emulator is forbidden in production.');
  const name = 'aira-api-auth';
  const app = getApps().find(a => a.name === name) || initializeApp({ projectId }, name);
  const token = await getAuth(app).verifyIdToken(header.slice(7));
  // Firebase verifies signature, issuer, audience, subject and token expiry.
  return { userId: token.uid, sessionId: `firebase_${token.uid}_${token.auth_time}`, roles: ['user'], scopes: ['aira-bot'] };
}
