import test from 'node:test';
import assert from 'node:assert/strict';
import { down } from '../packages/db/src/migrations/030_principal_workspace_authority.js';

test('workspace authority migration refuses destructive rollback without disposable PostgreSQL certification', async () => {
  const keys = ['NODE_ENV', 'CI_DISPOSABLE_DATABASE', 'DATABASE_URL', 'ISOLATED_TEST_DATABASE_URL'] as const;
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  let dropAttempted = false;

  process.env.NODE_ENV = 'test';
  delete process.env.CI_DISPOSABLE_DATABASE;
  process.env.DATABASE_URL = 'postgresql://not-used@postgres:5432/not-used';
  process.env.ISOLATED_TEST_DATABASE_URL = process.env.DATABASE_URL;

  try {
    await assert.rejects(
      () => down({
        schema: {
          dropTableIfExists: async () => { dropAttempted = true; }
        }
      } as any),
      /verified disposable PostgreSQL certification is required/
    );
    assert.equal(dropAttempted, false, 'Destructive DDL must not execute before the disposable-target guard passes.');
  } finally {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
});
