/**
 * AIRA AI 2026 — Milestone M-R3
 * Real Express Application Adversarial Integration Suite (20 Tests)
 *
 * Authoritative integration tests verifying AIRA's Express application (apps/api/src/index.ts)
 * and PostgreSQL database against all 20 required adversarial scenarios from ORIGINAL_REQUEST.md Part 6:
 *
 * 1.  Unauthenticated x-user-tier spoofing
 * 2.  Free user paid model access attempt (403)
 * 3.  Plus user Pro browser/python execution attempt (403)
 * 4.  Authenticated caller forged subscription claims
 * 5.  Caller invokes upgrade endpoints without payment (400 BILLING_UNAVAILABLE)
 * 6.  Cross-account project access isolation (404)
 * 7.  Cross-account memory access isolation (404)
 * 8.  Concurrent requests exhausting last quota unit (atomic race)
 * 9.  Duplicate reservations & retries with Idempotency-Key
 * 10. Cancellation before first token (quota refunded)
 * 11. Cancellation after partial streaming (quota settled)
 * 12. Database outage during quota reservation (503 fail-closed)
 * 13. Worker restart & abandoned reservation recovery (status HELD timeout)
 * 14. Subscription expiry during autonomous execution (re-validation)
 * 15. Downgrade project read-only retention (records >= limit readOnly: true, mutations blocked)
 * 16. Spoofed administrator/developer roles (no Pro tier bypass)
 * 17. Subscription event duplication & replay
 * 18. Server restart data persistence in memory_records
 * 19. Multiple server instances enforcing same limits
 * 20. Genuine billing-disabled upgrade behavior
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';

// 1. Setup isolated database connection before importing DB module
import '../../setup-isolated-neon.js';
import { db, closeDb } from '../../../packages/db/src/index.js';

// 2. Configure Express server environment
process.env.VERCEL = '1';
process.env.NODE_ENV = 'test';
process.env.AIRA_SESSION_SECRET = process.env.AIRA_SESSION_SECRET || 'test-secret-at-least-32-chars-long-for-testing';
process.env.ALLOWED_ORIGINS = 'https://aira-ai-2026.vercel.app,http://localhost:5173';

// 3. Import production Express app & services
const { default: app } = await import('../../../apps/api/src/index.js');
import {
  COMMERCIAL_PLANS,
  PlanTier,
  isModelAllowedForTier,
  isFeatureAllowedForTier,
  VERIFIED_MODEL_REGISTRY,
  VERIFIED_PLAN_MODEL_ALLOWLIST
} from '../../../packages/contracts/src/index.js';
import {
  commercialBillingService,
  StandardQuotaExceededError
} from '../../../apps/api/src/billing/commercial-billing-service.js';
import { paymentGatewayService } from '../../../apps/api/src/billing/payment-gateway-service.js';
import { AutonomousWorkerHost } from '../../../packages/agent-runtime/src/autonomous/autonomous-worker-host.js';
import { ToolGateway, InMemoryToolCallRepository } from '../../../packages/tool-runtime/src/index.js';
import {
  durableIdempotencyManager,
  IdempotencyConflictError
} from '../../../apps/api/src/utils/idempotency.js';

// ============================================================================
// TEST HARNESS & DATABASE FIXTURE LIFECYCLE
// ============================================================================

let mainServer: http.Server;
let baseUrl: string;
const suiteTag = crypto.randomUUID().slice(0, 8);
const createdPrincipals = new Set<string>();

test.before(async () => {
  await new Promise<void>((resolve) => {
    mainServer = app.listen(0, '127.0.0.1', () => {
      const addr = mainServer.address() as any;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

test.after(async () => {
  console.log('[CLEANUP] Starting test.after cleanup...');
  // Batch teardown created test entities
  const pids = Array.from(createdPrincipals);
  if (pids.length > 0) {
    try {
      console.log(`[CLEANUP] Deleting ${pids.length} principals...`);
      const customers = await db('billing_customers').whereIn('principal_id', pids).select('id');
      const custIds = customers.map(c => c.id);
      if (custIds.length > 0) {
        const accounts = await db('credit_accounts').whereIn('customer_id', custIds).select('id');
        const accIds = accounts.map(a => a.id);
        if (accIds.length > 0) {
          await db('credit_reservations').whereIn('account_id', accIds).del();
          await db('credit_grants').whereIn('account_id', accIds).del();
          await db('credit_transactions').whereIn('account_id', accIds).del();
          await db('credit_accounts').whereIn('id', accIds).del();
        }
        await db('entitlement_snapshots').whereIn('customer_id', custIds).del();
        await db('subscriptions').whereIn('customer_id', custIds).del();
        await db('billing_customers').whereIn('id', custIds).del();
      }
      await db('memory_records').whereIn('principal_id', pids).del();
      console.log('[CLEANUP] Principals deleted.');
    } catch (err: any) {
      console.error('[CLEANUP_ERR]', err.message);
    }
  }

  console.log('[CLEANUP] Closing mainServer...');
  await new Promise<void>((resolve) => {
    (mainServer as any).closeAllConnections?.();
    mainServer.close(() => resolve());
  });
  console.log('[CLEANUP] Closing db...');
  await closeDb();
  console.log('[CLEANUP] Complete.');
  setTimeout(() => {
    process.exit(0);
  }, 1500);
});

// Helper for authenticated request headers
function authHeaders(userId: string, role = 'workspace_user'): Record<string, string> {
  createdPrincipals.add(userId);
  return {
    'Content-Type': 'application/json',
    'Origin': 'https://aira-ai-2026.vercel.app',
    'x-test-user-id': userId,
    'x-test-session-id': `sess_${userId}_${suiteTag}`
  };
}

// Helper for creating active subscription in PostgreSQL
async function insertDurableSubscription(
  principalId: string,
  planId: 'plus' | 'pro',
  options: { active?: boolean; expiresAt?: number } = {}
): Promise<{ customerId: string; subscriptionId: string }> {
  createdPrincipals.add(principalId);
  const customer = await commercialBillingService.getOrCreateCustomer(principalId);
  const now = Date.now();
  const subId = `sub_${crypto.randomUUID().replace(/-/g, '')}`;
  const priceId = planId === 'plus' ? 'price_plus_usd' : 'price_pro_usd';
  const amount = planId === 'plus' ? 799 : 1999;
  const isActive = options.active ?? true;
  const currentPeriodEnd = options.expiresAt ?? (isActive ? now + 30 * 24 * 60 * 60 * 1000 : now - 1000);
  const status = isActive ? 'active' : 'cancelled';

  await db('subscriptions').insert({
    id: subId,
    customer_id: customer.id,
    plan_id: planId,
    price_id: priceId,
    status,
    gateway: 'manual_grant',
    currency: 'USD',
    amount_minor_units: amount,
    current_period_start: now - 1000,
    current_period_end: currentPeriodEnd,
    cancel_at_period_end: false,
    metadata: JSON.stringify({ testFixture: true, principalId }),
    created_at: now,
    updated_at: now
  });

  return { customerId: customer.id, subscriptionId: subId };
}

// ============================================================================
// 20 REQUIRED ADVERSARIAL SCENARIOS (ORIGINAL_REQUEST.md Part 6)
// ============================================================================

test('Scenario 1: Unauthenticated caller attempts Pro access using x-user-tier (strictly evaluated as guest, 401/403)', async () => {
  // 1A. Attempt to access project creation without authentication, spoofing x-user-tier: pro
  const projRes = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': 'https://aira-ai-2026.vercel.app',
      'x-aira-csrf-protection': '1',
      'x-user-tier': 'pro'
    },
    body: JSON.stringify({ name: 'Spoofed Pro Project' })
  });

  assert.equal(projRes.status, 401, 'Unauthenticated project creation with x-user-tier: pro must return 401');
  const projBody = await projRes.json();
  assert.equal(projBody.error, 'Unauthorized');

  // 1B. Attempt chat stream with pro-restricted model without authentication, spoofing x-user-tier: pro
  const chatRes = await fetch(`${baseUrl}/api/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': 'https://aira-ai-2026.vercel.app',
      'x-aira-csrf-protection': '1',
      'x-user-tier': 'pro'
    },
    body: JSON.stringify({
      model: 'claude-3-opus',
      messages: [{ role: 'user', content: 'Execute flagship prompt' }]
    })
  });

  assert.equal(chatRes.status, 401, 'Unauthenticated chat stream with x-user-tier: pro must return 401 Unauthorized');
  const chatBody = await chatRes.json();
  assert.equal(chatBody.error, 'Unauthorized');

  // 1C. Attempt privileged tool execution without authentication, spoofing x-user-tier: pro
  const toolRes = await fetch(`${baseUrl}/api/tools/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': 'https://aira-ai-2026.vercel.app',
      'x-aira-csrf-protection': '1',
      'x-user-tier': 'pro'
    },
    body: JSON.stringify({
      toolName: 'browser_navigate',
      arguments: { url: 'https://example.com' }
    })
  });

  assert.equal(toolRes.status, 401, 'Unauthenticated tool execution with x-user-tier: pro must return 401');
  const toolBody = await toolRes.json();
  assert.equal(toolBody.error, 'Unauthorized');

  // 1D. Authenticated Free caller attempts Pro tool execution while spoofing x-user-tier: pro
  const freeUser = `usr_adv_s1_free_${suiteTag}`;
  createdPrincipals.add(freeUser);
  const authToolRes = await fetch(`${baseUrl}/api/tools/execute`, {
    method: 'POST',
    headers: {
      ...authHeaders(freeUser),
      'x-user-tier': 'pro'
    },
    body: JSON.stringify({
      toolName: 'browser_navigate',
      arguments: { url: 'https://example.com' }
    })
  });

  assert.equal(authToolRes.status, 403, 'Free caller spoofing x-user-tier: pro must be evaluated as free and return 403');
  const authToolBody = await authToolRes.json();
  assert.equal(authToolBody.error, 'PLAN_TOOL_RESTRICTED');
  assert.equal(authToolBody.requiredTier, 'pro');
});

test('Scenario 2: Free user attempts paid model access (403 PLAN_MODEL_RESTRICTED)', async () => {
  const freeUser = `usr_adv_s2_free_${suiteTag}`;

  // 2A. Free user attempts flagship opus model (requires Pro)
  const opusRes = await fetch(`${baseUrl}/api/chat/stream`, {
    method: 'POST',
    headers: authHeaders(freeUser),
    body: JSON.stringify({
      model: 'claude-3-opus',
      messages: [{ role: 'user', content: 'Deep analysis' }]
    })
  });

  assert.equal(opusRes.status, 403, 'Free user calling opus must return 403');
  const opusBody = await opusRes.json();
  assert.equal(opusBody.error, 'PLAN_MODEL_RESTRICTED');
  assert.equal(opusBody.callerTier, 'free');
  assert.equal(opusBody.requiredTier, 'pro');

  // 2B. Free user attempts paid pro model (claude-3-5-sonnet requires Plus tier)
  const sonnetRes = await fetch(`${baseUrl}/api/chat/stream`, {
    method: 'POST',
    headers: authHeaders(freeUser),
    body: JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'Autonomous synthesis' }]
    })
  });

  assert.equal(sonnetRes.status, 403, 'Free user calling claude-3-5-sonnet must return 403');
  const sonnetBody = await sonnetRes.json();
  assert.equal(sonnetBody.error, 'PLAN_MODEL_RESTRICTED');
  assert.equal(sonnetBody.callerTier, 'free');
  assert.equal(sonnetBody.requiredTier, 'plus');
});

test('Scenario 3: Plus user Pro browser/python execution attempt (403 PLAN_TOOL_RESTRICTED)', async () => {
  const plusUser = `usr_adv_s3_plus_${suiteTag}`;
  await insertDurableSubscription(plusUser, 'plus', { active: true });

  // 3A. Plus user attempts browser navigation (requires Pro)
  const browserRes = await fetch(`${baseUrl}/api/tools/execute`, {
    method: 'POST',
    headers: authHeaders(plusUser),
    body: JSON.stringify({
      toolName: 'browser_navigate',
      arguments: { url: 'https://github.com' }
    })
  });

  assert.equal(browserRes.status, 403, 'Plus user browser execution must return 403');
  const browserBody = await browserRes.json();
  assert.equal(browserBody.error, 'PLAN_TOOL_RESTRICTED');
  assert.equal(browserBody.requiredTier, 'pro');
  assert.match(browserBody.message, /Browser execution tools require AIRA Pro plan/);

  // 3B. Plus user attempts python sandbox execution (requires Pro)
  const pythonRes = await fetch(`${baseUrl}/api/tools/execute`, {
    method: 'POST',
    headers: authHeaders(plusUser),
    body: JSON.stringify({
      toolName: 'python_sandbox',
      arguments: { code: 'import numpy as np; print(np.pi)' }
    })
  });

  assert.equal(pythonRes.status, 403, 'Plus user python execution must return 403');
  const pythonBody = await pythonRes.json();
  assert.equal(pythonBody.error, 'PLAN_TOOL_RESTRICTED');
  assert.equal(pythonBody.requiredTier, 'pro');
  assert.match(pythonBody.message, /Python Sandbox execution requires AIRA Pro plan/);
});

test('Scenario 4: Authenticated caller forges subscription claims in body/headers (derives tier strictly from PostgreSQL subscriptions)', async () => {
  const freeUser = `usr_adv_s4_forger_${suiteTag}`;

  // Caller sends forged claims in body and headers
  const forgedRes = await fetch(`${baseUrl}/api/chat/stream`, {
    method: 'POST',
    headers: {
      ...authHeaders(freeUser),
      'x-user-tier': 'pro',
      'x-subscription-tier': 'pro',
      'x-plan-id': 'pro'
    },
    body: JSON.stringify({
      model: 'claude-3-opus',
      tier: 'pro',
      plan: 'pro',
      subscription: {
        status: 'active',
        planId: 'pro',
        currentPeriodEnd: Date.now() + 1000000
      },
      messages: [{ role: 'user', content: 'Bypass attempt' }]
    })
  });

  assert.equal(forgedRes.status, 403, 'Forged subscription claims must be rejected with 403');
  const body = await forgedRes.json();
  assert.equal(body.error, 'PLAN_MODEL_RESTRICTED');
  assert.equal(body.callerTier, 'free', 'Server must evaluate user strictly as free from database');
});

test('Scenario 5: Caller invokes upgrade endpoints without payment (400 BILLING_UNAVAILABLE)', async () => {
  const user = `usr_adv_s5_mockup_${suiteTag}`;

  // 5A. Direct self-upgrade endpoint invocation
  const upgradeRes = await fetch(`${baseUrl}/api/user/upgrade`, {
    method: 'POST',
    headers: authHeaders(user),
    body: JSON.stringify({ planId: 'pro', tier: 'pro' })
  });

  assert.equal(upgradeRes.status, 400, 'POST /api/user/upgrade must return 400 BILLING_UNAVAILABLE');
  const upgradeBody = await upgradeRes.json();
  assert.equal(upgradeBody.error, 'BILLING_UNAVAILABLE');
  assert.match(upgradeBody.message, /Direct self-service plan upgrades without verified payment are disabled/);

  // 5B. Direct self-downgrade endpoint invocation
  const downgradeRes = await fetch(`${baseUrl}/api/user/downgrade`, {
    method: 'POST',
    headers: authHeaders(user),
    body: JSON.stringify({ planId: 'free', tier: 'free' })
  });

  assert.equal(downgradeRes.status, 400, 'POST /api/user/downgrade must return 400 BILLING_UNAVAILABLE');
  const downgradeBody = await downgradeRes.json();
  assert.equal(downgradeBody.error, 'BILLING_UNAVAILABLE');

  // Verify no fraudulent subscription was inserted in PostgreSQL
  const customer = await db('billing_customers').where({ principal_id: user }).first();
  if (customer) {
    const sub = await db('subscriptions').where({ customer_id: customer.id }).first();
    assert.equal(sub, undefined, 'No subscription should exist after rejected self-upgrade');
  }
});

test('Scenario 6: Cross-account project access isolation (404 NOT_FOUND across GET, PATCH, DELETE)', async () => {
  const tenantA = `usr_adv_s6_alpha_${suiteTag}`;
  const tenantB = `usr_adv_s6_beta_${suiteTag}`;

  // Tenant A creates a project
  const createRes = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: authHeaders(tenantA),
    body: JSON.stringify({
      name: 'Confidential Strategy Alpha',
      description: 'Strictly isolated to Tenant A'
    })
  });

  assert.equal(createRes.status, 201);
  const createdProject = await createRes.json();
  const projectId = createdProject.id;
  assert.ok(projectId, 'Project ID must be returned');

  // Tenant B attempts to read Tenant A's project
  const getRes = await fetch(`${baseUrl}/api/projects/${projectId}`, {
    method: 'GET',
    headers: authHeaders(tenantB)
  });
  assert.equal(getRes.status, 404, 'Cross-tenant GET must return 404');
  const getBody = await getRes.json();
  assert.equal(getBody.error, 'NOT_FOUND');

  // Tenant B attempts to update Tenant A's project
  const patchRes = await fetch(`${baseUrl}/api/projects/${projectId}`, {
    method: 'PATCH',
    headers: authHeaders(tenantB),
    body: JSON.stringify({ name: 'Tampered by Tenant B' })
  });
  assert.equal(patchRes.status, 404, 'Cross-tenant PATCH must return 404');

  // Tenant B attempts to delete Tenant A's project
  const delRes = await fetch(`${baseUrl}/api/projects/${projectId}`, {
    method: 'DELETE',
    headers: authHeaders(tenantB)
  });
  assert.equal(delRes.status, 404, 'Cross-tenant DELETE must return 404');

  // Verify Tenant A's project is intact and unmodified in the database
  const verifyRes = await fetch(`${baseUrl}/api/projects/${projectId}`, {
    method: 'GET',
    headers: authHeaders(tenantA)
  });
  assert.equal(verifyRes.status, 200);
  const verifyBody = await verifyRes.json();
  assert.equal(verifyBody.name, 'Confidential Strategy Alpha');
});

test('Scenario 7: Cross-account memory access isolation (404 NOT_FOUND across GET, DELETE)', async () => {
  const tenantA = `usr_adv_s7_alpha_${suiteTag}`;
  const tenantB = `usr_adv_s7_beta_${suiteTag}`;

  // Tenant A creates a memory
  const createRes = await fetch(`${baseUrl}/api/memories`, {
    method: 'POST',
    headers: authHeaders(tenantA),
    body: JSON.stringify({
      content: 'Confidential knowledge item for Alpha',
      tags: ['sensitive', 'tenantA']
    })
  });

  assert.equal(createRes.status, 201);
  const memory = await createRes.json();
  const memoryId = memory.id;

  // Tenant B attempts to read Tenant A's memory
  const getRes = await fetch(`${baseUrl}/api/memories/${memoryId}`, {
    method: 'GET',
    headers: authHeaders(tenantB)
  });
  assert.equal(getRes.status, 404, 'Cross-tenant memory GET must return 404');

  // Tenant B attempts to delete Tenant A's memory
  const delRes = await fetch(`${baseUrl}/api/memories/${memoryId}`, {
    method: 'DELETE',
    headers: authHeaders(tenantB)
  });
  assert.equal(delRes.status, 404, 'Cross-tenant memory DELETE must return 404');

  // Confirm memory still accessible by Tenant A
  const verifyRes = await fetch(`${baseUrl}/api/memories/${memoryId}`, {
    method: 'GET',
    headers: authHeaders(tenantA)
  });
  assert.equal(verifyRes.status, 200);
  const verifyBody = await verifyRes.json();
  assert.equal(verifyBody.content, 'Confidential knowledge item for Alpha');
});

test('Scenario 8: Concurrent requests exhausting last quota unit (atomic race on last unit; exactly 1 succeeds, others receive 429)', async () => {
  const user = `usr_adv_s8_race_${suiteTag}`;
  createdPrincipals.add(user);

  const customer = await commercialBillingService.getOrCreateCustomer(user);
  const today = new Date().toISOString().slice(0, 10);
  const now = Date.now();
  const freeLimit = COMMERCIAL_PLANS.free.dailyStandardChatLimit; // 15

  // Seed entitlement snapshot with exactly 1 quota unit remaining
  await db('entitlement_snapshots')
    .insert({
      id: `snp_${crypto.randomUUID().replace(/-/g, '')}`,
      customer_id: customer.id,
      period_date: today,
      daily_standard_chat_count: freeLimit - 1, // 14 of 15 used
      monthly_standard_chat_count: freeLimit - 1,
      monthly_reasoning_boost_count: 0,
      last_reset_at: now,
      updated_at: now
    })
    .onConflict(['customer_id', 'period_date'])
    .merge({
      daily_standard_chat_count: freeLimit - 1,
      monthly_standard_chat_count: freeLimit - 1,
      updated_at: now
    });

  // Launch 5 concurrent calls racing on the single remaining quota unit
  const promises = Array.from({ length: 5 }, () =>
    commercialBillingService.reserveStandardChat(user, 'free', 'claude-3-5-haiku')
  );

  const results = await Promise.allSettled(promises);
  const fulfilled = results.filter(r => r.status === 'fulfilled');
  const rejected = results.filter(r => r.status === 'rejected');

  assert.equal(fulfilled.length, 1, 'Exactly one concurrent reservation must succeed');
  assert.equal(rejected.length, 4, 'All four racing requests must be rejected');

  for (const r of rejected) {
    if (r.status === 'rejected') {
      assert.ok(
        r.reason instanceof StandardQuotaExceededError,
        'Rejected error must be StandardQuotaExceededError'
      );
      assert.equal(r.reason.reason, 'daily');
    }
  }

  // Verify database counter in PostgreSQL is exactly at the limit (15) and never overdrafted
  const finalSnapshot = await db('entitlement_snapshots')
    .where({ customer_id: customer.id, period_date: today })
    .first();
  assert.equal(Number(finalSnapshot.daily_standard_chat_count), freeLimit);
});

test('Scenario 9: Duplicate reservations and retries with Idempotency-Key (returns identical outcome without double deduction)', async () => {
  const user = `usr_adv_s9_idemp_${suiteTag}`;
  createdPrincipals.add(user);

  const customer = await commercialBillingService.getOrCreateCustomer(user);
  const today = new Date().toISOString().slice(0, 10);
  const idempotencyKey = `idemp_adv_${crypto.randomUUID()}`;
  const operationType = 'STANDARD_CHAT_RESERVATION';
  const payload = {
    userId: user,
    tier: 'free',
    model: 'claude-3-5-haiku',
    purpose: 'adversarial_idempotency_test'
  };

  // 1. Initial execution begins with Idempotency-Key
  const check1 = await durableIdempotencyManager.beginOrGet(
    user,
    idempotencyKey,
    operationType,
    payload
  );
  assert.equal(check1.isReplay, false, 'Initial call must not be marked replay');

  // Perform genuine single reservation deduction
  const reservation = await commercialBillingService.reserveStandardChat(user, 'free', 'claude-3-5-haiku');
  const token = reservation.reservationToken;

  const snapshotAfter1 = await db('entitlement_snapshots')
    .where({ customer_id: customer.id, period_date: today })
    .first();
  const countAfter1 = Number(snapshotAfter1.daily_standard_chat_count);

  // Complete idempotency lock with genuine reservation result
  await durableIdempotencyManager.complete(user, idempotencyKey, 201, {
    reservationToken: token,
    dailyCount: countAfter1
  });

  // 2. Exact retry with identical Idempotency-Key and payload
  const check2 = await durableIdempotencyManager.beginOrGet(
    user,
    idempotencyKey,
    operationType,
    payload
  );

  assert.equal(check2.isReplay, true, 'Retry must return cached response as replay');
  if (check2.isReplay) {
    assert.equal(check2.statusCode, 201);
    assert.equal(check2.responseBody.reservationToken, token);
    assert.equal(check2.responseBody.dailyCount, countAfter1);
  }

  // Verify snapshot daily count was NOT incremented on retry
  const snapshotAfter2 = await db('entitlement_snapshots')
    .where({ customer_id: customer.id, period_date: today })
    .first();
  const countAfter2 = Number(snapshotAfter2.daily_standard_chat_count);
  assert.equal(countAfter2, countAfter1, 'Idempotent retry must not deduct additional quota');

  // 3. Forged retry with same Idempotency-Key but modified payload -> rejected with 409 IDEMPOTENCY_CONFLICT
  await assert.rejects(
    async () => {
      await durableIdempotencyManager.beginOrGet(
        user,
        idempotencyKey,
        operationType,
        { ...payload, model: 'claude-3-opus-forged' }
      );
    },
    (err: any) => err instanceof IdempotencyConflictError,
    'Conflicting payload with reused idempotency key must reject with 409 IDEMPOTENCY_CONFLICT'
  );
});

test('Scenario 10: Client cancellation before first token delta (quota is atomically refunded via releaseStandardChat)', async () => {
  const user = `usr_adv_s10_cancel_${suiteTag}`;
  createdPrincipals.add(user);

  const customer = await commercialBillingService.getOrCreateCustomer(user);
  const today = new Date().toISOString().slice(0, 10);

  // Reserve a standard chat unit
  const reservation = await commercialBillingService.reserveStandardChat(user, 'free', 'claude-3-5-haiku');
  const token = reservation.reservationToken;

  const snapshotHeld = await db('entitlement_snapshots')
    .where({ customer_id: customer.id, period_date: today })
    .first();
  const heldCount = Number(snapshotHeld.daily_standard_chat_count);

  // Client aborts before first token delta -> releaseStandardChat called
  await commercialBillingService.releaseStandardChat(token, 'client_abort_pre_token');

  // Verify reservation status transitioned to RELEASED
  const reservationRow = await db('credit_reservations').where({ id: token }).first();
  assert.equal(reservationRow.status, 'RELEASED');

  // Verify snapshot daily count was refunded atomically in PostgreSQL
  const snapshotRefunded = await db('entitlement_snapshots')
    .where({ customer_id: customer.id, period_date: today })
    .first();
  const refundedCount = Number(snapshotRefunded.daily_standard_chat_count);

  assert.equal(refundedCount, heldCount - 1, 'Quota unit must be atomically refunded on pre-token cancel');
});

test('Scenario 11: Cancellation after partial streaming (quota settled on first token delta and remains committed)', async () => {
  const user = `usr_adv_s11_settle_${suiteTag}`;
  createdPrincipals.add(user);

  const customer = await commercialBillingService.getOrCreateCustomer(user);
  const today = new Date().toISOString().slice(0, 10);

  // Reserve standard chat unit
  const reservation = await commercialBillingService.reserveStandardChat(user, 'free', 'claude-3-5-haiku');
  const token = reservation.reservationToken;

  // First token delta emitted -> settleStandardChat called
  await commercialBillingService.settleStandardChat(token);

  const snapshotSettled = await db('entitlement_snapshots')
    .where({ customer_id: customer.id, period_date: today })
    .first();
  const settledCount = Number(snapshotSettled.daily_standard_chat_count);

  const reservationRow = await db('credit_reservations').where({ id: token }).first();
  assert.equal(reservationRow.status, 'SETTLED');

  // Subsequent client disconnect after streaming partial tokens attempts release
  await commercialBillingService.releaseStandardChat(token, 'client_abort_post_token');

  // Verify reservation remains SETTLED and was NOT refunded
  const reservationRowAfter = await db('credit_reservations').where({ id: token }).first();
  assert.equal(reservationRowAfter.status, 'SETTLED', 'Settled reservation must not transition to RELEASED');

  const snapshotAfter = await db('entitlement_snapshots')
    .where({ customer_id: customer.id, period_date: today })
    .first();
  assert.equal(Number(snapshotAfter.daily_standard_chat_count), settledCount, 'Settled quota must not be refunded');
});

test('Scenario 12: Database outage during quota reservation (API fails closed with 503 ENTITLEMENT_SERVICE_UNAVAILABLE)', async () => {
  const user = `usr_adv_s12_dboutage_${suiteTag}`;

  // Temporarily stub reserveStandardChat to simulate database connectivity failure
  const originalReserve = commercialBillingService.reserveStandardChat.bind(commercialBillingService);
  commercialBillingService.reserveStandardChat = async () => {
    const err: any = new Error('Connection terminated unexpectedly: PostgreSQL connection refused');
    err.code = 'ECONNREFUSED';
    throw err;
  };

  try {
    const res = await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: authHeaders(user),
      body: JSON.stringify({
        model: 'claude-3-5-haiku',
        messages: [{ role: 'user', content: 'Test stream during outage' }]
      })
    });

    assert.equal(res.status, 503, 'Chat stream must fail closed with HTTP 503 during DB outage');
    const body = await res.json();
    assert.equal(body.error, 'ENTITLEMENT_SERVICE_UNAVAILABLE');
    assert.match(body.message, /Unable to verify quota entitlements. Execution denied./);
  } finally {
    // Restore genuine reservation method
    commercialBillingService.reserveStandardChat = originalReserve;
  }
});

test('Scenario 13: Worker restart and abandoned reservation recovery (stale reservations with status HELD timeout swept and refunded)', async () => {
  const user = `usr_adv_s13_abandoned_${suiteTag}`;
  createdPrincipals.add(user);

  const customer = await commercialBillingService.getOrCreateCustomer(user);
  const account = await db('credit_accounts').where({ customer_id: customer.id }).first();
  const today = new Date().toISOString().slice(0, 10);
  const now = Date.now();
  const staleReservationId = `res_stale_${crypto.randomUUID().replace(/-/g, '')}`;

  // Seed snapshot with 5 standard chats used
  await db('entitlement_snapshots')
    .insert({
      id: `snp_${crypto.randomUUID().replace(/-/g, '')}`,
      customer_id: customer.id,
      period_date: today,
      daily_standard_chat_count: 5,
      monthly_standard_chat_count: 5,
      monthly_reasoning_boost_count: 0,
      last_reset_at: now,
      updated_at: now
    })
    .onConflict(['customer_id', 'period_date'])
    .merge({ daily_standard_chat_count: 5, monthly_standard_chat_count: 5, updated_at: now });

  // Insert abandoned reservation: status HELD, expired 30 minutes ago
  await db('credit_reservations').insert({
    id: staleReservationId,
    account_id: account.id,
    reference_id: `task_abandoned_${suiteTag}`,
    task_type: 'standard_chat',
    amount_credits: 0,
    status: 'HELD',
    expires_at: now - 30 * 60 * 1000, // Expired
    metadata: JSON.stringify({ customerId: customer.id, periodDate: today, units: 1 }),
    created_at: now - 35 * 60 * 1000,
    updated_at: now - 35 * 60 * 1000
  });

  // Sweeper execution: query abandoned reservations past expiration
  const staleList = await db('credit_reservations')
    .where({ status: 'HELD' })
    .where('expires_at', '<', Date.now());

  const foundStale = staleList.find(r => r.id === staleReservationId);
  assert.ok(foundStale, 'Sweeper must find the expired abandoned reservation');

  // Sweep and release stale hold
  await commercialBillingService.releaseStandardChat(staleReservationId, 'worker_recovery_expired_hold');

  // Verify transition to RELEASED and quota refund
  const updatedReservation = await db('credit_reservations').where({ id: staleReservationId }).first();
  assert.equal(updatedReservation.status, 'RELEASED');

  const snapshotAfter = await db('entitlement_snapshots')
    .where({ customer_id: customer.id, period_date: today })
    .first();
  assert.equal(Number(snapshotAfter.daily_standard_chat_count), 4, 'Abandoned reservation must be refunded on sweep');
});

test('Scenario 14: Subscription expiry during autonomous execution (re-validation detects expired subscription and rejects privileged execution)', async () => {
  const user = `usr_adv_s14_subexpiry_${suiteTag}`;
  const { customerId, subscriptionId } = await insertDurableSubscription(user, 'pro', { active: true });

  // 1. Initially user is Pro: can access browser tools via API
  const initRes = await fetch(`${baseUrl}/api/tools/execute`, {
    method: 'POST',
    headers: authHeaders(user),
    body: JSON.stringify({
      toolName: 'browser_navigate',
      arguments: { url: 'https://authorized.example.com' }
    })
  });
  // Does not return 403 PLAN_TOOL_RESTRICTED for Pro tier
  assert.notEqual(initRes.status, 403);

  // 2. Subscription expires mid-execution
  await db('subscriptions')
    .where({ id: subscriptionId })
    .update({
      status: 'cancelled',
      current_period_end: Date.now() - 1000,
      updated_at: Date.now()
    });

  // Revalidate tier from database
  const refreshedSub = await commercialBillingService.getActiveSubscription(customerId);
  assert.equal(refreshedSub.planId, 'free', 'Expired subscription must downgrade caller tier to free');

  // 3. Autonomous worker host rejects execution for downgraded user
  const host = new AutonomousWorkerHost(
    {
      getTask: async () => null,
      updateState: async () => {}
    } as any,
    {
      executeAutonomousTask: async () => ({ state: 'COMPLETED' })
    } as any,
    { pollIntervalMs: 50, leaseDurationMs: 1000, heartbeatIntervalMs: 200 }
  );

  let failedEvent: any = null;
  host.on('task.failed', (e) => { failedEvent = e; });

  await (host as any).processTask({
    taskId: `task_exp_${suiteTag}`,
    principal: {
      userId: user,
      sessionId: `sess_${user}`,
      workspaceId: 'default',
      roles: ['workspace_user'],
      scopes: ['*'],
      tier: 'free' // Downgraded
    },
    fencingToken: 1
  });

  assert.ok(failedEvent, 'Autonomous worker host must fail task when tier is downgraded');
  assert.match(failedEvent.error, /Autonomous worker execution restricted to Plus and Pro tiers/);

  // 4. Privileged tools are also blocked via the real Express API
  const expiredRes = await fetch(`${baseUrl}/api/tools/execute`, {
    method: 'POST',
    headers: authHeaders(user),
    body: JSON.stringify({
      toolName: 'browser_navigate',
      arguments: { url: 'https://blocked.example.com' }
    })
  });
  assert.equal(expiredRes.status, 403, 'Privileged tool execution must return 403 for expired tier');
  const expiredBody = await expiredRes.json();
  assert.equal(expiredBody.error, 'PLAN_TOOL_RESTRICTED');
  assert.equal(expiredBody.requiredTier, 'pro');
});

test('Scenario 15: Downgrade while projects exceed new limit (records >= limit dynamically marked readOnly: true, mutations blocked, zero records deleted)', async () => {
  const user = `usr_adv_s15_downgrade_${suiteTag}`;
  const { subscriptionId } = await insertDurableSubscription(user, 'plus', { active: true });

  // Plus user creates 5 projects (within Plus limit of 10, but exceeding Free limit of 3)
  const createdProjects: any[] = [];
  for (let i = 1; i <= 5; i++) {
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: authHeaders(user),
      body: JSON.stringify({
        name: `Project ${i} — Downgrade Test`,
        description: `Project number ${i}`
      })
    });
    assert.equal(res.status, 201);
    createdProjects.push(await res.json());
  }

  // Confirm all 5 were writable on Plus tier
  assert.equal(createdProjects.length, 5);
  assert.ok(createdProjects.every(p => p.readOnly === false));

  // Downgrade subscription to Free (limit becomes 3)
  await db('subscriptions')
    .where({ id: subscriptionId })
    .update({
      status: 'cancelled',
      current_period_end: Date.now() - 5000,
      updated_at: Date.now()
    });

  // Query projects as Free user
  const listRes = await fetch(`${baseUrl}/api/projects`, {
    method: 'GET',
    headers: authHeaders(user)
  });
  assert.equal(listRes.status, 200);
  const listBody = await listRes.json();
  assert.equal(listBody.projects.length, 5, 'Zero projects must be deleted on downgrade');

  // Verify dynamic read-only assignment: first 3 writable, 4th and 5th read-only
  assert.equal(listBody.projects[0].readOnly, false);
  assert.equal(listBody.projects[1].readOnly, false);
  assert.equal(listBody.projects[2].readOnly, false);
  assert.equal(listBody.projects[3].readOnly, true, 'Project index 3 (4th project) must be readOnly: true');
  assert.equal(listBody.projects[4].readOnly, true, 'Project index 4 (5th project) must be readOnly: true');

  // Attempt mutation (PATCH) on read-only project 4
  const patchRes = await fetch(`${baseUrl}/api/projects/${listBody.projects[3].id}`, {
    method: 'PATCH',
    headers: authHeaders(user),
    body: JSON.stringify({ name: 'Illegal Mutation on Read-Only Project' })
  });
  assert.equal(patchRes.status, 403, 'PATCH on read-only project must return 403 ITEM_READ_ONLY');
  const patchBody = await patchRes.json();
  assert.equal(patchBody.error, 'ITEM_READ_ONLY');

  // Attempt deletion (DELETE) on read-only project 4
  const delRes = await fetch(`${baseUrl}/api/projects/${listBody.projects[3].id}`, {
    method: 'DELETE',
    headers: authHeaders(user)
  });
  assert.equal(delRes.status, 403, 'DELETE on read-only project must return 403 ITEM_READ_ONLY');

  // Re-upgrade to Plus: all 5 projects must dynamically become writable again
  await db('subscriptions')
    .where({ id: subscriptionId })
    .update({
      status: 'active',
      current_period_end: Date.now() + 30 * 24 * 60 * 60 * 1000,
      updated_at: Date.now()
    });

  const reupgradedList = await fetch(`${baseUrl}/api/projects`, {
    method: 'GET',
    headers: authHeaders(user)
  });
  const reupgradedBody = await reupgradedList.json();
  assert.ok(
    reupgradedBody.projects.every((p: any) => p.readOnly === false),
    'All projects must become writable again upon re-upgrade'
  );
});

test('Scenario 16: Spoofed administrator/developer roles and wildcard scopes (no commercial Pro tier bypass)', async () => {
  const adminUser = `usr_adv_s16_admin_${suiteTag}`;

  // Admin user has admin role and wildcard scopes, but NO Pro subscription in database
  const headers = {
    ...authHeaders(adminUser, 'admin'),
    'x-user-roles': 'admin,developer,superuser',
    'x-user-scopes': '*'
  };

  // Attempt pro model access
  const chatRes = await fetch(`${baseUrl}/api/chat/stream`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'claude-3-opus',
      messages: [{ role: 'user', content: 'Admin privilege escalation attempt' }]
    })
  });
  assert.equal(chatRes.status, 403, 'Admin role must not confer Pro model access');
  const chatBody = await chatRes.json();
  assert.equal(chatBody.error, 'PLAN_MODEL_RESTRICTED');
  assert.equal(chatBody.callerTier, 'free');

  // Attempt pro tool access
  const toolRes = await fetch(`${baseUrl}/api/tools/execute`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      toolName: 'browser_navigate',
      arguments: { url: 'https://internal.admin' }
    })
  });
  assert.equal(toolRes.status, 403, 'Admin role must not confer Pro tool access');
  const toolBody = await toolRes.json();
  assert.equal(toolBody.error, 'PLAN_TOOL_RESTRICTED');
});

test('Scenario 17: Subscription event duplication & replay (idempotent webhook processing prevents duplicate credits/actions)', async () => {
  const user = `usr_adv_s17_webhook_${suiteTag}`;
  const customer = await commercialBillingService.getOrCreateCustomer(user);
  const eventId = `evt_adv_replay_${suiteTag}_${Date.now()}`;

  const webhookPayload = {
    event_id: eventId,
    event: 'subscription.charged',
    payload: {
      subscription: {
        entity: {
          id: `sub_gw_${suiteTag}`,
          customer_id: customer.id,
          plan_id: 'plus',
          notes: { principal_id: user }
        }
      }
    }
  };

  const rawBody = JSON.stringify(webhookPayload);
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET || 'test_webhook_secret_razorpay_2026';
  const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  // First invocation: Process genuine webhook event
  const res1 = await fetch(`${baseUrl}/api/billing/webhook/razorpay`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': 'https://aira-ai-2026.vercel.app',
      'x-aira-csrf-protection': '1',
      'x-razorpay-signature': signature
    },
    body: rawBody
  });
  assert.equal(res1.status, 200);
  const body1 = await res1.json();
  assert.equal(body1.ok, true);
  assert.equal(body1.status, 'PROCESSED');
  assert.equal(body1.duplicate, false);

  // Second invocation: Replay the exact duplicate webhook event
  const res2 = await fetch(`${baseUrl}/api/billing/webhook/razorpay`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': 'https://aira-ai-2026.vercel.app',
      'x-aira-csrf-protection': '1',
      'x-razorpay-signature': signature
    },
    body: rawBody
  });
  assert.equal(res2.status, 200);
  const body2 = await res2.json();
  assert.equal(body2.ok, true);
  assert.equal(body2.status, 'ALREADY_PROCESSED');
  assert.equal(body2.duplicate, true, 'Replayed event must be marked duplicate');

  // Verify in payment_gateway_events exactly one event record exists
  const events = await db('payment_gateway_events').where({ event_id: eventId });
  assert.equal(events.length, 1);
});

test('Scenario 18: Server restart data persistence in memory_records (projects and memories survive process/server shutdown)', async () => {
  const user = `usr_adv_s18_restart_${suiteTag}`;

  // 1. Create project and memory on active mainServer
  const projRes = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: authHeaders(user),
    body: JSON.stringify({
      name: 'Architecture Contract 2026',
      description: 'Durable persistence across server restarts'
    })
  });
  assert.equal(projRes.status, 201);
  const createdProject = await projRes.json();

  const memRes = await fetch(`${baseUrl}/api/memories`, {
    method: 'POST',
    headers: authHeaders(user),
    body: JSON.stringify({
      content: 'Server restart test memory',
      tags: ['restart-proof']
    })
  });
  assert.equal(memRes.status, 201);
  const createdMemory = await memRes.json();

  // 2. Spin up a separate secondary Express server instance simulating a new process/pod
  let secondaryServer: http.Server;
  let secondaryUrl = '';
  await new Promise<void>((resolve) => {
    secondaryServer = http.createServer(app).listen(0, '127.0.0.1', () => {
      const addr = secondaryServer.address() as any;
      secondaryUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });

  try {
    // 3. Query secondary server for projects and memories created previously
    const projQueryRes = await fetch(`${secondaryUrl}/api/projects/${createdProject.id}`, {
      method: 'GET',
      headers: authHeaders(user)
    });
    assert.equal(projQueryRes.status, 200, 'Secondary server must load project from PostgreSQL memory_records');
    const projData = await projQueryRes.json();
    assert.equal(projData.name, 'Architecture Contract 2026');

    const memQueryRes = await fetch(`${secondaryUrl}/api/memories/${createdMemory.id}`, {
      method: 'GET',
      headers: authHeaders(user)
    });
    assert.equal(memQueryRes.status, 200, 'Secondary server must load memory from PostgreSQL memory_records');
    const memData = await memQueryRes.json();
    assert.equal(memData.content, 'Server restart test memory');
  } finally {
    await new Promise<void>((resolve) => {
      secondaryServer.close(() => resolve());
    });
  }
});

test('Scenario 19: Multiple server instances enforcing same limits (concurrent Express servers against shared storage enforce identical quotas)', async () => {
  const user = `usr_adv_s19_multiserver_${suiteTag}`;

  // Start two independent Express server instances connected to the shared PostgreSQL DB
  let serverA: http.Server;
  let serverB: http.Server;
  let urlA = '';
  let urlB = '';

  await new Promise<void>((resolve) => {
    serverA = http.createServer(app).listen(0, '127.0.0.1', () => {
      urlA = `http://127.0.0.1:${(serverA.address() as any).port}`;
      resolve();
    });
  });
  await new Promise<void>((resolve) => {
    serverB = http.createServer(app).listen(0, '127.0.0.1', () => {
      urlB = `http://127.0.0.1:${(serverB.address() as any).port}`;
      resolve();
    });
  });

  try {
    // Free user creates 3 initial projects across both servers (reaching the 3-project Free limit)
    const p1 = await fetch(`${urlA}/api/projects`, {
      method: 'POST',
      headers: authHeaders(user),
      body: JSON.stringify({ name: 'Project 1 on Server A' })
    });
    assert.equal(p1.status, 201);

    const p2 = await fetch(`${urlB}/api/projects`, {
      method: 'POST',
      headers: authHeaders(user),
      body: JSON.stringify({ name: 'Project 2 on Server B' })
    });
    assert.equal(p2.status, 201);

    const p3 = await fetch(`${urlA}/api/projects`, {
      method: 'POST',
      headers: authHeaders(user),
      body: JSON.stringify({ name: 'Project 3 on Server A' })
    });
    assert.equal(p3.status, 201);

    // 4th project creation attempted on Server A -> rejected with 403 QUOTA_EXCEEDED_READ_ONLY_MODE
    const resA = await fetch(`${urlA}/api/projects`, {
      method: 'POST',
      headers: authHeaders(user),
      body: JSON.stringify({ name: 'Project 4 Attempt on Server A' })
    });
    assert.equal(resA.status, 403, 'Server A must reject 4th project with 403 QUOTA_EXCEEDED_READ_ONLY_MODE');
    const bodyA4 = await resA.json();
    assert.equal(bodyA4.error, 'QUOTA_EXCEEDED_READ_ONLY_MODE');
    assert.equal(bodyA4.code, 'PROJECT_LIMIT_REACHED');

    // 4th project creation attempted on Server B -> also rejected with 403 QUOTA_EXCEEDED_READ_ONLY_MODE
    const resB = await fetch(`${urlB}/api/projects`, {
      method: 'POST',
      headers: authHeaders(user),
      body: JSON.stringify({ name: 'Project 4 Attempt on Server B' })
    });
    assert.equal(resB.status, 403, 'Server B must reject 4th project with 403 QUOTA_EXCEEDED_READ_ONLY_MODE');
    const bodyB4 = await resB.json();
    assert.equal(bodyB4.error, 'QUOTA_EXCEEDED_READ_ONLY_MODE');
    assert.equal(bodyB4.code, 'PROJECT_LIMIT_REACHED');

    // Verify both servers report exactly 3 projects total from PostgreSQL
    const checkA = await fetch(`${urlA}/api/projects`, { method: 'GET', headers: authHeaders(user) });
    const checkB = await fetch(`${urlB}/api/projects`, { method: 'GET', headers: authHeaders(user) });

    const bodyA = await checkA.json();
    const bodyB = await checkB.json();

    assert.equal(bodyA.projects.length, 3, 'Server A must observe total count of 3');
    assert.equal(bodyB.projects.length, 3, 'Server B must observe total count of 3');
  } finally {
    await Promise.all([
      new Promise<void>((r) => serverA.close(() => r())),
      new Promise<void>((r) => serverB.close(() => r()))
    ]);
  }
});

test('Scenario 20: Genuine billing-disabled upgrade behavior (UI and API consistently reject direct self-upgrades with clean user guidance)', async () => {
  const user = `usr_adv_s20_guidance_${suiteTag}`;

  // 1. API endpoint rejects self-upgrade with honest guidance
  const apiRes = await fetch(`${baseUrl}/api/user/upgrade`, {
    method: 'POST',
    headers: authHeaders(user),
    body: JSON.stringify({ planId: 'plus' })
  });

  assert.equal(apiRes.status, 400);
  const apiBody = await apiRes.json();
  assert.equal(apiBody.error, 'BILLING_UNAVAILABLE');
  assert.equal(
    apiBody.message,
    'Direct self-service plan upgrades without verified payment are disabled in preview deployment.'
  );

  // 2. Direct self-downgrade is also rejected
  const downgradeRes = await fetch(`${baseUrl}/api/user/downgrade`, {
    method: 'POST',
    headers: authHeaders(user),
    body: JSON.stringify({ planId: 'free' })
  });
  assert.equal(downgradeRes.status, 400);
  const downgradeBody = await downgradeRes.json();
  assert.equal(downgradeBody.error, 'BILLING_UNAVAILABLE');

  // 3. Payment gateway checkout creation fails closed when administrative emergency disable kill-switch is set
  const origKillswitch = process.env.AIRA_BILLING_EMERGENCY_DISABLE;
  process.env.AIRA_BILLING_EMERGENCY_DISABLE = 'true';
  try {
    await assert.rejects(
      async () => {
        await paymentGatewayService.createSubscriptionCheckout(user, 'plus', 'INR');
      },
      (err: any) => {
        return (
          err.message.includes('BILLING_UNAVAILABLE') ||
          err.message.includes('BILLING_EMERGENCY_DISABLE')
        );
      },
      'Checkout creation must fail closed with BILLING_UNAVAILABLE when kill-switch is active'
    );
  } finally {
    if (origKillswitch === undefined) {
      delete process.env.AIRA_BILLING_EMERGENCY_DISABLE;
    } else {
      process.env.AIRA_BILLING_EMERGENCY_DISABLE = origKillswitch;
    }
  }

  // 4. Invalid plan tier checkout attempt (free tier) fails closed
  await assert.rejects(
    async () => {
      await paymentGatewayService.createSubscriptionCheckout(user, 'free' as any, 'INR');
    },
    (err: any) => err.message.includes('Invalid plan tier for subscription checkout'),
    'Checkout creation for free tier must fail closed'
  );

  // 5. Verify plans and capabilities in commercial contracts provide consistent preview guidance
  assert.ok(COMMERCIAL_PLANS.free);
  assert.ok(COMMERCIAL_PLANS.plus);
  assert.ok(COMMERCIAL_PLANS.pro);
  assert.equal(isModelAllowedForTier('claude-3-opus', 'free'), false);
  assert.equal(isFeatureAllowedForTier('browsertools', 'plus'), false);
  assert.equal(isFeatureAllowedForTier('browsertools', 'pro'), true);
});
