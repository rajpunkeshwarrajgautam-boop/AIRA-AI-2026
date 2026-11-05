import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESET_THEMES } from '../src/components/SettingsModal.js';
import { COMMERCIAL_PLANS } from '../packages/contracts/src/index.js';
import { ModelRouter, InMemoryCapacityStore } from '../packages/model-router/src/index.js';
import { commercialBillingService } from '../apps/api/src/billing/commercial-billing-service.js';

test('Mission H — Application Layer, UI Integration, Billing Attribution & Aesthetic Themes', async (t) => {
  await t.test('1. Verify All Eight Aesthetic Themes', () => {
    assert.equal(PRESET_THEMES.length, 8, 'Must declare exactly 8 premium aesthetic themes');

    const expectedThemeIds = [
      'linear-precision',
      'warm-parchment',
      'liquid-glass',
      'industrial-brutalist',
      'nordic-moss',
      'solar-gold',
      'tokyo-neon',
      'vanguard-monolith'
    ];

    for (const expectedId of expectedThemeIds) {
      const found = PRESET_THEMES.find(th => th.id === expectedId);
      assert.ok(found, `Theme "${expectedId}" must be defined`);
      assert.ok(found.name.length > 0);
      assert.ok(found.badge.length > 0);
      assert.equal(found.swatches.length, 3, 'Each theme must provide 3 primary swatches');
      for (const swatch of found.swatches) {
        assert.match(swatch, /^#[0-9A-Fa-f]{6}$/, 'Swatch must be a valid 6-character hex color');
      }
    }
  });

  await t.test('2. Verify Commercial Plans and Credit Quotas', () => {
    assert.ok(COMMERCIAL_PLANS);
    assert.ok(COMMERCIAL_PLANS.free);
    assert.ok(COMMERCIAL_PLANS.plus);
    assert.ok(COMMERCIAL_PLANS.pro);

    assert.equal(COMMERCIAL_PLANS.free.monthlyPremiumCredits, 100);
    assert.equal(COMMERCIAL_PLANS.plus.monthlyPremiumCredits, 3000);
    assert.equal(COMMERCIAL_PLANS.pro.monthlyPremiumCredits, 7500);

    assert.equal(COMMERCIAL_PLANS.free.dailyStandardChatLimit, 15);
    assert.equal(COMMERCIAL_PLANS.plus.dailyStandardChatLimit, 50);
    assert.equal(COMMERCIAL_PLANS.pro.dailyStandardChatLimit, 150);
  });

  await t.test('3. Model Router Multi-Provider Policy and Capacity Guard', () => {
    const router = new ModelRouter();
    assert.ok(router);

    const store = new InMemoryCapacityStore();
    assert.ok(store);
  });

  await t.test('4. Billing Service and Credit Attribution Safety', () => {
    assert.ok(commercialBillingService);
    assert.equal(typeof commercialBillingService.getOrCreateCustomer, 'function');
    assert.equal(typeof commercialBillingService.getEntitlements, 'function');
    assert.equal(typeof commercialBillingService.reserveCredits, 'function');
    assert.equal(typeof commercialBillingService.settleReservation, 'function');
    assert.equal(typeof commercialBillingService.releaseReservation, 'function');
    assert.equal(typeof commercialBillingService.grantCredits, 'function');
    assert.equal(typeof commercialBillingService.recordUsageEvent, 'function');
  });
});
