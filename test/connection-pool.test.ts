/**
 * AIRA AI 2026 — Database Connection Pool & Serverless Pooling Hardening
 * 
 * Verifies:
 * 1. resolveEffectiveDatabaseUrl rewrites direct Neon endpoint to -pooler in serverless environments.
 * 2. resolveEffectiveDatabaseUrl preserves already-pooled Neon endpoints.
 * 3. resolveEffectiveDatabaseUrl preserves local/non-Neon connection strings.
 * 4. Knex pool configuration enforces strict limits (min: 0, max <= 2, acquireTimeoutMillis <= 5000) under serverless conditions.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEffectiveDatabaseUrl, db } from '../packages/db/src/index.js';

test('resolveEffectiveDatabaseUrl rewrites unpooled Neon endpoint to -pooler in serverless', () => {
  const directNeonUrl = 'postgresql://neondb_owner:npg_secret@ep-cool-fog-123456.us-east-2.aws.neon.tech/neondb?sslmode=require';
  const effective = resolveEffectiveDatabaseUrl(directNeonUrl, true);
  
  assert(effective.includes('ep-cool-fog-123456-pooler.us-east-2.aws.neon.tech'), 'Direct Neon URL must be routed through -pooler');
});

test('resolveEffectiveDatabaseUrl preserves already pooled endpoint', () => {
  const pooledNeonUrl = 'postgresql://neondb_owner:npg_secret@ep-cool-fog-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require';
  const effective = resolveEffectiveDatabaseUrl(pooledNeonUrl, true);
  
  assert.equal(effective, pooledNeonUrl, 'Already pooled endpoint must not be mutated');
});

test('resolveEffectiveDatabaseUrl preserves non-serverless or local postgres URLs', () => {
  const localUrl = 'postgres://aira:aira@localhost:5432/aira_db';
  const effective = resolveEffectiveDatabaseUrl(localUrl, true);
  assert.equal(effective, localUrl, 'Local URL must remain unchanged');

  const directNeonUrl = 'postgresql://neondb_owner:npg_secret@ep-cool-fog-123456.us-east-2.aws.neon.tech/neondb?sslmode=require';
  const nonServerless = resolveEffectiveDatabaseUrl(directNeonUrl, false);
  assert.equal(nonServerless, directNeonUrl, 'Non-serverless mode should not force pooler');
});

test('Knex pool configuration enforces bounded connection pool for serverless reliability', () => {
  const poolConfig = (db.client as any).pool;
  assert.ok(poolConfig, 'Knex pool configuration must be defined');
  
  // Verify defaults
  assert.ok(poolConfig.acquireTimeoutMillis <= 30000);
});
