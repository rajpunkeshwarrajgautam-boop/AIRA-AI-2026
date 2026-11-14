import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// Execute the same entrypoint that Vercel runs before staging migrations.
// The connection string is a synthetic fixture; these tests never connect
// to PostgreSQL or read real Vercel credentials.
const isolated = 'ep-twilight-cherry-b3iz2oqv.c-4.ap-southeast-1.aws.neon.tech';
const primary = 'ep-shiny-bird-b3xundyt.c-4.ap-southeast-1.aws.neon.tech';

function runGuard(host: string, user = 'aira_staging_runtime', vercelEnv = 'preview', gitRef = 'staging') {
  const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const result = spawnSync(command, ['--no-install', 'tsx', 'scripts/staging-db-guard.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      VERCEL_ENV: vercelEnv,
      VERCEL_GIT_COMMIT_REF: gitRef,
      DATABASE_URL: `postgresql://${user}:test-fixture@${host}/neondb?sslmode=require`
    },
    encoding: 'utf8',
    timeout: 15_000
  });
  if (result.error) throw result.error;
  return result;
}

test('isolated staging branch runtime role is permitted', () => {
  const r = runGuard(isolated);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /isolated staging database verified/);
});

test('Neon default/primary branch is rejected even in preview', () => {
  const r = runGuard(primary);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /STAGING_DB_GUARD/);
});

test('privileged owner role is rejected on isolated staging', () => {
  const r = runGuard(isolated, 'neondb_owner');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /STAGING_DB_GUARD/);
});

test('production environment and other Git branches are refused', () => {
  assert.notEqual(runGuard(isolated, 'aira_staging_runtime', 'production').status, 0);
  assert.notEqual(runGuard(isolated, 'aira_staging_runtime', 'preview', 'prod-release').status, 0);
});
