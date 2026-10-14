/**
 * AIRA AI 2026 — Cloudflare Cron dispatcher.
 *
 * Fail-closed by default. No production dispatch is supported by this worker.
 * Scheduled delivery requires a verified AIRA Preview endpoint and an encrypted
 * CRON_SECRET binding. Neither value should be committed to source control.
 *
 * Every-minute Cloudflare Cron is an external clock, not an autonomous retry
 * queue; authoritative job claims and notification delivery remain AIRA's job.
 */

const EXPECTED_PATH = '/api/automations/cron/execute';
const EXPECTED_PREVIEW_SUFFIX =
  '-rajpunkeshwarrajgautam-boops-projects.vercel.app';
const EXPECTED_PREVIEW_PREFIX = 'aira-ai-2026-';

export function validateStagingEndpoint(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('STAGING_ENDPOINT_NOT_CONFIGURED');
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('STAGING_ENDPOINT_INVALID');
  }

  if (url.protocol !== 'https:' || url.username || url.password ||
      url.port || url.search || url.hash) {
    throw new Error('STAGING_ENDPOINT_INVALID');
  }

  const host = url.hostname.toLowerCase();
  // Production is never accepted, even if accidentally configured as a secret.
  if (host === 'aira-ai-2026.vercel.app' ||
      host === 'aira-ai.in' || host === 'www.aira-ai.in') {
    throw new Error('PRODUCTION_ENDPOINT_FORBIDDEN');
  }

  if (!host.startsWith(EXPECTED_PREVIEW_PREFIX) ||
      !host.endsWith(EXPECTED_PREVIEW_SUFFIX) ||
      url.pathname !== EXPECTED_PATH) {
    throw new Error('STAGING_ENDPOINT_NOT_ALLOWLISTED');
  }

  return url.toString();
}

export async function runScheduledTick(env, dependencies = {}) {
  const fetchRequest = dependencies.fetch ?? fetch;
  const log = dependencies.log ?? console;

  if (env?.DISPATCH_ENABLED !== 'true') {
    log.info('aira_scheduler_skipped', { reason: 'disabled' });
    return { status: 'SKIPPED', reason: 'disabled' };
  }

  // Validate all prerequisites *before* making a network request.
  const endpoint = validateStagingEndpoint(env?.AIRA_STAGING_SCHEDULER_URL);
  const secret = env?.CRON_SECRET;
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('CRON_SECRET_NOT_CONFIGURED');
  }

  let response;
  try {
    response = await fetchRequest(endpoint, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${secret}`,
        'Accept': 'application/json',
        'Cache-Control': 'no-store'
      },
      signal: AbortSignal.timeout(12000),
      redirect: 'error'
    });
  } catch {
    log.error('aira_scheduler_transport_failed');
    throw new Error('AIRA_STAGING_SCHEDULER_UNREACHABLE');
  }

  if (!response.ok) {
    // Never log response bodies or request headers: they may contain secrets.
    log.error('aira_scheduler_http_failed', { statusCode: response.status });
    throw new Error(`AIRA_STAGING_SCHEDULER_HTTP_${response.status}`);
  }

  let receipt;
  try {
    receipt = await response.json();
  } catch {
    throw new Error('AIRA_STAGING_SCHEDULER_RECEIPT_INVALID');
  }

  if (!receipt || receipt.status !== 'CRON_CYCLE_EXECUTED' ||
      !Array.isArray(receipt.triggered)) {
    throw new Error('AIRA_STAGING_SCHEDULER_RECEIPT_UNVERIFIED');
  }

  log.info('aira_scheduler_tick_succeeded', {
    triggered: receipt.triggered.length
  });
  return { status: 'DISPATCHED', triggered: receipt.triggered.length };
}

export default {
  async fetch() {
    // Never allow HTTP requests to remotely invoke the scheduler.
    return new Response('Not Found', {
      status: 404,
      headers: { 'Cache-Control': 'no-store' }
    });
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runScheduledTick(env));
  }
};
