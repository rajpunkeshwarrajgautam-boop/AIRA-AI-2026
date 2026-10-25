/**
 * AIRA AI 2026 — Accurately Scoped Environment Detection & Branding
 * 
 * Strict environment classification rules:
 * 1. Production: aira-ai-2026.vercel.app, virexaaiventures.com, www.virexaaiventures.com
 *    -> Never displays "Staging"
 * 2. Staging: staging.virexaaiventures.com, staging.*
 *    -> Displays "Staging" only in actual staging
 * 3. Local Development: localhost, 127.0.0.1, ::1, *.local
 *    -> Displays "Local" or nothing, never claims to be "Staging"
 * 4. Preview: *.vercel.app (excluding canonical production)
 *    -> Displays "Preview", never falsely claims production or staging
 */

export type AppEnvironment = 'production' | 'staging' | 'preview' | 'development' | 'test';

export function getAppEnvironment(hostnameOverride?: string): AppEnvironment {
  // 1. Explicit override or window hostname
  const host = (
    hostnameOverride !== undefined
      ? hostnameOverride
      : typeof window !== 'undefined'
      ? window.location.hostname
      : ''
  ).trim().toLowerCase();

  if (!host) {
    const proc = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process;
    if (proc?.env?.NODE_ENV === 'test') {
      return 'test';
    }
    return 'production';
  }

  // Local development
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.local')
  ) {
    return 'development';
  }

  // Actual Staging domain
  if (host === 'staging.virexaaiventures.com' || host.startsWith('staging.')) {
    return 'staging';
  }

  // Canonical Production domains
  if (
    host === 'aira-ai-2026.vercel.app' ||
    host === 'virexaaiventures.com' ||
    host === 'www.virexaaiventures.com'
  ) {
    return 'production';
  }

  // Vercel Preview Deployments (e.g. aira-ai-2026-*-rajpunkeshwarrajgautam-boops-projects.vercel.app)
  if (host.endsWith('.vercel.app')) {
    return 'preview';
  }

  return 'production';
}

export function isStagingEnvironment(hostnameOverride?: string): boolean {
  return getAppEnvironment(hostnameOverride) === 'staging';
}

export function isProductionEnvironment(hostnameOverride?: string): boolean {
  return getAppEnvironment(hostnameOverride) === 'production';
}

export function isLocalEnvironment(hostnameOverride?: string): boolean {
  return getAppEnvironment(hostnameOverride) === 'development';
}

export function isPreviewEnvironment(hostnameOverride?: string): boolean {
  return getAppEnvironment(hostnameOverride) === 'preview';
}

/**
 * Returns user-facing environment badge label or null if standard production/clean UI.
 * Production returns null (clean customer UI, no technical badge).
 * Staging returns 'Staging'.
 * Preview returns 'Preview'.
 * Local returns 'Local Dev'.
 */
export function getEnvironmentBadgeLabel(hostnameOverride?: string): string | null {
  const env = getAppEnvironment(hostnameOverride);
  switch (env) {
    case 'staging':
      return 'Staging';
    case 'preview':
      return 'Preview';
    case 'development':
      return 'Local Dev';
    case 'production':
    case 'test':
    default:
      return null;
  }
}
