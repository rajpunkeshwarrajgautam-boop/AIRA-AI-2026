import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getAppEnvironment,
  getEnvironmentBadgeLabel,
  isStagingEnvironment,
  isProductionEnvironment,
  isLocalEnvironment,
  isPreviewEnvironment,
} from '../src/lib/environment.ts';

test('Production domains never identify as Staging or display technical labels', () => {
  const prodHosts = [
    'aira-ai-2026.vercel.app',
    'virexaaiventures.com',
    'www.virexaaiventures.com',
  ];

  for (const host of prodHosts) {
    assert.equal(getAppEnvironment(host), 'production', `Expected ${host} to be production`);
    assert.equal(isProductionEnvironment(host), true);
    assert.equal(isStagingEnvironment(host), false);
    assert.equal(getEnvironmentBadgeLabel(host), null, `Production ${host} should not have badge`);
  }
});

test('Staging domains accurately identify as Staging and display Staging badge', () => {
  const stagingHosts = [
    'staging.virexaaiventures.com',
    'staging.aira.internal',
  ];

  for (const host of stagingHosts) {
    assert.equal(getAppEnvironment(host), 'staging', `Expected ${host} to be staging`);
    assert.equal(isStagingEnvironment(host), true);
    assert.equal(isProductionEnvironment(host), false);
    assert.equal(getEnvironmentBadgeLabel(host), 'Staging');
  }
});

test('Local development never claims to be Staging or Production', () => {
  const localHosts = [
    'localhost',
    '127.0.0.1',
    '::1',
    'aira.local',
  ];

  for (const host of localHosts) {
    assert.equal(getAppEnvironment(host), 'development', `Expected ${host} to be development`);
    assert.equal(isLocalEnvironment(host), true);
    assert.equal(isStagingEnvironment(host), false, `Local ${host} must never claim to be staging`);
    assert.equal(isProductionEnvironment(host), false);
    assert.equal(getEnvironmentBadgeLabel(host), 'Local Dev');
  }
});

test('Vercel preview branches identify as Preview and do not claim production or staging', () => {
  const previewHosts = [
    'aira-ai-2026-git-feat-preview-rajpunkeshwarrajgautam-boops-projects.vercel.app',
    'aira-ai-2026-dbiobdfxt-rajpunkeshwarrajgautam-boops-projects.vercel.app',
  ];

  for (const host of previewHosts) {
    assert.equal(getAppEnvironment(host), 'preview', `Expected ${host} to be preview`);
    assert.equal(isPreviewEnvironment(host), true);
    assert.equal(isProductionEnvironment(host), false);
    assert.equal(isStagingEnvironment(host), false);
    assert.equal(getEnvironmentBadgeLabel(host), 'Preview');
  }
});
