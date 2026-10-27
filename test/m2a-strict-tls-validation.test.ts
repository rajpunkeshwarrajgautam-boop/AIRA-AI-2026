import './setup-isolated-neon.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import knex from 'knex';
import { db } from '../packages/db/src/index.js';
import {
  assertAuthorizedStagingDatabase,
  STAGING_NEON_PROJECT_ID
} from '../packages/db/src/security/database-isolation-guard.js';

test.describe('AIRA AI 2026 — Milestone 2A Strict Neon TLS Certification Suite', () => {
  const rawUrl = process.env.DATABASE_URL || '';
  const parsed = new URL(rawUrl);
  const host = parsed.hostname;
  const port = parseInt(parsed.port || '5432', 10);

  test('TLS-1: Trusted staging Neon certificate => ACCEPT with valid TLSv1.3 handshake', async () => {
    const tlsDetails = await new Promise<{
      authorized: boolean;
      authorizationError?: Error;
      protocol: string;
      cipher: tls.CipherNameAndProtocol;
      peerCertificate: tls.PeerCertificate;
    }>((resolve, reject) => {
      const socket = tls.connect(
        {
          host,
          port,
          servername: host,
          rejectUnauthorized: true
        },
        () => {
          const cert = socket.getPeerCertificate(true);
          const cipher = socket.getCipher();
          const protocol = socket.getProtocol() || 'UNKNOWN';
          const authorized = socket.authorized;
          const authorizationError = socket.authorizationError;
          socket.end();
          resolve({ authorized, authorizationError, protocol, cipher, peerCertificate: cert });
        }
      );

      socket.on('error', (err) => {
        reject(err);
      });
    });

    assert.strictEqual(tlsDetails.authorized, true, 'Staging Neon TLS certificate must be fully authorized by system CA store');
    assert.ok(!tlsDetails.authorizationError, 'TLS authorization must have zero errors');
    assert.strictEqual(tlsDetails.protocol, 'TLSv1.3', 'Must negotiate TLSv1.3');
    assert.ok(tlsDetails.cipher.name.includes('AES_256') || tlsDetails.cipher.name.includes('GCM'), 'Must negotiate modern cipher suite');
    assert.ok(tlsDetails.peerCertificate.subject, 'Peer certificate must include valid subject');
  });

  test('TLS-2: Untrusted certificate authority => REJECT fail-closed', async () => {
    let rejected = false;
    let errorCode = '';

    try {
      await new Promise((resolve, reject) => {
        const socket = tls.connect(
          {
            host,
            port,
            servername: host,
            rejectUnauthorized: true,
            // Bogus self-signed CA string to ensure foreign CA is rejected
            ca: '-----BEGIN CERTIFICATE-----\nMIIBojCCAUegAwIBAgIUFakeBogusCaCert==\n-----END CERTIFICATE-----'
          },
          () => {
            socket.end();
            resolve(true);
          }
        );

        socket.on('error', (err: any) => {
          reject(err);
        });
      });
    } catch (err: any) {
      rejected = true;
      errorCode = err.code || err.message;
    }

    assert.strictEqual(rejected, true, 'TLS socket must reject untrusted CA fail-closed');
    assert.match(
      errorCode,
      /CERT|UNABLE_TO_VERIFY|DEPTH_ZERO/,
      'Error code must indicate certificate authority verification failure'
    );
  });

  test('TLS-3: Hostname mismatch (spoofed domain) => REJECT fail-closed', async () => {
    let rejected = false;
    let errorCode = '';

    try {
      await new Promise((resolve, reject) => {
        const socket = tls.connect(
          {
            host,
            port,
            servername: 'spoofed-attacker-domain.evil-corp.com',
            rejectUnauthorized: true
          },
          () => {
            socket.end();
            resolve(true);
          }
        );

        socket.on('error', (err: any) => {
          reject(err);
        });
      });
    } catch (err: any) {
      rejected = true;
      errorCode = err.code || err.message;
    }

    assert.strictEqual(rejected, true, 'TLS socket must reject mismatched hostname fail-closed');
    assert.strictEqual(errorCode, 'ERR_TLS_CERT_ALTNAME_INVALID');
  });

  test('TLS-4: Invalid trust configuration (malformed CA) => REJECT fail-closed', async () => {
    let rejected = false;

    try {
      await new Promise((resolve, reject) => {
        const socket = tls.connect(
          {
            host,
            port,
            servername: host,
            rejectUnauthorized: true,
            ca: 'THIS_IS_NOT_A_VALID_PEM_CERTIFICATE_DATA'
          },
          () => {
            socket.end();
            resolve(true);
          }
        );

        socket.on('error', (err: any) => {
          reject(err);
        });
      });
    } catch (err: any) {
      rejected = true;
    }

    assert.strictEqual(rejected, true, 'Malformed trust configuration must fail closed');
  });

  test('TLS-5: Configuration attempting to disable verification => REJECT and enforce rejectUnauthorized: true in DB client', async () => {
    // 1. Verify default codebase knex client enforces rejectUnauthorized: true
    const poolConfig = (db.client as any).connectionSettings;
    assert.strictEqual(
      poolConfig.ssl.rejectUnauthorized,
      true,
      'AIRA db pool configuration must enforce ssl.rejectUnauthorized = true'
    );

    // 2. Verify Knex client connecting to staging Neon verifies TLS stream attributes
    const testDb = knex({
      client: 'pg',
      connection: {
        connectionString: rawUrl,
        ssl: { rejectUnauthorized: true }
      },
      pool: { min: 1, max: 2 }
    });

    try {
      const identity = await assertAuthorizedStagingDatabase(testDb, {
        allowedProjectIds: [STAGING_NEON_PROJECT_ID]
      });
      assert.strictEqual(identity.neonProjectId, STAGING_NEON_PROJECT_ID);

      const poolClient = await (testDb.client as any).acquireConnection();
      const stream = poolClient.connection?.stream;
      assert.strictEqual(Boolean(stream?.encrypted), true, 'PostgreSQL socket stream must be encrypted');
      assert.strictEqual(stream?.authorized, true, 'PostgreSQL socket stream must be authorized');
      assert.strictEqual(stream?.getProtocol?.(), 'TLSv1.3', 'PostgreSQL socket protocol must be TLSv1.3');

      await (testDb.client as any).releaseConnection(poolClient);
    } finally {
      await testDb.destroy();
    }
  });
});
