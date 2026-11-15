import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createPortableRecoveryEnvelope,
  recoverKeyFromPortableEnvelope,
} from '../scripts/portable-recovery-escrow.js';

test('Portable Escrow: creates envelope, recovers key cleanly with valid passphrase', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aira_escrow_test_'));
  try {
    const rawKey = 'sample_aira_prod_backup_encryption_key_20261115_99887766554433221100aabbccddeeff';
    const strongPassphrase = 'correct-horse-battery-staple-secure-recovery-passphrase-2026';

    const { envelopePath, keyFingerprint } = createPortableRecoveryEnvelope({
      backupKey: rawKey,
      recoveryPassphrase: strongPassphrase,
      destinationDir: tmpDir,
    });

    assert.ok(fs.existsSync(envelopePath));
    const metadata = JSON.parse(fs.readFileSync(envelopePath, 'utf8'));
    assert.equal(metadata.format, 'AIRA_PORTABLE_KEY_ENVELOPE_V1');
    assert.equal(metadata.cipher, 'aes-256-gcm');
    assert.equal(metadata.kdf, 'scrypt');
    assert.equal(metadata.scryptParams.cost, 32768);
    assert.equal(metadata.scryptParams.blockSize, 8);
    assert.equal(metadata.scryptParams.parallelization, 1);
    assert.equal(metadata.scryptParams.keyLength, 32);
    assert.equal(Buffer.from(metadata.saltHex, 'hex').length, 32);
    assert.equal(Buffer.from(metadata.ivHex, 'hex').length, 12, 'Must use 96-bit nonce');
    assert.equal(Buffer.from(metadata.tagHex, 'hex').length, 16, 'Must use 128-bit GCM auth tag');

    // Recover using envelope alone
    const recovered = recoverKeyFromPortableEnvelope(envelopePath, strongPassphrase);
    assert.equal(recovered.backupKey, rawKey);
    assert.equal(recovered.keyFingerprint, keyFingerprint);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Portable Escrow: fails closed on incorrect passphrase', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aira_escrow_test_'));
  try {
    const rawKey = 'test_key_secret_material_12345';
    const strongPassphrase = 'strong-initial-passphrase-must-be-long-enough';

    const { envelopePath } = createPortableRecoveryEnvelope({
      backupKey: rawKey,
      recoveryPassphrase: strongPassphrase,
      destinationDir: tmpDir,
    });

    assert.throws(
      () => recoverKeyFromPortableEnvelope(envelopePath, 'wrong-password-attempt-fails-closed'),
      /ESCROW_AUTH_FAILED/
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Portable Escrow: fails closed on tampered ciphertext', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aira_escrow_test_'));
  try {
    const rawKey = 'test_key_secret_material_12345';
    const strongPassphrase = 'strong-initial-passphrase-must-be-long-enough';

    const { envelopePath } = createPortableRecoveryEnvelope({
      backupKey: rawKey,
      recoveryPassphrase: strongPassphrase,
      destinationDir: tmpDir,
    });

    // Tamper with ciphertext
    const metadata = JSON.parse(fs.readFileSync(envelopePath, 'utf8'));
    const ctBytes = Buffer.from(metadata.ciphertextHex, 'hex');
    ctBytes[0] ^= 0x01; // flip 1 bit
    metadata.ciphertextHex = ctBytes.toString('hex');
    fs.writeFileSync(envelopePath, JSON.stringify(metadata, null, 2), 'utf8');

    assert.throws(
      () => recoverKeyFromPortableEnvelope(envelopePath, strongPassphrase),
      /ESCROW_AUTH_FAILED/
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Portable Escrow: fails closed on unmounted/non-existent destination drive', () => {
  const nonExistentDrive = 'Z:\\NON_EXISTENT_REMOVABLE_DRIVE_MOUNT_POINT';
  assert.throws(
    () => createPortableRecoveryEnvelope({
      backupKey: 'dummy_key',
      recoveryPassphrase: 'strong-passphrase-long-enough',
      destinationDir: nonExistentDrive,
    }),
    /ESCROW_TARGET_ERROR/
  );
});

test('Portable Escrow: fails closed on weak/short recovery passphrase', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aira_escrow_test_'));
  try {
    assert.throws(
      () => createPortableRecoveryEnvelope({
        backupKey: 'dummy_key',
        recoveryPassphrase: 'short',
        destinationDir: tmpDir,
      }),
      /ESCROW_SECURITY_ERROR/
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
