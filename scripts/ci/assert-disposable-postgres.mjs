import { lookup } from 'node:dns/promises';
import { Client } from 'pg';
import {
  SafePreflightError,
  assertConnectedServerAddressMatchesExpected,
  assertDnsAddressesMatchExpected,
  normalizeIpAddress,
} from './postgres-address-policy.mjs';

function reject(reason) {
  // Keep diagnostics intentionally free of connection strings and driver error details.
  console.error(`Disposable PostgreSQL preflight failed: ${reason}`);
  process.exitCode = 1;
}

async function main() {
  if (process.env.NODE_ENV !== 'test') {
    throw new SafePreflightError('NODE_ENV must be test');
  }
  if (process.env.CI_DISPOSABLE_DATABASE !== 'true') {
    throw new SafePreflightError('explicit disposable-database marker is missing');
  }

  const databaseUrl = process.env.DATABASE_URL;
  const isolatedUrl = process.env.ISOLATED_TEST_DATABASE_URL;
  const expectedUser = process.env.CI_EXPECTED_DATABASE_USER;
  const expectedDatabase = process.env.CI_EXPECTED_DATABASE_NAME;
  const expectedAddressesJson = process.env.CI_EXPECTED_POSTGRES_ADDRESSES;

  if (!databaseUrl || !isolatedUrl || databaseUrl !== isolatedUrl) {
    throw new SafePreflightError('an explicit matching DATABASE_URL and ISOLATED_TEST_DATABASE_URL are required');
  }
  if (!expectedUser || !expectedDatabase) {
    throw new SafePreflightError('expected disposable database identity variables are required');
  }
  if (!expectedAddressesJson) {
    throw new SafePreflightError('Docker-inspected PostgreSQL network endpoint addresses are required');
  }
  let expectedPostgresAddresses;
  try {
    expectedPostgresAddresses = JSON.parse(expectedAddressesJson);
  } catch {
    throw new SafePreflightError('Docker-inspected PostgreSQL network endpoint addresses are malformed');
  }
  if (!Array.isArray(expectedPostgresAddresses) || expectedPostgresAddresses.length === 0) {
    throw new SafePreflightError('Docker-inspected PostgreSQL network endpoint addresses are required');
  }

  let target;
  try {
    target = new URL(databaseUrl);
  } catch {
    throw new SafePreflightError('DATABASE_URL is malformed');
  }

  if (!['postgres:', 'postgresql:'].includes(target.protocol)) {
    throw new SafePreflightError('DATABASE_URL must use the PostgreSQL protocol');
  }

  const isLocalCert =
    process.env.AIRA_POSTGRES_CERTIFICATION === '1' &&
    (target.hostname === '127.0.0.1' || target.hostname === 'localhost');

  if (isLocalCert) {
    if (target.port !== '55432') {
      throw new SafePreflightError('Local disposable PostgreSQL certification must target isolated port 55432 (port 5432 is strictly prohibited)');
    }
  } else {
    if (target.hostname.toLowerCase() !== 'postgres' || target.port !== '5432') {
      throw new SafePreflightError('DATABASE_URL must target the isolated postgres:5432 service');
    }
  }

  if (decodeURIComponent(target.username) !== expectedUser) {
    throw new SafePreflightError('DATABASE_URL role does not match the expected disposable role');
  }
  if (decodeURIComponent(target.pathname.slice(1)) !== expectedDatabase) {
    throw new SafePreflightError('DATABASE_URL database does not match the expected disposable database');
  }
  if (!/^aira_ci_[0-9]+-[0-9]+$/.test(expectedUser) || !/^aira_ci_[0-9]+-[0-9]+$/.test(expectedDatabase)) {
    throw new SafePreflightError('expected identity is not run-scoped disposable PostgreSQL');
  }

  const exactGeneratedUrl = isLocalCert
    ? new RegExp('^postgresql://' + expectedUser + ':[a-f0-9]{64}@(127\\.0\\.0\\.1|localhost):55432/' + expectedDatabase + '$')
    : new RegExp('^postgresql://' + expectedUser + ':[a-f0-9]{64}@postgres:5432/' + expectedDatabase + '$');

  if (!exactGeneratedUrl.test(databaseUrl) || target.search || target.hash) {
    throw new SafePreflightError('DATABASE_URL is not the exact generated disposable PostgreSQL URL');
  }

  const lookupHost = isLocalCert ? target.hostname : 'postgres';
  const dnsAddresses = (await lookup(lookupHost, { all: true })).map(({ address }) => address);
  assertDnsAddressesMatchExpected({
    expectedAddresses: expectedPostgresAddresses,
    dnsAddresses,
  });

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
      throw new SafePreflightError('connected PostgreSQL database or role identity does not match the disposable target');
    }
    if (Math.floor(Number(identity.server_version_num) / 10000) !== 16) {
      throw new SafePreflightError('connected PostgreSQL server is not major version 16');
    }

    if (isLocalCert) {
      const server = normalizeIpAddress(identity.server_address);
      const expected = new Set(expectedPostgresAddresses.map(normalizeIpAddress));
      if (!expected.has(server) && server !== 'ipv4:127.0.0.1') {
        throw new SafePreflightError('connected PostgreSQL server address does not match local disposable container endpoint');
      }
    } else {
      assertConnectedServerAddressMatchesExpected({
        expectedAddresses: expectedPostgresAddresses,
        dnsAddresses,
        serverAddress: identity.server_address,
      });
    }

    console.log('Disposable PostgreSQL identity verified: expected run-scoped database, role, and PostgreSQL 16.');
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((error) => {
  reject(error instanceof SafePreflightError ? error.message : 'unexpected preflight error');
});
