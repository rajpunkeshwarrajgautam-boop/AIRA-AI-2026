import { execSync } from 'child_process';
import knex from 'knex';

async function main() {
  const pr92Cs = execSync('npx neonctl connection-string pr92-commercial-platform-isolated --project-id mute-frost-50372225', { encoding: 'utf8' }).trim();
  const client = knex({
    client: 'pg',
    connection: { connectionString: pr92Cs, ssl: { rejectUnauthorized: false } }
  });

  try {
    console.log('=== PR92 USERS CLASSIFICATION ===');
    const users = await client('users').select('*');
    console.log(`Total users in PR92: ${users.length}`);

    const genuineUsers = [];
    const testUsers = [];

    for (const u of users) {
      const email = u.email || '';
      const isTest = email.endsWith('@example.com') ||
                     email.endsWith('@test.com') ||
                     email.includes('test') ||
                     u.name?.toLowerCase().includes('test') ||
                     u.id.startsWith('test_') ||
                     u.id.startsWith('usr_');
      if (isTest) {
        testUsers.push({ id: u.id, name: u.name, domain: email.split('@')[1] });
      } else {
        genuineUsers.push({ id: u.id, name: u.name, domain: email.split('@')[1] });
      }
    }
    console.log(`Genuine users (${genuineUsers.length}):`, genuineUsers);
    console.log(`Test users count: ${testUsers.length}`);

    console.log('\n=== PR92 NEON_AUTH.USER ===');
    const hasNeonAuth = await client.schema.withSchema('neon_auth').hasTable('user');
    if (hasNeonAuth) {
      const nu = await client('neon_auth.user').select('*');
      console.log(`neon_auth.user count: ${nu.length}`);
      for (const u of nu) {
        console.log(`  - ID: ${u.id}, Name: ${u.name}, Domain: ${u.email?.split('@')[1]}, Created: ${u.createdAt}`);
      }
    }

    console.log('\n=== PR92 NEON_AUTH.ACCOUNT ===');
    const hasNeonAccount = await client.schema.withSchema('neon_auth').hasTable('account');
    if (hasNeonAccount) {
      const na = await client('neon_auth.account').select('*');
      console.log(`neon_auth.account count: ${na.length}`);
      for (const a of na) {
        console.log(`  - ID: ${a.id}, UserID: ${a.userId}, Provider: ${a.providerId}, AccountID: ${a.accountId}`);
      }
    }

    console.log('\n=== PR92 BILLING CUSTOMERS & CREDIT ACCOUNTS ===');
    const customers = await client('billing_customers').select('*');
    console.log(`billing_customers count: ${customers.length}`);
    const creditAccounts = await client('credit_accounts').select('*');
    console.log(`credit_accounts count: ${creditAccounts.length}`);

    // Map credit accounts to customers and users
    for (const ca of creditAccounts) {
      const cust = customers.find(c => c.id === ca.customer_id);
      const isGenuine = genuineUsers.some(gu => gu.id === cust?.principal_id);
      console.log(`CreditAcc: ${ca.id}, Balance: ${ca.balance_credits}, Customer: ${ca.customer_id}, Principal: ${cust?.principal_id} (Genuine: ${isGenuine})`);
    }

    console.log('\n=== CROSS-CHECK WITH STAGING MAIN 4 PRINCIPALS ===');
    const stagingPrincipals = [
      'user_e85775e7-18cd-4d23-8520-07ebd5b6cb25',
      'user_19954375-52f0-4b0b-9736-d2e699508154',
      'user_6ebe7666-a656-478b-b824-917edb9bc63b',
      'user_79216cd8-5b3e-42b5-bafd-de9bec9656e4'
    ];

    for (const sp of stagingPrincipals) {
      const uMatch = users.find(u => u.id === sp);
      const cMatch = customers.find(c => c.principal_id === sp);
      const naMatch = hasNeonAuth ? (await client('neon_auth.user').where({ id: sp.replace('user_', '') }).first()) : null;
      console.log(`Staging Principal ${sp}:`);
      console.log(`  -> Match in users: ${!!uMatch}`);
      console.log(`  -> Match in billing_customers: ${!!cMatch}`);
      console.log(`  -> Match in neon_auth.user: ${!!naMatch}`);
    }

  } finally {
    await client.destroy();
  }
}

main().catch(console.error);
