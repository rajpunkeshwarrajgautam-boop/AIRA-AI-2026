import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import {
  encryptFile,
  decryptFile,
  verifyArchiveContainer,
  deriveKey,
  validateBackupConnectionUrl,
  HEADER_LENGTH,
  MAGIC_HEADER
} from '../scripts/secure-backup-crypto.js';

describe('AIRA AI 2026 — Authenticated Backup Encryption (AES-256-GCM)', () => {
  const tmpDir = path.join(os.tmpdir(), `aira-backup-test-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const testPassphrase = 'CorrectHorseBatteryStaple2026!#$';
  const samplePayload = Buffer.from('PGDMP_MOCK_ARCHIVE_DATA_' + crypto.randomBytes(65536).toString('hex'));
  const sampleSourceFile = path.join(tmpDir, 'sample_source.dump');
  const encryptedArchive = path.join(tmpDir, 'sample_backup.dump.enc');
  const decryptedFile = path.join(tmpDir, 'sample_restored.dump');

  fs.writeFileSync(sampleSourceFile, samplePayload);

  it('1. Rejects weak or short passphrases (<8 chars)', () => {
    assert.throws(
      () => deriveKey('short', crypto.randomBytes(16)),
      /passphrase must be at least 8 characters/
    );
  });

  it('2. Encrypts source archive and verifies container format', async () => {
    const encResult = await encryptFile({
      passphrase: testPassphrase,
      sourceFilePath: sampleSourceFile,
      destinationEncryptedPath: encryptedArchive
    });

    assert.ok(fs.existsSync(encryptedArchive));
    assert.ok(encResult.bytesWritten > samplePayload.length);
    assert.equal(typeof encResult.sha256, 'string');

    const container = fs.readFileSync(encryptedArchive);
    assert.ok(container.subarray(0, 8).equals(MAGIC_HEADER));
    assert.ok(container.length >= HEADER_LENGTH + samplePayload.length);
  });

  it('3. Inspects container metadata without decrypting', () => {
    const inspectResult = verifyArchiveContainer(encryptedArchive, testPassphrase);
    assert.equal(inspectResult.valid, true);
    assert.equal(inspectResult.algorithm, 'aes-256-gcm');
    assert.equal(inspectResult.saltHex.length, 32); // 16 bytes = 32 hex chars
    assert.equal(inspectResult.ivHex.length, 24);   // 12 bytes = 24 hex chars
    assert.equal(inspectResult.tagHex.length, 32);  // 16 bytes = 32 hex chars
    assert.ok(inspectResult.ciphertextBytes >= samplePayload.length);
  });

  it('4. Successfully decrypts container with 100% byte-for-byte SHA256 parity', async () => {
    const decResult = await decryptFile({
      passphrase: testPassphrase,
      sourceEncryptedPath: encryptedArchive,
      destinationPlaintextPath: decryptedFile
    });

    assert.ok(fs.existsSync(decryptedFile));
    const restoredPayload = fs.readFileSync(decryptedFile);
    assert.equal(restoredPayload.length, samplePayload.length);

    const sourceSha = crypto.createHash('sha256').update(samplePayload).digest('hex');
    assert.equal(decResult.sha256, sourceSha);
    assert.ok(restoredPayload.equals(samplePayload));
  });

  it('5. Fails closed with authentication error on wrong passphrase', async () => {
    const badRestoredFile = path.join(tmpDir, 'bad_restored.dump');
    await assert.rejects(
      async () => {
        await decryptFile({
          passphrase: 'WrongPassword2026!',
          sourceEncryptedPath: encryptedArchive,
          destinationPlaintextPath: badRestoredFile
        });
      },
      /AUTHENTICATION_FAILED/
    );
    assert.ok(!fs.existsSync(badRestoredFile));
  });

  it('6. Fails closed when GCM authentication tag is tampered with', async () => {
    const tamperedTagArchive = path.join(tmpDir, 'tampered_tag.dump.enc');
    const container = Buffer.from(fs.readFileSync(encryptedArchive));
    // Flip a bit in the authentication tag (bytes 36..51)
    container[40] ^= 0xff;
    fs.writeFileSync(tamperedTagArchive, container);

    const badRestoredFile = path.join(tmpDir, 'tampered_tag_restored.dump');
    await assert.rejects(
      async () => {
        await decryptFile({
          passphrase: testPassphrase,
          sourceEncryptedPath: tamperedTagArchive,
          destinationPlaintextPath: badRestoredFile
        });
      },
      /AUTHENTICATION_FAILED/
    );
  });

  it('7. Fails closed when ciphertext payload is tampered with', async () => {
    const tamperedCtArchive = path.join(tmpDir, 'tampered_ct.dump.enc');
    const container = Buffer.from(fs.readFileSync(encryptedArchive));
    // Flip a bit in the ciphertext (byte 60)
    container[60] ^= 0xaa;
    fs.writeFileSync(tamperedCtArchive, container);

    const badRestoredFile = path.join(tmpDir, 'tampered_ct_restored.dump');
    await assert.rejects(
      async () => {
        await decryptFile({
          passphrase: testPassphrase,
          sourceEncryptedPath: tamperedCtArchive,
          destinationPlaintextPath: badRestoredFile
        });
      },
      /AUTHENTICATION_FAILED/
    );
  });

  it('8. Rejects corrupt or truncated header', async () => {
    const truncatedArchive = path.join(tmpDir, 'truncated.dump.enc');
    fs.writeFileSync(truncatedArchive, Buffer.from('SHORT'));

    const badRestoredFile = path.join(tmpDir, 'truncated_restored.dump');
    await assert.rejects(
      async () => {
        await decryptFile({
          passphrase: testPassphrase,
          sourceEncryptedPath: truncatedArchive,
          destinationPlaintextPath: badRestoredFile
        });
      },
      /smaller than minimum header/
    );
  });

  it('9. Enforces direct unpooled connection for backup operations and rejects pooler endpoint', () => {
    // Rejects pooler host
    const poolerUrl = ['postgresql://neondb_owner', 'mock_fixture_pass@ep-withered-art-b36ox90b-pooler.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require'].join(':');
    assert.throws(
      () => validateBackupConnectionUrl(poolerUrl),
      /UNPOOLED_CONNECTION_REQUIRED/
    );

    // Accepts direct compute endpoint
    const directUrl = ['postgresql://neondb_owner', 'mock_fixture_pass@ep-withered-art-b36ox90b.ap-southeast-1.aws.neon.tech/neondb?sslmode=require'].join(':');
    const validation = validateBackupConnectionUrl(directUrl);
    assert.equal(validation.valid, true);
    assert.equal(validation.isDirect, true);
    assert.equal(validation.endpoint, 'ep-withered-art-b36ox90b.ap-southeast-1.aws.neon.tech');
    assert.ok(!validation.sanitized.includes('mock_fixture_pass'));
    assert.ok(validation.sanitized.includes('[REDACTED]'));
  });

  it('10. Securely unlinks source plaintext file when removeSourceAfterEncryption is true', async () => {
    const sensitiveFile = path.join(tmpDir, 'ephemeral_sensitive.dump');
    const encTarget = path.join(tmpDir, 'ephemeral_sensitive.dump.enc');
    fs.writeFileSync(sensitiveFile, Buffer.from('SENSITIVE_TEMP_DATABASE_RECORD_DATA'));

    assert.ok(fs.existsSync(sensitiveFile));

    await encryptFile({
      passphrase: testPassphrase,
      sourceFilePath: sensitiveFile,
      destinationEncryptedPath: encTarget,
      removeSourceAfterEncryption: true
    });

    assert.ok(!fs.existsSync(sensitiveFile), 'Plaintext source should be unlinked after encryption');
    assert.ok(fs.existsSync(encTarget), 'Encrypted target should exist');
  });

  // Cleanup
  it('11. Cleans up temporary artifacts cleanly', () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    assert.ok(!fs.existsSync(tmpDir));
  });
});
