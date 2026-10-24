/**
 * AIRA AI 2026 — URL & Request Logging Sanitizer
 * 
 * Prevents sensitive authentication material (OAuth authorization codes,
 * state parameters, PKCE verifiers, session tokens, passwords, and PII emails)
 * from appearing in application runtime logs, error reports, and HTTP responses.
 */

export function sanitizeUrlForLogging(rawUrl: string): string {
  if (!rawUrl) return '';
  try {
    const url = new URL(rawUrl, 'http://localhost');
    const sensitiveKeys = new Set([
      'code',
      'state',
      'flowid',
      'flow_id',
      'token',
      'session',
      'sessiontoken',
      'session_token',
      'secret',
      'key',
      'apikey',
      'api_key',
      'password',
      'verifier',
      'code_verifier',
      'code_challenge',
      'claimedemail',
      'email',
      'authorization',
      'auth_token',
      'access_token',
      'refresh_token',
      'id_token'
    ]);
    for (const [key] of Array.from(url.searchParams.entries())) {
      if (sensitiveKeys.has(key.toLowerCase())) {
        url.searchParams.set(key, '[REDACTED]');
      }
    }
    return url.pathname + (url.search ? url.search : '');
  } catch {
    return rawUrl.split('?')[0];
  }
}
