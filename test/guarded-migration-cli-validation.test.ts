import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseGuardedMigrationCliArgs,
  validateTargetConnectionUrl,
  CANONICAL_PRODUCTION_ENDPOINT_ID,
  APPROVED_REHEARSAL_ENDPOINT_ID,
} from '../scripts/run-guarded-migration-032.js';

test('CLI: rejects empty arguments', () => {
  assert.throws(() => parseGuardedMigrationCliArgs([]), /Missing required execution target/);
});

test('CLI: rejects positional arguments', () => {
  assert.throws(() => parseGuardedMigrationCliArgs(['production']), /Unexpected positional argument/);
  assert.throws(() => parseGuardedMigrationCliArgs(['--target=disposable_test', 'extra']), /Unexpected positional argument/);
});

test('CLI: rejects unknown flags', () => {
  assert.throws(() => parseGuardedMigrationCliArgs(['--dry-run']), /Unrecognized flag/);
  assert.throws(() => parseGuardedMigrationCliArgs(['--target=disposable_test', '--skip-locking']), /Unrecognized flag/);
  assert.throws(() => parseGuardedMigrationCliArgs(['-target=production']), /Unexpected positional argument|Unrecognized flag/);
});

test('CLI: rejects duplicate arguments', () => {
  assert.throws(() => parseGuardedMigrationCliArgs(['--target=rehearsal', '--target=rehearsal']), /Duplicate argument/);
});

test('CLI: rejects invalid target value', () => {
  assert.throws(() => parseGuardedMigrationCliArgs(['--target=staging']), /Invalid target environment/);
  assert.throws(() => parseGuardedMigrationCliArgs(['--target=prod']), /Invalid target environment/);
});

test('CLI: rejects production target without explicit authorization flag', () => {
  assert.throws(
    () => parseGuardedMigrationCliArgs(['--target=production']),
    /mandatory authorization flag "--authorize-production-migration-032-execute" was not provided/
  );
});

test('CLI: rejects production authorization flag on non-production targets', () => {
  assert.throws(
    () => parseGuardedMigrationCliArgs(['--target=rehearsal', '--authorize-production-migration-032-execute']),
    /is only permitted with --target=production/
  );
  assert.throws(
    () => parseGuardedMigrationCliArgs(['--target=disposable_test', '--authorize-production-migration-032-execute']),
    /is only permitted with --target=production/
  );
});

test('CLI: accepts exact valid forms', () => {
  const prod = parseGuardedMigrationCliArgs(['--target=production', '--authorize-production-migration-032-execute']);
  assert.equal(prod.targetEnv, 'production');
  assert.equal(prod.isProdAuth, true);

  const rehearsal = parseGuardedMigrationCliArgs(['--target=rehearsal']);
  assert.equal(rehearsal.targetEnv, 'rehearsal');
  assert.equal(rehearsal.isProdAuth, false);

  const testTarget = parseGuardedMigrationCliArgs(['--target=disposable_test']);
  assert.equal(testTarget.targetEnv, 'disposable_test');
  assert.equal(testTarget.isProdAuth, false);
});

test('Preflight URL: validates production endpoint strictly and rejects spoofing/substring matches', () => {
  // Canonical pooled URL
  const validPooled = ['postgresql://neondb_owner', `mock_pass@${CANONICAL_PRODUCTION_ENDPOINT_ID}-pooler.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`].join(':');
  assert.doesNotThrow(() => validateTargetConnectionUrl('production', validPooled));

  // Canonical direct URL
  const validDirect = ['postgresql://neondb_owner', `mock_pass@${CANONICAL_PRODUCTION_ENDPOINT_ID}.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`].join(':');
  assert.doesNotThrow(() => validateTargetConnectionUrl('production', validDirect));

  // Substring spoofing in attacker domain
  const spoofedDomain = ['postgresql://neondb_owner', `mock_pass@${CANONICAL_PRODUCTION_ENDPOINT_ID}.attacker.com/neondb`].join(':');
  assert.throws(() => validateTargetConnectionUrl('production', spoofedDomain), /must reside on the \.neon\.tech domain/);

  // Substring match in path or query
  const querySpoof = ['postgresql://user', `mock_pass@ep-other-id.neon.tech/neondb?leak=${CANONICAL_PRODUCTION_ENDPOINT_ID}`].join(':');
  assert.throws(() => validateTargetConnectionUrl('production', querySpoof), /does not match canonical Neon production endpoint/);

  // Wrong database name on production endpoint
  const wrongDb = ['postgresql://neondb_owner', `mock_pass@${CANONICAL_PRODUCTION_ENDPOINT_ID}.c-4.ap-southeast-1.aws.neon.tech/staging_db`].join(':');
  assert.throws(() => validateTargetConnectionUrl('production', wrongDb), /does not match canonical production database "neondb"/);
});

test('Preflight URL: validates rehearsal endpoint and rejects arbitrary branches', () => {
  const validRehearsal = ['postgresql://user', `mock_pass@${APPROVED_REHEARSAL_ENDPOINT_ID}.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`].join(':');
  assert.doesNotThrow(() => validateTargetConnectionUrl('rehearsal', validRehearsal));

  const unapprovedBranch = ['postgresql://user', 'mock_pass@ep-random-unapproved.neon.tech/neondb'].join(':');
  assert.throws(() => validateTargetConnectionUrl('rehearsal', unapprovedBranch), /does not match approved rehearsal branch endpoint/);
});

test('Preflight URL: validates disposable_test and restricts to local/CI hosts', () => {
  assert.doesNotThrow(() => validateTargetConnectionUrl('disposable_test', ['postgresql://postgres', 'mock_pass@127.0.0.1:5432/test_db'].join(':')));
  assert.doesNotThrow(() => validateTargetConnectionUrl('disposable_test', ['postgresql://postgres', 'mock_pass@localhost:5432/test_db'].join(':')));
  assert.doesNotThrow(() => validateTargetConnectionUrl('disposable_test', ['postgresql://postgres', 'mock_pass@postgres:5432/test_db'].join(':')));

  // Remote hosts are rejected for disposable_test
  assert.throws(
    () => validateTargetConnectionUrl('disposable_test', ['postgresql://user', 'mock_pass@remote.host.com:5432/db'].join(':')),
    /not a recognized local or CI container host/
  );
});

test('package.json: defines db:migrate:032 invoking guarded runner scripts/run-guarded-migration-032.ts', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const pkgPath = path.resolve(process.cwd(), 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  assert.equal(
    pkg.scripts['db:migrate:032'],
    'npx tsx scripts/run-guarded-migration-032.ts',
    'Root package.json must define db:migrate:032 invoking scripts/run-guarded-migration-032.ts'
  );
});

test('CLI process invocation: fails closed when invoked without mandatory flags', async () => {
  const { execSync } = await import('node:child_process');
  
  // 1. No arguments: exits 1 with CLI_ERROR
  assert.throws(() => {
    execSync('npm run db:migrate:032', { stdio: 'pipe' });
  }, (err: any) => {
    return err.status === 1 && err.stderr.toString().includes('[CLI_ERROR] Missing required execution target');
  });

  // 2. Production target without auth flag: exits 1 with CLI_ERROR
  assert.throws(() => {
    execSync('npm run db:migrate:032 -- --target=production', { stdio: 'pipe' });
  }, (err: any) => {
    return err.status === 1 && err.stderr.toString().includes('mandatory authorization flag "--authorize-production-migration-032-execute" was not provided');
  });
});

