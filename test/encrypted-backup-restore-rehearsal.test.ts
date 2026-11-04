import { describe, it, before } from 'node:test';
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
  MAGIC_HEADER,
  SALT_LENGTH,
  IV_LENGTH,
  TAG_LENGTH,
  PBKDF2_ITERATIONS
} from '../scripts/secure-backup-crypto.js';

describe('AIRA AI 2026 — Encrypted Backup & Restore Rehearsal Suite (Phase 2)', () => {
  const tmpDir = path.join(os.tmpdir(), `aira-encrypted-backup-rehearsal-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const testPassphrase = 'Phase2ProductionRecoveryPassphrase2026!#$';

  // 1. Connection Architecture Tests
  describe('1. Direct Unpooled Connection Safeguards', () => {
    it('1.1 Rejects connection pooler endpoint (-pooler) fail-closed', () => {
      const poolerUrl = 'postgresql://neondb_owner:secret_pass_123@ep-withered-art-b36ox90b-pooler.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require';
      assert.throws(
        () => validateBackupConnectionUrl(poolerUrl),
        /UNPOOLED_CONNECTION_REQUIRED/
      );
    });

    it('1.2 Accepts direct unpooled compute endpoint', () => {
      const directUrl = 'postgresql://neondb_owner:secret_pass_123@ep-withered-art-b36ox90b.ap-southeast-1.aws.neon.tech/neondb?sslmode=require';
      const result = validateBackupConnectionUrl(directUrl);
      assert.equal(result.valid, true);
      assert.equal(result.isDirect, true);
      assert.equal(result.endpoint, 'ep-withered-art-b36ox90b.ap-southeast-1.aws.neon.tech');
    });

    it('1.3 Never exposes plaintext database password in validation results or errors', () => {
      const sensitivePassword = 'SUPER_SECRET_LEAK_TARGET_987654';
      const testUrl = `postgresql://neondb_owner:${sensitivePassword}@ep-withered-art-b36ox90b-pooler.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`;
      
      try {
        validateBackupConnectionUrl(testUrl);
        assert.fail('Should have thrown pooler error');
      } catch (err) {
        const errorMsg = (err as Error).message;
        assert.ok(!errorMsg.includes(sensitivePassword), 'Error message must not leak password');
        assert.ok(!errorMsg.includes('secret_pass'), 'Error message must not leak credentials');
      }

      const directUrl = `postgresql://neondb_owner:${sensitivePassword}@ep-withered-art-b36ox90b.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`;
      const val = validateBackupConnectionUrl(directUrl);
      assert.ok(!val.sanitized.includes(sensitivePassword));
      assert.ok(val.sanitized.includes('[REDACTED]'));
    });
  });

  // 2. NIST AEAD Encryption & Key Derivation Specification Tests
  describe('2. NIST AEAD & Cryptographic Specifications', () => {
    it('2.1 Enforces PBKDF2 with 100,000 iterations and 256-bit key output', () => {
      const salt = crypto.randomBytes(SALT_LENGTH);
      const key1 = deriveKey(testPassphrase, salt);
      const key2 = deriveKey(testPassphrase, salt);
      assert.equal(key1.length, 32); // 256 bits
      assert.ok(key1.equals(key2), 'Deterministic key derivation given same salt');
      assert.equal(PBKDF2_ITERATIONS, 100_000);
    });

    it('2.2 Rejects short passphrases (<8 characters)', () => {
      assert.throws(
        () => deriveKey('short', crypto.randomBytes(16)),
        /passphrase must be at least 8 characters/
      );
    });

    it('2.3 Generates unique salt and IV per encryption invocation', async () => {
      const sourceA = path.join(tmpDir, 'sourceA.bin');
      const sourceB = path.join(tmpDir, 'sourceB.bin');
      const encA = path.join(tmpDir, 'encA.dump.enc');
      const encB = path.join(tmpDir, 'encB.dump.enc');

      fs.writeFileSync(sourceA, Buffer.from('IDENTICAL_PAYLOAD_FOR_NONCE_TEST'));
      fs.writeFileSync(sourceB, Buffer.from('IDENTICAL_PAYLOAD_FOR_NONCE_TEST'));

      await encryptFile({ passphrase: testPassphrase, sourceFilePath: sourceA, destinationEncryptedPath: encA });
      await encryptFile({ passphrase: testPassphrase, sourceFilePath: sourceB, destinationEncryptedPath: encB });

      const verA = verifyArchiveContainer(encA, testPassphrase);
      const verB = verifyArchiveContainer(encB, testPassphrase);

      assert.notEqual(verA.saltHex, verB.saltHex, 'Salts must be unique per archive');
      assert.notEqual(verA.ivHex, verB.ivHex, 'IVs must be unique per archive');
      assert.notEqual(verA.tagHex, verB.tagHex, 'Tags must differ across independent runs');
    });
  });

  // 3. Representative Database Archive Round-Trip & Parity Tests
  describe('3. Representative Backup Archive Round-Trip & Parity', () => {
    const fixturePath = path.join(tmpDir, 'representative_pg_dump.dump');
    const encPath = path.join(tmpDir, 'representative_pg_dump.dump.enc');
    const decPath = path.join(tmpDir, 'representative_pg_dump.restored.dump');

    // Generate realistic custom-format simulated archive header + table payloads
    const pgDumpHeader = Buffer.from('PGDMP\x01\x0f\x00\x04\x00\x00\x00\x00'); // Standard PostgreSQL pg_dump header magic
    const schemaPayload = Buffer.from(JSON.stringify({
      version: '18.1',
      totalMigrations: 31,
      totalTables: 48,
      tables: ['agents', 'runs', 'specialist_tasks', 'autonomous_agent_tasks', 'bff_sessions'],
      sampleRows: Array.from({ length: 50 }, (_, i) => ({ id: `task-${i}`, state: 'COMPLETED', created_at: new Date().toISOString() }))
    }));
    const fullArchivePayload = Buffer.concat([pgDumpHeader, schemaPayload, crypto.randomBytes(32768)]);

    before(() => {
      fs.writeFileSync(fixturePath, fullArchivePayload);
    });

    it('3.1 Encrypts representative archive into valid AIRA_ENC container', async () => {
      const result = await encryptFile({
        passphrase: testPassphrase,
        sourceFilePath: fixturePath,
        destinationEncryptedPath: encPath
      });

      assert.ok(fs.existsSync(encPath));
      assert.ok(result.bytesWritten > fullArchivePayload.length);

      const fileBuf = fs.readFileSync(encPath);
      assert.ok(fileBuf.subarray(0, 8).equals(MAGIC_HEADER));
      assert.equal(fileBuf.length, HEADER_LENGTH + fullArchivePayload.length);
    });

    it('3.2 Inspects encrypted container metadata without decrypting payload', () => {
      const ver = verifyArchiveContainer(encPath, testPassphrase);
      assert.equal(ver.valid, true);
      assert.equal(ver.algorithm, 'aes-256-gcm');
      assert.equal(ver.ciphertextBytes, fullArchivePayload.length);
    });

    it('3.3 Decrypts container and proves 100% byte-for-byte SHA256 parity', async () => {
      const decResult = await decryptFile({
        passphrase: testPassphrase,
        sourceEncryptedPath: encPath,
        destinationPlaintextPath: decPath
      });

      assert.ok(fs.existsSync(decPath));
      const restoredBuf = fs.readFileSync(decPath);
      assert.ok(restoredBuf.equals(fullArchivePayload), 'Decrypted buffer must be identical to source');

      const originalSha = crypto.createHash('sha256').update(fullArchivePayload).digest('hex');
      assert.equal(decResult.sha256, originalSha);
    });
  });

  // 4. Fail-Closed Tamper Detection Tests
  describe('4. Fail-Closed Tamper & Corruption Detection', () => {
    const validArchive = path.join(tmpDir, 'valid.dump.enc');

    before(async () => {
      const src = path.join(tmpDir, 'valid.dump');
      fs.writeFileSync(src, Buffer.from('VALID_BACKUP_CONTENT_FOR_TAMPER_TESTS'));
      await encryptFile({ passphrase: testPassphrase, sourceFilePath: src, destinationEncryptedPath: validArchive });
    });

    it('4.1 Rejects incorrect passphrase fail-closed (AUTHENTICATION_FAILED)', async () => {
      const out = path.join(tmpDir, 'out_bad_pass.dump');
      await assert.rejects(
        async () => {
          await decryptFile({ passphrase: 'WrongPassphrase2026!', sourceEncryptedPath: validArchive, destinationPlaintextPath: out });
        },
        /AUTHENTICATION_FAILED/
      );
      assert.ok(!fs.existsSync(out));
    });

    it('4.2 Rejects corrupted GCM authentication tag fail-closed (AUTHENTICATION_FAILED)', async () => {
      const tamperedTagArchive = path.join(tmpDir, 'bad_tag.dump.enc');
      const container = Buffer.from(fs.readFileSync(validArchive));
      container[38] ^= 0x01; // Bit flip in tag
      fs.writeFileSync(tamperedTagArchive, container);

      const out = path.join(tmpDir, 'out_bad_tag.dump');
      await assert.rejects(
        async () => {
          await decryptFile({ passphrase: testPassphrase, sourceEncryptedPath: tamperedTagArchive, destinationPlaintextPath: out });
        },
        /AUTHENTICATION_FAILED/
      );
      assert.ok(!fs.existsSync(out));
    });

    it('4.3 Rejects modified ciphertext payload fail-closed (AUTHENTICATION_FAILED)', async () => {
      const tamperedCtArchive = path.join(tmpDir, 'bad_ct.dump.enc');
      const container = Buffer.from(fs.readFileSync(validArchive));
      container[HEADER_LENGTH + 2] ^= 0xff; // Bit flip in ciphertext
      fs.writeFileSync(tamperedCtArchive, container);

      const out = path.join(tmpDir, 'out_bad_ct.dump');
      await assert.rejects(
        async () => {
          await decryptFile({ passphrase: testPassphrase, sourceEncryptedPath: tamperedCtArchive, destinationPlaintextPath: out });
        },
        /AUTHENTICATION_FAILED/
      );
      assert.ok(!fs.existsSync(out));
    });

    it('4.4 Rejects truncated container fail-closed', async () => {
      const truncatedArchive = path.join(tmpDir, 'truncated.dump.enc');
      fs.writeFileSync(truncatedArchive, Buffer.from('AIRA_ENC_TOO_SHORT'));

      const out = path.join(tmpDir, 'out_truncated.dump');
      await assert.rejects(
        async () => {
          await decryptFile({ passphrase: testPassphrase, sourceEncryptedPath: truncatedArchive, destinationPlaintextPath: out });
        },
        /smaller than minimum header size/
      );
      assert.ok(!fs.existsSync(out));
    });
  });

  // 5. Plaintext Lifecycle & Cleanup Tests
  describe('5. Secure Plaintext Lifecycle & Temporary Directory Cleanup', () => {
    it('5.1 Securely removes source plaintext archive when removeSourceAfterEncryption is true', async () => {
      const sensitivePath = path.join(tmpDir, 'ephemeral_raw_backup.dump');
      const encTargetPath = path.join(tmpDir, 'ephemeral_raw_backup.dump.enc');
      fs.writeFileSync(sensitivePath, Buffer.from('SENSITIVE_NEON_PGDUMP_PLAINTEXT_BYTES'));

      assert.ok(fs.existsSync(sensitivePath));

      await encryptFile({
        passphrase: testPassphrase,
        sourceFilePath: sensitivePath,
        destinationEncryptedPath: encTargetPath,
        removeSourceAfterEncryption: true
      });

      assert.ok(!fs.existsSync(sensitivePath), 'Source plaintext file must be unlinked');
      assert.ok(fs.existsSync(encTargetPath), 'Target encrypted container must exist');
    });

    it('5.2 Cleans up test rehearsal directory cleanly', () => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      assert.ok(!fs.existsSync(tmpDir));
    });
  });
});
