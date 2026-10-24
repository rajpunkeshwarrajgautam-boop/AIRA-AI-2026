import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeUrlForLogging } from '../apps/api/src/index.js';

test('Security Audit: sanitizeUrlForLogging prevents credential leakage', async (t) => {
  await t.test('Redacts OAuth authorization code and state parameter from query strings', () => {
    const rawUrl = '/api/auth/oauth/google/callback?code=4/0AbCd12345SecretCode&state=secure_state_val_8899&flowId=flw_9900';
    const sanitized = sanitizeUrlForLogging(rawUrl);

    assert.ok(!sanitized.includes('4/0AbCd12345SecretCode'), 'Must not contain raw authorization code');
    assert.ok(!sanitized.includes('secure_state_val_8899'), 'Must not contain raw state value');
    assert.ok(!sanitized.includes('flw_9900'), 'Must not contain raw flowId');
    assert.ok(sanitized.includes('code=%5BREDACTED%5D') || sanitized.includes('code=[REDACTED]'), 'Code param must be redacted');
    assert.ok(sanitized.includes('state=%5BREDACTED%5D') || sanitized.includes('state=[REDACTED]'), 'State param must be redacted');
    assert.ok(sanitized.startsWith('/api/auth/oauth/google/callback'), 'Must preserve pathname');
  });

  await t.test('Redacts tokens, session identifiers, passwords, and API keys', () => {
    const rawUrl = '/api/v1/resource?token=secret_jwt_token&sessionToken=sess_abc&apiKey=sk-123456&password=mypassword';
    const sanitized = sanitizeUrlForLogging(rawUrl);

    assert.ok(!sanitized.includes('secret_jwt_token'));
    assert.ok(!sanitized.includes('sess_abc'));
    assert.ok(!sanitized.includes('sk-123456'));
    assert.ok(!sanitized.includes('mypassword'));
    assert.ok(sanitized.includes('token=%5BREDACTED%5D') || sanitized.includes('token=[REDACTED]'));
  });

  await t.test('Redacts email query parameters to prevent PII logging', () => {
    const rawUrl = '/?auth_error=account_exists_conflict&email=user%40example.com';
    const sanitized = sanitizeUrlForLogging(rawUrl);

    assert.ok(!sanitized.includes('user@example.com'));
    assert.ok(!sanitized.includes('user%40example.com'));
    assert.ok(sanitized.includes('auth_error=account_exists_conflict'), 'Preserves safe error codes');
  });

  await t.test('Preserves safe diagnostic query parameters', () => {
    const rawUrl = '/api/chat/stream?mode=chat&stream=true&limit=50';
    const sanitized = sanitizeUrlForLogging(rawUrl);

    assert.strictEqual(sanitized, '/api/chat/stream?mode=chat&stream=true&limit=50');
  });

  await t.test('Handles malformed URLs gracefully without throwing', () => {
    const rawUrl = 'http:///invalid:url:pattern/callback?code=123';
    assert.doesNotThrow(() => {
      const sanitized = sanitizeUrlForLogging(rawUrl);
      assert.ok(!sanitized.includes('123'));
    });
  });

  await t.test('Handles empty or undefined inputs safely', () => {
    assert.strictEqual(sanitizeUrlForLogging(''), '');
  });
});
