import { execSync } from 'child_process';
import knex from 'knex';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const rawCs = execSync('npx neonctl connection-string pr90-p1-6-7-preview-isolated --project-id mute-frost-50372225', { encoding: 'utf8' }).trim();

const client = knex({
  client: 'pg',
  connection: {
    connectionString: rawCs,
    ssl: { rejectUnauthorized: false }
  },
  migrations: {
    directory: path.resolve(process.cwd(), 'packages/db/src/migrations'),
    extension: 'ts',
    loadExtensions: ['.ts']
  }
});

async function main() {
  try {
    console.log('Checking current migrations on isolated branch...');
    const [completed] = await client.migrate.list();
    console.log(`Current completed migrations: ${completed.length}`);
    
    console.log('Running latest migrations...');
    const [batchNo, log] = await client.migrate.latest();
    console.log(`Batch ${batchNo} ran ${log.length} migrations:`, log);

    const [allAfter] = await client.migrate.list();
    console.log(`Total migrations now: ${allAfter.length}`);

    const hasPermits = await client.schema.hasTable('capacity_permits');
    const hasRateLog = await client.schema.hasTable('capacity_rate_log');
    console.log(`capacity_permits exists: ${hasPermits}`);
    console.log(`capacity_rate_log exists: ${hasRateLog}`);
  } catch (err: any) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await client.destroy();
  }
}

main();
