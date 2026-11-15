import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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
