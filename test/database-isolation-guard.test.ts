import assert from 'node:assert/strict';
import {
  classifyDatabaseUrl,
  validateDatabaseEnvironment,
  sanitizeConnectionEndpoint,
  assertCanRunMigrations,
  validateOAuthOrigin,
  verifyDatabaseIdentityFromEvidence,
  NEON_CONTROL_PLANE_REGISTRY,
  PRODUCTION_NEON_PROJECT_ID,
  PRODUCTION_NEON_BRANCH_ID,
  PRODUCTION_NEON_ENDPOINT_ID,
  STAGING_NEON_PROJECT_ID,
  STAGING_NEON_BRANCH_ID,
  STAGING_NEON_ENDPOINT_ID,
  COMMERCIAL_PR92_BRANCH_ID,
  COMMERCIAL_PR92_ENDPOINT_ID,
  STAGING_CANONICAL_DOMAIN,
  STAGING_VERCEL_PREVIEW_HOST,
  PRODUCTION_CANONICAL_HOST
} from '../packages/db/src/security/database-isolation-guard.js';

console.log('\n=== AIRA AI 2026 — DATABASE ISOLATION & ENVIRONMENT CROSSOVER TESTS ===\n');

// Test URLs (using standard Neon endpoint URLs without embedded passwords)
const prodDirectUrl = `postgresql://neondb_owner@${PRODUCTION_NEON_ENDPOINT_ID}.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`;
const prodPooledUrl = `postgresql://neondb_owner@${PRODUCTION_NEON_ENDPOINT_ID}-pooler.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`;
const stagingDirectUrl = `postgresql://neondb_owner@${STAGING_NEON_ENDPOINT_ID}.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`;
const stagingPooledUrl = `postgresql://neondb_owner@${STAGING_NEON_ENDPOINT_ID}-pooler.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`;
const commercialPr92Url = `postgresql://neondb_owner@${COMMERCIAL_PR92_ENDPOINT_ID}.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`;
const featurePreviewUrl = `postgresql://neondb_owner@ep-custom-feature-b31234.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`;
const localTestUrl = 'postgres://aira:aira@localhost:5432/aira_db';
const ciServiceContainerUrl = 'postgres://aira:aira@127.0.0.1:5432/aira_db';

let passed = 0;

function runTest(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(err);
    process.exit(1);
  }
}

// 1. Classification Tests
runTest('Classify Production direct endpoint', () => {
  const res = classifyDatabaseUrl(prodDirectUrl);
  assert.equal(res.category, 'production');
  assert.equal(res.isProduction, true);
  assert.equal(res.isStagingPermanent, false);
  assert.equal(res.projectId, PRODUCTION_NEON_PROJECT_ID);
});

runTest('Classify Production pooled endpoint', () => {
  const res = classifyDatabaseUrl(prodPooledUrl);
  assert.equal(res.category, 'production');
  assert.equal(res.isProduction, true);
});

runTest('Classify Staging main endpoint', () => {
  const res = classifyDatabaseUrl(stagingDirectUrl);
  assert.equal(res.category, 'staging_permanent');
  assert.equal(res.isStagingPermanent, true);
  assert.equal(res.isProduction, false);
  assert.equal(res.projectId, STAGING_NEON_PROJECT_ID);
});

runTest('Classify Staging main pooled endpoint', () => {
  const res = classifyDatabaseUrl(stagingPooledUrl);
  assert.equal(res.category, 'staging_permanent');
  assert.equal(res.isStagingPermanent, true);
});

runTest('Classify Commercial PR #92 branch endpoint', () => {
  const res = classifyDatabaseUrl(commercialPr92Url);
  assert.equal(res.category, 'commercial_pr92');
  assert.equal(res.isCommercialPr92, true);
  assert.equal(res.isProduction, false);
  assert.equal(res.isStagingPermanent, false);
});

runTest('Classify local and CI test container endpoints', () => {
  assert.equal(classifyDatabaseUrl(localTestUrl).category, 'local_or_ci_test');
  assert.equal(classifyDatabaseUrl(ciServiceContainerUrl).category, 'local_or_ci_test');
});

runTest('Classify generic feature preview Neon endpoint', () => {
  const res = classifyDatabaseUrl(featurePreviewUrl);
  assert.equal(res.category, 'isolated_neon_preview');
  assert.equal(res.isProduction, false);
});

// 2. Secret Sanitization Tests
runTest('Sanitize connection endpoint strips passwords', () => {
  const dummyPassUrl = ['postgresql://testuser', 'samplepwd@ep-shiny-bird-b3xundyt.neon.tech/neondb'].join(':');
  const { sanitized } = sanitizeConnectionEndpoint(dummyPassUrl);
  assert.ok(!sanitized.includes('samplepwd'), 'Sanitized output must never include password');
  assert.ok(sanitized.includes('testuser@ep-shiny-bird-b3xundyt.neon.tech/neondb'));
});

// 3. Environment Crossover Prevention Tests
runTest('REJECT Production DB in Preview environment', () => {
  const res = validateDatabaseEnvironment(prodDirectUrl, 'preview');
  assert.equal(res.valid, false);
  assert.equal(res.code, 'ENVIRONMENT_CROSSOVER_VIOLATION_PRODUCTION_DB_IN_NON_PROD');
});

runTest('REJECT Production DB in Staging environment', () => {
  const res = validateDatabaseEnvironment(prodDirectUrl, 'staging');
  assert.equal(res.valid, false);
  assert.equal(res.code, 'ENVIRONMENT_CROSSOVER_VIOLATION_PRODUCTION_DB_IN_NON_PROD');
});

runTest('REJECT Production DB in CI Test environment', () => {
  const res = validateDatabaseEnvironment(prodDirectUrl, 'test');
  assert.equal(res.valid, false);
  assert.equal(res.code, 'ENVIRONMENT_CROSSOVER_VIOLATION_PRODUCTION_DB_IN_NON_PROD');
});

runTest('REJECT Non-Production DB in Production environment', () => {
  const resStaging = validateDatabaseEnvironment(stagingDirectUrl, 'production');
  assert.equal(resStaging.valid, false);
  assert.equal(resStaging.code, 'PRODUCTION_ENVIRONMENT_DATABASE_MISMATCH');

  const resPreview = validateDatabaseEnvironment(featurePreviewUrl, 'production');
  assert.equal(resPreview.valid, false);
  assert.equal(resPreview.code, 'PRODUCTION_ENVIRONMENT_DATABASE_MISMATCH');
});

runTest('ACCEPT Production DB in Production environment', () => {
  const res = validateDatabaseEnvironment(prodDirectUrl, 'production');
  assert.equal(res.valid, true);
  assert.equal(res.code, 'PRODUCTION_DATABASE_VERIFIED');
});

runTest('ACCEPT Permanent Staging DB in Staging environment', () => {
  const res = validateDatabaseEnvironment(stagingDirectUrl, 'staging');
  assert.equal(res.valid, true);
  assert.equal(res.code, 'STAGING_DATABASE_VERIFIED');
});

runTest('REJECT arbitrary preview DB in permanent Staging environment', () => {
  const res = validateDatabaseEnvironment(featurePreviewUrl, 'staging');
  assert.equal(res.valid, false);
  assert.equal(res.code, 'PERMANENT_STAGING_DATABASE_MISMATCH');
});

// 4. Commercial PR #92 Isolation Tests
runTest('REJECT Commercial PR #92 DB in generic pipeline by default', () => {
  const res = validateDatabaseEnvironment(commercialPr92Url, 'preview');
  assert.equal(res.valid, false);
  assert.equal(res.code, 'COMMERCIAL_BRANCH_MUTATION_RESTRICTED');
});

runTest('PERMIT Commercial PR #92 DB only when explicitly authorized', () => {
  const res = validateDatabaseEnvironment(commercialPr92Url, 'preview', { allowCommercialPr92: true });
  assert.equal(res.valid, true);
  assert.equal(res.code, 'PREVIEW_DATABASE_VERIFIED');
});

// 5. Migration Guard Tests
runTest('Migration guard blocks unapproved production migrations', () => {
  assert.throws(
    () => assertCanRunMigrations(prodDirectUrl, 'production', false),
    /PRODUCTION_MIGRATION_BLOCKED/
  );
});

runTest('Migration guard blocks production migration from non-production target', () => {
  assert.throws(
    () => assertCanRunMigrations(prodDirectUrl, 'preview', true),
    /Attempted to run migrations against Production Neon DB from preview environment/
  );
});

runTest('Migration guard permits production migration when authorized and target is production', () => {
  assert.doesNotThrow(() => assertCanRunMigrations(prodDirectUrl, 'production', true));
});

runTest('Migration guard blocks Commercial PR #92 migration from CI/CD pipeline', () => {
  assert.throws(
    () => assertCanRunMigrations(commercialPr92Url, 'preview'),
    /COMMERCIAL_BRANCH_MIGRATION_BLOCKED/
  );
});

runTest('Migration guard permits staging migration on staging target', () => {
  assert.doesNotThrow(() => assertCanRunMigrations(stagingDirectUrl, 'staging'));
});

// 6. OAuth Origin Validation Tests
runTest('OAuth origin validator accepts canonical production origin', () => {
  const res = validateOAuthOrigin(`https://${PRODUCTION_CANONICAL_HOST}`, 'production');
  assert.equal(res.valid, true);
  assert.equal(res.code, 'PRODUCTION_ORIGIN_VERIFIED');
});

runTest('OAuth origin validator rejects non-production origin in production', () => {
  const res = validateOAuthOrigin(`https://${STAGING_CANONICAL_DOMAIN}`, 'production');
  assert.equal(res.valid, false);
  assert.equal(res.code, 'INVALID_PRODUCTION_ORIGIN');
});

runTest('OAuth origin validator accepts staging domain and preview host', () => {
  const res1 = validateOAuthOrigin(`https://${STAGING_CANONICAL_DOMAIN}`, 'staging');
  assert.equal(res1.valid, true);
  assert.equal(res1.code, 'STAGING_ORIGIN_VERIFIED');

  const res2 = validateOAuthOrigin(`https://${STAGING_VERCEL_PREVIEW_HOST}`, 'staging');
  assert.equal(res2.valid, true);
  assert.equal(res2.code, 'STAGING_ORIGIN_VERIFIED');
});

runTest('OAuth origin validator rejects production origin in staging', () => {
  const res = validateOAuthOrigin(`https://${PRODUCTION_CANONICAL_HOST}`, 'staging');
  assert.equal(res.valid, false);
  assert.equal(res.code, 'PRODUCTION_ORIGIN_IN_STAGING');
});

runTest('OAuth origin validator accepts local development origins', () => {
  const res1 = validateOAuthOrigin('http://localhost:5173', 'local');
  assert.equal(res1.valid, true);
  const res2 = validateOAuthOrigin('http://127.0.0.1:5173', 'local');
  assert.equal(res2.valid, true);
});

// 7. Neon Control-Plane Registry & Authenticated Database Identity Tests
runTest('Neon Control-Plane Registry has exact certified projects and endpoints', () => {
  assert.equal(NEON_CONTROL_PLANE_REGISTRY.production.projectId, PRODUCTION_NEON_PROJECT_ID);
  assert.equal(NEON_CONTROL_PLANE_REGISTRY.production.defaultBranchId, PRODUCTION_NEON_BRANCH_ID);
  assert.equal(NEON_CONTROL_PLANE_REGISTRY.production.primaryEndpointId, PRODUCTION_NEON_ENDPOINT_ID);

  assert.equal(NEON_CONTROL_PLANE_REGISTRY.staging_permanent.projectId, STAGING_NEON_PROJECT_ID);
  assert.equal(NEON_CONTROL_PLANE_REGISTRY.staging_permanent.defaultBranchId, STAGING_NEON_BRANCH_ID);
  assert.equal(NEON_CONTROL_PLANE_REGISTRY.staging_permanent.primaryEndpointId, STAGING_NEON_ENDPOINT_ID);

  assert.equal(NEON_CONTROL_PLANE_REGISTRY.commercial_pr92.projectId, STAGING_NEON_PROJECT_ID);
  assert.equal(NEON_CONTROL_PLANE_REGISTRY.commercial_pr92.defaultBranchId, COMMERCIAL_PR92_BRANCH_ID);
  assert.equal(NEON_CONTROL_PLANE_REGISTRY.commercial_pr92.primaryEndpointId, COMMERCIAL_PR92_ENDPOINT_ID);
});

runTest('Database identity check ACCEPTS authentic Staging control-plane metadata', () => {
  const res = verifyDatabaseIdentityFromEvidence({
    databaseName: 'neondb',
    user: 'neondb_owner',
    neonProjectId: STAGING_NEON_PROJECT_ID,
    neonBranchId: STAGING_NEON_BRANCH_ID,
    neonEndpointId: STAGING_NEON_ENDPOINT_ID
  }, 'staging_permanent');

  assert.equal(res.ok, true);
  assert.equal(res.code, 'AUTHENTICATED_STAGING_IDENTITY_VERIFIED');
  assert.equal(res.identity.controlPlaneVerified, true);
  assert.equal(res.identity.endpointMatch, true);
});

runTest('Database identity check ACCEPTS authentic Production control-plane metadata', () => {
  const res = verifyDatabaseIdentityFromEvidence({
    databaseName: 'neondb',
    user: 'neondb_owner',
    neonProjectId: PRODUCTION_NEON_PROJECT_ID,
    neonBranchId: PRODUCTION_NEON_BRANCH_ID,
    neonEndpointId: PRODUCTION_NEON_ENDPOINT_ID
  }, 'production');

  assert.equal(res.ok, true);
  assert.equal(res.code, 'AUTHENTICATED_PRODUCTION_IDENTITY_VERIFIED');
  assert.equal(res.identity.controlPlaneVerified, true);
});

runTest('Database identity check REJECTS Production DB identity in Staging', () => {
  const res = verifyDatabaseIdentityFromEvidence({
    databaseName: 'neondb',
    user: 'neondb_owner',
    neonProjectId: PRODUCTION_NEON_PROJECT_ID,
    neonEndpointId: PRODUCTION_NEON_ENDPOINT_ID
  }, 'staging_permanent');

  assert.equal(res.ok, false);
  assert.equal(res.code, 'CRITICAL_SECURITY_VIOLATION_PRODUCTION_DB_IN_STAGING');
  assert.equal(res.identity.endpointMatch, false);
});

runTest('Database identity check REJECTS Staging DB identity in Production', () => {
  const res = verifyDatabaseIdentityFromEvidence({
    databaseName: 'neondb',
    user: 'neondb_owner',
    neonProjectId: STAGING_NEON_PROJECT_ID,
    neonEndpointId: STAGING_NEON_ENDPOINT_ID
  }, 'production');

  assert.equal(res.ok, false);
  assert.equal(res.code, 'CRITICAL_SECURITY_VIOLATION_STAGING_DB_IN_PRODUCTION');
  assert.equal(res.identity.endpointMatch, false);
});

runTest('Database identity check REJECTS Commercial PR #92 branch in Staging pipeline', () => {
  const res = verifyDatabaseIdentityFromEvidence({
    databaseName: 'neondb',
    user: 'neondb_owner',
    neonProjectId: STAGING_NEON_PROJECT_ID,
    neonBranchId: COMMERCIAL_PR92_BRANCH_ID,
    neonEndpointId: COMMERCIAL_PR92_ENDPOINT_ID
  }, 'staging_permanent');

  assert.equal(res.ok, false);
  assert.equal(res.code, 'COMMERCIAL_BRANCH_MUTATION_RESTRICTED');
});

runTest('Database identity check REJECTS unrecognized project IDs in Staging', () => {
  const res = verifyDatabaseIdentityFromEvidence({
    databaseName: 'neondb',
    user: 'neondb_owner',
    neonProjectId: 'unrecognized-project-12345',
    neonEndpointId: 'ep-random-endpoint-999'
  }, 'staging_permanent');

  assert.equal(res.ok, false);
  assert.equal(res.code, 'PERMANENT_STAGING_DATABASE_MISMATCH');
});

console.log(`\nAll ${passed} Database Isolation & Environment Crossover tests PASSED successfully!\n`);
