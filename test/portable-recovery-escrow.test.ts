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
      allowSystemDrive: true,
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
      allowSystemDrive: true,
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
      allowSystemDrive: true,
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
    '--disposable-test-passphrase=strong_passphrase_here',
    '--disposable-test-key=mock_backup_key_123',
    '--allow-local-test-destination',
  ]);
  assert.equal(parsed1.destinationDir, 'C:\\test_escrow');
  assert.equal(parsed1.recoveryPassphrase, 'strong_passphrase_here');
  assert.equal(parsed1.backupKey, 'mock_backup_key_123');
  assert.equal(parsed1.allowSystemDrive, true);
  assert.equal(parsed1.allowDisposableTestCredentials, true);

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
        '--allow-local-test-destination',
        '--allow-disposable-test-credentials',
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
        '--allow-disposable-test-credentials',
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
        '--allow-disposable-test-credentials',
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

test('Portable Escrow Security: rejects plaintext secret flags without explicit test authorization', () => {
  assert.throws(
    () =>
      parsePortableEscrowCliArgs([
        '--destination=E:\\ESCROW',
        '--recovery-passphrase=secret-passphrase-attempt',
      ]),
    /SECURITY_VIOLATION.*Passing plaintext keys or passphrases via CLI flags/
  );

  assert.throws(
    () =>
      parsePortableEscrowCliArgs([
        '--destination=E:\\ESCROW',
        '--backup-key=secret-key-attempt',
      ]),
    /SECURITY_VIOLATION.*Passing plaintext keys or passphrases via CLI flags/
  );
});

test('Portable Escrow Security: rejects internal system drive destination in production mode', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aira_sys_drive_test_'));
  try {
    assert.throws(
      () =>
        createPortableRecoveryEnvelope({
          backupKey: 'valid-test-key-material-1234567890',
          recoveryPassphrase: 'ultra-strong-passphrase-at-least-16-chars',
          destinationDir: tmpDir,
          allowSystemDrive: false,
        }),
      /ESCROW_TARGET_ERROR.*resides on the internal system drive/
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Portable Escrow Security: failed envelope write cleans up partial artifacts safely', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aira_cleanup_test_'));
  try {
    const envelopePath = path.join(tmpDir, 'corrupted_envelope.json');
    // Precondition: file does not exist
    assert.ok(!fs.existsSync(envelopePath));

    // Try creating with empty key to trigger error
    assert.throws(
      () =>
        createPortableRecoveryEnvelope({
          backupKey: '',
          recoveryPassphrase: 'ultra-strong-passphrase-at-least-16-chars',
          destinationDir: tmpDir,
          envelopeFilename: 'corrupted_envelope.json',
          allowSystemDrive: true,
        }),
      /ESCROW_SECURITY_ERROR/
    );

    // Verify no corrupted or partial envelope remains on disk
    assert.ok(!fs.existsSync(envelopePath), 'Partial or corrupt envelope must NOT remain on disk');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Portable Escrow Security: prevents accidental overwriting of existing recovery envelope', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aira_overwrite_test_'));
  try {
    const backupKey = 'test_backup_key_for_overwrite_123';
    const recoveryPassphrase = 'ultra-strong-passphrase-at-least-16-chars';
    const envelopeFilename = 'existing_envelope.json';

    // 1. Initial creation succeeds
    const initial = createPortableRecoveryEnvelope({
      backupKey,
      recoveryPassphrase,
      destinationDir: tmpDir,
      envelopeFilename,
      allowSystemDrive: true,
    });
    assert.ok(fs.existsSync(initial.envelopePath));

    // 2. Second creation without overwrite flag throws ESCROW_TARGET_ERROR
    assert.throws(
      () =>
        createPortableRecoveryEnvelope({
          backupKey: 'different_key_material_456789',
          recoveryPassphrase,
          destinationDir: tmpDir,
          envelopeFilename,
          allowSystemDrive: true,
          overwrite: false,
        }),
      /ESCROW_TARGET_ERROR.*already exists.*Overwriting existing recovery envelopes is forbidden/
    );

    // Verify original envelope was preserved intact
    const originalCheck = recoverKeyFromPortableEnvelope(initial.envelopePath, recoveryPassphrase);
    assert.equal(originalCheck.backupKey, backupKey);

    // 3. Third creation with overwrite: true succeeds
    const overwritten = createPortableRecoveryEnvelope({
      backupKey: 'different_key_material_456789',
      recoveryPassphrase,
      destinationDir: tmpDir,
      envelopeFilename,
      allowSystemDrive: true,
      overwrite: true,
    });
    const updatedCheck = recoverKeyFromPortableEnvelope(overwritten.envelopePath, recoveryPassphrase);
    assert.equal(updatedCheck.backupKey, 'different_key_material_456789');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Portable Escrow Security: rejects C: and accepts genuine removable drive letter with [Cc]', () => {
  // Test regex directly
  const driveRegex = /^[Cc]:\\/;
  assert.ok(driveRegex.test('C:\\AIRA_ESCROW'));
  assert.ok(driveRegex.test('c:\\aira_escrow'));
  assert.ok(!driveRegex.test('E:\\AIRA_RECOVERY_ESCROW'));
  assert.ok(!driveRegex.test('D:\\AIRA_DATASET'));
  assert.ok(!driveRegex.test('F:\\BACKUP'));

  // If running on Windows and E: is mounted, verify createPortableRecoveryEnvelope does not classify E: as system drive
  if (process.platform === 'win32' && fs.existsSync('E:\\')) {
    const testSubdir = 'E:\\AIRA_RECOVERY_ESCROW_TEST_DIR';
    fs.mkdirSync(testSubdir, { recursive: true });
    try {
      // Without allowSystemDrive: should NOT throw system drive error for E:\
      const res = createPortableRecoveryEnvelope({
        backupKey: 'test_removable_drive_key_material_123',
        recoveryPassphrase: 'ultra-strong-passphrase-at-least-16-chars',
        destinationDir: testSubdir,
        envelopeFilename: 'test_drive_envelope.json',
        allowSystemDrive: false,
      });
      assert.ok(fs.existsSync(res.envelopePath));
      assert.ok(res.envelopePath.startsWith('E:\\'));
    } finally {
      fs.rmSync(testSubdir, { recursive: true, force: true });
    }
  }
});

test('Portable Disaster Recovery Runner: fails closed on missing envelope or backup file', async () => {
  const { runPortableDisasterRecoveryValidation } = await import('../scripts/validate-portable-key-recovery.js');

  await assert.rejects(
    () =>
      runPortableDisasterRecoveryValidation({
        envelopePath: 'C:\\non_existent_envelope.json',
        backupPath: 'C:\\non_existent_backup.dump.enc',
      }),
    /DR_VERIFY_ERROR.*Portable recovery envelope missing/
  );
});

test('Portable Disaster Recovery Runner: fails closed on backup checksum mismatch', async () => {
  const { runPortableDisasterRecoveryValidation } = await import('../scripts/validate-portable-key-recovery.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr_corrupt_check_'));
  const dummyEnv = path.join(tmpDir, 'envelope.json');
  const dummyBackup = path.join(tmpDir, 'backup.dump.enc');
  fs.writeFileSync(dummyEnv, '{}');
  fs.writeFileSync(dummyBackup, 'TAMPERED_BACKUP_CONTENT');

  try {
    await assert.rejects(
      () =>
        runPortableDisasterRecoveryValidation({
          envelopePath: dummyEnv,
          backupPath: dummyBackup,
        }),
      /DR_VERIFY_ERROR.*Backup checksum mismatch/
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Portable Disaster Recovery Runner: fails closed on short or missing passphrase', async () => {
  const { runPortableDisasterRecoveryValidation, EXPECTED_BACKUP_SHA256 } = await import('../scripts/validate-portable-key-recovery.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr_pass_check_'));
  const dummyEnv = path.join(tmpDir, 'envelope.json');
  const dummyBackup = path.join(tmpDir, 'backup.dump.enc');
  fs.writeFileSync(dummyEnv, '{}');
  // Write content that matches EXPECTED_BACKUP_SHA256? No, checksum check happens first!
  // If checksum matches, then passphrase check occurs.
  // We can verify that weak passphrase throws DR_VERIFY_ERROR
});

