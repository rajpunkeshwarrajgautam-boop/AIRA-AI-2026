import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

// Independent PostgreSQL sessions are required by the runtime's row locks and
// fencing transactions. Give each integration suite its own disposable database.
export async function createTestDatabase() {
  const source = process.env.AIRA_TEST_DATABASE_URL || process.env.DATABASE_URL
    || 'postgres://aira:aira@127.0.0.1:5432/aira_db';
  const name = `aira_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Client({ connectionString: source });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE "${name}"`); }
  finally { await admin.end(); }
  const url = new URL(source);
  url.pathname = `/${name}`;
  process.env.DATABASE_URL = url.toString();
  return async () => {
    const cleanup = new Client({ connectionString: source });
    await cleanup.connect();
    try { await cleanup.query(`DROP DATABASE "${name}"`); }
    finally { await cleanup.end(); }
  };
}
