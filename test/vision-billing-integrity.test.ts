import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, closeDb } from '../packages/db/src/index.js';
import {
  visionService,
  VisionProviderUnavailableError,
  resolveImageDimensions
} from '../apps/api/src/vision/vision-service.js';
import { commercialBillingService } from '../apps/api/src/billing/commercial-billing-service.js';
import {
  durableIdempotencyManager
} from '../apps/api/src/utils/idempotency.js';
import {
  detectCapabilityIntent,
  getVisionTariff
} from '../src/utils/capabilityDispatcher.js';
import fs from 'fs';
import path from 'path';

describe('AIRA Vision Billing Integrity & Provider Verification Suite', () => {
  const testPrincipalId = `usr_vision_integrity_${Date.now()}`;
  let customerId = '';
  let accountId = '';

  before(async () => {
    // Reset custom providers to default unconfigured state
    visionService.setCustomProviders(null);

    const cust = await commercialBillingService.getOrCreateCustomer(testPrincipalId);
    customerId = cust.id;
    const acc = await db('credit_accounts').where({ customer_id: customerId }).first();
    accountId = acc.id;
  });

  after(async () => {
    visionService.setCustomProviders(null);
    if (customerId) {
      await db('usage_events').where({ customer_id: customerId }).delete();
      await db('credit_transactions').where({ account_id: accountId }).delete();
      await db('credit_reservations').where({ account_id: accountId }).delete();
      await db('credit_grants').where({ account_id: accountId }).delete();
      await db('credit_accounts').where({ id: accountId }).delete();
      await db('billing_customers').where({ id: customerId }).delete();
    }
    await db('idempotent_operations').where({ principal_id: testPrincipalId }).delete();
    await closeDb();
  });

  it('1. Missing provider returns an explicit VISION_PROVIDER_NOT_READY error with zero credit deduction', async () => {
    visionService.setCustomProviders(null);
    // Ensure test environment does not have external keys set
    const originalFal = process.env.FAL_KEY;
    const originalOpenAI = process.env.OPENAI_API_KEY;
    const originalReplicate = process.env.REPLICATE_API_TOKEN;
    const originalNvidia = process.env.NVIDIA_API_KEY;
    const originalGemini = process.env.GEMINI_API_KEY;

    delete process.env.FAL_KEY;
    delete process.env.FAL_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.REPLICATE_API_TOKEN;
    delete process.env.NVIDIA_API_KEY;
    delete process.env.GEMINI_API_KEY;

    try {
      // A. Generate
      await assert.rejects(
        async () => {
          await visionService.generate(testPrincipalId, {
            prompt: 'Serene Japanese zen garden in autumn',
            aspectRatio: '1:1',
            quality: 'economy',
            resolution: 'standard'
          });
        },
        (err: any) => {
          assert.equal(err.code, 'VISION_PROVIDER_NOT_READY');
          assert.equal(err.statusCode, 503);
          assert.equal(err.capability, 'generate');
          return true;
        }
      );

      // B. Edit
      await assert.rejects(
        async () => {
          await visionService.edit(testPrincipalId, {
            prompt: 'Add falling maple leaves',
            quality: 'economy',
            resolution: 'standard'
          });
        },
        (err: any) => {
          assert.equal(err.code, 'VISION_PROVIDER_NOT_READY');
          assert.equal(err.statusCode, 503);
          assert.equal(err.capability, 'edit');
          return true;
        }
      );

      // C. Understand
      await assert.rejects(
        async () => {
          await visionService.understand(testPrincipalId, {
            prompt: 'Explain the visual structure of this layout'
          });
        },
        (err: any) => {
          assert.equal(err.code, 'VISION_PROVIDER_NOT_READY');
          assert.equal(err.statusCode, 503);
          assert.equal(err.capability, 'understand');
          return true;
        }
      );

      // Invariant: Zero credit deductions, zero reservations
      const ent = await commercialBillingService.getEntitlements(testPrincipalId);
      assert.equal(ent.creditBalance, 100);
      assert.equal(ent.reservedCredits, 0);
      assert.equal(ent.availableCredits, 100);
    } finally {
      if (originalFal) process.env.FAL_KEY = originalFal;
      if (originalOpenAI) process.env.OPENAI_API_KEY = originalOpenAI;
      if (originalReplicate) process.env.REPLICATE_API_TOKEN = originalReplicate;
      if (originalNvidia) process.env.NVIDIA_API_KEY = originalNvidia;
      if (originalGemini) process.env.GEMINI_API_KEY = originalGemini;
    }
  });

  it('2. Image generation never returns placeholder success or SVG placeholders', async () => {
    // Simulate a rogue provider attempting to return SVG placeholder data
    visionService.setCustomProviders({
      generate: async (_params, dims) => [
        {
          url: `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>').toString('base64')}`,
          width: dims.width,
          height: dims.height
        }
      ]
    });

    await assert.rejects(
      async () => {
        await visionService.generate(testPrincipalId, {
          prompt: 'Attempting to inject SVG placeholder',
          aspectRatio: '1:1',
          quality: 'economy',
          resolution: 'standard'
        });
      },
      (err: any) => {
        assert.equal(err.code, 'VISION_PROVIDER_NOT_READY');
        assert.ok(err.message.includes('placeholder') || err.message.includes('invalid'));
        return true;
      }
    );

    // Invariant: Zero credits debited, reservation released
    const ent = await commercialBillingService.getEntitlements(testPrincipalId);
    assert.equal(ent.creditBalance, 100);
    assert.equal(ent.reservedCredits, 0);
  });

  it('3. Image editing never returns placeholder success or SVG placeholders', async () => {
    // Simulate an edit provider attempting to return an SVG placeholder
    visionService.setCustomProviders({
      edit: async (_params, dims) => ({
        url: `data:image/svg+xml;base64,${Buffer.from('<svg><text>placeholder</text></svg>').toString('base64')}`,
        width: dims.width,
        height: dims.height
      })
    });

    await assert.rejects(
      async () => {
        await visionService.edit(testPrincipalId, {
          prompt: 'Modify lighting with SVG output',
          quality: 'economy',
          resolution: 'standard'
        });
      },
      (err: any) => {
        assert.equal(err.code, 'VISION_PROVIDER_NOT_READY');
        assert.ok(err.message.includes('placeholder') || err.message.includes('invalid'));
        return true;
      }
    );

    // Invariant: Zero credits debited
    const ent = await commercialBillingService.getEntitlements(testPrincipalId);
    assert.equal(ent.creditBalance, 100);
    assert.equal(ent.reservedCredits, 0);
  });

  it('4. Understanding never returns fabricated analysis after provider failure', async () => {
    // Provider fails with empty string or throws
    visionService.setCustomProviders({
      understand: async () => '' // Empty string returned by provider
    });

    await assert.rejects(
      async () => {
        await visionService.understand(testPrincipalId, {
          prompt: 'Describe the contents of this chart'
        });
      },
      (err: any) => {
        assert.equal(err.code, 'VISION_PROVIDER_NOT_READY');
        assert.ok(err.message.includes('failed to generate analysis'));
        return true;
      }
    );

    // Invariant: Balance untouched
    const ent = await commercialBillingService.getEntitlements(testPrincipalId);
    assert.equal(ent.creditBalance, 100);
    assert.equal(ent.reservedCredits, 0);
  });

  it('5. Provider failure never settles credits (atomic release of reservations)', async () => {
    visionService.setCustomProviders({
      generate: async () => {
        throw new Error('Upstream GPU worker timeout (504 Gateway Timeout)');
      }
    });

    await assert.rejects(
      async () => {
        await visionService.generate(testPrincipalId, {
          prompt: 'Crash scenario test',
          aspectRatio: '16:9',
          quality: 'economy',
          resolution: 'standard'
        });
      },
      (err: any) => err.code === 'VISION_PROVIDER_NOT_READY'
    );

    // Verify reservation in DB was released
    const reservations = await db('credit_reservations')
      .where({ account_id: accountId })
      .orderBy('created_at', 'desc');

    const lastRes = reservations[0];
    assert.ok(lastRes);
    assert.equal(lastRes.status, 'RELEASED');
    const metaStr = typeof lastRes.metadata === 'string' ? lastRes.metadata : JSON.stringify(lastRes.metadata);
    assert.ok(metaStr.includes('failed'));

    // Check account balance is exactly intact
    const ent = await commercialBillingService.getEntitlements(testPrincipalId);
    assert.equal(ent.creditBalance, 100);
    assert.equal(ent.reservedCredits, 0);
  });

  it('6. Successful generation settles only the exact tariff', async () => {
    // 2 images, economy high: 24 credits per image = 48 credits total
    visionService.setCustomProviders({
      generate: async (_params, dims) => [
        { url: 'https://cdn.aira.example.com/renders/real_image_01.png', width: dims.width, height: dims.height },
        { url: 'https://cdn.aira.example.com/renders/real_image_02.png', width: dims.width, height: dims.height }
      ]
    });

    const expectedTariff = getVisionTariff({ quality: 'economy', resolution: 'high', numImages: 2 });
    assert.equal(expectedTariff, 48);

    const result = await visionService.generate(testPrincipalId, {
      prompt: 'Hyper-detailed architectural rendering of wooden pavilion',
      aspectRatio: '16:9',
      quality: 'economy',
      resolution: 'high',
      numImages: 2
    });

    assert.equal(result.images.length, 2);
    assert.equal(result.totalCredits, 48);
    assert.equal(result.images[0].url, 'https://cdn.aira.example.com/renders/real_image_01.png');
    assert.equal(result.images[1].url, 'https://cdn.aira.example.com/renders/real_image_02.png');

    // Balance should now be 52 (100 - 48)
    const ent = await commercialBillingService.getEntitlements(testPrincipalId);
    assert.equal(ent.creditBalance, 52);
    assert.equal(ent.reservedCredits, 0);

    // Usage events should record exactly 48 charged credits
    const usage = await db('usage_events')
      .where({ customer_id: customerId, task_type: 'vision_generate' })
      .orderBy('created_at', 'desc')
      .first();
    assert.ok(usage);
    assert.equal(Number(usage.charged_credits), 48);
    assert.equal(Number(usage.images_count), 2);
  });

  it('7. Retry protection prevents duplicate billing across client operation IDs', async () => {
    const clientOpId = `op_idemp_${Date.now()}`;
    const payload = {
      prompt: 'Idempotency test rendering',
      aspectRatio: '1:1',
      quality: 'economy',
      resolution: 'standard',
      numImages: 1
    };

    // First attempt: beginOrGet
    const check1 = await durableIdempotencyManager.beginOrGet(
      testPrincipalId,
      clientOpId,
      'VISION_GENERATE',
      payload,
      180_000
    );
    assert.equal(check1.isReplay, false);

    // Execute generation (12 credits)
    const res1 = await visionService.generate(testPrincipalId, payload as any);
    assert.equal(res1.totalCredits, 12);
    await durableIdempotencyManager.complete(testPrincipalId, clientOpId, 200, res1);

    // Balance: 52 - 12 = 40
    const entAfter1 = await commercialBillingService.getEntitlements(testPrincipalId);
    assert.equal(entAfter1.creditBalance, 40);

    // Second attempt: identical retry replay
    const check2 = await durableIdempotencyManager.beginOrGet(
      testPrincipalId,
      clientOpId,
      'VISION_GENERATE',
      payload,
      180_000
    );
    assert.equal(check2.isReplay, true);
    assert.equal(check2.statusCode, 200);
    assert.equal(check2.responseBody.totalCredits, 12);

    // Balance MUST NOT have been deducted a second time!
    const entAfter2 = await commercialBillingService.getEntitlements(testPrincipalId);
    assert.equal(entAfter2.creditBalance, 40);
    assert.equal(entAfter2.reservedCredits, 0);
  });

  it('8. Failure before external side effect commits safely clears in-progress lock for subsequent retries', async () => {
    const clientOpId = `op_fail_retry_${Date.now()}`;
    const payload = {
      prompt: 'Temporary fail-recover test',
      aspectRatio: '1:1',
      quality: 'economy',
      resolution: 'standard',
      numImages: 1
    };

    // Begin idempotency lease
    const check1 = await durableIdempotencyManager.beginOrGet(
      testPrincipalId,
      clientOpId,
      'VISION_GENERATE',
      payload,
      180_000
    );
    assert.equal(check1.isReplay, false);

    // Simulate transient failure BEFORE side effect committed
    await durableIdempotencyManager.fail(testPrincipalId, clientOpId, {
      sideEffectCommitted: false,
      error: 'Upstream connection reset'
    });

    // In-progress lock must be deleted from PostgreSQL so the client can retry immediately
    const checkRetry = await durableIdempotencyManager.beginOrGet(
      testPrincipalId,
      clientOpId,
      'VISION_GENERATE',
      payload,
      180_000
    );
    assert.equal(checkRetry.isReplay, false, 'Lease must be re-acquirable after clean failure');

    // Clean up
    await durableIdempotencyManager.fail(testPrincipalId, clientOpId, { sideEffectCommitted: false });
  });

  it('9. Capability intent detector and tariff calculations adhere to contracts', () => {
    // 1. Image generation intent
    const genIntent = detectCapabilityIntent('Please generate an image of an emerald forest at sunrise', 'chat');
    assert.equal(genIntent.capability, 'IMAGE_GENERATION');
    assert.equal(genIntent.parameters?.aspectRatio, '1:1');

    const landscapeIntent = detectCapabilityIntent('Render a 16:9 landscape visual of snow peaks', 'chat');
    assert.equal(landscapeIntent.capability, 'IMAGE_GENERATION');
    assert.equal(landscapeIntent.parameters?.aspectRatio, '16:9');

    // 2. Builder app intent
    const builderIntent = detectCapabilityIntent('Build a saas analytics dashboard for monitoring user activity', 'chat');
    assert.equal(builderIntent.capability, 'BUILDER_APP');
    assert.equal(builderIntent.suggestAgentMode, true);

    // 3. Automation intent
    const autoIntent = detectCapabilityIntent('Schedule a weekly report every Monday at 9am', 'chat');
    assert.equal(autoIntent.capability, 'AUTOMATION');
    assert.equal(autoIntent.parameters?.isScheduled, true);

    // 4. Tariffs
    assert.equal(getVisionTariff({ quality: 'economy', resolution: 'standard', numImages: 1 }), 12);
    assert.equal(getVisionTariff({ quality: 'economy', resolution: 'high', numImages: 1 }), 24);
    assert.equal(getVisionTariff({ quality: 'premium', resolution: 'standard', numImages: 1 }), 100);
    assert.equal(getVisionTariff({ quality: 'premium', resolution: 'high', numImages: 1 }), 125);
    assert.equal(getVisionTariff({ quality: 'premium', resolution: 'high', numImages: 2 }), 250);
  });

  it('10. Confirms UI preserves distraction-free two-mode architecture and no persistent Agent Mode banners', () => {
    const appTsxPath = path.join(process.cwd(), 'src', 'App.tsx');
    const appContent = fs.readFileSync(appTsxPath, 'utf8');

    // Banner check: Must NOT have persistent Agent Mode header banners
    assert.ok(!appContent.includes('Agent Mode Active:'), 'Persistent Agent Mode banner must remain eliminated');
    assert.ok(!appContent.includes('WORKSPACE: AGENT MODE ACTIVE'), 'Persistent Agent Mode header must remain eliminated');

    // Two-mode check: App supports strictly Chat and Agent
    assert.ok(appContent.includes("workspaceMode === 'agent'"), 'Workspace mode agent supported');
    assert.ok(appContent.includes("workspaceMode === 'chat'"), 'Workspace mode chat supported');

    // Clean providerUnavailable handling in conversation
    assert.ok(appContent.includes('visionRes.providerUnavailable'), 'App.tsx must handle providerUnavailable cleanly');
    assert.ok(appContent.includes('[Vision Service Unavailable]'), 'App.tsx must display honest non-success notice');
  });
});
