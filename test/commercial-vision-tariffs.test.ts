import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, closeDb } from '../packages/db/src/index.js';
import { calculateVisionTariff } from '../packages/contracts/src/commercial.js';
import { resolveImageDimensions, visionService } from '../apps/api/src/vision/vision-service.js';
import { commercialBillingService } from '../apps/api/src/billing/commercial-billing-service.js';

describe('AIRA Vision Multimodal Tariffs & Dimension Mapping', () => {
  const testPrincipalId = `usr_vision_${Date.now()}`;

  after(async () => {
    const customer = await db('billing_customers').where({ principal_id: testPrincipalId }).first();
    if (customer) {
      await db('usage_events').where({ customer_id: customer.id }).delete();
      const account = await db('credit_accounts').where({ customer_id: customer.id }).first();
      if (account) {
        await db('credit_transactions').where({ account_id: account.id }).delete();
        await db('credit_reservations').where({ account_id: account.id }).delete();
        await db('credit_grants').where({ account_id: account.id }).delete();
        await db('credit_accounts').where({ id: account.id }).delete();
      }
      await db('billing_customers').where({ id: customer.id }).delete();
    }
    await closeDb();
  });

  it('1. Resolves target dimensions across aspect ratios and resolution tiers', () => {
    // Square 1:1
    assert.deepEqual(resolveImageDimensions('1:1', 'standard'), { width: 1024, height: 1024 });
    assert.deepEqual(resolveImageDimensions('1:1', 'high'), { width: 1536, height: 1536 });

    // Portrait 3:4
    assert.deepEqual(resolveImageDimensions('3:4', 'standard'), { width: 896, height: 1152 });
    assert.deepEqual(resolveImageDimensions('3:4', 'high'), { width: 1344, height: 1792 });

    // Landscape 16:9
    assert.deepEqual(resolveImageDimensions('16:9', 'standard'), { width: 1344, height: 768 });
    assert.deepEqual(resolveImageDimensions('16:9', 'high'), { width: 2048, height: 1152 });
  });

  it('2. Calculates generation tariffs per Section 8A specification', () => {
    // 1 image
    assert.equal(calculateVisionTariff('generate', { quality: 'economy', resolution: 'standard', numImages: 1 }), 12);
    assert.equal(calculateVisionTariff('generate', { quality: 'economy', resolution: 'high', numImages: 1 }), 24);
    assert.equal(calculateVisionTariff('generate', { quality: 'premium', resolution: 'standard', numImages: 1 }), 100);
    assert.equal(calculateVisionTariff('generate', { quality: 'premium', resolution: 'high', numImages: 1 }), 125);

    // 2 images
    assert.equal(calculateVisionTariff('generate', { quality: 'economy', resolution: 'standard', numImages: 2 }), 24);
    assert.equal(calculateVisionTariff('generate', { quality: 'economy', resolution: 'high', numImages: 2 }), 48);
    assert.equal(calculateVisionTariff('generate', { quality: 'premium', resolution: 'high', numImages: 2 }), 250);
  });

  it('3. Calculates editing tariffs per Section 8A specification', () => {
    assert.equal(calculateVisionTariff('edit', { quality: 'economy', resolution: 'standard' }), 40);
    assert.equal(calculateVisionTariff('edit', { quality: 'economy', resolution: 'high' }), 80);
    assert.equal(calculateVisionTariff('edit', { quality: 'premium' }), 130);
    assert.equal(calculateVisionTariff('edit', { advancedMode: true }), 250);
  });

  it('4. Fail-closed on missing provider, then executes Vision Generate with credit reservation and wallet settlement for 2 images when provider is configured', async () => {
    await commercialBillingService.getOrCreateCustomer(testPrincipalId);
    // User starts with 100 credits

    // A. Unconfigured provider must fail closed with VISION_PROVIDER_NOT_READY without deducting credits
    visionService.setCustomProviders(null);
    await assert.rejects(
      async () => {
        await visionService.generate(testPrincipalId, {
          prompt: 'Cinematic drone shot of modern glass architecture at dusk',
          aspectRatio: '16:9',
          quality: 'economy',
          resolution: 'standard',
          numImages: 2
        });
      },
      (err: any) => err.code === 'VISION_PROVIDER_NOT_READY'
    );

    // Balance must remain exactly 100
    const entBefore = await commercialBillingService.getEntitlements(testPrincipalId);
    assert.equal(entBefore.creditBalance, 100);
    assert.equal(entBefore.reservedCredits, 0);

    // B. With genuine provider configured, generate 2 images
    visionService.setCustomProviders({
      generate: async (params, dims) => [
        { url: 'https://images.aira-test.internal/gen_1.jpg', width: dims.width, height: dims.height },
        { url: 'https://images.aira-test.internal/gen_2.jpg', width: dims.width, height: dims.height }
      ]
    });

    const result = await visionService.generate(testPrincipalId, {
      prompt: 'Cinematic drone shot of modern glass architecture at dusk',
      aspectRatio: '16:9',
      quality: 'economy',
      resolution: 'standard',
      numImages: 2
    });

    assert.equal(result.images.length, 2);
    assert.equal(result.totalCredits, 24); // 12 * 2 images = 24 credits
    assert.equal(result.images[0].aspectRatio, '16:9');
    assert.equal(result.images[0].width, 1344);
    assert.equal(result.images[0].height, 768);
    // Never return SVG placeholders
    assert.ok(!result.images[0].url.includes('data:image/svg+xml'));
    assert.ok(!result.images[1].url.includes('data:image/svg+xml'));

    // Wallet balance should now be 76 (100 - 24)
    const ent = await commercialBillingService.getEntitlements(testPrincipalId);
    assert.equal(ent.creditBalance, 76);
    assert.equal(ent.reservedCredits, 0);
  });

  it('5. Fail-closed on missing provider, then executes Vision Edit with credit reservation and settlement when provider is configured', async () => {
    // A. Unconfigured provider must fail closed with VISION_PROVIDER_NOT_READY
    visionService.setCustomProviders(null);
    await assert.rejects(
      async () => {
        await visionService.edit(testPrincipalId, {
          prompt: 'Make the sky sunset golden hour with subtle clouds',
          quality: 'economy',
          resolution: 'standard'
        });
      },
      (err: any) => err.code === 'VISION_PROVIDER_NOT_READY'
    );

    // Balance remains 76
    const entBefore = await commercialBillingService.getEntitlements(testPrincipalId);
    assert.equal(entBefore.creditBalance, 76);
    assert.equal(entBefore.reservedCredits, 0);

    // B. With genuine provider configured
    visionService.setCustomProviders({
      edit: async (params, dims) => ({
        url: 'https://images.aira-test.internal/edit_1.png',
        width: dims.width,
        height: dims.height
      })
    });

    const editResult = await visionService.edit(testPrincipalId, {
      prompt: 'Make the sky sunset golden hour with subtle clouds',
      quality: 'economy',
      resolution: 'standard'
    });

    assert.equal(editResult.chargedCredits, 40);
    assert.ok(editResult.image.id);
    assert.ok(!editResult.image.url.includes('data:image/svg+xml'));

    // Wallet balance should now be 36 (76 - 40)
    const ent = await commercialBillingService.getEntitlements(testPrincipalId);
    assert.equal(ent.creditBalance, 36);
    assert.equal(ent.reservedCredits, 0);

    // Clean up
    visionService.setCustomProviders(null);
  });
});

