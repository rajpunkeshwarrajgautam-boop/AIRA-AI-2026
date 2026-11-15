/**
 * AIRA AI 2026 — Unified Strict Staging Host & Destination Guard
 *
 * Enforces that all browser automation, API requests, fixture management,
 * and certification harnesses target ONLY the certified staging environment.
 *
 * Strictly rejects:
 * - Production domains (e.g. aira-ai-2026.vercel.app, *.vercel.app)
 * - Arbitrary HTTPS domains (e.g. attacker.com, example.com)
 * - Lookalike domains and subdomains (e.g. staging.virexaaiventures.com.attacker.com)
 * - Insecure HTTP protocols
 * - URLs containing embedded credentials (e.g. https://user:pass@staging.virexaaiventures.com)
 * - Non-standard ports (e.g. :8443, :3000)
 * - Unexpected paths, queries, or fragments on base staging URL configuration
 * - Unsafe redirects that could exfiltrate authenticated sessions
 */

export const CERTIFIED_STAGING_ORIGIN = 'https://staging.virexaaiventures.com';
export const CERTIFIED_STAGING_HOSTNAME = 'staging.virexaaiventures.com';

const ALLOWED_OAUTH_IDP_HOSTS = new Set([
  'accounts.google.com',
  'github.com',
]);

/**
 * Validates that a raw base staging URL or environment variable override
 * is strictly and exclusively the certified staging origin.
 */
export function assertPr178StagingDestination(rawUrl: unknown): string {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new Error('PR178_CERTIFICATION_DESTINATION_REJECTED: staging URL must be a non-empty string');
  }

  const trimmed = rawUrl.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`PR178_CERTIFICATION_DESTINATION_REJECTED: invalid staging URL "${trimmed}"`);
  }

  // 1. Insecure protocol rejection
  if (url.protocol !== 'https:') {
    throw new Error(`PR178_CERTIFICATION_DESTINATION_REJECTED: insecure protocol "${url.protocol}"; HTTPS is required`);
  }

  // 2. Embedded credentials rejection
  if (url.username !== '' || url.password !== '') {
    throw new Error('PR178_CERTIFICATION_DESTINATION_REJECTED: URLs with embedded credentials are strictly forbidden');
  }

  // 3. Port rejection (must be default HTTPS 443)
  if (url.port !== '') {
    throw new Error(`PR178_CERTIFICATION_DESTINATION_REJECTED: unexpected port "${url.port}"; default port 443 required`);
  }

  // 4. Exact hostname match (rejects production, vercel previews, lookalikes, apex, arbitrary hosts)
  if (url.hostname.toLowerCase() !== CERTIFIED_STAGING_HOSTNAME) {
    throw new Error(
      `PR178_CERTIFICATION_DESTINATION_REJECTED: destination host "${url.hostname}" is not authorized. ONLY "${CERTIFIED_STAGING_HOSTNAME}" is permitted.`
    );
  }

  // 5. Origin strict equality
  if (url.origin !== CERTIFIED_STAGING_ORIGIN) {
    throw new Error(`PR178_CERTIFICATION_DESTINATION_REJECTED: origin "${url.origin}" does not match certified "${CERTIFIED_STAGING_ORIGIN}"`);
  }

  // 6. Base URL configuration must not include unexpected paths, queries, or fragments
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error(`PR178_CERTIFICATION_DESTINATION_REJECTED: base staging URL cannot contain subpaths, got "${url.pathname}"`);
  }
  if (url.search !== '') {
    throw new Error(`PR178_CERTIFICATION_DESTINATION_REJECTED: base staging URL cannot contain query parameters, got "${url.search}"`);
  }
  if (url.hash !== '') {
    throw new Error(`PR178_CERTIFICATION_DESTINATION_REJECTED: base staging URL cannot contain fragments, got "${url.hash}"`);
  }

  return CERTIFIED_STAGING_ORIGIN;
}

/**
 * Alias for assertPr178StagingDestination to maintain seamless compatibility
 * with existing Phase 2 certification consumers while enforcing strict validation.
 */
export const assertStagingTargetUrl = assertPr178StagingDestination;

/**
 * Validates endpoint URLs (e.g. https://staging.virexaaiventures.com/api/version)
 * ensuring they remain strictly on the certified staging origin.
 */
export function assertStagingEndpointUrl(endpointUrl: string): string {
  let url: URL;
  try {
    url = new URL(endpointUrl);
  } catch {
    throw new Error(`PR178_CERTIFICATION_ENDPOINT_REJECTED: invalid endpoint URL "${endpointUrl}"`);
  }

  if (url.origin !== CERTIFIED_STAGING_ORIGIN || url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') {
    throw new Error(`PR178_CERTIFICATION_ENDPOINT_REJECTED: endpoint "${endpointUrl}" does not target certified staging origin`);
  }

  return endpointUrl;
}

/**
 * Validates browser navigation targets during interactive OAuth handshakes.
 * Permits ONLY the certified staging origin and authorized OAuth Identity Providers.
 */
export function assertAllowedOAuthNavigation(targetUrl: string, provider?: 'google' | 'github'): void {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    throw new Error(`UNAUTHORIZED_OAUTH_NAVIGATION: cannot parse target URL "${targetUrl}"`);
  }

  if (url.origin === CERTIFIED_STAGING_ORIGIN) {
    return;
  }

  if (url.protocol !== 'https:') {
    throw new Error(`UNAUTHORIZED_OAUTH_NAVIGATION: insecure protocol on navigation target "${targetUrl}"`);
  }

  const hostname = url.hostname.toLowerCase();
  if (provider === 'google' && (hostname === 'accounts.google.com' || hostname.endsWith('.google.com'))) {
    return;
  }
  if (provider === 'github' && (hostname === 'github.com' || hostname.endsWith('.github.com'))) {
    return;
  }

  if (ALLOWED_OAUTH_IDP_HOSTS.has(hostname)) {
    return;
  }

  throw new Error(`UNAUTHORIZED_OAUTH_NAVIGATION: navigation to untrusted host "${hostname}" blocked`);
}
