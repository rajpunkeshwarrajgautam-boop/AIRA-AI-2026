import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, closeDb } from '../packages/db/src/index.js';
import {
  CommercialBillingService,
  InsufficientCreditsError,
  StandardQuotaExceededError
} from '../apps/api/src/billing/commercial-billing-service.js';

describe('Commercial Credit Ledger & Entitlements Engine', () => {
  const service = new CommercialBillingService();
  const testPrincipalId = `usr_test_${Date.now()}`;

  after(async () => {
    // Clean up test customer data
    const customer = await db('billing_customers').where({ principal_id: testPrincipalId }).first();
    if (customer) {
      await db('usage_events').where({ customer_id: customer.id }).delete();
      await db('entitlement_snapshots').where({ customer_id: customer.id }).delete();
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

  it('1. Initializes new customer with Free tier welcome allotment (100 credits)', async () => {
    const customer = await service.getOrCreateCustomer(testPrincipalId, 'test@virexa.com', 'Test User');
    assert.ok(customer.id);
    assert.equal(customer.principalId, testPrincipalId);

    const entitlements = await service.getEntitlements(testPrincipalId);
    assert.equal(entitlements.plan, 'free');
    assert.equal(entitlements.creditBalance, 100);
    assert.equal(entitlements.reservedCredits, 0);
    assert.equal(entitlements.availableCredits, 100);
    assert.equal(entitlements.dailyStandardChatLimit, 15);
    assert.equal(entitlements.monthlyStandardChatUnitsLimit, 150);
    assert.equal(entitlements.reasoningBoostsLimit, 5);
  });

  it('2. Atomically consumes standard chat and enforces daily ceiling', async () => {
    // Consume 14 units
    const step1 = await service.consumeStandardChat(testPrincipalId, 14);
    assert.equal(step1.remainingDaily, 1);

    // Consume 1 unit (reaches ceiling 15)
    const step2 = await service.consumeStandardChat(testPrincipalId, 1);
    assert.equal(step2.remainingDaily, 0);

    // 16th unit must throw StandardQuotaExceededError
    await assert.rejects(
      async () => {
        await service.consumeStandardChat(testPrincipalId, 1);
      },
      (err: any) => err instanceof StandardQuotaExceededError && err.reason === 'daily'
    );
  });

  it('3. Consumes complimentary reasoning boosts within monthly cap', async () => {
    // Consume up to 5 boosts
    for (let i = 0; i < 5; i++) {
      const consumed = await service.tryConsumeReasoningBoost(testPrincipalId);
      assert.equal(consumed, true);
    }
    // 6th boost should return false (exhausted)
    const extraBoost = await service.tryConsumeReasoningBoost(testPrincipalId);
    assert.equal(extraBoost, false);
  });

  it('4. Two-phase commit reservation hold and full settlement', async () => {
    // Current available credits: 100
    const hold = await service.reserveCredits(testPrincipalId, 40, 'vision_generate', 'ref_test_1');
    assert.ok(hold.reservationId);
    assert.equal(hold.amountCredits, 40);

    // Available credits should now be 60 (100 - 40 hold)
    const entDuringHold = await service.getEntitlements(testPrincipalId);
    assert.equal(entDuringHold.creditBalance, 100);
    assert.equal(entDuringHold.reservedCredits, 40);
    assert.equal(entDuringHold.availableCredits, 60);

    // Settle with actual cost 24 credits (Economy High 1 image)
    const settlement = await service.settleReservation(hold.reservationId, 24);
    assert.equal(settlement.settledAmount, 24);
    assert.equal(settlement.releasedAmount, 16);
    assert.equal(settlement.balanceAfter, 76);

    // After settlement, balance is 76, reserved is 0, available is 76
    const entAfter = await service.getEntitlements(testPrincipalId);
    assert.equal(entAfter.creditBalance, 76);
    assert.equal(entAfter.reservedCredits, 0);
    assert.equal(entAfter.availableCredits, 76);
  });

  it('5. Two-phase commit reservation hold and complete release on error', async () => {
    // Available credits: 76
    const hold = await service.reserveCredits(testPrincipalId, 50, 'builder_execution');
    assert.ok(hold.reservationId);

    const entDuringHold = await service.getEntitlements(testPrincipalId);
    assert.equal(entDuringHold.availableCredits, 26);

    // Abort and release hold
    const release = await service.releaseReservation(hold.reservationId, 'Sandbox timeout');
    assert.equal(release.releasedAmount, 50);

    const entAfterRelease = await service.getEntitlements(testPrincipalId);
    assert.equal(entAfterRelease.creditBalance, 76);
    assert.equal(entAfterRelease.reservedCredits, 0);
    assert.equal(entAfterRelease.availableCredits, 76);
  });

  it('6. Rejects requests exceeding available credits with InsufficientCreditsError', async () => {
    // Current available: 76 credits. Trying to reserve 100 credits must fail closed!
    await assert.rejects(
      async () => {
        await service.reserveCredits(testPrincipalId, 100, 'vision_generate');
      },
      (err: any) => err instanceof InsufficientCreditsError && err.availableCredits === 76
    );

    // Invariant: Balance unchanged
    const ent = await service.getEntitlements(testPrincipalId);
    assert.equal(ent.creditBalance, 76);
    assert.equal(ent.availableCredits, 76);
  });

  it('7. Concurrency & Race-condition safety: Prevents double spending across simultaneous requests', async () => {
    // Available credits: 76.
    // We launch TWO simultaneous promises both attempting to reserve 50 credits.
    // 50 + 50 = 100 > 76.
    // Exactly ONE promise must succeed, and ONE must fail with InsufficientCreditsError.
    // Under NO circumstance may both succeed or drive balance negative!
    const [p1, p2] = await Promise.allSettled([
      service.reserveCredits(testPrincipalId, 50, 'agent_step'),
      service.reserveCredits(testPrincipalId, 50, 'agent_step')
    ]);

    const successes = [p1, p2].filter(r => r.status === 'fulfilled');
    const failures = [p1, p2].filter(r => r.status === 'rejected');

    assert.equal(successes.length, 1, 'Exactly one concurrent reservation must succeed');
    assert.equal(failures.length, 1, 'Exactly one concurrent reservation must fail');

    const err = (failures[0] as PromiseRejectedResult).reason;
    assert.ok(err instanceof InsufficientCreditsError, 'Failed promise must be InsufficientCreditsError');

    // Clean up the winning reservation
    const winningRes = (successes[0] as PromiseFulfilledResult<any>).value;
    await service.releaseReservation(winningRes.reservationId, 'Test race cleanup');

    // Final balance invariant
    const finalEnt = await service.getEntitlements(testPrincipalId);
    assert.equal(finalEnt.creditBalance, 76);
    assert.equal(finalEnt.reservedCredits, 0);
    assert.equal(finalEnt.availableCredits, 76);
  });
});
