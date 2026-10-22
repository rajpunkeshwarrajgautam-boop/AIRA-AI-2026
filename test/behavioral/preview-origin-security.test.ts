import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isRequestTargetingOrigin, resolveTargetDeployment } from '../preview-real-acceptance.js';
import { formatProvenanceBadge } from '../../src/components/ChatMessage.js';

describe('Preview Origin Security & Provenance Badge Fidelity Suite', () => {
  const previewOrigin = 'https://aira-ai-2026-ba7ahm4r9-rajpunkeshwarrajgautam-boops-projects.vercel.app';

  describe('isRequestTargetingOrigin — Strict URL Origin Isolation', () => {
    it('accepts legitimate same-origin requests with various paths, queries, and ports', () => {
      assert.strictEqual(
        isRequestTargetingOrigin(`${previewOrigin}/`, previewOrigin),
        true,
        'Root path must match'
      );
      assert.strictEqual(
        isRequestTargetingOrigin(`${previewOrigin}/api/chat`, previewOrigin),
        true,
        'API route must match'
      );
      assert.strictEqual(
        isRequestTargetingOrigin(`${previewOrigin}/api/chat?stream=true&model=nemotron#section`, previewOrigin),
        true,
        'Query parameters and fragments must match'
      );
      assert.strictEqual(
        isRequestTargetingOrigin(`${previewOrigin.toUpperCase()}/nested/route`, previewOrigin),
        true,
        'Case-insensitive origin matching must succeed'
      );
    });

    it('REJECTS malicious lookalike hostnames using attacker suffix domain (CRITICAL REGRESSION)', () => {
      // Previously, reqUrl.startsWith(previewOrigin) would return TRUE for these lookalike hostnames:
      const lookalikeAttackerUrl = `${previewOrigin}.attacker.com/steal-bypass-header`;
      assert.strictEqual(
        isRequestTargetingOrigin(lookalikeAttackerUrl, previewOrigin),
        false,
        'Must NEVER forward bypass header to lookalike attacker domain (.attacker.com)'
      );
    });

    it('REJECTS malicious lookalike hostnames using hyphenated suffix domain', () => {
      const hyphenatedLookalikeUrl = `${previewOrigin}-evil.com/collect`;
      assert.strictEqual(
        isRequestTargetingOrigin(hyphenatedLookalikeUrl, previewOrigin),
        false,
        'Must NEVER forward bypass header to hyphenated lookalike domain (-evil.com)'
      );
    });

    it('REJECTS malicious lookalike hostnames with subdomain prefix', () => {
      const subdomainLookalikeUrl = 'https://attacker.aira-ai-2026-ba7ahm4r9-rajpunkeshwarrajgautam-boops-projects.vercel.app/leak';
      assert.strictEqual(
        isRequestTargetingOrigin(subdomainLookalikeUrl, previewOrigin),
        false,
        'Must NEVER forward bypass header to arbitrary subdomain'
      );
    });

    it('REJECTS protocol downgrade attacks (http vs https)', () => {
      const insecureUrl = previewOrigin.replace('https://', 'http://') + '/api/chat';
      assert.strictEqual(
        isRequestTargetingOrigin(insecureUrl, previewOrigin),
        false,
        'Must REJECT insecure HTTP downgrade'
      );
    });

    it('REJECTS port mismatch lookalikes', () => {
      const portMismatchUrl = previewOrigin + ':8443/api/chat';
      assert.strictEqual(
        isRequestTargetingOrigin(portMismatchUrl, previewOrigin),
        false,
        'Must REJECT unexpected port lookalike'
      );
    });

    it('REJECTS completely cross-origin requests (e.g. Google Fonts, CDNs, third-party APIs)', () => {
      assert.strictEqual(
        isRequestTargetingOrigin('https://fonts.googleapis.com/css2?family=Inter', previewOrigin),
        false,
        'Google Fonts must not receive bypass headers'
      );
      assert.strictEqual(
        isRequestTargetingOrigin('https://api.tavily.com/search', previewOrigin),
        false,
        'External search APIs must not receive bypass headers'
      );
      assert.strictEqual(
        isRequestTargetingOrigin('https://integrate.api.nvidia.com/v1/chat/completions', previewOrigin),
        false,
        'NVIDIA NIM must not receive bypass headers'
      );
    });

    it('handles malformed URLs and invalid input safely without throwing', () => {
      assert.strictEqual(isRequestTargetingOrigin('not-a-valid-url', previewOrigin), false);
      assert.strictEqual(isRequestTargetingOrigin('', previewOrigin), false);
      assert.strictEqual(isRequestTargetingOrigin('javascript:void(0)', previewOrigin), false);
    });
  });

  describe('resolveTargetDeployment — Fail-Closed Hardening', () => {
    const originalEnv = { ...process.env };

    it('supports explicit authenticated deployment parameters when both are provided', () => {
      process.env.AIRA_TARGET_DEPLOYMENT_ID = 'dpl_explicit_auth_test_123';
      process.env.AIRA_PREVIEW_URL = 'https://aira-explicit-test.vercel.app/';

      const result = resolveTargetDeployment('any-commit-sha');
      assert.strictEqual(result.deploymentId, 'dpl_explicit_auth_test_123');
      assert.strictEqual(result.previewUrl, 'https://aira-explicit-test.vercel.app/');

      delete process.env.AIRA_TARGET_DEPLOYMENT_ID;
      delete process.env.AIRA_PREVIEW_URL;
    });

    it('fails closed and throws rather than substituting hardcoded stale deployments on lookup failure', () => {
      delete process.env.AIRA_TARGET_DEPLOYMENT_ID;
      delete process.env.AIRA_PREVIEW_URL;

      // Passing an invalid or non-existent commit SHA
      assert.throws(
        () => resolveTargetDeployment('0000000000000000000000000000000000000000'),
        /RESOLVE_DEPLOYMENT_FAILED/
      );
    });
  });

  describe('formatProvenanceBadge — Visible Distinction of verified: false', () => {
    it('Scenario 1: Confirmed model identity (verified: true, executionStatus: SUCCESS)', () => {
      const badge = formatProvenanceBadge({
        requestedModel: 'nvidia/nemotron-3-super-120b-a12b',
        resolvedPolicyModel: 'nvidia/nemotron-3-super-120b-a12b',
        provider: 'nvidia',
        executedModel: 'nvidia/nemotron-3-super-120b-a12b',
        fallbackOccurred: false,
        verified: true,
        executionStatus: 'SUCCESS',
        timestamp: Date.now()
      });

      assert.strictEqual(badge.text, 'NVIDIA · nemotron-3-super-120b-a12b');
      assert.strictEqual(badge.isVerified, true);
      assert.strictEqual(badge.statusSuffix, '');
      assert.strictEqual(badge.className.includes('border-dashed'), false, 'Confirmed badge must NOT have dashed border');
      assert.strictEqual(badge.title.includes('Confirmed'), true);
      assert.strictEqual(badge.title.includes('Unconfirmed'), false);
    });

    it('Scenario 2: Unconfirmed model identity (verified: false, executionStatus: SUCCESS)', () => {
      const badge = formatProvenanceBadge({
        requestedModel: 'mock-deterministic',
        resolvedPolicyModel: 'mock-deterministic',
        provider: 'mock',
        executedModel: 'mock-deterministic',
        fallbackOccurred: false,
        verified: false,
        executionStatus: 'SUCCESS',
        timestamp: Date.now()
      });

      assert.strictEqual(badge.text, 'Mock · mock-deterministic (Unconfirmed)');
      assert.strictEqual(badge.isVerified, false);
      assert.strictEqual(badge.statusSuffix, ' (Unconfirmed)');
      assert.strictEqual(badge.className.includes('border-dashed'), true, 'Unconfirmed badge must visibly have dashed border');
      assert.strictEqual(badge.className.includes('amber'), true, 'Unconfirmed badge must have amber styling');
      assert.strictEqual(badge.title.includes('Unconfirmed'), true);
    });

    it('Scenario 3: Fallback execution with confirmed model identity (verified: true, executionStatus: FALLBACK)', () => {
      const badge = formatProvenanceBadge({
        requestedModel: 'auto',
        resolvedPolicyModel: 'claude-3-7-sonnet',
        provider: 'nvidia',
        executedModel: 'nvidia/nemotron-3-super-120b-a12b',
        fallbackOccurred: true,
        fallbackReason: 'Anthropic API key absent on Preview',
        verified: true,
        executionStatus: 'FALLBACK',
        timestamp: Date.now()
      });

      assert.strictEqual(badge.text, 'NVIDIA · nemotron-3-super-120b-a12b (Fallback)');
      assert.strictEqual(badge.isVerified, true);
      assert.strictEqual(badge.statusSuffix, ' (Fallback)');
      assert.strictEqual(badge.className.includes('border-dashed'), false);
      assert.strictEqual(badge.title.includes('Fallback'), true);
      assert.strictEqual(badge.title.includes('Confirmed'), true);
    });

    it('Scenario 4: Fallback execution with unconfirmed model identity (verified: false, executionStatus: FALLBACK)', () => {
      const badge = formatProvenanceBadge({
        requestedModel: 'auto',
        resolvedPolicyModel: 'claude-3-7-sonnet',
        provider: 'nvidia',
        executedModel: 'nvidia/nemotron-3-super-120b-a12b',
        fallbackOccurred: true,
        fallbackReason: 'Upstream omitted model ID during fallback',
        verified: false,
        executionStatus: 'FALLBACK',
        timestamp: Date.now()
      });

      assert.strictEqual(badge.text, 'NVIDIA · nemotron-3-super-120b-a12b (Fallback · Unconfirmed)');
      assert.strictEqual(badge.isVerified, false);
      assert.strictEqual(badge.statusSuffix, ' (Fallback · Unconfirmed)');
      assert.strictEqual(badge.className.includes('border-dashed'), true);
      assert.strictEqual(badge.title.includes('Unconfirmed'), true);
    });

    it('Scenario 5: Failed execution (executionStatus: FAILED, verified: false)', () => {
      const badge = formatProvenanceBadge({
        requestedModel: 'nvidia/nemotron-3-super-120b-a12b',
        resolvedPolicyModel: 'nvidia/nemotron-3-super-120b-a12b',
        provider: 'nvidia',
        executedModel: 'nvidia/nemotron-3-super-120b-a12b',
        fallbackOccurred: false,
        verified: false,
        executionStatus: 'FAILED',
        timestamp: Date.now()
      });

      assert.strictEqual(badge.text, 'NVIDIA · nemotron-3-super-120b-a12b (Failed)');
      assert.strictEqual(badge.statusSuffix, ' (Failed)');
      assert.strictEqual(badge.className.includes('rose'), true, 'Failed badge must have rose styling');
      assert.strictEqual(badge.executionStatus, 'FAILED');
    });
  });
});
