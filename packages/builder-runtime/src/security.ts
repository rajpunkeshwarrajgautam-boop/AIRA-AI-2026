import { createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import type { ExecutionPrincipal } from '../../contracts/src/index.js';
import { resolveDeploymentEnvironment } from '../../contracts/src/deployment-environment.js';

export interface WorkspaceTicket {
  version: 2;
  issuer: 'aira-builder';
  audience: 'aira-builder-runtime';
  environment: import('../../contracts/src/deployment-environment.js').DeploymentEnvironment;
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

export type WorkspaceTicketDraft = Omit<WorkspaceTicket, 'version' | 'issuer' | 'audience' | 'environment'>;

type LegacyWorkspaceTicket = Omit<WorkspaceTicket, 'version' | 'issuer' | 'audience' | 'environment'> & { version: 1 };

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

const BUILDER_ISSUER = 'aira-builder' as const;
const BUILDER_AUDIENCE = 'aira-builder-runtime' as const;

export function signingSecret(): string {
  const secret = process.env.AIRA_BUILDER_SIGNING_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error('AIRA_BUILDER_SIGNING_SECRET must be configured with at least 32 characters.');
  }
  return secret;
}

export function signTicket(ticket: WorkspaceTicketDraft, secret = signingSecret()): string {
  const wsId = ticket.workspaceId || ticket.sandboxId || '';
  const provider = ticket.provider || process.env.AIRA_SANDBOX_PROVIDER || 'lightning';
  const environment = resolveDeploymentEnvironment();
  const normalized: WorkspaceTicket = {
    ...ticket,
    version: 2,
    issuer: BUILDER_ISSUER,
    audience: BUILDER_AUDIENCE,
    environment,
    workspaceId: wsId,
    sandboxId: wsId,
    provider
  };
  const payload = Buffer.from(JSON.stringify(normalized)).toString('base64url');
  const signature = createHmac('sha256', secret)
    .update(`aira-builder-v2:${environment}:${payload}`)
    .digest('base64url');
  return `${payload}.${signature}`;
}

export function verifyTicket(token: string, principal: ExecutionPrincipal, purpose: WorkspaceTicket['purpose'], secret = signingSecret()): WorkspaceTicket {
  if (typeof token !== 'string' || token.length > 6000) throw new Error('Invalid workspace ticket.');
  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('Invalid workspace ticket.');

  let parsed: WorkspaceTicket | LegacyWorkspaceTicket;
  try {
    parsed = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as WorkspaceTicket | LegacyWorkspaceTicket;
  } catch {
    throw new Error('Invalid workspace ticket.');
  }

  const environment = resolveDeploymentEnvironment();
  let expected: Buffer;
  if (parsed.version === 2) {
    if (
      parsed.issuer !== BUILDER_ISSUER ||
      parsed.audience !== BUILDER_AUDIENCE ||
      parsed.environment !== environment
    ) throw new Error('Workspace ticket environment or claims are invalid.');
    expected = createHmac('sha256', secret).update(`aira-builder-v2:${parsed.environment}:${parts[0]}`).digest();
  } else if (
    parsed.version === 1 &&
    environment === 'production' &&
    process.env.AIRA_BUILDER_ACCEPT_LEGACY_V1 === 'true'
  ) {
    // Explicit Production-only grace for old tickets, still requiring the dedicated
    // builder key. Never fall back to AIRA_SESSION_SECRET to verify them.
    expected = createHmac('sha256', secret).update(`aira-builder-v1:${parts[0]}`).digest();
  } else {
    throw new Error('Workspace ticket version is not accepted.');
  }

  const actual = Buffer.from(parts[1], 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) {
    throw new Error('Invalid workspace ticket signature.');
  }
  const id = parsed.workspaceId || parsed.sandboxId || '';
  if (parsed.purpose !== purpose || parsed.userId !== principal.userId || parsed.sessionId !== principal.sessionId || !/^[a-zA-Z0-9_-]{1,150}$/.test(id)) {
    throw new Error('Workspace access denied.');
  }
  if (parsed.provider && !/^[a-zA-Z0-9_-]{1,30}$/.test(parsed.provider)) {
    throw new Error('Invalid workspace provider.');
  }
  if (!Number.isFinite(parsed.expiresAt) || parsed.expiresAt <= Date.now()) throw new Error('Workspace expired. Start a new builder workspace.');
  if (purpose === 'file' && (!parsed.path || !/^[a-f0-9]{64}$/.test(parsed.sha256 || ''))) throw new Error('Invalid file ticket.');

  return {
    ...parsed,
    version: 2,
    issuer: BUILDER_ISSUER,
    audience: BUILDER_AUDIENCE,
    environment,
    workspaceId: id,
    sandboxId: id,
    provider: parsed.provider || process.env.AIRA_SANDBOX_PROVIDER || 'lightning'
  };
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
  const secretConfigured = (process.env.AIRA_BUILDER_SIGNING_SECRET || '').trim().length >= 32;
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
