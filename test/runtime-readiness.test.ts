import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateRuntimeReadiness } from '../apps/api/src/runtime-readiness.js';

test('deployed preview cannot report Agent readiness without DATABASE_URL', () => {
  assert.deepEqual(evaluateRuntimeReadiness('HEALTHY', {
    VERCEL: '1', NODE_ENV: 'production'
  }), {
    ready: false, status: 'NOT_READY', reason: 'AGENT_DATABASE_NOT_CONFIGURED'
  });
});

test('production deployment cannot report Agent readiness with a blank DATABASE_URL', () => {
  assert.equal(evaluateRuntimeReadiness('HEALTHY', {
    NODE_ENV: 'production', DATABASE_URL: '  '
  }).ready, false);
});

test('a configured deployment retains the startup/recovery readiness barrier', () => {
  const env = { VERCEL: '1', DATABASE_URL: 'postgres://example.invalid/app' };
  assert.equal(evaluateRuntimeReadiness('STARTING', env).ready, false);
  assert.equal(evaluateRuntimeReadiness('RECOVERING', env).ready, false);
  assert.equal(evaluateRuntimeReadiness('FAILED', env).ready, false);
  assert.deepEqual(evaluateRuntimeReadiness('HEALTHY', env), { ready: true, status: 'READY' });
});

test('local development remains operable without a persistent database', () => {
  assert.deepEqual(evaluateRuntimeReadiness('HEALTHY', { NODE_ENV: 'development' }), {
    ready: true, status: 'READY'
  });
});
