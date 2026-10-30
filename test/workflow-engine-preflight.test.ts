import assert from 'node:assert/strict';
import test from 'node:test';
import { runWithDisposablePostgresTestContract } from './helpers/disposable-postgres-test-entry.js';

const validEnvironment = {
  NODE_ENV: 'test',
  CI_DISPOSABLE_DATABASE: 'true',
  DATABASE_URL: 'postgresql://aira_ci_123-456:synthetic@postgres:5432/aira_ci_123-456',
  ISOLATED_TEST_DATABASE_URL: 'postgresql://aira_ci_123-456:synthetic@postgres:5432/aira_ci_123-456',
  CI_EXPECTED_DATABASE_USER: 'aira_ci_123-456',
  CI_EXPECTED_DATABASE_NAME: 'aira_ci_123-456',
  CI_EXPECTED_POSTGRES_ADDRESSES: '["ipv4:172.30.0.2"]'
};

test('missing disposable authorization refuses before preflight or database-suite initiation', async () => {
  let preflightCalls = 0;
  let suiteCalls = 0;
  const env = { ...validEnvironment, CI_DISPOSABLE_DATABASE: undefined };

  await assert.rejects(
    runWithDisposablePostgresTestContract({
      env,
      preflight: () => { preflightCalls += 1; },
      run: () => { suiteCalls += 1; }
    }),
    /identity-verified, run-scoped disposable database contract/
  );

  assert.equal(preflightCalls, 0, 'refusal must occur before the database identity preflight can connect');
  assert.equal(suiteCalls, 0, 'refusal must occur before any database-backed test code is imported or run');
});

test('a localhost DATABASE_URL alone is not authorization and cannot initiate preflight', async () => {
  let preflightCalls = 0;
  let suiteCalls = 0;

  await assert.rejects(
    runWithDisposablePostgresTestContract({
      env: {
        NODE_ENV: 'test',
        DATABASE_URL: 'postgres://aira:aira@localhost:5432/aira_db'
      },
      preflight: () => { preflightCalls += 1; },
      run: () => { suiteCalls += 1; }
    }),
    /identity-verified, run-scoped disposable database contract/
  );

  assert.equal(preflightCalls, 0, 'implicit localhost fallback must not initiate preflight');
  assert.equal(suiteCalls, 0, 'implicit localhost fallback must not initiate the database suite');
});

test('valid disposable contract runs identity preflight before the database suite', async () => {
  const order: string[] = [];

  await runWithDisposablePostgresTestContract({
    env: validEnvironment,
    preflight: () => { order.push('preflight'); },
    run: () => { order.push('suite'); }
  });

  assert.deepEqual(order, ['preflight', 'suite']);
});

test('a failed identity preflight never starts the database suite', async () => {
  let suiteCalls = 0;

  await assert.rejects(
    runWithDisposablePostgresTestContract({
      env: validEnvironment,
      preflight: () => { throw new Error('synthetic preflight rejection'); },
      run: () => { suiteCalls += 1; }
    }),
    /synthetic preflight rejection/
  );

  assert.equal(suiteCalls, 0);
});