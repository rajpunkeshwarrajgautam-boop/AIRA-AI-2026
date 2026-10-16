import { createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import type { ExecutionPrincipal } from '../../contracts/src/index.js';

export interface WorkspaceTicket {
  version: 1;
  purpose: 'workspace' | 'file';
  provider?: string;
  workspaceId?: string;
  sandboxId?: string; // backwards compatibility alias for workspaceId
  userId: string;
  sessionId: string;
  expiresAt: number;
  allowInternet: boolean;
  allowPreview: boolean;
  path?: string;
  sha256?: string;
}

export interface BuilderAccessStatus {
  enabled: boolean;
  allowed: boolean;
  configured: boolean;
  reason: string;
  sandboxProvider: string;
  sandboxProviderConfigured: boolean;
  teamspaceConfigured: boolean;
  runtime: string;
  instanceType: string;
  workspaceTtlMinutes: number;
  previewPort: number;
  fallbackProvider: string;
}

export function signingSecret(): string {
  const secret = process.env.AIRA_BUILDER_SIGNING_SECRET || process.env.AIRA_SESSION_SECRET || '';
  if (secret.length < 32) throw new Error('Builder signing secret is not configured (minimum 32 characters).');
  return secret;
}

export function signTicket(ticket: WorkspaceTicket, secret = signingSecret()): string {
  const wsId = ticket.workspaceId || ticket.sandboxId || '';
  const provider = ticket.provider || process.env.AIRA_SANDBOX_PROVIDER || 'lightning';
  const normalized: WorkspaceTicket = {
    ...ticket,
    workspaceId: wsId,
    sandboxId: wsId,
    provider
  };
  const payload = Buffer.from(JSON.stringify(normalized)).toString('base64url');
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
  const id = t.workspaceId || t.sandboxId || '';
  if (t.version !== 1 || t.purpose !== purpose || t.userId !== principal.userId || t.sessionId !== principal.sessionId || !/^[a-zA-Z0-9_-]{1,150}$/.test(id)) {
    throw new Error('Workspace access denied.');
  }
  if (t.provider && !/^[a-zA-Z0-9_-]{1,30}$/.test(t.provider)) {
    throw new Error('Invalid workspace provider.');
  }
  if (!Number.isFinite(t.expiresAt) || t.expiresAt <= Date.now()) throw new Error('Workspace expired. Start a new builder workspace.');
  if (purpose === 'file' && (!t.path || !/^[a-f0-9]{64}$/.test(t.sha256 || ''))) throw new Error('Invalid file ticket.');

  t.workspaceId = id;
  t.sandboxId = id;
  t.provider = t.provider || process.env.AIRA_SANDBOX_PROVIDER || 'lightning';
  return t;
}

export function safeRelativePath(value: string, allowRoot = false): string {
  if (typeof value !== 'string' || value.length > 240 || /[\x00-\x1f\\]/.test(value) || path.posix.isAbsolute(value) || value.split('/').includes('..')) {
    throw new Error('Only relative workspace paths without traversal are allowed.');
  }
  const result = path.posix.normalize(value);
  if ((!allowRoot && result === '.') || result.startsWith('../')) throw new Error('A file path is required.');
  return result;
}

export function builderAccess(principal: ExecutionPrincipal): BuilderAccessStatus {
  const enabled = process.env.AIRA_BUILDER_ENABLED === 'true';
  const allowed = (process.env.AIRA_BUILDER_ALLOWED_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean).includes(principal.userId);

  const sandboxProvider = process.env.AIRA_SANDBOX_PROVIDER || 'lightning';
  let sandboxProviderConfigured = false;
  let teamspaceConfigured = false;
  let runtime = 'node24';
  let instanceType = 'cpu-2';
  let previewPort = 3000;
  let workspaceTtlMinutes = 15;

  if (sandboxProvider === 'lightning') {
    sandboxProviderConfigured = Boolean(process.env.LIGHTNING_SANDBOX_API_KEY?.trim());
    teamspaceConfigured = Boolean((process.env.AIRA_LIGHTNING_TEAMSPACE || 'rajpunkeshwarrajgautam-org/aira-ai-2026').trim());
    runtime = process.env.AIRA_LIGHTNING_RUNTIME || 'node24';
    instanceType = process.env.AIRA_LIGHTNING_INSTANCE_TYPE || 'cpu-2';
    previewPort = Number(process.env.AIRA_LIGHTNING_PREVIEW_PORT) || 3000;
    workspaceTtlMinutes = Math.round((Number(process.env.AIRA_LIGHTNING_SANDBOX_TIMEOUT_MS) || 900000) / 60000);
  } else if (sandboxProvider === 'e2b') {
    sandboxProviderConfigured = Boolean(process.env.E2B_API_KEY?.trim());
    teamspaceConfigured = false;
    runtime = 'linux';
    instanceType = 'standard';
    previewPort = 3000;
    workspaceTtlMinutes = 15;
  } else {
    sandboxProviderConfigured = false;
  }

  const fallbackProvider = process.env.AIRA_SANDBOX_FALLBACK_PROVIDER || 'disabled';
  const secretConfigured = (process.env.AIRA_BUILDER_SIGNING_SECRET || process.env.AIRA_SESSION_SECRET || '').length >= 32;
  const configured = sandboxProviderConfigured && secretConfigured;

  let reason = 'Ready';
  if (!enabled) {
    reason = 'Builder is disabled. Ask the owner to complete the sandbox setup.';
  } else if (!allowed) {
    reason = 'Builder is limited to owner-approved users. Ask the owner to allow your user ID.';
  } else if (!configured) {
    reason = !sandboxProviderConfigured
      ? `${sandboxProvider === 'lightning' ? 'Lightning AI Sandbox' : 'Sandbox'} credentials are not configured.`
      : 'Signing secret is not configured.';
  }

  return {
    enabled,
    allowed,
    configured,
    reason,
    sandboxProvider,
    sandboxProviderConfigured,
    teamspaceConfigured,
    runtime,
    instanceType,
    workspaceTtlMinutes,
    previewPort,
    fallbackProvider
  };
}

export function publicBuilderError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const name of [
    'LIGHTNING_SANDBOX_API_KEY',
    'E2B_API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'NVIDIA_API_KEY',
    'AIRA_BUILDER_SIGNING_SECRET',
    'AIRA_SESSION_SECRET',
    'DATABASE_URL'
  ]) {
    const value = process.env[name];
    if (value) message = message.split(value).join('[redacted]');
  }
  return message.slice(0, 800);
}
