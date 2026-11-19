import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateStagingTargetUrl,
  validateStagingDatabaseUrl,
  validateRedirectTargetUrl
} from './helpers/staging-test-fixture-lifecycle.js';

describe('Remediation F5: Staging Target Validation & Security Matrix', () => {
  describe('HTTP/HTTPS Target URL Validation', () => {
    it('accepts legitimate canonical staging URL', () => {
      const result = validateStagingTargetUrl('https://staging.virexaaiventures.com');
      assert.equal(result, 'https://staging.virexaaiventures.com');
    });

    it('accepts valid scoped Vercel preview URLs matching the strict regex', () => {
      const validPreview = 'https://aira-ai-2026-971f7620-team-0izkx9o2ab319usapw9oq1sl.vercel.app';
      const result = validateStagingTargetUrl(validPreview);
      assert.equal(result, validPreview);
    });

    it('accepts local development URLs on http/https', () => {
      assert.equal(validateStagingTargetUrl('http://localhost:3000/api'), 'http://localhost:3000');
      assert.equal(validateStagingTargetUrl('http://127.0.0.1:3001'), 'http://127.0.0.1:3001');
    });

    it('rejects lookalike and attacker-controlled domains fail-closed', () => {
      const lookalikes = [
        'https://staging.virexaaiventures.com.attacker.com',
        'https://staging.virexaaiventures.com.evil.io/path',
        'https://fake-virexaaiventures.com',
        'https://aira-ai-2026.vercel.app.attacker.com',
        'https://preview-staging.com'
      ];

      for (const target of lookalikes) {
        assert.throws(
          () => validateStagingTargetUrl(target),
          /is not recognized as a valid staging or preview domain/,
          `Target '${target}' must be rejected as an unapproved domain`
        );
      }
    });

    it('unconditionally rejects production targets', () => {
      const prodTargets = [
        'https://aira-ai-2026.vercel.app',
        'https://virexaaiventures.com',
        'https://www.virexaaiventures.com',
        'https://aira-ai-2026-git-prod-team.vercel.app',
        'https://aira-ai-2026-production.vercel.app'
      ];

      for (const target of prodTargets) {
        assert.throws(
          () => validateStagingTargetUrl(target),
          /targets PRODUCTION/,
          `Target '${target}' must be rejected because it points to production`
        );
      }
    });

    it('rejects URLs with embedded userinfo credentials fail-closed', () => {
      const userinfoUrls = [
        'https://admin:password@staging.virexaaiventures.com',
        'https://user:token@staging.virexaaiventures.com/dashboard',
        'http://root:toor@localhost:3000'
      ];

      for (const target of userinfoUrls) {
        assert.throws(
          () => validateStagingTargetUrl(target),
          /userinfo credentials is strictly rejected/,
          `Target '${target}' must be rejected for containing userinfo`
        );
      }
    });

    it('rejects non-standard ports on remote targets', () => {
      const nonStandardPorts = [
        'https://staging.virexaaiventures.com:8443',
        'https://staging.virexaaiventures.com:444',
        'https://staging.virexaaiventures.com:8080'
      ];

      for (const target of nonStandardPorts) {
        assert.throws(
          () => validateStagingTargetUrl(target),
          /unapproved port/,
          `Remote target with port '${target}' must be rejected`
        );
      }
    });

    it('rejects insecure HTTP protocol for remote targets', () => {
      assert.throws(
        () => validateStagingTargetUrl('http://staging.virexaaiventures.com'),
        /must use HTTPS/,
        'Remote staging target must require HTTPS'
      );
    });

    it('rejects empty or malformed URLs', () => {
      assert.throws(() => validateStagingTargetUrl(''), /Target URL is empty/);
      assert.throws(() => validateStagingTargetUrl('   '), /Target URL is empty/);
      assert.throws(() => validateStagingTargetUrl('not a url'), /Target URL is malformed/);
    });
  });

  describe('Database Target URL Validation', () => {
    it('accepts local disposable database URLs', () => {
      assert.doesNotThrow(() => {
        validateStagingDatabaseUrl('postgresql://postgres:postgres@localhost:5432/disposable_test_db', {
          requireDisposable: true
        });
      });
      assert.doesNotThrow(() => {
        validateStagingDatabaseUrl('postgresql://postgres:postgres@127.0.0.1:5432/ci_test', {
          requireDisposable: true
        });
      });
    });

    it('strictly rejects production Neon database endpoints and project IDs', () => {
      const productionUrls = [
        'postgresql://aira_owner:secret@ep-cool-fog-123456.us-east-2.aws.neon.tech/aira?sslmode=require',
        'postgresql://aira_user:pass@ep-prod-root.us-east-2.aws.neon.tech/aira-ai-2026?sslmode=require'
      ];

      for (const dbUrl of productionUrls) {
        assert.throws(
          () => validateStagingDatabaseUrl(dbUrl, { requireDisposable: true }),
          /classified as PRODUCTION|not verified as an authorized disposable database target/,
          `Production database URL '${dbUrl}' must be rejected`
        );
      }
    });

    it('fails closed when disposable database is required but omitted', () => {
      assert.throws(
        () => validateStagingDatabaseUrl('', { requireDisposable: true }),
        /Disposable database URL is required/
      );
    });
  });

  describe('Redirect Destination Validation', () => {
    it('allows staging and authorized localhost redirect targets', () => {
      assert.equal(
        validateRedirectTargetUrl('https://staging.virexaaiventures.com/auth/callback'),
        'https://staging.virexaaiventures.com'
      );
      assert.equal(
        validateRedirectTargetUrl('http://localhost:3000/api/auth/callback'),
        'http://localhost:3000'
      );
    });

    it('rejects unapproved external open redirect destinations', () => {
      const maliciousRedirects = [
        'https://attacker.com/steal-token',
        'https://google.com/oauth/phish',
        'https://staging.virexaaiventures.com.fake/callback'
      ];

      for (const dest of maliciousRedirects) {
        assert.throws(
          () => validateRedirectTargetUrl(dest),
          /Unapproved redirect destination/,
          `Redirect '${dest}' must be blocked`
        );
      }
    });

    it('rejects redirect URLs containing embedded userinfo credentials', () => {
      assert.throws(
        () => validateRedirectTargetUrl('https://user:pass@staging.virexaaiventures.com/auth'),
        /Redirect URL contains userinfo/
      );
    });
  });
});
