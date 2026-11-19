/**
 * AIRA AI 2026 — Secure Staging Test Fixture Lifecycle & Environment Isolation Guard
 * 
 * Enforces:
 * 1. Fail-closed target validation (blocks production URLs and production Neon endpoints)
 * 2. Cryptographic staging credential generation without embedded plaintext secrets
 * 3. Strict fixture ownership tracking (prevents touching or deleting records of other principals)
 * 4. Safe, idempotent, reverse-dependency cleanup with error recovery
 */

import crypto from 'node:crypto';
import {
  classifyDatabaseUrl,
  PRODUCTION_CANONICAL_HOST,
  PRODUCTION_NEON_ENDPOINT_ID,
  PRODUCTION_NEON_PROJECT_ID,
  STAGING_CANONICAL_DOMAIN
} from '../../packages/db/src/security/database-isolation-guard.js';

export interface ValidatedStagingEnvironment {
  url: string;
  isStagingOrPreview: boolean;
  databaseUrl?: string;
}

/**
 * Validates that the target HTTP/HTTPS URL is a genuine staging or preview deployment,
 * and strictly rejects production targets, lookalikes, unapproved ports, and userinfo fail-closed.
 */
export function validateStagingTargetUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new Error('[SECURITY FATAL] Target URL is empty. Fail-closed.');
  }

  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`[SECURITY FATAL] Target URL is malformed: "${trimmed}". Fail-closed.`);
  }

  // 1. Userinfo credentials rejection
  if (parsed.username || parsed.password) {
    throw new Error('[SECURITY FATAL] URL containing userinfo credentials is strictly rejected. Fail-closed.');
  }

  const host = parsed.hostname.toLowerCase();

  // 2. Unconditional production rejection (exact match, aliases, and subdomains)
  if (
    host === PRODUCTION_CANONICAL_HOST.toLowerCase() ||
    host === 'aira-ai-2026.vercel.app' ||
    host === 'virexaaiventures.com' ||
    host === 'www.virexaaiventures.com' ||
    host.endsWith('.aira-ai-2026.vercel.app') ||
    host.startsWith('aira-ai-2026-git-prod') ||
    host.includes('production')
  ) {
    throw new Error(`[SECURITY FATAL] Target URL "${trimmed}" targets PRODUCTION. Staging tests are forbidden against production.`);
  }

  // 3. Localhost development support with separate explicit controls
  const isLocal = host === 'localhost' || host === '127.0.0.1';
  if (isLocal) {
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`[SECURITY FATAL] Invalid protocol "${parsed.protocol}" for local target. Fail-closed.`);
    }
    const localPort = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'https:' ? 443 : 80);
    if (isNaN(localPort) || localPort <= 0 || localPort > 65535) {
      throw new Error(`[SECURITY FATAL] Invalid local port "${parsed.port}". Fail-closed.`);
    }
    return parsed.origin;
  }

  // 4. Remote targets: must use HTTPS strictly
  if (parsed.protocol !== 'https:') {
    throw new Error(`[SECURITY FATAL] Remote target URL "${trimmed}" must use HTTPS. Fail-closed.`);
  }

  // 5. Port restriction on remote targets (standard 443 only)
  if (parsed.port && parsed.port !== '443') {
    throw new Error(`[SECURITY FATAL] Remote target URL contains unapproved port "${parsed.port}". Only standard HTTPS (443) is allowed.`);
  }

  // 6. Strict approved-origin validation (no loose substring matching)
  const isExactStaging = host === STAGING_CANONICAL_DOMAIN.toLowerCase();
  
  // Scoped Vercel preview format: aira-ai-2026-<hash>-<team>.vercel.app (minimum 8 hash chars)
  const isScopedVercelPreview = /^aira-ai-2026-[a-z0-9]{8,}-[a-z0-9-]+\.vercel\.app$/.test(host) &&
                                !host.includes('prod') &&
                                !host.includes('production');

  if (!isExactStaging && !isScopedVercelPreview) {
    throw new Error(`[SECURITY FATAL] Target host "${host}" is not recognized as a valid staging or preview domain. Fail-closed.`);
  }

  return parsed.origin;
}

/**
 * Validates that the database connection string is an authorized test/staging database
 * and strictly verifies that it does not point to production Neon projects, pooled endpoints, or unverified targets.
 */
export function validateStagingDatabaseUrl(
  databaseUrl?: string,
  options: { requireDisposable?: boolean } = {}
): void {
  if (!databaseUrl || typeof databaseUrl !== 'string' || !databaseUrl.trim()) {
    if (options.requireDisposable) {
      throw new Error('[SECURITY FATAL] Disposable database URL is required for database operations. Fail-closed.');
    }
    return;
  }

  const trimmed = databaseUrl.trim();
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    throw new Error('[SECURITY FATAL] Target database URL is malformed. Fail-closed.');
  }

  const classification = classifyDatabaseUrl(trimmed);

  if (classification.isProduction) {
    throw new Error(
      `[SECURITY FATAL] Target database "${classification.sanitizedTarget}" is classified as PRODUCTION. ` +
      `All test execution against production databases is strictly rejected.`
    );
  }

  if (
    trimmed.includes(PRODUCTION_NEON_ENDPOINT_ID) ||
    trimmed.includes(PRODUCTION_NEON_PROJECT_ID)
  ) {
    throw new Error(
      `[SECURITY FATAL] Target database URL contains production endpoint (${PRODUCTION_NEON_ENDPOINT_ID}) ` +
      `or project (${PRODUCTION_NEON_PROJECT_ID}). Fail-closed.`
    );
  }

  // Reject shared production connection poolers
  if (parsedUrl.hostname.includes('pooler') && !parsedUrl.hostname.includes('localhost') && !parsedUrl.hostname.includes('127.0.0.1')) {
    if (options.requireDisposable) {
      throw new Error('[SECURITY FATAL] Pooled endpoint detected on non-local database. Destructive test operations require an isolated disposable database.');
    }
  }

  if (options.requireDisposable) {
    const isLocalDocker = parsedUrl.hostname === 'localhost' || parsedUrl.hostname === '127.0.0.1' || parsedUrl.hostname === 'postgres';
    const isExplicitDisposableBranch = trimmed.includes('disposable') || trimmed.includes('test-branch') || trimmed.includes('ci-disposable');
    if (!isLocalDocker && !isExplicitDisposableBranch) {
      throw new Error(`[SECURITY FATAL] Database "${parsedUrl.hostname}" is not verified as an authorized disposable database target.`);
    }
  }
}

/**
 * Validates redirect destination to prevent open-redirect vulnerabilities during OAuth or authentication tests.
 */
export function validateRedirectTargetUrl(redirectUrl: string, allowedOrigins: string[] = []): string {
  if (!redirectUrl || typeof redirectUrl !== 'string' || !redirectUrl.trim()) {
    throw new Error('[SECURITY FATAL] Redirect URL is empty. Fail-closed.');
  }

  let parsed: URL;
  try {
    parsed = new URL(redirectUrl.trim());
  } catch {
    throw new Error(`[SECURITY FATAL] Malformed redirect URL: "${redirectUrl}". Fail-closed.`);
  }

  if (parsed.username || parsed.password) {
    throw new Error('[SECURITY FATAL] Redirect URL contains userinfo. Fail-closed.');
  }

  const origin = parsed.origin.toLowerCase();
  const defaultAllowed = [
    'https://' + STAGING_CANONICAL_DOMAIN.toLowerCase(),
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:5173',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3001',
    'http://127.0.0.1:5173'
  ];

  const allAllowed = new Set([...defaultAllowed, ...allowedOrigins.map(o => o.toLowerCase())]);
  const isAllowed = allAllowed.has(origin) || (
    origin.endsWith('.vercel.app') &&
    /^https:\/\/aira-ai-2026-[a-z0-9]{8,}-[a-z0-9-]+\.vercel\.app$/.test(origin) &&
    !origin.includes('prod')
  );

  if (!isAllowed) {
    throw new Error(`[SECURITY FATAL] Unapproved redirect destination "${origin}". Fail-closed.`);
  }

  return origin;
}

export interface GeneratedTestCredentials {
  email: string;
  password: string;
  name: string;
  namespace: string;
  sessionTag: string;
}

/**
 * Generates uniquely namespaced, cryptographically secure credentials for staging test accounts.
 * Reads environment override if explicitly provided, but never uses hardcoded credentials.
 */
export function generateStagingTestCredentials(
  namespace: string,
  envOverridePassword?: string
): GeneratedTestCredentials {
  const safeNs = namespace.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  const sessionTag = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const email = `test.${safeNs}.${sessionTag}@staging-test.virexaaiventures.com`;
  
  // Use env override if explicitly provided, else cryptographically generate high-entropy password
  const password = envOverridePassword && envOverridePassword.trim().length >= 12
    ? envOverridePassword.trim()
    : `Stg_${crypto.randomBytes(12).toString('base64url')}!Aa1`;

  const name = `QA Test ${safeNs} ${sessionTag.slice(0, 8)}`;

  return { email, password, name, namespace: safeNs, sessionTag };
}

export interface TrackedFixtureItem {
  id: string;
  type: 'user' | 'conversation' | 'project' | 'session';
  ownerPrincipalId: string;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

/**
 * Manages test fixture ownership and provides safe, isolated cleanup.
 * Prevents modifying or deleting records belonging to other principals.
 */
export class StagingFixtureTracker {
  private items: Map<string, TrackedFixtureItem> = new Map();
  private cleanedUp = false;

  constructor(public readonly sessionTag: string) {}

  /**
   * Registers a newly created fixture item under this test session.
   */
  public trackItem(
    id: string,
    type: 'user' | 'conversation' | 'project' | 'session',
    ownerPrincipalId: string,
    metadata?: Record<string, unknown>
  ): void {
    if (!id || !ownerPrincipalId) {
      throw new Error(`[FIXTURE ERROR] Cannot track fixture without valid ID and ownerPrincipalId.`);
    }
    this.items.set(id, {
      id,
      type,
      ownerPrincipalId,
      createdAt: Date.now(),
      metadata
    });
  }

  public getTrackedItems(): TrackedFixtureItem[] {
    return Array.from(this.items.values());
  }

  /**
   * Asserts that a record belongs to this test session before taking any action.
   */
  public verifyOwnership(id: string, requestedByPrincipalId: string): boolean {
    const item = this.items.get(id);
    if (!item) return false;
    return item.ownerPrincipalId === requestedByPrincipalId;
  }

  /**
   * Safely cleans up all tracked fixtures in reverse dependency order.
   * Can be called multiple times safely (idempotent).
   */
  public async cleanup(
    handlers: {
      deleteConversation?: (id: string, ownerPrincipalId: string) => Promise<boolean>;
      deleteProject?: (id: string, ownerPrincipalId: string) => Promise<boolean>;
      deleteUser?: (id: string, ownerPrincipalId: string) => Promise<boolean>;
    } = {}
  ): Promise<{ succeeded: string[]; failed: string[]; skipped: string[] }> {
    const result = {
      succeeded: [] as string[],
      failed: [] as string[],
      skipped: [] as string[]
    };

    if (this.cleanedUp) {
      return result; // Idempotent double-cleanup
    }

    const itemsList = Array.from(this.items.values());
    // Reverse dependency order: conversations/projects first, users last
    const order = ['conversation', 'project', 'session', 'user'];
    itemsList.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));

    for (const item of itemsList) {
      try {
        let deleted = false;
        if (item.type === 'conversation' && handlers.deleteConversation) {
          deleted = await handlers.deleteConversation(item.id, item.ownerPrincipalId);
        } else if (item.type === 'project' && handlers.deleteProject) {
          deleted = await handlers.deleteProject(item.id, item.ownerPrincipalId);
        } else if (item.type === 'user' && handlers.deleteUser) {
          deleted = await handlers.deleteUser(item.id, item.ownerPrincipalId);
        } else {
          result.skipped.push(item.id);
          continue;
        }

        if (deleted) {
          result.succeeded.push(item.id);
        } else {
          result.failed.push(item.id);
        }
      } catch (err: any) {
        result.failed.push(item.id);
      }
    }

    this.cleanedUp = true;
    return result;
  }
}
