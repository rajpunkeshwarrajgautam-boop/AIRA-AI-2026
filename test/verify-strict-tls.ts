import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import tls from 'node:tls';
import knex from 'knex';
import { assertAuthorizedStagingDatabase, STAGING_NEON_PROJECT_ID } from '../packages/db/src/security/database-isolation-guard.js';

function getStagingConnectionString(): string {
  if (process.env.ISOLATED_TEST_DATABASE_URL?.trim()) {
    return process.env.ISOLATED_TEST_DATABASE_URL.trim();
  }
  if (process.env.DATABASE_URL?.trim() && !process.env.DATABASE_URL.includes('localhost')) {
    return process.env.DATABASE_URL.trim();
  }
  const output = execSync(
    'npx --yes neonctl connection-string pr-agent-tool-calls-isolated --project-id mute-frost-50372225 --org-id org-broad-butterfly-41820185',
    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim();
  return output;
}

const connStr = getStagingConnectionString();
process.env.DATABASE_URL = connStr;
process.env.ISOLATED_TEST_DATABASE_URL = connStr;
const { db } = await import('../packages/db/src/index.js');

async function verifyStrictTls(): Promise<void> {
  console.log('========================================================================');
  console.log('  AIRA AI 2026 — STRICT TLS CERTIFICATE VERIFICATION AUDIT');
  console.log('========================================================================');

  const parsed = new URL(connStr);
  const host = parsed.hostname;
  const port = parseInt(parsed.port || '5432', 10);

  console.log(`Target Host: ${host}:${port}`);

  // 1. Direct TLS Socket Inspection
  console.log('\n[TEST 1] Performing direct TLS handshake inspection against Neon endpoint...');
  const tlsDetails = await new Promise<{
    authorized: boolean;
    authorizationError?: Error;
    protocol: string;
    cipher: tls.CipherNameAndProtocol;
    peerCertificate: tls.PeerCertificate;
  }>((resolve, reject) => {
    const socket = tls.connect({
      host,
      port,
      servername: host,
      rejectUnauthorized: true
    }, () => {
      const cert = socket.getPeerCertificate(true);
      const cipher = socket.getCipher();
      const protocol = socket.getProtocol() || 'UNKNOWN';
      const authorized = socket.authorized;
      const authorizationError = socket.authorizationError;
      socket.end();
      resolve({ authorized, authorizationError, protocol, cipher, peerCertificate: cert });
    });

    socket.on('error', (err) => {
      reject(err);
    });
  });

  console.log(`TLS Authorized: ${tlsDetails.authorized}`);
  console.log(`TLS Protocol: ${tlsDetails.protocol}`);
  console.log(`TLS Cipher: ${tlsDetails.cipher.name} (${tlsDetails.cipher.standardName || tlsDetails.cipher.version})`);
  console.log(`Cert Subject CN: ${(tlsDetails.peerCertificate.subject as any)?.CN}`);
  console.log(`Cert Issuer O: ${(tlsDetails.peerCertificate.issuer as any)?.O}`);
  console.log(`Cert Valid From: ${tlsDetails.peerCertificate.valid_from}`);
  console.log(`Cert Valid To: ${tlsDetails.peerCertificate.valid_to}`);

  assert.equal(tlsDetails.authorized, true, 'TLS certificate must be fully authorized by system trust store');
  assert.ok(!tlsDetails.authorizationError, 'TLS authorization must have zero errors');
  console.log('PASS: Direct TLS handshake authenticated successfully with valid CA chain');

  // 2. Negative Test: Strict verification must REJECT untrusted CA
  console.log('\n[TEST 2] Negative Test: Verifying rejectUnauthorized=true fails-closed against untrusted CA...');
  let rejectedAsExpected = false;
  let rejectedErrorCode = '';
  try {
    await new Promise((resolve, reject) => {
      const socket = tls.connect({
        host,
        port,
        servername: host,
        rejectUnauthorized: true,
        ca: '-----BEGIN CERTIFICATE-----\nMIIBojCCAUegAwIBAgIUFakeBogusCaCert==\n-----END CERTIFICATE-----'
      }, () => {
        socket.end();
        resolve(true);
      });

      socket.on('error', (err: any) => {
        reject(err);
      });
    });
  } catch (err: any) {
    rejectedAsExpected = true;
    rejectedErrorCode = err.code || err.message;
    console.log(`PASS: Connection rejected fail-closed with untrusted CA: ${err.message} (code: ${err.code})`);
  }
  assert.equal(rejectedAsExpected, true, 'Strict TLS must reject untrusted certificate authorities');
  assert.match(rejectedErrorCode, /CERT|UNABLE_TO_VERIFY|DEPTH_ZERO/, 'Rejection code must indicate certificate verification failure');

  // 3. Negative Test: Hostname mismatch rejection
  console.log('\n[TEST 3] Negative Test: Verifying hostname mismatch fails-closed...');
  let mismatchRejected = false;
  try {
    await new Promise((resolve, reject) => {
      const socket = tls.connect({
        host,
        port,
        servername: 'spoofed-domain.malicious-actor.com',
        rejectUnauthorized: true
      }, () => {
        socket.end();
        resolve(true);
      });

      socket.on('error', (err: any) => {
        reject(err);
      });
    });
  } catch (err: any) {
    mismatchRejected = true;
    console.log(`PASS: Hostname mismatch rejected fail-closed: ${err.message} (code: ${err.code})`);
  }
  assert.equal(mismatchRejected, true, 'Strict TLS must reject mismatched server names');

  // 4. Knex / PostgreSQL Client Verification with rejectUnauthorized: true
  console.log('\n[TEST 4] Verifying Knex / pg client connection with rejectUnauthorized: true...');
  const testDb = knex({
    client: 'pg',
    connection: {
      connectionString: connStr,
      ssl: { rejectUnauthorized: true }
    },
    pool: { min: 1, max: 2 }
  });

  const identity = await assertAuthorizedStagingDatabase(testDb, {
    allowedProjectIds: [STAGING_NEON_PROJECT_ID],
    allowedBranchIds: ['br-muddy-wave-b3zxhkqf']
  });

  console.log(`PASS: Connected via Knex with strict TLS to Neon Project ${identity.neonProjectId}, Branch ${identity.neonBranchId}`);

  // Inspect node-postgres client-side TLS stream
  // Note: Neon terminates TLS at the proxy layer (c-4.ap-southeast-1.aws.neon.tech), so client-to-proxy is TLSv1.3
  const poolClient = await (testDb.client as any).acquireConnection();
  const stream = poolClient.connection?.stream;
  const isEncrypted = Boolean(stream?.encrypted);
  const isAuthorized = stream?.authorized;
  const protocol = stream?.getProtocol?.();
  const cipher = stream?.getCipher?.();
  
  console.log(`Node-pg stream.encrypted: ${isEncrypted}`);
  console.log(`Node-pg stream.authorized: ${isAuthorized}`);
  console.log(`Node-pg stream protocol: ${protocol}`);
  console.log(`Node-pg stream cipher: ${cipher?.name}`);

  assert.equal(isEncrypted, true, 'Client connection stream must be encrypted');
  assert.equal(isAuthorized, true, 'Client connection stream must be authorized by valid CA');

  await (testDb.client as any).releaseConnection(poolClient);
  await testDb.destroy();

  // 5. Codebase Configuration Verification
  console.log('\n[TEST 5] Verifying AIRA codebase db configuration enforces rejectUnauthorized: true...');
  const poolConfig = (db.client as any).connectionSettings;
  assert.equal(poolConfig.ssl.rejectUnauthorized, true, 'packages/db/src/index.ts must enforce rejectUnauthorized: true');
  console.log('PASS: packages/db/src/index.ts default export enforces rejectUnauthorized: true');

  console.log('\n========================================================================');
  console.log('  STRICT TLS CERTIFICATE VERIFICATION: FULLY VERIFIED & COMPLETED (PASS)');
  console.log('========================================================================');
}

verifyStrictTls().catch((err) => {
  console.error('[FATAL TLS VERIFICATION FAILED]:', err);
  process.exit(1);
});
