import { execSync } from 'child_process';
import knex from 'knex';

const rawCs = execSync('npx neonctl connection-string main --project-id mute-frost-50372225', { encoding: 'utf8' }).trim();

const client = knex({
  client: 'pg',
  connection: {
    connectionString: rawCs,
    ssl: { rejectUnauthorized: false }
  }
});

async function main() {
  try {
    const res = await client.raw('SELECT current_database(), current_user, inet_server_addr()');
    console.log('Staging DB query ok:', res.rows[0]);
    const migs = await client('knex_migrations').select('name').orderBy('id', 'asc');
    console.log('Staging Migration count:', migs.length);
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
