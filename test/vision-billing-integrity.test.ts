import './setup-disposable-db.js';
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

    visionService.setCustomProviders({
      generate: async (_params, dims) => [
        { url: 'https://cdn.aira.example.com/renders/real_image_01.png', width: dims.width, height: dims.height }
      ]
    });

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

  it('11. Gate 2: Fal.ai output count mismatch (requested 2, returned 1) aborts with 0 credits charged', async () => {
    const originalFal = process.env.FAL_KEY;
    const originalOpenAI = process.env.OPENAI_API_KEY;
    const originalReplicate = process.env.REPLICATE_API_TOKEN;
    const originalFetch = globalThis.fetch;

    process.env.FAL_KEY = 'mock-fal-key-for-test';
    delete process.env.OPENAI_API_KEY;
    delete process.env.REPLICATE_API_TOKEN;
    visionService.setCustomProviders(null);

    // Mock Fal.ai responding with only 1 image when 2 were requested
    globalThis.fetch = async (url: any, opts: any) => {
      if (typeof url === 'string' && url.includes('fal.run')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            images: [
              { url: 'https://fal.media/files/mock/img_01.png', width: 1024, height: 1024 }
            ]
          })
        } as any;
      }
      return originalFetch(url, opts);
    };

    const principal = `usr_fal_mismatch_${Date.now()}`;
    await commercialBillingService.getOrCreateCustomer(principal);

    try {
      await assert.rejects(
        async () => {
          await visionService.generate(principal, {
            prompt: 'Serene mountain landscape',
            aspectRatio: '1:1',
            quality: 'economy',
            resolution: 'standard',
            numImages: 2
          });
        },
        (err: any) => {
          assert.equal(err.code, 'VISION_PROVIDER_NOT_READY');
          assert.ok(err.message.includes('Provider output count mismatch'));
          assert.ok(err.message.includes('Zero credits were charged') || err.message.includes('zero credits were debited'));
          return true;
        }
      );

      // Verify zero credits debited and reservation released
      const ent = await commercialBillingService.getEntitlements(principal);
      assert.equal(ent.creditBalance, 100);
      assert.equal(ent.reservedCredits, 0);

      // Verify in DB that reservation status is RELEASED
      const customer = await db('billing_customers').where({ principal_id: principal }).first();
      const reservation = await db('credit_reservations')
        .where({ account_id: (await db('credit_accounts').where({ customer_id: customer.id }).first()).id })
        .orderBy('created_at', 'desc')
        .first();
      assert.ok(reservation);
      assert.equal(reservation.status, 'RELEASED');
    } finally {
      globalThis.fetch = originalFetch;
      if (originalFal) process.env.FAL_KEY = originalFal; else delete process.env.FAL_KEY;
      if (originalOpenAI) process.env.OPENAI_API_KEY = originalOpenAI;
      if (originalReplicate) process.env.REPLICATE_API_TOKEN = originalReplicate;
      const cust = await db('billing_customers').where({ principal_id: principal }).first();
      if (cust) {
        const acc = await db('credit_accounts').where({ customer_id: cust.id }).first();
        if (acc) {
          await db('credit_reservations').where({ account_id: acc.id }).delete().catch(() => {});
          await db('credit_grants').where({ account_id: acc.id }).delete().catch(() => {});
          await db('credit_accounts').where({ id: acc.id }).delete().catch(() => {});
        }
        await db('billing_customers').where({ id: cust.id }).delete().catch(() => {});
      }
    }
  });

  it('12. Gate 2: OpenAI DALL-E 3 dispatches parallel n:1 calls for numImages: 2 and settles exact tariff', async () => {
    const originalOpenAI = process.env.OPENAI_API_KEY;
    const originalFal = process.env.FAL_KEY;
    const originalReplicate = process.env.REPLICATE_API_TOKEN;
    const originalFetch = globalThis.fetch;

    delete process.env.FAL_KEY;
    delete process.env.FAL_API_KEY;
    delete process.env.REPLICATE_API_TOKEN;
    process.env.OPENAI_API_KEY = 'mock-openai-key-for-test';
    visionService.setCustomProviders(null);

    let openaiCallCount = 0;
    const payloadsReceived: any[] = [];

    globalThis.fetch = async (url: any, opts: any) => {
      if (typeof url === 'string' && url.includes('api.openai.com/v1/images/generations')) {
        openaiCallCount++;
        const parsedBody = JSON.parse(opts.body);
        payloadsReceived.push(parsedBody);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              { url: `https://oaidalleapiprodscus.blob.core.windows.net/private/img_${openaiCallCount}.png` }
            ]
          })
        } as any;
      }
      return originalFetch(url, opts);
    };

    const principal = `usr_openai_batch_${Date.now()}`;
    const cust = await commercialBillingService.getOrCreateCustomer(principal);
    // 2 premium high images = 250 credits; grant additional credits
    await db('credit_accounts').where({ customer_id: cust.id }).update({ balance_credits: 500 });

    try {
      const result = await visionService.generate(principal, {
        prompt: 'Futuristic solar metropolis with sky bridges',
        aspectRatio: '16:9',
        quality: 'premium',
        resolution: 'high',
        numImages: 2
      });

      // Strict assertions on multi-image execution
      assert.equal(openaiCallCount, 2, 'Must dispatch exactly 2 parallel OpenAI calls for numImages: 2');
      assert.equal(payloadsReceived.length, 2);
      assert.equal(payloadsReceived[0].n, 1, 'Each OpenAI call must use n: 1 due to DALL-E 3 constraints');
      assert.equal(payloadsReceived[1].n, 1);
      assert.equal(result.images.length, 2);
      assert.equal(result.totalCredits, 250, 'Tariff for 2 premium high images must be 250');

      // Check balance deducted by exact tariff: 500 - 250 = 250
      const ent = await commercialBillingService.getEntitlements(principal);
      assert.equal(ent.creditBalance, 250);
      assert.equal(ent.reservedCredits, 0);

      // Verify reservation settled in database
      const reservation = await db('credit_reservations')
        .where({ account_id: (await db('credit_accounts').where({ customer_id: cust.id }).first()).id })
        .orderBy('created_at', 'desc')
        .first();
      assert.ok(reservation);
      assert.equal(reservation.status, 'SETTLED');
      assert.equal(Number(reservation.amount_credits), 250);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalOpenAI) process.env.OPENAI_API_KEY = originalOpenAI; else delete process.env.OPENAI_API_KEY;
      if (originalFal) process.env.FAL_KEY = originalFal;
      if (originalReplicate) process.env.REPLICATE_API_TOKEN = originalReplicate;
      const acc = await db('credit_accounts').where({ customer_id: cust.id }).first();
      if (acc) {
        await db('usage_events').where({ customer_id: cust.id }).delete().catch(() => {});
        await db('credit_transactions').where({ account_id: acc.id }).delete().catch(() => {});
        await db('credit_reservations').where({ account_id: acc.id }).delete().catch(() => {});
        await db('credit_grants').where({ account_id: acc.id }).delete().catch(() => {});
        await db('credit_accounts').where({ id: acc.id }).delete().catch(() => {});
      }
      await db('billing_customers').where({ id: cust.id }).delete().catch(() => {});
    }
  });

  it('13. Gate 2: OpenAI DALL-E 3 partial failure aborts transaction and debits 0 credits', async () => {
    const originalOpenAI = process.env.OPENAI_API_KEY;
    const originalFal = process.env.FAL_KEY;
    const originalReplicate = process.env.REPLICATE_API_TOKEN;
    const originalFetch = globalThis.fetch;

    delete process.env.FAL_KEY;
    delete process.env.FAL_API_KEY;
    delete process.env.REPLICATE_API_TOKEN;
    process.env.OPENAI_API_KEY = 'mock-openai-key-for-test';
    visionService.setCustomProviders(null);

    let callCount = 0;
    globalThis.fetch = async (url: any, opts: any) => {
      if (typeof url === 'string' && url.includes('api.openai.com/v1/images/generations')) {
        callCount++;
        if (callCount === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: [{ url: 'https://oaidalleapiprodscus.blob.core.windows.net/private/img_1.png' }]
            })
          } as any;
        } else {
          return {
            ok: false,
            status: 429,
            text: async () => 'Rate limit exceeded on second concurrent request'
          } as any;
        }
      }
      return originalFetch(url, opts);
    };

    const principal = `usr_openai_partial_${Date.now()}`;
    const cust = await commercialBillingService.getOrCreateCustomer(principal);

    try {
      await assert.rejects(
        async () => {
          await visionService.generate(principal, {
            prompt: 'Cozy alpine cabin in blizzard',
            aspectRatio: '1:1',
            quality: 'economy',
            resolution: 'standard',
            numImages: 2
          });
        },
        (err: any) => {
          assert.equal(err.code, 'VISION_PROVIDER_NOT_READY');
          assert.ok(err.message.includes('Zero credits were charged') || err.message.includes('zero credits were debited'));
          return true;
        }
      );

      // Verify zero credits debited
      const ent = await commercialBillingService.getEntitlements(principal);
      assert.equal(ent.creditBalance, 100);
      assert.equal(ent.reservedCredits, 0);

      // Verify reservation was released in database
      const acc = await db('credit_accounts').where({ customer_id: cust.id }).first();
      const res = await db('credit_reservations').where({ account_id: acc.id }).orderBy('created_at', 'desc').first();
      assert.ok(res);
      assert.equal(res.status, 'RELEASED');
    } finally {
      globalThis.fetch = originalFetch;
      if (originalOpenAI) process.env.OPENAI_API_KEY = originalOpenAI; else delete process.env.OPENAI_API_KEY;
      if (originalFal) process.env.FAL_KEY = originalFal;
      if (originalReplicate) process.env.REPLICATE_API_TOKEN = originalReplicate;
      const acc = await db('credit_accounts').where({ customer_id: cust.id }).first();
      if (acc) {
        await db('credit_reservations').where({ account_id: acc.id }).delete().catch(() => {});
        await db('credit_grants').where({ account_id: acc.id }).delete().catch(() => {});
        await db('credit_accounts').where({ id: acc.id }).delete().catch(() => {});
      }
      await db('billing_customers').where({ id: cust.id }).delete().catch(() => {});
    }
  });

  it('14. Gate 2: Replicate output count mismatch (requested 2, delivered 1) aborts with 0 credits debited', async () => {
    const originalReplicate = process.env.REPLICATE_API_TOKEN;
    const originalFal = process.env.FAL_KEY;
    const originalOpenAI = process.env.OPENAI_API_KEY;
    const originalFetch = globalThis.fetch;

    delete process.env.FAL_KEY;
    delete process.env.FAL_API_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.REPLICATE_API_TOKEN = 'mock-replicate-token-for-test';
    visionService.setCustomProviders(null);

    globalThis.fetch = async (url: any, opts: any) => {
      if (typeof url === 'string' && url.includes('api.replicate.com/v1/models/black-forest-labs/flux-schnell')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            output: ['https://replicate.delivery/pbxt/single_image_output.png'] // Only 1 output returned
          })
        } as any;
      }
      return originalFetch(url, opts);
    };

    const principal = `usr_replicate_mismatch_${Date.now()}`;
    const cust = await commercialBillingService.getOrCreateCustomer(principal);

    try {
      await assert.rejects(
        async () => {
          await visionService.generate(principal, {
            prompt: 'Cyberpunk neon alleyway in rain',
            aspectRatio: '1:1',
            quality: 'economy',
            resolution: 'standard',
            numImages: 2
          });
        },
        (err: any) => {
          assert.equal(err.code, 'VISION_PROVIDER_NOT_READY');
          assert.ok(err.message.includes('Provider output count mismatch'));
          assert.ok(err.message.includes('zero credits were debited') || err.message.includes('Zero credits were charged'));
          return true;
        }
      );

      // Verify zero credits debited
      const ent = await commercialBillingService.getEntitlements(principal);
      assert.equal(ent.creditBalance, 100);
      assert.equal(ent.reservedCredits, 0);

      // Verify reservation released in database
      const acc = await db('credit_accounts').where({ customer_id: cust.id }).first();
      const res = await db('credit_reservations').where({ account_id: acc.id }).orderBy('created_at', 'desc').first();
      assert.ok(res);
      assert.equal(res.status, 'RELEASED');
    } finally {
      globalThis.fetch = originalFetch;
      if (originalReplicate) process.env.REPLICATE_API_TOKEN = originalReplicate; else delete process.env.REPLICATE_API_TOKEN;
      if (originalFal) process.env.FAL_KEY = originalFal;
      if (originalOpenAI) process.env.OPENAI_API_KEY = originalOpenAI;
      const acc = await db('credit_accounts').where({ customer_id: cust.id }).first();
      if (acc) {
        await db('credit_reservations').where({ account_id: acc.id }).delete().catch(() => {});
        await db('credit_grants').where({ account_id: acc.id }).delete().catch(() => {});
        await db('credit_accounts').where({ id: acc.id }).delete().catch(() => {});
      }
      await db('billing_customers').where({ id: cust.id }).delete().catch(() => {});
    }
  });

  it('15. Gate 2: Custom provider count mismatch (requested 2, delivered 1) aborts with 0 credits charged', async () => {
    visionService.setCustomProviders({
      generate: async (_p, d) => [
        { url: 'https://cdn.aira.example.com/custom_single.png', width: d.width, height: d.height }
      ]
    });

    const principal = `usr_custom_mismatch_${Date.now()}`;
    const cust = await commercialBillingService.getOrCreateCustomer(principal);

    try {
      await assert.rejects(
        async () => {
          await visionService.generate(principal, {
            prompt: 'Test custom mismatch',
            aspectRatio: '1:1',
            quality: 'economy',
            resolution: 'standard',
            numImages: 2
          });
        },
        (err: any) => {
          assert.equal(err.code, 'VISION_PROVIDER_NOT_READY');
          assert.ok(err.message.includes('Provider output count mismatch'));
          return true;
        }
      );

      const ent = await commercialBillingService.getEntitlements(principal);
      assert.equal(ent.creditBalance, 100);
      assert.equal(ent.reservedCredits, 0);

      const acc = await db('credit_accounts').where({ customer_id: cust.id }).first();
      const res = await db('credit_reservations').where({ account_id: acc.id }).orderBy('created_at', 'desc').first();
      assert.ok(res);
      assert.equal(res.status, 'RELEASED');
    } finally {
      visionService.setCustomProviders(null);
      const acc = await db('credit_accounts').where({ customer_id: cust.id }).first();
      if (acc) {
        await db('credit_reservations').where({ account_id: acc.id }).delete().catch(() => {});
        await db('credit_grants').where({ account_id: acc.id }).delete().catch(() => {});
        await db('credit_accounts').where({ id: acc.id }).delete().catch(() => {});
      }
      await db('billing_customers').where({ id: cust.id }).delete().catch(() => {});
    }
  });

  it('16. Gate 3: GET /api/vision/capabilities reports edit.available: false; credential presence alone does not advertise readiness', async () => {
    // Set dummy keys in environment
    const origOpenAI = process.env.OPENAI_API_KEY;
    const origFal = process.env.FAL_KEY;
    process.env.OPENAI_API_KEY = 'mock-openai-key';
    process.env.FAL_KEY = 'mock-fal-key';
    visionService.setCustomProviders(null);

    const principal = `usr_gate3_unavail_${Date.now()}`;
    const cust = await commercialBillingService.getOrCreateCustomer(principal);

    try {
      // 1. Inspect readiness: Even with keys present, edit must NOT be advertised as available
      const status = visionService.getProviderStatus();
      assert.equal(status.edit.available, false, 'Vision edit must NOT be advertised as ready merely because keys exist');
      assert.equal(status.edit.provider, null);
      assert.equal(status.edit.model, null);

      // 2. Calling edit unconfigured fails closed with 503 before any credit hold is created
      await assert.rejects(
        async () => {
          await visionService.edit(principal, {
            prompt: 'Add sunglasses to portrait',
            quality: 'economy',
            resolution: 'standard'
          });
        },
        (err: any) => {
          assert.equal(err.code, 'VISION_PROVIDER_NOT_READY');
          assert.equal(err.statusCode, 503);
          assert.ok(err.message.includes('not configured'));
          return true;
        }
      );

      // Verify ZERO reservations created in database
      const acc = await db('credit_accounts').where({ customer_id: cust.id }).first();
      const count = await db('credit_reservations').where({ account_id: acc.id }).count('* as c');
      assert.equal(Number(count[0].c), 0, 'Zero credit reservations must be created when provider is not ready');

      // 3. Injecting a genuine verified custom edit provider makes edit available
      visionService.setCustomProviders({
        edit: async (_params, dims) => ({
          url: 'https://cdn.aira.example.com/verified_edit_output.png',
          width: dims.width,
          height: dims.height
        })
      });

      const readyStatus = visionService.getProviderStatus();
      assert.equal(readyStatus.edit.available, true);
      assert.equal(readyStatus.edit.provider, 'custom');
      assert.equal(readyStatus.edit.model, 'custom-edit');

      const editResult = await visionService.edit(principal, {
        prompt: 'Add sunglasses to portrait',
        quality: 'economy',
        resolution: 'standard'
      });
      assert.equal(editResult.image.url, 'https://cdn.aira.example.com/verified_edit_output.png');
      assert.equal(editResult.chargedCredits, 40);
    } finally {
      visionService.setCustomProviders(null);
      if (origOpenAI) process.env.OPENAI_API_KEY = origOpenAI; else delete process.env.OPENAI_API_KEY;
      if (origFal) process.env.FAL_KEY = origFal; else delete process.env.FAL_KEY;
      const acc = await db('credit_accounts').where({ customer_id: cust.id }).first();
      if (acc) {
        await db('credit_reservations').where({ account_id: acc.id }).delete().catch(() => {});
        await db('credit_grants').where({ account_id: acc.id }).delete().catch(() => {});
        await db('credit_accounts').where({ id: acc.id }).delete().catch(() => {});
      }
      await db('billing_customers').where({ id: cust.id }).delete().catch(() => {});
    }
  });

  it('17. Gate 4: Post-settlement telemetry failure delivers output to user without false zero-credit claims', async () => {
    visionService.setCustomProviders({
      generate: async (_p, d) => [
        { url: 'https://cdn.aira.example.com/settled_real_image.png', width: d.width, height: d.height }
      ]
    });

    const principal = `usr_gate4_telemetry_${Date.now()}`;
    const cust = await commercialBillingService.getOrCreateCustomer(principal);

    // Mock recordUsageEvent to simulate telemetry/event-bus failure after settlement
    const originalRecordUsage = commercialBillingService.recordUsageEvent.bind(commercialBillingService);
    commercialBillingService.recordUsageEvent = async () => {
      throw new Error('Kafka/EventBus connection refused: simulated post-settlement telemetry failure');
    };

    try {
      // Generation must succeed and deliver image despite telemetry logging failure
      const result = await visionService.generate(principal, {
        prompt: 'Architectural render of floating pavilion',
        aspectRatio: '1:1',
        quality: 'economy',
        resolution: 'standard',
        numImages: 1
      });

      assert.equal(result.images.length, 1);
      assert.equal(result.totalCredits, 12);
      assert.equal(result.images[0].url, 'https://cdn.aira.example.com/settled_real_image.png');

      // Verify settlement in PostgreSQL: balance is 88 (100 - 12), reservation is SETTLED
      const ent = await commercialBillingService.getEntitlements(principal);
      assert.equal(ent.creditBalance, 88);
      assert.equal(ent.reservedCredits, 0);

      const acc = await db('credit_accounts').where({ customer_id: cust.id }).first();
      const res = await db('credit_reservations').where({ account_id: acc.id }).first();
      assert.equal(res.status, 'SETTLED');
    } finally {
      commercialBillingService.recordUsageEvent = originalRecordUsage;
      visionService.setCustomProviders(null);
      const acc = await db('credit_accounts').where({ customer_id: cust.id }).first();
      if (acc) {
        await db('credit_reservations').where({ account_id: acc.id }).delete().catch(() => {});
        await db('credit_grants').where({ account_id: acc.id }).delete().catch(() => {});
        await db('credit_accounts').where({ id: acc.id }).delete().catch(() => {});
      }
      await db('billing_customers').where({ id: cust.id }).delete().catch(() => {});
    }
  });

  it('18. Gate 4: End-to-end audit of all 4 lifecycle failure stages in isolated PostgreSQL', async () => {
    const principal = `usr_gate4_lifecycle_${Date.now()}`;
    const cust = await commercialBillingService.getOrCreateCustomer(principal);
    const acc = await db('credit_accounts').where({ customer_id: cust.id }).first();

    try {
      // Stage 1: Error before reservation (e.g. balance is 0 and request needs credits)
      await db('credit_accounts').where({ id: acc.id }).update({ balance_credits: 0 });
      visionService.setCustomProviders({
        generate: async (_p, d) => [{ url: 'https://cdn.aira.example.com/img.png', width: d.width, height: d.height }]
      });

      await assert.rejects(
        async () => {
          await visionService.generate(principal, {
            prompt: 'Stage 1 test',
            aspectRatio: '1:1',
            quality: 'economy',
            resolution: 'standard',
            numImages: 1
          });
        },
        (err: any) => err.code === 'INSUFFICIENT_CREDITS' || err.statusCode === 402
      );
      let reservations = await db('credit_reservations').where({ account_id: acc.id });
      assert.equal(reservations.length, 0, 'Stage 1: Zero reservations created on pre-reservation error');

      // Restore balance for subsequent stages
      await db('credit_accounts').where({ id: acc.id }).update({ balance_credits: 100 });

      // Stage 2: Error after reservation, before provider output (provider crashes during execution)
      visionService.setCustomProviders({
        generate: async () => {
          throw new Error('GPU worker exploded mid-generation');
        }
      });

      await assert.rejects(
        async () => {
          await visionService.generate(principal, {
            prompt: 'Stage 2 test',
            aspectRatio: '1:1',
            quality: 'economy',
            resolution: 'standard',
            numImages: 1
          });
        },
        (err: any) => err.code === 'VISION_PROVIDER_NOT_READY'
      );
      reservations = await db('credit_reservations').where({ account_id: acc.id }).orderBy('created_at', 'desc');
      assert.equal(reservations[0].status, 'RELEASED', 'Stage 2: Reservation must be RELEASED when provider fails');
      let ent = await commercialBillingService.getEntitlements(principal);
      assert.equal(ent.creditBalance, 100, 'Stage 2: Balance intact at 100');

      // Stage 3: Error after provider output (invalid SVG placeholder output detected)
      visionService.setCustomProviders({
        generate: async (_p, d) => [{ url: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', width: d.width, height: d.height }]
      });

      await assert.rejects(
        async () => {
          await visionService.generate(principal, {
            prompt: 'Stage 3 test',
            aspectRatio: '1:1',
            quality: 'economy',
            resolution: 'standard',
            numImages: 1
          });
        },
        (err: any) => err.code === 'VISION_PROVIDER_NOT_READY'
      );
      reservations = await db('credit_reservations').where({ account_id: acc.id }).orderBy('created_at', 'desc');
      assert.equal(reservations[0].status, 'RELEASED', 'Stage 3: Reservation released on invalid output payload');
      ent = await commercialBillingService.getEntitlements(principal);
      assert.equal(ent.creditBalance, 100, 'Stage 3: Balance intact at 100');

      // Stage 4: Ledger settlement success
      visionService.setCustomProviders({
        generate: async (_p, d) => [{ url: 'https://cdn.aira.example.com/stage4_success.png', width: d.width, height: d.height }]
      });

      const successRes = await visionService.generate(principal, {
        prompt: 'Stage 4 test',
        aspectRatio: '1:1',
        quality: 'economy',
        resolution: 'standard',
        numImages: 1
      });
      assert.equal(successRes.images.length, 1);
      reservations = await db('credit_reservations').where({ account_id: acc.id }).orderBy('created_at', 'desc');
      assert.equal(reservations[0].status, 'SETTLED', 'Stage 4: Reservation SETTLED in ledger');
      ent = await commercialBillingService.getEntitlements(principal);
      assert.equal(ent.creditBalance, 88, 'Stage 4: Exactly 12 credits debited in ledger (100 - 12 = 88)');
    } finally {
      visionService.setCustomProviders(null);
      if (acc) {
        await db('credit_reservations').where({ account_id: acc.id }).delete().catch(() => {});
        await db('credit_grants').where({ account_id: acc.id }).delete().catch(() => {});
        await db('credit_accounts').where({ id: acc.id }).delete().catch(() => {});
      }
      await db('billing_customers').where({ id: cust.id }).delete().catch(() => {});
    }
  });

  it('19. Gate 5: Confirms test database isolation and safety barriers against operational databases', async () => {
    const res = await db.raw(
      "SELECT version() AS version, current_database() AS db_name, current_user AS db_user"
    );
    const row = res.rows[0];
    assert.ok(row.version.toLowerCase().includes('postgresql'), 'Engine must be real PostgreSQL');

    // Strict invariant: Must NOT be connected to remote neon.tech or unapproved operational database
    const dbUrl = process.env.DATABASE_URL || '';
    assert.ok(!dbUrl.includes('neon.tech'), 'Test suite must NEVER connect to remote Neon database');
    assert.ok(!dbUrl.includes('staging'), 'Test suite must NEVER connect to remote staging database');
    assert.ok(!dbUrl.includes('prod'), 'Test suite must NEVER connect to production database');

    // Must be aira_test_db
    const isApprovedDisposableDb = row.db_name === 'aira_test_db' || (process.env.CI === 'true' && row.db_name.endsWith('_test_db'));
    assert.strictEqual(
      isApprovedDisposableDb,
      true,
      `GATE 5 SAFETY: Database must be disposable 'aira_test_db', received: ${row.db_name}`
    );
  });
});
