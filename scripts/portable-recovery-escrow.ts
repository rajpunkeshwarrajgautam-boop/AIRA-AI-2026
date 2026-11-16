import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);

export interface PortableEnvelopeMetadata {
  format: 'AIRA_PORTABLE_KEY_ENVELOPE_V1';
  kdf: 'scrypt';
  scryptParams: {
    cost: number;            // N = 32768 (CPU/memory cost)
    blockSize: number;       // r = 8
    parallelization: number; // p = 1
    maxmem: number;          // 128 MB RAM bound
    keyLength: number;       // 32 bytes (256 bits)
  };
  cipher: 'aes-256-gcm';
  saltHex: string;
  ivHex: string;
  tagHex: string;
  ciphertextHex: string;
  keyFingerprintSha256: string;
  createdAt: string;
}

export interface CreatePortableEnvelopeOptions {
  backupKey: string | Buffer;
  recoveryPassphrase: string;
  destinationDir: string;
  envelopeFilename?: string;
}

/**
 * Creates a portable AES-256-GCM encrypted recovery envelope independent of Windows DPAPI.
 * Scrypt KDF parameters: N=32768, r=8, p=1, maxmem=128MB.
 * Nonce: 96-bit (12 bytes) cryptographically random IV.
 * Authenticated via 128-bit (16 bytes) GCM auth tag.
 */
export function createPortableRecoveryEnvelope(options: CreatePortableEnvelopeOptions): {
  envelopePath: string;
  keyFingerprint: string;
} {
  const { backupKey, recoveryPassphrase, destinationDir, envelopeFilename = 'aira_portable_recovery_envelope.json' } = options;

  if (!recoveryPassphrase || typeof recoveryPassphrase !== 'string' || recoveryPassphrase.length < 16) {
    throw new Error('[ESCROW_SECURITY_ERROR] Recovery passphrase must be provided and must be at least 16 characters long.');
  }

  // Strictly verify destination exists — never assume drive E: or fall back to C:
  if (!fs.existsSync(destinationDir)) {
    throw new Error(
      `[ESCROW_TARGET_ERROR] Configured destination directory "${destinationDir}" does not exist. ` +
      'Please mount and verify the approved removable recovery storage drive before creating escrow.'
    );
  }

  const stat = fs.statSync(destinationDir);
  if (!stat.isDirectory()) {
    throw new Error(`[ESCROW_TARGET_ERROR] Destination path "${destinationDir}" is not a directory.`);
  }

  const keyBuffer = Buffer.isBuffer(backupKey) ? backupKey : Buffer.from(backupKey.trim(), 'utf8');
  if (keyBuffer.length === 0) {
    throw new Error('[ESCROW_SECURITY_ERROR] Backup key to be encrypted cannot be empty.');
  }

  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12); // 96-bit GCM nonce

  const scryptParams = {
    cost: 32768,
    blockSize: 8,
    parallelization: 1,
    maxmem: 128 * 1024 * 1024,
    keyLength: 32,
  };

  const derivedKey = crypto.scryptSync(recoveryPassphrase, salt, scryptParams.keyLength, {
    N: scryptParams.cost,
    r: scryptParams.blockSize,
    p: scryptParams.parallelization,
    maxmem: scryptParams.maxmem,
  });

  const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey, iv);
  const encrypted = Buffer.concat([cipher.update(keyBuffer), cipher.final()]);
  const tag = cipher.getAuthTag();

  const keyFingerprint = crypto.createHash('sha256').update(keyBuffer).digest('hex');

  const metadata: PortableEnvelopeMetadata = {
    format: 'AIRA_PORTABLE_KEY_ENVELOPE_V1',
    kdf: 'scrypt',
    scryptParams,
    cipher: 'aes-256-gcm',
    saltHex: salt.toString('hex'),
    ivHex: iv.toString('hex'),
    tagHex: tag.toString('hex'),
    ciphertextHex: encrypted.toString('hex'),
    keyFingerprintSha256: keyFingerprint,
    createdAt: new Date().toISOString(),
  };

  const envelopePath = path.join(destinationDir, envelopeFilename);
  fs.writeFileSync(envelopePath, JSON.stringify(metadata, null, 2), { encoding: 'utf8', mode: 0o600 });

  return { envelopePath, keyFingerprint };
}

/**
 * Recovers the backup encryption key from a portable recovery envelope.
 * Completely independent of Windows DPAPI, local workstation registry, and user profiles.
 */
export function recoverKeyFromPortableEnvelope(envelopePath: string, recoveryPassphrase: string): {
  backupKey: string;
  keyFingerprint: string;
} {
  if (!fs.existsSync(envelopePath)) {
    throw new Error(`[ESCROW_RECOVERY_ERROR] Recovery envelope file missing: "${envelopePath}".`);
  }

  const content = fs.readFileSync(envelopePath, 'utf8');
  let metadata: PortableEnvelopeMetadata;
  try {
    metadata = JSON.parse(content);
  } catch {
    throw new Error('[ESCROW_RECOVERY_ERROR] Recovery envelope is not valid JSON.');
  }

  if (metadata.format !== 'AIRA_PORTABLE_KEY_ENVELOPE_V1' || metadata.cipher !== 'aes-256-gcm' || metadata.kdf !== 'scrypt') {
    throw new Error('[ESCROW_RECOVERY_ERROR] Unsupported recovery envelope format or cipher algorithm.');
  }

  const salt = Buffer.from(metadata.saltHex, 'hex');
  const iv = Buffer.from(metadata.ivHex, 'hex');
  const tag = Buffer.from(metadata.tagHex, 'hex');
  const ciphertext = Buffer.from(metadata.ciphertextHex, 'hex');

  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error('[ESCROW_RECOVERY_ERROR] Invalid cryptographic parameters in recovery envelope.');
  }

  const derivedKey = crypto.scryptSync(recoveryPassphrase, salt, metadata.scryptParams.keyLength, {
    N: metadata.scryptParams.cost,
    r: metadata.scryptParams.blockSize,
    p: metadata.scryptParams.parallelization,
    maxmem: metadata.scryptParams.maxmem,
  });

  const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey, iv);
  decipher.setAuthTag(tag);

  let decrypted: Buffer;
  try {
    decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err: any) {
    throw new Error(`[ESCROW_AUTH_FAILED] Decryption failed or recovery passphrase incorrect: ${err.message}`);
  }

  const recoveredFingerprint = crypto.createHash('sha256').update(decrypted).digest('hex');
  if (recoveredFingerprint !== metadata.keyFingerprintSha256) {
    throw new Error('[ESCROW_INTEGRITY_FAILED] Recovered key fingerprint does not match metadata.');
  }

  return {
    backupKey: decrypted.toString('utf8'),
    keyFingerprint: recoveredFingerprint,
  };
}

export interface PortableEscrowCliArgs {
  destinationDir?: string;
  envelopePath?: string;
  recoveryPassphrase?: string;
  backupKey?: string;
  envelopeFilename?: string;
  verifyOnly?: boolean;
}

export function parsePortableEscrowCliArgs(argv: string[]): PortableEscrowCliArgs {
  const result: PortableEscrowCliArgs = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      result.destinationDir = '--help';
      return result;
    }

    if (arg.startsWith('--destination=')) {
      result.destinationDir = arg.slice('--destination='.length);
    } else if (arg === '--destination' && i + 1 < argv.length) {
      result.destinationDir = argv[++i];
    } else if (arg.startsWith('--recovery-passphrase=')) {
      result.recoveryPassphrase = arg.slice('--recovery-passphrase='.length);
    } else if (arg === '--recovery-passphrase' && i + 1 < argv.length) {
      result.recoveryPassphrase = argv[++i];
    } else if (arg.startsWith('--recovery-passphrase-env=')) {
      const envName = arg.slice('--recovery-passphrase-env='.length);
      result.recoveryPassphrase = process.env[envName];
    } else if (arg.startsWith('--backup-key=')) {
      result.backupKey = arg.slice('--backup-key='.length);
    } else if (arg === '--backup-key' && i + 1 < argv.length) {
      result.backupKey = argv[++i];
    } else if (arg.startsWith('--backup-key-env=')) {
      const envName = arg.slice('--backup-key-env='.length);
      result.backupKey = process.env[envName];
    } else if (arg.startsWith('--envelope=')) {
      result.envelopePath = arg.slice('--envelope='.length);
    } else if (arg === '--envelope' && i + 1 < argv.length) {
      result.envelopePath = argv[++i];
    } else if (arg.startsWith('--verify=')) {
      result.verifyOnly = true;
      result.envelopePath = arg.slice('--verify='.length);
    } else if (arg === '--verify') {
      result.verifyOnly = true;
    } else if (arg.startsWith('--envelope-filename=')) {
      result.envelopeFilename = arg.slice('--envelope-filename='.length);
    } else {
      throw new Error(`[CLI_VALIDATION_ERROR] Unrecognized or invalid argument: "${arg}"`);
    }
  }

  return result;
}

export function tryReadDpapiEscrowKey(): string | null {
  const INDEP_KEY_FILE = 'C:\\Users\\WORKSTATION\\.aira_secure_keys\\aira_prod_backup_passphrase_dpapi_encrypted.bin';
  if (process.platform !== 'win32' || !fs.existsSync(INDEP_KEY_FILE)) {
    return null;
  }
  try {
    const psScript = `
      Add-Type -AssemblyName System.Security
      $encBytes = [System.IO.File]::ReadAllBytes('${INDEP_KEY_FILE.replace(/\\/g, '\\\\')}')
      $entropy = [System.Text.Encoding]::UTF8.GetBytes('AIRA_AI_2026_INDEPENDENT_KEY_ESCROW')
      $decBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
        $encBytes,
        $entropy,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
      )
      [System.Text.Encoding]::UTF8.GetString($decBytes)
    `;
    const res = spawnSync('powershell', ['-NoProfile', '-Command', psScript], {
      encoding: 'utf8',
    });
    if (res.status === 0 && res.stdout.trim()) {
      return res.stdout.trim();
    }
  } catch {}
  return null;
}

export function runPortableEscrowCli(argv: string[]): void {
  const args = parsePortableEscrowCliArgs(argv);

  if (args.destinationDir === '--help') {
    console.log(`
AIRA AI 2026 — Portable Recovery Escrow CLI
Usage:
  # Create a portable AES-256-GCM recovery envelope in the designated directory:
  npx tsx scripts/portable-recovery-escrow.ts --destination=<path> [--recovery-passphrase=<pass>] [--backup-key=<key>]

  # Verify an existing portable recovery envelope:
  npx tsx scripts/portable-recovery-escrow.ts --verify=<envelope_path> [--recovery-passphrase=<pass>]

Options:
  --destination=<path>              Removable escrow target directory (e.g. E:\\AIRA_RECOVERY_ESCROW)
  --recovery-passphrase=<pass>      Independent recovery passphrase (>=16 chars; or via AIRA_RECOVERY_PASSPHRASE env)
  --backup-key=<key>                Source backup encryption key (or via AIRA_BACKUP_ENCRYPTION_KEY or DPAPI)
  --envelope=<path>                 Path to envelope JSON file for verification
  --verify[=<path>]                 Verify envelope authenticity without exposing secrets
  --envelope-filename=<name>        Custom filename (default: aira_portable_recovery_envelope.json)
`);
    return;
  }

  const recoveryPassphrase =
    args.recoveryPassphrase ||
    process.env.AIRA_RECOVERY_PASSPHRASE ||
    '';

  if (!recoveryPassphrase || recoveryPassphrase.length < 16) {
    throw new Error(
      '[ESCROW_SECURITY_ERROR] Recovery passphrase must be provided via --recovery-passphrase or AIRA_RECOVERY_PASSPHRASE and must be at least 16 characters long.'
    );
  }

  if (args.verifyOnly) {
    const envelopePath =
      args.envelopePath ||
      (args.destinationDir
        ? path.join(args.destinationDir, args.envelopeFilename || 'aira_portable_recovery_envelope.json')
        : null);

    if (!envelopePath) {
      throw new Error('[ESCROW_CLI_ERROR] Must provide envelope path via --verify=<path> or --envelope=<path>.');
    }

    const { keyFingerprint } = recoverKeyFromPortableEnvelope(envelopePath, recoveryPassphrase);
    console.log('========================================================================');
    console.log(' AIRA AI 2026 — PORTABLE ESCROW ENVELOPE VERIFICATION: PASS');
    console.log('========================================================================');
    console.log(`✓ Envelope:         ${envelopePath}`);
    console.log(`✓ Status:           AUTHENTICATED`);
    console.log(`✓ Key Fingerprint:  ${keyFingerprint} (SHA-256)`);
    console.log(`✓ Integrity:        128-bit GCM Auth Tag & Plaintext Fingerprint Validated`);
    return;
  }

  if (!args.destinationDir) {
    throw new Error('[ESCROW_CLI_ERROR] Missing required flag: --destination=<directory_path>.');
  }

  let backupKey =
    args.backupKey ||
    process.env.AIRA_BACKUP_ENCRYPTION_KEY ||
    '';

  if (!backupKey) {
    const dpapiExtracted = tryReadDpapiEscrowKey();
    if (dpapiExtracted) {
      backupKey = dpapiExtracted;
      console.log('  -> Sourced backup key from local DPAPI credential store.');
    } else {
      throw new Error(
        '[ESCROW_SECURITY_ERROR] Backup key not found. Provide via --backup-key, AIRA_BACKUP_ENCRYPTION_KEY, or local DPAPI escrow.'
      );
    }
  }

  console.log('========================================================================');
  console.log(' AIRA AI 2026 — CREATING PORTABLE RECOVERY ESCROW ENVELOPE');
  console.log('========================================================================');
  console.log(`Target Destination: ${args.destinationDir}`);

  const { envelopePath, keyFingerprint } = createPortableRecoveryEnvelope({
    backupKey,
    recoveryPassphrase,
    destinationDir: args.destinationDir,
    envelopeFilename: args.envelopeFilename,
  });

  const stat = fs.statSync(envelopePath);
  console.log(`✓ Envelope Created:   ${envelopePath} (${stat.size} bytes)`);
  console.log(`✓ KDF:                scrypt (N=32768, r=8, p=1, maxmem=128MB)`);
  console.log(`✓ Cipher:             aes-256-gcm (96-bit nonce, 128-bit auth tag)`);
  console.log(`✓ Key Fingerprint:    ${keyFingerprint} (SHA-256)`);

  // Immediate round-trip validation
  console.log('\nPerforming immediate round-trip recovery verification on written file...');
  const verifyCheck = recoverKeyFromPortableEnvelope(envelopePath, recoveryPassphrase);
  if (verifyCheck.keyFingerprint !== keyFingerprint) {
    throw new Error('[ESCROW_INTEGRITY_FAILED] Round-trip verification failed: fingerprint mismatch.');
  }
  console.log('✓ Round-trip Check:   100% PASS (envelope successfully decrypted and authenticated).');
  console.log('========================================================================\n');
}

// CLI Entrypoint
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  try {
    runPortableEscrowCli(process.argv.slice(2));
    process.exit(0);
  } catch (err: any) {
    console.error('\n✗ Portable Escrow Error:', err.message);
    process.exit(1);
  }
}
