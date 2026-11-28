import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { db } from '../packages/db/src/index.js';
import { commercialBillingService } from '../apps/api/src/billing/commercial-billing-service.js';
import { paymentGatewayService } from '../apps/api/src/billing/payment-gateway-service.js';

describe('Phase 3 Financial Lifecycle Defect Reproduction & Remediation Suite (PG18)', () => {
  const prevCommercialBilling = process.env.AIRA_COMMERCIAL_BILLING_ENABLED;
  const prevNodeEnv = process.env.NODE_ENV;
  const createdPrincipals: string[] = [];
  const createdEvents: string[] = [];

  if (prevCommercialBilling !== 'true') {
    process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'true';
  }
  if (!prevNodeEnv) {
    process.env.NODE_ENV = 'test';
  }

  const uid = (tag: string) => {
    const id = `usr_p3_${tag}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    createdPrincipals.push(id);
    return id;
  };

  after(async () => {
    try {
      if (createdEvents.length > 0) {
        await db('payment_gateway_events').whereIn('event_id', createdEvents).delete().catch(() => {});
      }
      for (const p of createdPrincipals) {
        const cust = await db('billing_customers').where({ principal_id: p }).first().catch(() => null);
        if (cust) {
          await db('billing_credit_notes').where({ customer_id: cust.id }).delete().catch(() => {});
          await db('billing_invoices').where({ customer_id: cust.id }).delete().catch(() => {});
          await db('billing_audit_events').where({ customer_id: cust.id }).delete().catch(() => {});
          await db('subscription_cancellation_outbox').where({ customer_id: cust.id }).delete().catch(() => {});
          await db('billing_invoice_reconciliation_outbox').where({ customer_id: cust.id }).delete().catch(() => {});
          await db('idempotent_operations').where('principal_id', p).delete().catch(() => {});
          await db('subscriptions').where({ customer_id: cust.id }).delete().catch(() => {});
          const acct = await db('credit_accounts').where({ customer_id: cust.id }).first().catch(() => null);
          if (acct) {
            await db('credit_reservations').where({ account_id: acct.id }).delete().catch(() => {});
            await db('credit_transactions').where({ account_id: acct.id }).delete().catch(() => {});
            await db('credit_grants').where({ account_id: acct.id }).delete().catch(() => {});
          }
          await db('billing_customers').where({ id: cust.id }).delete().catch(() => {});
        }
      }
    } catch {}
    if (prevCommercialBilling === undefined) {
      delete process.env.AIRA_COMMERCIAL_BILLING_ENABLED;
    } else {
      process.env.AIRA_COMMERCIAL_BILLING_ENABLED = prevCommercialBilling;
    }
    if (prevNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = prevNodeEnv;
    }
  });

  it('D1: Free welcome grant is classified as grant_type "promotional" (not "subscription_monthly")', async () => {
    const p = uid('welcome_promo');
    const customer = await commercialBillingService.getOrCreateCustomer(p, `${p}@virexa.test`, 'Promo User');
    const acct = await db('credit_accounts').where({ customer_id: customer.id }).first();
    assert.ok(acct);
    const grants = await db('credit_grants').where({ account_id: acct.id });
    assert.equal(grants.length, 1);
    assert.equal(grants[0].grant_type, 'promotional', 'Welcome grant must be classified as promotional');
  });

  it('D2: Reservation held across grant expiry settles against expired held grant and sweeps released remainder without stealing paid credits', async () => {
    const p = uid('res_expiry');
    const customer = await commercialBillingService.getOrCreateCustomer(p, `${p}@virexa.test`, 'Res User');
    const acct = await db('credit_accounts').where({ customer_id: customer.id }).first();

    // Hold 80 of the 100 welcome credits before expiry
    const hold = await commercialBillingService.reserveCredits(p, 80, 'image_generate', `ref_${Date.now()}`);

    // Backdate welcome grant expiry into the past and grant a fresh 3,000 paid grant
    const now = Date.now();
    await db('credit_grants').where({ account_id: acct.id }).update({ expires_at: now - 5000 });
    const paidGrantRes = await commercialBillingService.grantCredits(
      p,
      3000,
      'subscription_monthly',
      now + 30 * 86400000,
      7500,
      { purchaseId: `pur_d2_${Date.now()}` }
    );

    // Trigger expiry sweep while 80 is still HELD -> 20 expires immediately, 80 stays reserved
    await commercialBillingService.getEntitlements(p);

    // Now settle only 30 out of the 80 held credits (50 should be released and expired!)
    await commercialBillingService.settleReservation(hold.reservationId, 30);

    const paidGrant = await db('credit_grants').where({ id: paidGrantRes.grantId }).first();
    const acctAfter = await db('credit_accounts').where({ id: acct.id }).first();
    assert.equal(Number(paidGrant.remaining_credits), 3000, 'Paid grant must NOT lose credits to expired reservation');
    assert.equal(Number(acctAfter.balance_credits), 3000, 'Expired remainder (50) must be swept cleanly after settleReservation');
    assert.equal(Number(acctAfter.reserved_credits), 0);
  });

  it('D3: Cycle 2+ renewal passes renewed period window to invoice issuance and updates subscription period cleanly', async () => {
    const p = uid('cycle2_period');
    const customer = await commercialBillingService.getOrCreateCustomer(p, `${p}@virexa.test`, 'Cycle2 User');
    const now = Date.now();
    const subId = `pur_c2_${Date.now()}`;
    const gwSubId = `sub_c2_${Date.now()}`;
    const c1Start = now - 30 * 86400000;
    const c1End = now - 1000;

    await db('subscriptions').insert({
      id: subId,
      customer_id: customer.id,
      plan_id: 'plus',
      price_id: 'price_plus_inr',
      status: 'active',
      gateway: 'razorpay',
      gateway_subscription_id: gwSubId,
      currency: 'INR',
      amount_minor_units: 39900,
      current_period_start: c1Start,
      current_period_end: c1End,
      cancel_at_period_end: false,
      metadata: JSON.stringify({
        principalId: p,
        customerId: customer.id,
        customerState: '09',
        fulfilledCycle: 1,
        initialPaymentId: `pay_c1_${Date.now()}`,
        lastPaymentId: `pay_c1_${Date.now()}`
      }),
      created_at: c1Start,
      updated_at: c1Start
    });

    const acct = await db('credit_accounts').where({ customer_id: customer.id }).first();
    await commercialBillingService.grantCredits(p, 3000, 'subscription_monthly', c1End, 7500, { purchaseId: subId });

    // Trigger Cycle 2 renewal webhook
    const secret = 'test_rzp_secret_p3_2026';
    paymentGatewayService.setRazorpaySecret(secret);
    process.env.RAZORPAY_WEBHOOK_SECRET = secret;
    const c2PayId = `pay_c2_${Date.now()}`;
    const c2EvId = `evt_c2_${Date.now()}`;
    createdEvents.push(c2EvId);

    const raw = JSON.stringify({
      event_id: c2EvId,
      event: 'subscription.charged',
      payload: {
        subscription: { entity: { id: gwSubId, paid_count: 2, status: 'active' } },
        payment: { entity: { id: c2PayId, amount: 39900, currency: 'INR', status: 'captured' } }
      }
    });
    const sig = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    const res = await paymentGatewayService.processRazorpayWebhook(raw, sig);
    assert.equal(res.status, 'PROCESSED');

    const c2Inv = await db('billing_invoices').where({ subscription_id: subId, cycle_number: 2 }).first();
    assert.ok(c2Inv, 'Cycle 2 invoice must be issued');
    const invMeta = typeof c2Inv.metadata === 'string' ? JSON.parse(c2Inv.metadata) : c2Inv.metadata;
    const recordedStart = Number(c2Inv.billing_period_start ?? invMeta?.billingPeriodStart ?? 0);
    assert.equal(recordedStart, c1End, 'Cycle 2 invoice must anchor billing_period_start to Cycle 1 current_period_end');
    assert.ok(acct);
  });

  it('D4: Late captured payment arriving after cancellation preserves out-of-band recovery evidence despite terminal rejection', async () => {
    const p = uid('late_cap_cancel');
    const customer = await commercialBillingService.getOrCreateCustomer(p, `${p}@virexa.test`, 'LateCap User');
    const now = Date.now();
    const subId = `pur_lc_${Date.now()}`;
    const gwSubId = `sub_lc_${Date.now()}`;

    await db('subscriptions').insert({
      id: subId,
      customer_id: customer.id,
      plan_id: 'pro',
      price_id: 'price_pro_inr',
      status: 'cancelled',
      gateway: 'razorpay',
      gateway_subscription_id: gwSubId,
      currency: 'INR',
      amount_minor_units: 99900,
      current_period_start: now - 5 * 86400000,
      current_period_end: now + 25 * 86400000,
      cancel_at_period_end: true,
      cancelled_at: now - 1000,
      metadata: JSON.stringify({
        principalId: p,
        customerId: customer.id,
        customerState: '09',
        fulfilledCycle: 1,
        cancellation_status: 'CANCELLATION_CONFIRMED',
        initialPaymentId: `pay_lc_1_${Date.now()}`,
        lastPaymentId: `pay_lc_1_${Date.now()}`
      }),
      created_at: now - 5 * 86400000,
      updated_at: now - 1000
    });

    const secret = 'test_rzp_secret_p3_2026';
    paymentGatewayService.setRazorpaySecret(secret);
    process.env.RAZORPAY_WEBHOOK_SECRET = secret;
    const latePayId = `pay_lc_late_${Date.now()}`;
    const evId = `evt_lc_${Date.now()}`;
    createdEvents.push(evId);

    const raw = JSON.stringify({
      event_id: evId,
      event: 'subscription.charged',
      payload: {
        subscription: { entity: { id: gwSubId, paid_count: 2, status: 'active' } },
        payment: { entity: { id: latePayId, amount: 99900, currency: 'INR', status: 'captured' } }
      }
    });
    const sig = crypto.createHmac('sha256', secret).update(raw).digest('hex');

    await assert.rejects(
      () => paymentGatewayService.processRazorpayWebhook(raw, sig),
      /INVALID_STATE_TRANSITION/
    );

    const subAfter = await db('subscriptions').where({ id: subId }).first();
    const metaAfter = typeof subAfter.metadata === 'string' ? JSON.parse(subAfter.metadata) : subAfter.metadata;
    assert.ok(metaAfter.latePaymentRecovery, 'Late captured payment recovery record must survive rollback');
    assert.equal(metaAfter.latePaymentRecovery.paymentId, latePayId);
    assert.equal(metaAfter.latePaymentRecovery.status, 'PENDING_RECOVERY_REFUND');

    const audit = await db('billing_audit_events')
      .where({ customer_id: customer.id, event_type: 'LATE_PAYMENT_ON_CANCELLED_SUBSCRIPTION' })
      .first();
    assert.ok(audit, 'Out-of-band LATE_PAYMENT_ON_CANCELLED_SUBSCRIPTION audit event must be persisted');
  });
});
