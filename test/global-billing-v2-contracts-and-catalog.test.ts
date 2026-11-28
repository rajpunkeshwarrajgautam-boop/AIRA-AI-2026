import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GLOBAL_COUNTRY_CATALOG,
  resolveCountryBillingDefaults,
  getProviderCapabilityMatrix,
  resolveCheckoutProviderForRegion
} from '../apps/api/src/billing/global-billing-catalog.js';
import {
  BillingAccountTypeSchema,
  PaymentMethodSummarySchema,
  GlobalBillingProfileSchema
} from '../packages/contracts/src/commercial.js';

describe('V2 Slice 1: Global Billing Contracts, Country Catalog & Provider Capabilities', () => {
  it('validates GlobalBillingProfile and masked PaymentMethodSummary schemas without allowing raw PAN/CVV fields', () => {
    const profile = GlobalBillingProfileSchema.parse({
      country: 'US',
      accountType: 'business',
      legalName: 'Acme Robotics Inc.',
      addressLine1: '100 Market St',
      city: 'San Francisco',
      postalCode: '94105',
      taxId: 'EIN-94-1234567'
    });
    assert.equal(profile.country, 'US');
    assert.equal(profile.accountType, 'business');
    assert.equal(profile.taxId, 'EIN-94-1234567');
    assert.equal(BillingAccountTypeSchema.parse('individual'), 'individual');

    const method = PaymentMethodSummarySchema.parse({
      id: 'pm_rzp_123',
      gateway: 'razorpay',
      methodType: 'card',
      brand: 'Visa',
      last4: '4242',
      displayLabel: 'Visa ending in 4242',
      isDefault: true
    });
    assert.equal(method.last4, '4242');
    assert.throws(() =>
      PaymentMethodSummarySchema.parse({
        id: 'pm_bad',
        gateway: 'razorpay',
        methodType: 'card',
        last4: '4111111111114242', // full PAN rejected
        displayLabel: 'bad'
      })
    );
  });

  it('maps India (IN) to INR domestic rails and non-India countries to USD global card rails', () => {
    assert.ok(GLOBAL_COUNTRY_CATALOG.length >= 25);
    const inDefaults = resolveCountryBillingDefaults('in');
    assert.equal(inDefaults.countryCode, 'IN');
    assert.equal(inDefaults.currency, 'INR');
    assert.equal(inDefaults.requiresIndianStateForTax, true);

    const usDefaults = resolveCountryBillingDefaults('US');
    assert.equal(usDefaults.countryCode, 'US');
    assert.equal(usDefaults.currency, 'USD');
    assert.equal(usDefaults.requiresIndianStateForTax, false);

    const unknownDefaults = resolveCountryBillingDefaults('ZZ');
    assert.equal(unknownDefaults.currency, 'USD');
  });

  it('publishes truthful provider capability statuses and fails closed for Cashfree USD', () => {
    const matrix = getProviderCapabilityMatrix({ isSandbox: false, internationalUsdEnabled: true });
    assert.equal(matrix.domesticInrRazorpay.status, 'VERIFIED_SUPPORTED');
    assert.equal(matrix.domesticInrCashfree.status, 'VERIFIED_SUPPORTED');
    assert.equal(matrix.internationalUsdRazorpay.status, 'SUPPORTED_WITH_ACCOUNT_ACTIVATION');
    assert.equal(matrix.internationalUsdCashfree.status, 'UNVERIFIED_FOR_CURRENT_CHECKOUT');
    assert.equal(matrix.invoiceEmailDelivery.status, 'UNCONFIGURED_BLOCKER');

    const usdRes = resolveCheckoutProviderForRegion({
      currency: 'USD',
      country: 'US',
      requestedGateway: 'cashfree',
      isSandbox: false,
      internationalUsdEnabled: true
    });
    assert.equal(usdRes.allowed, false);
    assert.equal(usdRes.code, 'UNSUPPORTED_INTERNATIONAL_GATEWAY');

    const usdRzp = resolveCheckoutProviderForRegion({
      currency: 'USD',
      country: 'US',
      isSandbox: false,
      internationalUsdEnabled: true
    });
    assert.equal(usdRzp.allowed, true);
    assert.equal(usdRzp.gateway, 'razorpay');
  });
});
