import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertCertificationFixtureWriteOptIn,
  assertIsolatedAuthEndpoint
} from './staging-certification-safety.js';

const base = 'https://ep-isolated-123.neonauth.c-4.ap-southeast-1.aws.neon.tech/neondb/auth';
const jwks = `${base}/.well-known/jwks.json`;

test('accepts Auth only when its endpoint matches the verified database compute', () => {
  assert.doesNotThrow(() => assertIsolatedAuthEndpoint(base, jwks, 'ep-isolated-123'));
});

test('rejects a real-looking Auth endpoint bound to a different staging branch', () => {
  assert.throws(() => assertIsolatedAuthEndpoint(base, jwks, 'ep-different-456'), /does not match/);
});

test('rejects external lookalike hosts, insecure URLs and mismatched JWKS', () => {
  assert.throws(() => assertIsolatedAuthEndpoint(base.replace('aws.neon.tech', 'aws.neon.tech.evil.test'), jwks, 'ep-isolated-123'));
  assert.throws(() => assertIsolatedAuthEndpoint(base.replace('https:', 'http:'), jwks, 'ep-isolated-123'));
  assert.throws(() => assertIsolatedAuthEndpoint(base, 'https://other.invalid/jwks.json', 'ep-isolated-123'));
});

test('refuses fixture writes unless explicitly opted in', () => {
  for (const value of [undefined, '', 'false', 'TRUE', '1']) {
    assert.throws(() => assertCertificationFixtureWriteOptIn(value));
  }
  assert.doesNotThrow(() => assertCertificationFixtureWriteOptIn('true'));
});
