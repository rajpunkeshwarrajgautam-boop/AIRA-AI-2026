import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Client } from 'pg';

function reject(reason) {
  // Keep diagnostics intentionally free of connection strings and driver error details.
  console.error(`Disposable PostgreSQL preflight failed: ${reason}`);
  process.exitCode = 1;
}

async function main() {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('NODE_ENV must be test');
  }
  if (process.env.CI_DISPOSABLE_DATABASE !== 'true') {
    throw new Error('explicit disposable-database marker is missing');
  }

  const databaseUrl = process.env.DATABASE_URL;
  const isolatedUrl = process.env.ISOLATED_TEST_DATABASE_URL;
  const expectedUser = process.env.CI_EXPECTED_DATABASE_USER;
  const expectedDatabase = process.env.CI_EXPECTED_DATABASE_NAME;

  if (!databaseUrl || !isolatedUrl || databaseUrl !== isolatedUrl) {
    throw new Error('an explicit matching DATABASE_URL and ISOLATED_TEST_DATABASE_URL are required');
  }
  if (!expectedUser || !expectedDatabase) {
    throw new Error('expected disposable database identity variables are required');
  }

  let target;
  try {
    target = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL is malformed');
  }

  if (!['postgres:', 'postgresql:'].includes(target.protocol)) {
    throw new Error('DATABASE_URL must use the PostgreSQL protocol');
  }
  if (target.hostname.toLowerCase() !== 'postgres' || target.port !== '5432') {
    throw new Error('DATABASE_URL must target the isolated postgres:5432 service');
  }
  if (decodeURIComponent(target.username) !== expectedUser) {
    throw new Error('DATABASE_URL role does not match the expected disposable role');
  }
  if (decodeURIComponent(target.pathname.slice(1)) !== expectedDatabase) {
    throw new Error('DATABASE_URL database does not match the expected disposable database');
  }
  if (!/^aira_ci_[0-9]+-[0-9]+$/.test(expectedUser) || !/^aira_ci_[0-9]+-[0-9]+$/.test(expectedDatabase)) {
    throw new Error('expected identity is not run-scoped disposable PostgreSQL');
  }
  const exactGeneratedUrl = new RegExp(
    `^postgresql://${expectedUser}:[a-f0-9]{64}@postgres:5432/${expectedDatabase}$`,
  );
  if (!exactGeneratedUrl.test(databaseUrl) || target.search || target.hash) {
    throw new Error('DATABASE_URL is not the exact generated disposable PostgreSQL URL');
  }

  const addresses = await lookup('postgres', { all: true });
  const resolvedAddresses = new Set(addresses.map(({ address }) => address));
  if (resolvedAddresses.size === 0 || [...resolvedAddresses].some((address) => isIP(address) === 0)) {
    throw new Error('the internal postgres service name did not resolve to valid IP addresses');
  }

  const client = new Client({
    connectionString: databaseUrl,
    ssl: false,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
    statement_timeout: 5000,
  });

  try {
    await client.connect();
    const { rows } = await client.query(`
      SELECT
        current_database() AS database_name,
        current_user AS role_name,
        current_setting('server_version_num') AS server_version_num,
        inet_server_addr()::text AS server_address
    `);

    const identity = rows[0];
    if (!identity || identity.database_name !== expectedDatabase || identity.role_name !== expectedUser) {
      throw new Error('connected PostgreSQL database or role identity does not match the disposable target');
    }
    if (Math.floor(Number(identity.server_version_num) / 10000) !== 16) {
      throw new Error('connected PostgreSQL server is not major version 16');
    }
    if (!identity.server_address || !resolvedAddresses.has(identity.server_address)) {
      throw new Error('connected server address does not match internal postgres service DNS');
    }

    console.log(
      `Disposable PostgreSQL identity verified: database=${identity.database_name}, role=${identity.role_name}, major=16.`,
    );
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((error) => {
  reject(error instanceof Error ? error.message : 'unexpected preflight error');
});
