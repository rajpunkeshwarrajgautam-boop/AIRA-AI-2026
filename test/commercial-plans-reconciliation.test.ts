import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import {
  COMMERCIAL_PLANS,
  PlanTier,
  PlanTierSchema,
  PlanDefinitionSchema,
  isFeatureAllowedForTier,
  isModelAllowedForTier,
  getMinimumRequiredTierForFeature,
  getMinimumRequiredTierForModel,
  PLAN_CAPABILITY_MATRIX
} from '../packages/contracts/src/commercial.js';
import {
  CANDIDATE_PRICE_CATALOG,
  PaymentGatewayService
} from '../apps/api/src/billing/payment-gateway-service.js';
import { createBillingRoutes } from '../apps/api/src/billing-routes.js';

describe('AIRA AI 2026 — Plus & Pro Commercial Plans Reconciliation & Capability Integrity', () => {

  describe('1. Authoritative Pricing & Contract Structure', () => {
    it('validates all 4 canonical plan tiers satisfy PlanDefinitionSchema', () => {
      const tiers: PlanTier[] = ['guest', 'free', 'plus', 'pro'];
      for (const tier of tiers) {
        const plan = COMMERCIAL_PLANS[tier];
        assert.ok(plan, `Plan ${tier} must exist in COMMERCIAL_PLANS`);
        const parsed = PlanDefinitionSchema.safeParse(plan);
        assert.equal(parsed.success, true, `Plan ${tier} must be valid: ${JSON.stringify(parsed)}`);
      }
    });

    it('reconciles Plus pricing to ₹399/mo GST-inclusive and $7.99/mo USD', () => {
      const plus = COMMERCIAL_PLANS.plus;
      assert.deepEqual(plus.pricing, { INR: 399, USD: 7.99 });
      assert.equal(plus.prices.length, 2);

      const inr = plus.prices.find(p => p.currency === 'INR')!;
      assert.ok(inr);
      assert.equal(inr.amountMinorUnits, 39900, 'Plus INR must be 39,900 paise (₹399.00)');
      assert.equal(inr.displayAmount, 399);
      assert.equal(inr.isTaxInclusive, true, 'Domestic INR is GST-inclusive per Indian tax regulations');
      assert.equal(inr.taxRatePercent, 18);

      const usd = plus.prices.find(p => p.currency === 'USD')!;
      assert.ok(usd);
      assert.equal(usd.amountMinorUnits, 799, 'Plus USD must be 799 cents ($7.99)');
      assert.equal(usd.displayAmount, 7.99);
      assert.equal(usd.isTaxInclusive, false);
      assert.equal(usd.taxRatePercent, 0);
    });

    it('reconciles Pro pricing to ₹999/mo GST-inclusive and $19.99/mo USD', () => {
      const pro = COMMERCIAL_PLANS.pro;
      assert.deepEqual(pro.pricing, { INR: 999, USD: 19.99 });
      assert.equal(pro.prices.length, 2);

      const inr = pro.prices.find(p => p.currency === 'INR')!;
      assert.ok(inr);
      assert.equal(inr.amountMinorUnits, 99900, 'Pro INR must be 99,900 paise (₹999.00), strictly aligned with ADR 0001/0002');
      assert.equal(inr.displayAmount, 999);
      assert.equal(inr.isTaxInclusive, true);
      assert.equal(inr.taxRatePercent, 18);

      const usd = pro.prices.find(p => p.currency === 'USD')!;
      assert.ok(usd);
      assert.equal(usd.amountMinorUnits, 1999, 'Pro USD must be 1,999 cents ($19.99)');
      assert.equal(usd.displayAmount, 19.99);
      assert.equal(usd.isTaxInclusive, false);
      assert.equal(usd.taxRatePercent, 0);
    });

    it('ensures CANDIDATE_PRICE_CATALOG.pro.INR is reconciled to 99900 paise', () => {
      assert.equal(
        CANDIDATE_PRICE_CATALOG.pro.INR?.amountMinorUnits,
        99900,
        'CANDIDATE_PRICE_CATALOG.pro.INR must be 99900 paise (₹999), eliminating legacy 149900 mismatch'
      );
      assert.equal(CANDIDATE_PRICE_CATALOG.plus.INR?.amountMinorUnits, 39900);
      assert.equal(CANDIDATE_PRICE_CATALOG.pro.USD?.amountMinorUnits, 1999);
      assert.equal(CANDIDATE_PRICE_CATALOG.plus.USD?.amountMinorUnits, 799);
    });
  });

  describe('2. Feature & Tool Capability Matrix Enforcement', () => {
    it('enforces autonomous agent permissions: Plus and Pro only', () => {
      assert.equal(isFeatureAllowedForTier('autonomous', 'guest'), false);
      assert.equal(isFeatureAllowedForTier('autonomous', 'free'), false);
      assert.equal(isFeatureAllowedForTier('autonomous', 'plus'), true);
      assert.equal(isFeatureAllowedForTier('autonomous', 'pro'), true);
      assert.equal(getMinimumRequiredTierForFeature('autonomous'), 'plus');
    });

    it('enforces Python sandbox permissions: Pro only', () => {
      assert.equal(isFeatureAllowedForTier('pythonsandbox', 'guest'), false);
      assert.equal(isFeatureAllowedForTier('pythonsandbox', 'free'), false);
      assert.equal(isFeatureAllowedForTier('pythonsandbox', 'plus'), false);
      assert.equal(isFeatureAllowedForTier('pythonsandbox', 'pro'), true);
      assert.equal(getMinimumRequiredTierForFeature('pythonsandbox'), 'pro');
    });

    it('enforces browser tools permissions: Pro only', () => {
      assert.equal(isFeatureAllowedForTier('browsertools', 'guest'), false);
      assert.equal(isFeatureAllowedForTier('browsertools', 'free'), false);
      assert.equal(isFeatureAllowedForTier('browsertools', 'plus'), false);
      assert.equal(isFeatureAllowedForTier('browsertools', 'pro'), true);
      assert.equal(getMinimumRequiredTierForFeature('browsertools'), 'pro');
    });

    it('enforces saved agents limits per tier', () => {
      assert.equal(COMMERCIAL_PLANS.guest.savedAgentsLimit, 0);
      assert.equal(COMMERCIAL_PLANS.free.savedAgentsLimit, 0);
      assert.equal(COMMERCIAL_PLANS.plus.savedAgentsLimit, 3);
      assert.equal(COMMERCIAL_PLANS.pro.savedAgentsLimit, 20);
    });

    it('enforces builder access tiers', () => {
      assert.equal(COMMERCIAL_PLANS.guest.builderAccess, 'none');
      assert.equal(COMMERCIAL_PLANS.free.builderAccess, 'none');
      assert.equal(COMMERCIAL_PLANS.plus.builderAccess, 'trial');
      assert.equal(COMMERCIAL_PLANS.pro.builderAccess, 'metered');
    });

    it('enforces model allowlists per tier', () => {
      // Free models
      assert.equal(isModelAllowedForTier('aira-fast', 'free'), true);
      assert.equal(isModelAllowedForTier('aira-auto', 'free'), true);
      assert.equal(isModelAllowedForTier('aira-pro', 'free'), false);
      assert.equal(isModelAllowedForTier('aira-deep', 'free'), false);

      // Plus models (adds aira-pro and nemotron-70b)
      assert.equal(isModelAllowedForTier('aira-pro', 'plus'), true);
      assert.equal(isModelAllowedForTier('nvidia/llama-3.1-nemotron-70b-instruct', 'plus'), true);
      assert.equal(isModelAllowedForTier('aira-deep', 'plus'), false);

      // Pro models (adds aira-deep)
      assert.equal(isModelAllowedForTier('aira-deep', 'pro'), true);
      assert.equal(getMinimumRequiredTierForModel('aira-deep'), 'pro');
      assert.equal(getMinimumRequiredTierForModel('aira-pro'), 'plus');
    });
  });

  describe('3. Authoritative Billing Routes & State Separation', () => {
    it('GET /api/billing/plans returns complete pricing and capability readiness', async () => {
      const origKillSwitch = process.env.AIRA_COMMERCIAL_BILLING_ENABLED;
      try {
        process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'false';

        const app = express();
        app.use('/api/billing', createBillingRoutes());

        const server = http.createServer(app);
        await new Promise<void>(resolve => server.listen(0, resolve));
        const port = (server.address() as any).port;

        try {
          const fetchRes = await fetch(`http://127.0.0.1:${port}/api/billing/plans`);
          assert.equal(fetchRes.status, 200);
          const body = await fetchRes.json() as any;

          assert.equal(body.checkoutAvailable, false, 'Kill-switch false must report checkoutAvailable: false');
          assert.equal(body.featuresCertified, true, 'Features must be certified true');
          assert.ok(body.plans.length >= 4);

          const plus = body.plans.find((p: any) => p.id === 'plus');
          assert.ok(plus);
          assert.deepEqual(plus.pricing, { INR: 399, USD: 7.99 }, 'Server must not strip pricing object');
          assert.equal(plus.prices.length, 2, 'Server must preserve prices array');
          assert.equal(plus.featuresCertified, true);

          const pro = body.plans.find((p: any) => p.id === 'pro');
          assert.ok(pro);
          assert.deepEqual(pro.pricing, { INR: 999, USD: 19.99 }, 'Server must not strip pro pricing');
          assert.equal(pro.prices.length, 2);
          assert.equal(pro.prices.find((p: any) => p.currency === 'INR').amountMinorUnits, 99900);
        } finally {
          await new Promise<void>(resolve => server.close(() => resolve()));
        }
      } finally {
        if (origKillSwitch !== undefined) process.env.AIRA_COMMERCIAL_BILLING_ENABLED = origKillSwitch;
        else delete process.env.AIRA_COMMERCIAL_BILLING_ENABLED;
      }
    });

    it('enforces fail-closed kill-switch when AIRA_COMMERCIAL_BILLING_ENABLED is false', async () => {
      const origKillSwitch = process.env.AIRA_COMMERCIAL_BILLING_ENABLED;
      try {
        process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'false';

        const gateway = new PaymentGatewayService();
        await assert.rejects(
          async () => {
            await gateway.createSubscriptionCheckout('usr_test_1', 'plus', 'INR');
          },
          /BILLING_UNAVAILABLE: Live checkout has not been approved or integrated/
        );
      } finally {
        if (origKillSwitch !== undefined) process.env.AIRA_COMMERCIAL_BILLING_ENABLED = origKillSwitch;
        else delete process.env.AIRA_COMMERCIAL_BILLING_ENABLED;
      }
    });
  });
});
