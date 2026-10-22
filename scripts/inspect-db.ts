import fs from 'fs';
import knex from 'knex';

const env = fs.readFileSync('C:/Users/WORKSTATION/AIRA-AI-2026-P1-DB-LATENCY/.env', 'utf8');
let dbUrl = '';
for (const l of env.split('\n')) {
  if (l.startsWith('DATABASE_URL=')) {
    dbUrl = l.split('=')[1].trim();
    break;
  }
}

if (!dbUrl) {
  console.log('No DB URL');
  process.exit(1);
}

const client = knex({
  client: 'pg',
  connection: {
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }
  }
});

async function main() {
  try {
    const res = await client.raw('SELECT current_database(), current_user, inet_server_addr()');
    console.log('DB query ok:', res.rows[0]);
    try {
      const neonSettings = await client.raw("SELECT name, setting FROM pg_settings WHERE name LIKE '%neon.timeline%' OR name LIKE '%neon.project%' OR name LIKE '%neon.branch%' OR name LIKE '%neon.tenant%'");
      console.log('Neon IDs:', neonSettings.rows);
    } catch (e: any) {
      console.log('Neon settings query error:', e.message);
    }
    const migs = await client('knex_migrations').select('name').orderBy('id', 'asc');
    console.log('Migration count:', migs.length);
    console.log('Last 3 migrations:', migs.slice(-3));
    const tables = await client.raw("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
    console.log('Tables:', tables.rows.map((r: any) => r.tablename).sort());
  } catch (err: any) {
    console.error('Error:', err.message);
  } finally {
    await client.destroy();
  }
}

main();
