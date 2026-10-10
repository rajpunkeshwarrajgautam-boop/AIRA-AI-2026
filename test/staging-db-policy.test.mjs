import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stagingMigrationUrl } from '../scripts/staging-db-policy.mjs';

const pooled = 'ep-shiny-bird-b3xundyt-pooler.c-4.ap-southeast-1.aws.neon.tech';
const direct = pooled.replace('-pooler', '');
const fixture = host => `postgresql://fixture:fixture@${host}/neondb?sslmode=require`;
const valid = { VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'staging', DATABASE_URL: fixture(pooled) };

test('staging migrations use the isolated direct endpoint', () => {
  const url = new URL(stagingMigrationUrl(valid));
  assert.equal(url.hostname, direct);
  assert.equal(url.searchParams.get('sslmode'), 'require');
  assert.equal(stagingMigrationUrl({ ...valid, DATABASE_URL: fixture(direct) }), fixture(direct));
  assert.equal(stagingMigrationUrl({ ...valid, DATABASE_URL_UNPOOLED: fixture(direct) }), fixture(direct));
});

const rejected = [
  { VERCEL_ENV: 'production' }, { VERCEL_ENV: undefined },
  { VERCEL_GIT_COMMIT_REF: 'main' }, { VERCEL_GIT_COMMIT_REF: undefined },
  { VERCEL_GIT_COMMIT_REF: 'fix/staging-certification-fixture-20261010' },
  { DATABASE_URL: undefined }, { DATABASE_URL: 'not-a-url' },
  { DATABASE_URL: fixture('production.example.com') },
  { DATABASE_URL: fixture(pooled + '.attacker.example') },
  { DATABASE_URL: fixture(pooled).replace('/neondb', '/other') },
  { DATABASE_URL: fixture(pooled).replace('postgresql:', 'https:') },
  { DATABASE_URL: fixture(pooled).replace('sslmode=require', 'sslmode=disable') },
  { DATABASE_URL: fixture(pooled).replace('/neondb', ':4444/neondb') },
  { DATABASE_URL_UNPOOLED: fixture('production.example.com') },
  { DATABASE_URL_UNPOOLED: fixture(pooled) },
];
for (const [index, override] of rejected.entries()) {
  test(`reject unsafe migration target ${index + 1} without disclosing credentials`, () => {
    assert.throws(() => stagingMigrationUrl({ ...valid, ...override }), error =>
      error.message.startsWith('STAGING_DB_GUARD:') && !error.message.includes('fixture:fixture'));
  });
}
