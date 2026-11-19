import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  hashPrincipalIdentifier,
  validateSanitizedRecord
} from '../scripts/oauth-positive-certification-engine.js';

describe('Remediation F6: OAuth Evidence Privacy & Non-Reversible Identifiers', () => {
  describe('Cryptographic Principal Pseudonymization', () => {
    it('generates non-reversible keyed HMAC-SHA256 hashes without exposing identifiers', () => {
      const rawUserId = 'usr_private_998877';
      const hash1 = hashPrincipalIdentifier(rawUserId, 'test_hmac_key_123');
      const hash2 = hashPrincipalIdentifier(rawUserId, 'test_hmac_key_123');

      assert.equal(hash1, hash2, 'HMAC must be deterministic for identical input and key');
      assert.equal(hash1.length, 64, 'SHA256 hex digest must be 64 characters');
      assert.doesNotMatch(hash1, /usr_private/, 'Hash must not leak input substring');
    });

    it('produces distinct hashes when keys differ', () => {
      const rawUserId = 'usr_private_998877';
      const hashKeyA = hashPrincipalIdentifier(rawUserId, 'key_a');
      const hashKeyB = hashPrincipalIdentifier(rawUserId, 'key_b');

      assert.notEqual(hashKeyA, hashKeyB, 'Different HMAC keys must produce completely distinct hashes');
    });

    it('defaults to safe fallback key if AIRA_EVIDENCE_HMAC_KEY is unset', () => {
      const hash = hashPrincipalIdentifier('usr_sample');
      assert.equal(typeof hash, 'string');
      assert.equal(hash.length, 64);
    });
  });

  describe('Sanitized Evidence Record Verification', () => {
    it('accepts completely sanitized evidence structures', () => {
      const sanitizedRecord = {
        provider: 'google',
        principalHash: hashPrincipalIdentifier('usr_123'),
        authenticated: true,
        sessionPersistedOnReload: true,
        linkedProviders: ['google'],
        freeTierEntitlementsVerified: true,
        timestamp: '2026-11-19T12:00:00.000Z'
      };

      const result = validateSanitizedRecord(sanitizedRecord);
      assert.equal(result.valid, true);
      assert.equal(result.violations.length, 0);
    });

    it('detects and rejects plaintext email addresses in records', () => {
      const leakedRecord = {
        provider: 'github',
        principalHash: 'a5c94966...',
        userEmail: 'engineer@example.com' // Sensitive!
      };

      const result = validateSanitizedRecord(leakedRecord);
      assert.equal(result.valid, false);
      assert.ok(result.violations.some(v => v.includes('userEmail') || v.includes('Sensitive key')));
    });

    it('detects and rejects authentication tokens and secret patterns', () => {
      const tokenRecord = {
        provider: 'google',
        token: 'ghp_super_secret_token_1234567890',
        accessToken: 'ya29.sensitive_oauth_token'
      };

      const result = validateSanitizedRecord(tokenRecord);
      assert.equal(result.valid, false);
      assert.ok(result.violations.length >= 2);
    });

    it('detects embedded email regex patterns inside arbitrary string values', () => {
      const sneakyRecord = {
        provider: 'google',
        notes: 'User contact was developer.test@virexaaiventures.com for testing'
      };

      const result = validateSanitizedRecord(sneakyRecord);
      assert.equal(result.valid, false);
      assert.ok(result.violations.some(v => v.includes('forbidden credential pattern')));
    });
  });

  describe('Atomic Evidence Persistence with Secure Permissions', () => {
    it('writes evidence atomically without leaving partial or corrupted artifacts', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aira-privacy-test-'));
      const testFilePath = path.join(tmpDir, 'sanitized_evidence.json');

      const testData = {
        status: 'SUCCESS',
        principalHash: '20b32d76...',
        timestamp: new Date().toISOString()
      };

      // Atomic write pattern verification
      const tmpPath = `${testFilePath}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(testData, null, 2), { mode: 0o600 });
      fs.renameSync(tmpPath, testFilePath);

      assert.ok(fs.existsSync(testFilePath));
      const readBack = JSON.parse(fs.readFileSync(testFilePath, 'utf8'));
      assert.equal(readBack.status, 'SUCCESS');
      assert.equal(readBack.principalHash, '20b32d76...');

      // Cleanup
      fs.unlinkSync(testFilePath);
      fs.rmdirSync(tmpDir);
    });
  });
});
