import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {
  validateStagingEndpoint,
  runScheduledTick
} from '../infra/cloudflare/aira-ai-scheduler/src/worker.mjs';

const STAGING =
  'https://aira-ai-2026-staging123-rajpunkeshwarrajgautam-boops-projects.vercel.app/api/automations/cron/execute';
const SECRET = 'test-only-not-a-real-secret-1234567890abcdef';

test('disabled Cron never calls an endpoint (even without bindings)', async () => {
  let calls = 0;
  const log = { info() {}, error() {} };
  const out = await runScheduledTick({}, {
    log,
    fetch: async () => { calls += 1; throw Error('unexpected'); }
  });
  assert.deepEqual(out, { status: 'SKIPPED', reason: 'disabled' });
  assert.equal(calls, 0);
});

test('only this project staging previews can be targeted', () => {
  assert.equal(validateStagingEndpoint(STAGING), STAGING);
  for (const url of [
    'https://aira-ai-2026.vercel.app/api/automations/cron/execute',
    'https://aira-ai.in/api/automations/cron/execute',
    'http://aira-ai-2026-staging123-rajpunkeshwarrajgautam-boops-projects.vercel.app/api/automations/cron/execute',
    'https://evil.example/api/automations/cron/execute',
    'https://aira-ai-2026-staging123-rajpunkeshwarrajgautam-boops-projects.vercel.app/api/not-cron',
    STAGING + '?token=something',
    'https://someone:secret@aira-ai-2026-staging123-rajpunkeshwarrajgautam-boops-projects.vercel.app/api/automations/cron/execute',
  ]) {
    assert.throws(() => validateStagingEndpoint(url));
  }
});

test('missing secret fails closed, never sends requests', async () => {
  let calls = 0;
  await assert.rejects(
    runScheduledTick({
      DISPATCH_ENABLED: 'true', AIRA_STAGING_SCHEDULER_URL: STAGING
    }, { fetch: () => { calls++; return Promise.resolve(); } }),
    /CRON_SECRET_NOT_CONFIGURED/
  );
  assert.equal(calls, 0);
});

test('valid staging sends exactly one authenticated GET and checks execution receipt', async () => {
  const seen = [], events = [];
  const env = {
    DISPATCH_ENABLED: 'true',
    AIRA_STAGING_SCHEDULER_URL: STAGING,
    CRON_SECRET: SECRET
  };
  const result = await runScheduledTick(env, {
    fetch: async (url, init) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({
        status: 'CRON_CYCLE_EXECUTED',
        triggered: ['run-a']
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    log: { info: (...args) => events.push(args), error: () => {} }
  });
  assert.deepEqual(result, { status: 'DISPATCHED', triggered: 1 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, STAGING);
  assert.equal(seen[0].init.method, 'GET');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer ' + SECRET);
  assert.ok(!JSON.stringify(events).includes(SECRET), 'no credential exposure in logs');
});

test('HTTP errors and unverified responses fail closed without retry loops', async () => {
  let count = 0;
  const env = {
    DISPATCH_ENABLED: 'true', AIRA_STAGING_SCHEDULER_URL: STAGING, CRON_SECRET: SECRET
  };
  await assert.rejects(
    runScheduledTick(env, {
      fetch: async () => { count++; return new Response('down', { status: 503 }); },
      log: { error() {} }
    }), /AIRA_STAGING_SCHEDULER_HTTP_503/
  );
  assert.equal(count, 1, 'no hidden retries');
  await assert.rejects(
    runScheduledTick(env, {
      fetch: async () => new Response(JSON.stringify({ status: 'HEALTHY' }), { status: 200 })
    }), /RECEIPT_UNVERIFIED/
  );
});

test('public HTTP fetch cannot execute scheduled tasks', async () => {
  const response = await worker.fetch();
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('scheduled event sends one waitUntil operation, staying disabled by default', async () => {
  let promise;
  const out = worker.scheduled({}, { DISPATCH_ENABLED: 'false' }, {
    waitUntil(p) { promise = p; }
  });
  await out;
  const result = await promise;
  assert.equal(result.status, 'SKIPPED');
});
