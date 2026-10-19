import { execSync } from 'child_process';
import knex from 'knex';

const rawCs = execSync('npx neonctl connection-string pr90-p1-6-7-preview-isolated --project-id mute-frost-50372225', { encoding: 'utf8' }).trim();

const client = knex({
  client: 'pg',
  connection: {
    connectionString: rawCs,
    ssl: { rejectUnauthorized: false }
  }
});

async function main() {
  try {
    console.log('Querying isolated Preview Neon database (branch: pr90-p1-6-7-preview-isolated)...');
    
    const permits = await client('capacity_permits').select('*').orderBy('created_at', 'desc').limit(10);
    console.log(`capacity_permits count (recent 10): ${permits.length}`);
    console.log(permits);

    const rateLogs = await client('capacity_rate_log').select('*').orderBy('timestamp', 'desc').limit(10);
    console.log(`capacity_rate_log count (recent 10): ${rateLogs.length}`);
    console.log(rateLogs);

    const runs = await client('runs').select('id', 'user_id', 'model', 'provider', 'status', 'created_at').orderBy('created_at', 'desc').limit(5);
    console.log(`runs count: ${runs.length}`);
    console.log(runs);
  } catch (err: any) {
    console.error('Database query error:', err.message);
  } finally {
    await client.destroy();
  }
}

main().catch(console.error);
