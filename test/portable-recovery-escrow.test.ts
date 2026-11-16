import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  createPortableRecoveryEnvelope,
  recoverKeyFromPortableEnvelope,
  parsePortableEscrowCliArgs,
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

test('Portable Escrow CLI: parses flags and rejects unrecognized arguments', () => {
  const parsed1 = parsePortableEscrowCliArgs([
    '--destination=C:\\test_escrow',
    '--recovery-passphrase=strong_passphrase_here',
    '--backup-key=mock_backup_key_123',
  ]);
  assert.equal(parsed1.destinationDir, 'C:\\test_escrow');
  assert.equal(parsed1.recoveryPassphrase, 'strong_passphrase_here');
  assert.equal(parsed1.backupKey, 'mock_backup_key_123');

  const parsed2 = parsePortableEscrowCliArgs([
    '--destination', 'E:\\AIRA_ESCROW',
    '--envelope-filename=custom.json',
  ]);
  assert.equal(parsed2.destinationDir, 'E:\\AIRA_ESCROW');
  assert.equal(parsed2.envelopeFilename, 'custom.json');

  const parsedVerify = parsePortableEscrowCliArgs(['--verify=C:\\test\\env.json']);
  assert.equal(parsedVerify.verifyOnly, true);
  assert.equal(parsedVerify.envelopePath, 'C:\\test\\env.json');

  assert.throws(
    () => parsePortableEscrowCliArgs(['--unrecognized-flag=123']),
    /CLI_VALIDATION_ERROR.*Unrecognized or invalid argument/
  );
});

test('Portable Escrow CLI: executes create and verify workflows without leaking secrets', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aira_cli_escrow_test_'));
  try {
    const rawKey = 'sample_backup_key_material_abc_123';
    const strongPassphrase = 'my-ultra-strong-recovery-passphrase-2026';

    // 1. Execute CLI creation
    const resCreate = spawnSync(
      process.execPath,
      [
        'node_modules/tsx/dist/cli.mjs',
        'scripts/portable-recovery-escrow.ts',
        `--destination=${tmpDir}`,
        `--recovery-passphrase=${strongPassphrase}`,
        `--backup-key=${rawKey}`,
      ],
      { encoding: 'utf8' }
    );

    assert.equal(resCreate.status, 0, `CLI creation should exit with 0, got: ${resCreate.stderr}`);
    assert.ok(resCreate.stdout.includes('CREATING PORTABLE RECOVERY ESCROW ENVELOPE'));
    assert.ok(resCreate.stdout.includes('Round-trip Check:   100% PASS'));

    // Security assertion: NO plaintext key or secret passphrase in output
    assert.ok(!resCreate.stdout.includes(rawKey), 'Must NEVER expose backup key in stdout');
    assert.ok(!resCreate.stdout.includes(strongPassphrase), 'Must NEVER expose passphrase in stdout');

    const expectedEnvelope = path.join(tmpDir, 'aira_portable_recovery_envelope.json');
    assert.ok(fs.existsSync(expectedEnvelope), 'Envelope file must exist');

    // 2. Execute CLI verification
    const resVerify = spawnSync(
      process.execPath,
      [
        'node_modules/tsx/dist/cli.mjs',
        'scripts/portable-recovery-escrow.ts',
        `--verify=${expectedEnvelope}`,
        `--recovery-passphrase=${strongPassphrase}`,
      ],
      { encoding: 'utf8' }
    );

    assert.equal(resVerify.status, 0, `CLI verify should exit with 0, got: ${resVerify.stderr}`);
    assert.ok(resVerify.stdout.includes('PORTABLE ESCROW ENVELOPE VERIFICATION: PASS'));
    assert.ok(resVerify.stdout.includes('AUTHENTICATED'));

    // 3. Execute CLI with non-existent directory -> fail closed
    const resFail = spawnSync(
      process.execPath,
      [
        'node_modules/tsx/dist/cli.mjs',
        'scripts/portable-recovery-escrow.ts',
        '--destination=Z:\\NONEXISTENT_DIR_MOUNT_POINT',
        `--recovery-passphrase=${strongPassphrase}`,
        `--backup-key=${rawKey}`,
      ],
      { encoding: 'utf8' }
    );

    assert.notEqual(resFail.status, 0, 'Must exit with non-zero on non-existent directory');
    assert.ok(
      resFail.stderr.includes('ESCROW_TARGET_ERROR') || resFail.stdout.includes('ESCROW_TARGET_ERROR'),
      'Must report ESCROW_TARGET_ERROR'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
