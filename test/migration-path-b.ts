// Migration Path B: Simulate old DB that never got artifacts column, then run 006
import { pathToFileURL } from 'url';
import path from 'path';
import { execFileSync } from 'node:child_process';

async function sim() {
  // This test independently drops/recreates public schema; fail closed before
  // loading a database client or issuing any SQL unless the disposable target
  // and its private network identity have been verified.
  execFileSync(process.execPath, ['scripts/ci/assert-disposable-postgres.mjs'], { stdio: 'inherit' });
  const dbModule = await import(pathToFileURL(path.resolve('./packages/db/src/index.ts')).href as string);
  const db = (dbModule as any).db;

  // Start from scratch
  await db.raw('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.migrate.latest();

  // Simulate the old 003 by removing the column that the modified 003 added
  await db.schema.alterTable('runs', (t: any) => t.dropColumn('artifacts'));

  const existsBefore = await db.schema.hasColumn('runs', 'artifacts');
  if (existsBefore) {
    console.error('FAIL: setup failed to drop artifacts column');
    process.exit(1);
  }

  // Remove 006 record so it can re-run
  await db.raw(`DELETE FROM knex_migrations WHERE name = '006_phase3_3_runs_artifacts_compat.ts'`);

  // Run migrations again — 006 should add the column
  await db.migrate.latest();

  const existsAfter = await db.schema.hasColumn('runs', 'artifacts');
  if (!existsAfter) {
    console.error('FAIL: artifacts column still missing after 006 ran');
    process.exit(1);
  }

  console.log('PASS: artifacts column added by 006 on existing DB');
  process.exit(0);
}

sim().catch((err: any) => {
  console.error('FAIL:', err);
  process.exit(1);
});
