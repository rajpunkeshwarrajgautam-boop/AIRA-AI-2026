import path from 'path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'url';

async function validate() {
  if (process.env.AIRA_POSTGRES_CERTIFICATION !== '1') {
    throw new Error('Clean migration certification requires AIRA_POSTGRES_CERTIFICATION=1.');
  }
  if (process.env.CI_DISPOSABLE_DATABASE !== 'true'
      || !process.env.DATABASE_URL
      || process.env.DATABASE_URL !== process.env.ISOLATED_TEST_DATABASE_URL) {
    throw new Error('Clean migration certification requires the matching disposable PostgreSQL URL contract.');
  }
  execFileSync(process.execPath, ['scripts/ci/assert-disposable-postgres.mjs'], { stdio: 'inherit' });
  const dbModule = await import(pathToFileURL(path.resolve('./packages/db/src/index.ts')).href);
  const db = dbModule.db;
  console.log('--- Migration Check 1: Clean DB 001->008 ---');
  await db.raw('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.migrate.latest();
  
  const hasPrincipal = await db.schema.hasColumn('runs', 'principal_id');
  const hasSession = await db.schema.hasColumn('runs', 'session_id');
  const hasWorkspace = await db.schema.hasColumn('runs', 'workspace_id');
  const hasConversation = await db.schema.hasColumn('runs', 'conversation_id');
  const hasArtifacts = await db.schema.hasColumn('runs', 'artifacts');
  
  console.log('principal_id:', hasPrincipal ? 'PASS' : 'FAIL');
  console.log('session_id:', hasSession ? 'PASS' : 'FAIL');
  console.log('workspace_id:', hasWorkspace ? 'PASS' : 'FAIL');
  console.log('conversation_id:', hasConversation ? 'PASS' : 'FAIL');
  console.log('artifacts:', hasArtifacts ? 'PASS' : 'FAIL');
  
  const indexes = await db.raw("SELECT indexname FROM pg_indexes WHERE tablename = 'runs'");
  console.log('Indexes:', indexes.rows.map((r: any) => r.indexname));
  
  if (!hasPrincipal || !hasSession || !hasWorkspace || !hasConversation || !hasArtifacts) {
    console.error('MIGRATION CLEAN DB: FAIL');
    process.exit(1);
  }
  console.log('MIGRATION CLEAN DB 001->008: PASS');
  await db.destroy();
  process.exit(0);
}

validate().catch(e => {
  console.error(e);
  process.exit(1);
});
