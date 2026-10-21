import { execSync } from 'child_process';
import knex from 'knex';

async function main() {
  console.log('=== PART 1: INSPECTING STAGING MAIN BASELINE ===');
  const mainCs = execSync('npx neonctl connection-string main --project-id mute-frost-50372225', { encoding: 'utf8' }).trim();
  const mainClient = knex({
    client: 'pg',
    connection: { connectionString: mainCs, ssl: { rejectUnauthorized: false } }
  });

  try {
    const convs = await mainClient('conversations').select('*');
    console.log(`Staging main conversations (${convs.length}):`);
    for (const c of convs) {
      console.log(`  - ID: ${c.id}, Title: "${c.title}", Principal: "${c.principal_id}", Client: "${c.client_id}"`);
    }

    const runs = await mainClient('runs').select('id', 'principal_id');
    console.log(`Staging main runs (${runs.length}):`, runs);

    const mems = await mainClient('memory_records').select('id');
    console.log(`Staging main memory records (${mems.length}):`, mems);

    const schemas = await mainClient.raw("SELECT schema_name FROM information_schema.schemata");
    console.log('Staging main schemas:', schemas.rows.map((r: any) => r.schema_name));

  } finally {
    await mainClient.destroy();
  }

  console.log('\n=== PART 2: INSPECTING COMMERCIAL PR #92 ISOLATED DATABASE ===');
  const pr92Cs = execSync('npx neonctl connection-string pr92-commercial-platform-isolated --project-id mute-frost-50372225', { encoding: 'utf8' }).trim();
  const pr92Client = knex({
    client: 'pg',
    connection: { connectionString: pr92Cs, ssl: { rejectUnauthorized: false } }
  });

  try {
    const schemas92 = await pr92Client.raw("SELECT schema_name FROM information_schema.schemata");
    console.log('PR92 schemas:', schemas92.rows.map((r: any) => r.schema_name));

    const hasNeonAuth = schemas92.rows.some((r: any) => r.schema_name === 'neon_auth');
    if (hasNeonAuth) {
      const neonAuthTables = await pr92Client.raw("SELECT tablename FROM pg_tables WHERE schemaname = 'neon_auth'");
      console.log('PR92 neon_auth tables:', neonAuthTables.rows.map((r: any) => r.tablename));

      if (neonAuthTables.rows.some((r: any) => r.tablename === 'user')) {
        const uCount = await pr92Client('neon_auth.user').count('* as cnt');
        console.log(`PR92 neon_auth.user count: ${uCount[0].cnt}`);
        const sampleU = await pr92Client('neon_auth.user').select('id', 'name', 'email').limit(15);
        console.log('PR92 neon_auth.user sample (emails masked):', sampleU.map(u => ({ id: u.id, name: u.name, domain: u.email?.split('@')[1] })));
      }

      if (neonAuthTables.rows.some((r: any) => r.tablename === 'account')) {
        const aCount = await pr92Client('neon_auth.account').count('* as cnt');
        console.log(`PR92 neon_auth.account count: ${aCount[0].cnt}`);
        const sampleA = await pr92Client('neon_auth.account').select('id', 'userId', 'providerId', 'accountId').limit(20);
        console.log('PR92 neon_auth.account sample:', sampleA);
      }
    }

    // Check public tables in PR92
    if (await pr92Client.schema.hasTable('users')) {
      const uCount = await pr92Client('users').count('* as cnt');
      console.log(`PR92 public.users count: ${uCount[0].cnt}`);
      const allU = await pr92Client('users').select('id', 'name', 'email');
      console.log('PR92 public.users breakdown:', allU.map(u => ({ id: u.id, name: u.name, domain: u.email?.split('@')[1] })));
    }

    if (await pr92Client.schema.hasTable('oauth_accounts')) {
      const oaCount = await pr92Client('oauth_accounts').count('* as cnt');
      console.log(`PR92 public.oauth_accounts count: ${oaCount[0].cnt}`);
      const oas = await pr92Client('oauth_accounts').select('id', 'user_id', 'provider', 'provider_account_id', 'email');
      console.log('PR92 oauth_accounts all:', oas.map(oa => ({
        id: oa.id,
        user_id: oa.user_id,
        provider: oa.provider,
        provider_account_id: oa.provider_account_id,
        domain: oa.email?.split('@')[1]
      })));
    }

    if (await pr92Client.schema.hasTable('credit_accounts')) {
      const caCount = await pr92Client('credit_accounts').count('* as cnt');
      console.log(`PR92 public.credit_accounts count: ${caCount[0].cnt}`);
      const cas = await pr92Client('credit_accounts').select('id', 'customer_id', 'balance_credits', 'reserved_credits');
      console.log('PR92 credit_accounts all:', cas);
    }

    if (await pr92Client.schema.hasTable('conversations')) {
      const c92Count = await pr92Client('conversations').count('* as cnt');
      console.log(`PR92 conversations count: ${c92Count[0].cnt}`);
      const convs92 = await pr92Client('conversations').select('id', 'principal_id', 'title');
      console.log('PR92 conversations sample:', convs92.slice(0, 10));
    }

  } finally {
    await pr92Client.destroy();
  }
}

main().catch(console.error);
