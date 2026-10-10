// Fail closed if the staging deployment policy or independent DB certification regresses.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
assert.equal(config.framework, 'vite');
assert.equal(config.buildCommand, 'npm run build', 'Vercel frontend build must not migrate or verify any database');
assert.equal(config.installCommand, 'npm ci');
assert.equal(config.outputDirectory, 'dist');

const enabled = config.git?.deploymentEnabled;
assert.ok(enabled && typeof enabled === 'object');
assert.equal(enabled.main, true, 'Keep the existing production branch eligible for Git deployments');
assert.equal(enabled.staging, true, 'Permit staging Preview Git deployments');
assert.equal(enabled['**'], false, 'Suppress unlisted Preview branches (minimatch)');

const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
assert.match(ci, /^  push:$/m, 'Retain development-branch push CI');
assert.match(ci, /^  pull_request:$/m, 'Retain pull request CI');
assert.match(ci, /^  staging-db-readiness:$/m, 'Require an independent live staging DB gate');
assert.match(ci, /environment: staging/, 'Staging live Neon secret must come from a protected environment');
assert.match(ci, /secrets\.AIRA_STAGING_DATABASE_URL/, 'Do not use the production database URL');
assert.match(ci, /npx tsx scripts\/staging-db-guard\.ts/, 'Enforce explicit staging host/branch validation');
assert.match(ci, /run: npm run db:verify:deploy/, 'Keep full deploy database contract verification');
assert.match(ci, /needs: \[fast, semantic-search, certify, staging-db-readiness\]/, 'Block acceptance if live database is unverified');
assert.doesNotMatch(config.buildCommand, /db:migrate|db:verify:deploy|staging-db-guard/);
console.log('PASS: Vercel frontend build and staging-release database verification stay separate; CI remains mandatory.');
