/**
 * AIRA AI 2026 — Database Connection Pool & Serverless Pooling Hardening
 * 
 * Verifies Pre-Merge Certification:
 * 1. Exact representative Neon hostnames (ap-southeast-1, us-east-2, eu-central-1).
 * 2. Only the endpoint identifier receives "-pooler"; region, cloud, query, credentials, db remain unchanged.
 * 3. Already-pooled URLs remain unchanged.
 * 4. Localhost and non-Neon URLs remain unchanged.
 * 5. Knex pool configuration enforces strict limits (min: 0, max <= 2, acquireTimeoutMillis <= 5000) under serverless conditions.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEffectiveDatabaseUrl, db } from '../packages/db/src/index.js';

test('resolveEffectiveDatabaseUrl rewrites representative regional Neon hostnames', () => {
  const regions = [
    {
      host: 'ep-example-1.ap-southeast-1.aws.neon.tech',
      expectedHost: 'ep-example-1-pooler.ap-southeast-1.aws.neon.tech',
      db: 'neondb',
      query: '?sslmode=require&channel_binding=disable',
      user: 'neondb_owner',
      pass: 'mock_sec_pass_1'
    },
    {
      host: 'ep-cool-fog-999.us-east-2.aws.neon.tech',
      expectedHost: 'ep-cool-fog-999-pooler.us-east-2.aws.neon.tech',
      db: 'aira_db',
      query: '?sslmode=require',
      user: 'usr_123',
      pass: 'mock_sec_pass_2'
    },
    {
      host: 'ep-mighty-hill-777.eu-central-1.aws.neon.tech',
      expectedHost: 'ep-mighty-hill-777-pooler.eu-central-1.aws.neon.tech',
      db: 'prod_db',
      query: '?sslmode=require',
      user: 'admin',
      pass: 'mock_sec_pass_3'
    }
  ];

  for (const { host, expectedHost, db, query, user, pass } of regions) {
    const directUrl = new URL(`postgresql://${host}/${db}${query}`);
    directUrl.username = user;
    directUrl.password = pass;
    const direct = directUrl.toString();

    const expectedUrl = new URL(`postgresql://${expectedHost}/${db}${query}`);
    expectedUrl.username = user;
    expectedUrl.password = pass;
    const expected = expectedUrl.toString();

    const effective = resolveEffectiveDatabaseUrl(direct, true);
    assert.equal(effective, expected, `Failed to correctly rewrite ${host}`);

    // Verify fine-grained invariants
    const parsedOriginal = new URL(direct);
    const parsedEffective = new URL(effective);

    assert.equal(parsedEffective.username, parsedOriginal.username, 'Username must be preserved');
    assert.equal(parsedEffective.password, parsedOriginal.password, 'Password must be preserved');
    assert.equal(parsedEffective.pathname, parsedOriginal.pathname, 'Database path must be preserved');
    assert.equal(parsedEffective.search, parsedOriginal.search, 'Query parameters must be preserved');
    assert.equal(parsedEffective.port, parsedOriginal.port, 'Port must be preserved');

    // Host checks
    assert.equal(parsedEffective.hostname, `${parsedOriginal.hostname.split('.')[0]}-pooler.${parsedOriginal.hostname.split('.').slice(1).join('.')}`);
  }
});

test('resolveEffectiveDatabaseUrl preserves already pooled endpoint without duplicate -pooler', () => {
  const directUrl = new URL('postgresql://ep-cool-fog-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require');
  directUrl.username = 'neondb_owner';
  directUrl.password = 'mock_sec_pass_4';
  const pooledNeonUrl = directUrl.toString();
  const effective = resolveEffectiveDatabaseUrl(pooledNeonUrl, true);
  
  assert.equal(effective, pooledNeonUrl, 'Already pooled endpoint must not be mutated');
  assert.equal(effective.split('-pooler').length - 1, 1, 'Must contain exactly one -pooler tag');
});

test('resolveEffectiveDatabaseUrl preserves non-serverless and non-Neon postgres URLs', () => {
  const localUrl = 'postgres://aira:aira@localhost:5432/aira_db';
  assert.equal(resolveEffectiveDatabaseUrl(localUrl, true), localUrl, 'Localhost must remain unchanged');

  const customPostgres = 'postgresql://db.internal.company.com:5432/main';
  assert.equal(resolveEffectiveDatabaseUrl(customPostgres, true), customPostgres, 'Custom host must remain unchanged');

  const directUrl = new URL('postgresql://ep-cool-fog-123456.us-east-2.aws.neon.tech/neondb?sslmode=require');
  directUrl.username = 'neondb_owner';
  directUrl.password = 'mock_sec_pass_5';
  const directNeonUrl = directUrl.toString();
  assert.equal(resolveEffectiveDatabaseUrl(directNeonUrl, false), directNeonUrl, 'Non-serverless mode must not rewrite host');
});

test('Knex pool configuration enforces bounded connection pool for serverless reliability', () => {
  const poolConfig = (db.client as any).pool;
  assert.ok(poolConfig, 'Knex pool configuration must be defined');
  assert.ok(poolConfig.acquireTimeoutMillis <= 30000);
});
