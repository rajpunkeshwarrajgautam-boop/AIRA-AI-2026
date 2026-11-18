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
 * and strictly rejects production targets fail-closed.
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

  const host = parsed.hostname.toLowerCase();

  // 1. Unconditional production rejection
  if (
    host === PRODUCTION_CANONICAL_HOST.toLowerCase() ||
    host.includes('aira-ai-2026.vercel.app') ||
    host.includes('aira-ai-2026-git-prod') ||
    host === 'virexaaiventures.com' ||
    host === 'www.virexaaiventures.com'
  ) {
    throw new Error(`[SECURITY FATAL] Target URL "${trimmed}" targets PRODUCTION. Staging tests are forbidden against production.`);
  }

  // 2. Protocol check
  const isLocal = host === 'localhost' || host === '127.0.0.1';
  if (!isLocal && parsed.protocol !== 'https:') {
    throw new Error(`[SECURITY FATAL] Remote target URL "${trimmed}" must use HTTPS. Fail-closed.`);
  }

  // 3. Staging/preview format check
  const isStagingDomain = host === STAGING_CANONICAL_DOMAIN.toLowerCase() || host.endsWith(`.${STAGING_CANONICAL_DOMAIN.toLowerCase()}`);
  const isVercelPreview = /^aira-ai-2026-[a-z0-9]+-[a-z0-9-]+\.vercel\.app$/.test(host) ||
                          host.includes('git-staging') ||
                          host.includes('preview');

  if (!isLocal && !isStagingDomain && !isVercelPreview) {
    throw new Error(`[SECURITY FATAL] Target host "${host}" is not recognized as a valid staging or preview domain. Fail-closed.`);
  }

  return parsed.origin;
}

/**
 * Validates that the database connection string is NOT pointing to the production Neon project or endpoint.
 */
export function validateStagingDatabaseUrl(databaseUrl?: string): void {
  if (!databaseUrl || typeof databaseUrl !== 'string' || !databaseUrl.trim()) {
    return; // Optional if test only hits HTTP API
  }

  const trimmed = databaseUrl.trim();
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
