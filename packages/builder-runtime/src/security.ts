import { createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import type { ExecutionPrincipal } from '../../contracts/src/index.js';

export interface WorkspaceTicket {
  version: 1;
  purpose: 'workspace' | 'file';
  sandboxId: string;
  userId: string;
  sessionId: string;
  expiresAt: number;
  allowInternet: boolean;
  allowPreview: boolean;
  path?: string;
  sha256?: string;
}
export function signingSecret(): string {
  const secret = process.env.AIRA_BUILDER_SIGNING_SECRET || process.env.AIRA_SESSION_SECRET || '';
  if (secret.length < 32) throw new Error('Builder signing secret is not configured (minimum 32 characters).');
  return secret;
}
export function signTicket(ticket: WorkspaceTicket, secret = signingSecret()): string {
  const payload = Buffer.from(JSON.stringify(ticket)).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update('aira-builder-v1:' + payload).digest('base64url')}`;
}
export function verifyTicket(token: string, principal: ExecutionPrincipal, purpose: WorkspaceTicket['purpose'], secret = signingSecret()): WorkspaceTicket {
  if (token.length > 6000) throw new Error('Invalid workspace ticket.');
  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('Invalid workspace ticket.');
  const expected = createHmac('sha256', secret).update('aira-builder-v1:' + parts[0]).digest();
  const actual = Buffer.from(parts[1], 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) throw new Error('Invalid workspace ticket signature.');
  const t = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as WorkspaceTicket;
  if (t.version !== 1 || t.purpose !== purpose || t.userId !== principal.userId || t.sessionId !== principal.sessionId || !/^[a-zA-Z0-9_-]{1,150}$/.test(t.sandboxId)) throw new Error('Workspace access denied.');
  if (!Number.isFinite(t.expiresAt) || t.expiresAt <= Date.now()) throw new Error('Workspace expired. Start a new builder workspace.');
  if (purpose === 'file' && (!t.path || !/^[a-f0-9]{64}$/.test(t.sha256 || ''))) throw new Error('Invalid file ticket.');
  return t;
}
export function safeRelativePath(value: string, allowRoot = false): string {
  if (typeof value !== 'string' || value.length > 240 || /[\x00-\x1f\\]/.test(value) || path.posix.isAbsolute(value) || value.split('/').includes('..')) throw new Error('Only relative workspace paths without traversal are allowed.');
  const result = path.posix.normalize(value);
  if ((!allowRoot && result === '.') || result.startsWith('../')) throw new Error('A file path is required.');
  return result;
}
export function builderAccess(principal: ExecutionPrincipal): { enabled: boolean; allowed: boolean; configured: boolean; reason: string } {
  const enabled = process.env.AIRA_BUILDER_ENABLED === 'true';
  const allowed = (process.env.AIRA_BUILDER_ALLOWED_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean).includes(principal.userId);
  const configured = Boolean(process.env.E2B_API_KEY?.trim()) && (process.env.AIRA_BUILDER_SIGNING_SECRET || process.env.AIRA_SESSION_SECRET || '').length >= 32;
  return { enabled, allowed, configured, reason: !enabled ? 'Builder is disabled. Ask the owner to complete the sandbox setup.' : !allowed ? 'Builder is limited to owner-approved users. Ask the owner to allow your user ID.' : !configured ? 'Sandbox credentials or signing secret are not configured.' : 'Ready' };
}
export function publicBuilderError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const name of ['E2B_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NVIDIA_API_KEY', 'AIRA_BUILDER_SIGNING_SECRET', 'AIRA_SESSION_SECRET']) {
    const value = process.env[name];
    if (value) message = message.split(value).join('[redacted]');
  }
  return message.slice(0, 800);
}
