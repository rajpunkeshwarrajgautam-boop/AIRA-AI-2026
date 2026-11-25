import './setup-disposable-db.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { db, closeDb } from '../packages/db/src/index.js';
import {
  PaymentGatewayService,
  TerminalRejectionError,
  assertCommercialFulfillmentAllowed,
  SAFE_RECONCILIATION_EVENTS,
  PAID_FULFILLMENT_EVENTS
} from '../apps/api/src/billing/payment-gateway-service.js';

test.describe('Real PostgreSQL Payment-Integrity & Failure Scenarios Matrix (T1–T10)', () => {
  const origEnv = { ...process.env };
  const testSecret = 'whsec_postgres_test_secret_9988';
  let service: PaymentGatewayService;

  test.before(async () => {
    // Assert disposable database connectivity
    const res = await db.raw("SELECT current_database() AS db_name, version() AS version");
    const row = res.rows[0];
    assert.ok(row.version.toLowerCase().includes('postgresql'), 'Must connect to real PostgreSQL');
    assert.strictEqual(row.db_name, 'aira_test_db', 'Must connect to aira_test_db');

    service = new PaymentGatewayService();
    service.setRazorpaySecret(testSecret);
    service.setCashfreeSecret(testSecret);
  });

  async function cleanupTestData() {
    // Clean up test data in strict foreign-key dependency order
    try {
      if (await db.schema.hasTable('billing_credit_notes')) {
        await db('billing_credit_notes')
          .where('customer_id', 'like', 'cust_t%')
          .orWhere('subscription_id', 'like', 'sub_t%')
          .delete();
      }
    } catch {}

    try {
      if (await db.schema.hasTable('billing_invoices')) {
        await db('billing_invoices')
          .where('customer_id', 'like', 'cust_t%')
          .orWhere('subscription_id', 'like', 'sub_t%')
          .delete();
      }
    } catch {}

    await db('billing_audit_events').where('customer_id', 'like', 'cust_t%').delete();
    await db('idempotent_operations')
      .where('principal_id', 'like', 'usr_t%')
      .orWhere('principal_id', 'like', 'cust_t%')
      .orWhere('key', 'like', '%cust_t%')
      .orWhere('key', 'like', '%sub_t%')
      .orWhere('operation_id', 'like', '%t%')
      .delete();
    await db('credit_transactions').where('description', 'like', '%Credit Grant%').delete();
    await db('credit_transactions').where('account_id', 'like', 'acc_cust_t%').delete();
    await db('credit_grants').where('id', 'like', 'grant_%').delete();
    await db('subscriptions').where('id', 'like', 'sub_t%').delete();
    await db('credit_accounts').where('customer_id', 'like', 'cust_t%').delete();
    await db('billing_customers').where('id', 'like', 'cust_t%').delete();
    await db('payment_gateway_events')
      .where('event_id', 'like', 'evt_t%')
      .orWhere('id', 'like', 'pge_t%')
      .delete();
  }

  test.beforeEach(async () => {
    process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'true';
    process.env.NODE_ENV = 'test';
    delete process.env.VERCEL_ENV;
    await cleanupTestData();
  });

  test.afterEach(async () => {
    await cleanupTestData();
  });

  test.after(async () => {
    await cleanupTestData();
    process.env = { ...origEnv };
    await closeDb();
  });

  // Helper to create test customer, account, and purchase record in real PostgreSQL
  async function seedPurchase(options: {
    subId: string;
    gatewaySubId: string;
    customerId: string;
    principalId: string;
    planId: string;
    amountMinor: number;
    currency: string;
    status: 'created' | 'active' | 'cancelled';
    currentPeriodStart?: number;
    currentPeriodEnd?: number;
    meta?: any;
  }) {
    const now = Date.now();
    await db('billing_customers').insert({
      id: options.customerId,
      principal_id: options.principalId,
      email: `${options.principalId}@test.local`,
      name: 'Test Customer',
      created_at: now,
      updated_at: now
    }).onConflict('id').ignore();

    await db('credit_accounts').insert({
      id: `acc_${options.customerId}`,
      customer_id: options.customerId,
      balance_credits: 0,
      reserved_credits: 0,
      lifetime_granted_credits: 0,
      lifetime_spent_credits: 0,
      created_at: now,
      updated_at: now
    }).onConflict('id').ignore();

    await db('subscriptions').insert({
      id: options.subId,
      customer_id: options.customerId,
      plan_id: options.planId,
      price_id: `price_${options.planId}_${options.currency.toLowerCase()}`,
      status: options.status,
      gateway: 'razorpay',
      gateway_subscription_id: options.gatewaySubId,
      currency: options.currency,
      amount_minor_units: options.amountMinor,
      current_period_start: options.currentPeriodStart || now,
      current_period_end: options.currentPeriodEnd || (now + 30 * 86400000),
      cancel_at_period_end: false,
      metadata: JSON.stringify(options.meta || { principalId: options.principalId, customerId: options.customerId, tier: options.planId }),
      created_at: now,
      updated_at: now
    });
  }

  // T1: Same-event replay idempotency
  test('T1: Same-event replay idempotency in real PostgreSQL', async () => {
    const now = Date.now();
    const subId = 'sub_t1_001';
    const gwSubId = 'sub_gw_t1_001';
    const custId = 'cust_t1_001';
    const princId = 'usr_t1_001';

    await seedPurchase({
      subId,
      gatewaySubId: gwSubId,
      customerId: custId,
      principalId: princId,
      planId: 'plus',
      amountMinor: 39900,
      currency: 'INR',
      status: 'created'
    });

    const eventId = `evt_t1_${Date.now()}`;
    const payload = {
      event: 'subscription.charged',
      id: eventId,
      payload: {
        subscription: {
          entity: {
            id: gwSubId,
            current_start: Math.floor(now / 1000),
            current_end: Math.floor((now + 30 * 86400000) / 1000),
            paid_count: 1
          }
        },
        payment: {
          entity: {
            id: 'pay_t1_100',
            amount: 39900,
            currency: 'INR',
            status: 'captured'
          }
        }
      }
    };

    const rawBody = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', testSecret).update(rawBody).digest('hex');

    // 1. Initial delivery: PROCESSED
    const res1 = await service.processRazorpayWebhook(rawBody, signature);
    assert.strictEqual(res1.status, 'PROCESSED');
    assert.strictEqual(res1.duplicate, false);

    // Verify database state: subscription active, credit transaction created, event marked processed
    const subRecord = await db('subscriptions').where({ id: subId }).first();
    assert.strictEqual(subRecord.status, 'active');

    const eventRecord = await db('payment_gateway_events').where({ event_id: eventId }).first();
    assert.strictEqual(eventRecord.processed, true);
    assert.strictEqual(eventRecord.error, null);

    const txRows = await db('credit_transactions').where({ account_id: `acc_${custId}` });
    assert.strictEqual(txRows.length, 1, 'Exactly one credit transaction must be recorded');
    assert.strictEqual(txRows[0].amount_credits, 3000);

    // 2. Replay delivery: ALREADY_PROCESSED
    const res2 = await service.processRazorpayWebhook(rawBody, signature);
    assert.strictEqual(res2.status, 'ALREADY_PROCESSED');
    assert.strictEqual(res2.duplicate, true);

    // Verify no double-fulfillment in database
    const txRowsAfter = await db('credit_transactions').where({ account_id: `acc_${custId}` });
    assert.strictEqual(txRowsAfter.length, 1, 'Replay must not create duplicate credit transactions');
  });

  // T2: Cross-event duplicate / redelivery with different event ID
  test('T2: Cross-event duplicate prevention using idempotent_operations and payment ID', async () => {
    const now = Date.now();
    const subId = 'sub_t2_002';
    const gwSubId = 'sub_gw_t2_002';
    const custId = 'cust_t2_002';
    const princId = 'usr_t2_002';

    await seedPurchase({
      subId,
      gatewaySubId: gwSubId,
      customerId: custId,
      principalId: princId,
      planId: 'plus',
      amountMinor: 39900,
      currency: 'INR',
      status: 'created'
    });

    const paymentId = 'pay_t2_shared_999';

    // Event 1: order.paid with pay_t2_shared_999
    const payload1 = {
      event: 'order.paid',
      id: `evt_t2_first_${Date.now()}`,
      payload: {
        order: {
          entity: {
            id: gwSubId,
            amount: 39900,
            currency: 'INR'
          }
        },
        payment: {
          entity: {
            id: paymentId,
            order_id: gwSubId,
            amount: 39900,
            currency: 'INR',
            status: 'captured'
          }
        }
      }
    };
    const rawBody1 = JSON.stringify(payload1);
    const sig1 = crypto.createHmac('sha256', testSecret).update(rawBody1).digest('hex');

    const res1 = await service.processRazorpayWebhook(rawBody1, sig1);
    assert.strictEqual(res1.status, 'PROCESSED');

    // Event 2: payment.captured with different event ID but SAME payment ID pay_t2_shared_999
    const payload2 = {
      event: 'payment.captured',
      id: `evt_t2_second_${Date.now()}`,
      payload: {
        payment: {
          entity: {
            id: paymentId,
            order_id: gwSubId,
            amount: 39900,
            currency: 'INR',
            status: 'captured'
          }
        }
      }
    };
    const rawBody2 = JSON.stringify(payload2);
    const sig2 = crypto.createHmac('sha256', testSecret).update(rawBody2).digest('hex');

    const res2 = await service.processRazorpayWebhook(rawBody2, sig2);
    assert.strictEqual(res2.status, 'PROCESSED');

    // Verify credit transactions: still exactly 1 grant, no double fulfillment!
    const txRows = await db('credit_transactions').where({ account_id: `acc_${custId}` });
    assert.strictEqual(txRows.length, 1, 'Cross-event duplicate must not grant second credit allowance');

    // Verify idempotent_operations recorded the fulfillment
    const op = await db('idempotent_operations')
      .where({ principal_id: princId, operation_id: `razorpay:sub:${subId}:pay:${paymentId}` })
      .first();
    assert.ok(op, 'Fulfillment operation must be recorded in idempotent_operations table');
    assert.strictEqual(op.status, 'COMPLETED');
  });

  // T3: Missing billing period / renewal with missing end date & Insufficient evidence handling
  test('T3: Renewal with missing end date anchors strictly to previous period end; Insufficient evidence fails closed', async () => {
    const initialStart = Date.now() - 30 * 86400000;
    const initialEnd = Date.now(); // Period ends now
    const subId = 'sub_t3_003';
    const gwSubId = 'sub_gw_t3_003';
    const custId = 'cust_t3_003';
    const princId = 'usr_t3_003';

    await seedPurchase({
      subId,
      gatewaySubId: gwSubId,
      customerId: custId,
      principalId: princId,
      planId: 'plus',
      amountMinor: 39900,
      currency: 'INR',
      status: 'active',
      currentPeriodStart: initialStart,
      currentPeriodEnd: initialEnd,
      meta: { principalId: princId, customerId: custId, tier: 'plus', fulfilledCycle: 1, initialPaymentId: 'pay_t3_init' }
    });

    // Part A: Legitimate renewal with cycleNumber=2 and new payment ID, but MISSING current_end
    const renewalPayload = {
      event: 'subscription.charged',
      id: `evt_t3_renew_${Date.now()}`,
      payload: {
        subscription: {
          entity: {
            id: gwSubId,
            paid_count: 2
            // Note: current_end is deliberately omitted!
          }
        },
        payment: {
          entity: {
            id: 'pay_t3_renew_cycle_2',
            amount: 39900,
            currency: 'INR',
            status: 'captured'
          }
        }
      }
    };
    const rawRenewal = JSON.stringify(renewalPayload);
    const sigRenewal = crypto.createHmac('sha256', testSecret).update(rawRenewal).digest('hex');

    const resRenewal = await service.processRazorpayWebhook(rawRenewal, sigRenewal);
    assert.strictEqual(resRenewal.status, 'PROCESSED');

    // Verify that current_period_end was anchored to initialEnd + 30 days (NOT Date.now() + 30 days)
    const updatedSub = await db('subscriptions').where({ id: subId }).first();
    assert.strictEqual(Number(updatedSub.current_period_end), initialEnd + 30 * 86400000);
    assert.strictEqual(Number(updatedSub.current_period_start), initialEnd);

    // Part B: Active subscription with an event claiming renewal (subscription.renewed) but ZERO evidence
    const unevidencedPayload = {
      event: 'subscription.renewed',
      id: `evt_t3_fake_${Date.now()}`,
      payload: {
        subscription: {
          entity: {
            id: gwSubId,
            currency: 'INR',
            amount: 39900
            // No current_end, no paid_count, no payment entity, no payment ID
          }
        }
      }
    };
    const rawUnevidenced = JSON.stringify(unevidencedPayload);
    const sigUnevidenced = crypto.createHmac('sha256', testSecret).update(rawUnevidenced).digest('hex');

    await assert.rejects(
      async () => {
        await service.processRazorpayWebhook(rawUnevidenced, sigUnevidenced);
      },
      (err: any) => {
        assert.ok(err instanceof TerminalRejectionError);
        assert.match(err.message, /Subscription renewal event lacks authoritative cycle or payment evidence/);
        return true;
      }
    );
  });

  // T4: Crash after business commit simulation (atomic processed commit inside trx)
  test('T4: Atomic processed commit inside trx guarantees immediate ALREADY_PROCESSED on gateway redelivery', async () => {
    const now = Date.now();
    const subId = 'sub_t4_004';
    const gwSubId = 'sub_gw_t4_004';
    const custId = 'cust_t4_004';
    const princId = 'usr_t4_004';

    await seedPurchase({
      subId,
      gatewaySubId: gwSubId,
      customerId: custId,
      principalId: princId,
      planId: 'pro',
      amountMinor: 79900,
      currency: 'INR',
      status: 'created'
    });

    const eventId = `evt_t4_${Date.now()}`;
    const payload = {
      event: 'subscription.charged',
      id: eventId,
      payload: {
        subscription: {
          entity: {
            id: gwSubId,
            current_start: Math.floor(now / 1000),
            current_end: Math.floor((now + 30 * 86400000) / 1000),
            paid_count: 1
          }
        },
        payment: {
          entity: {
            id: 'pay_t4_400',
            amount: 79900,
            currency: 'INR',
            status: 'captured'
          }
        }
      }
    };
    const rawBody = JSON.stringify(payload);
    const sig = crypto.createHmac('sha256', testSecret).update(rawBody).digest('hex');

    // Execute first webhook
    const res1 = await service.processRazorpayWebhook(rawBody, sig);
    assert.strictEqual(res1.status, 'PROCESSED');

    // Inspect database: payment_gateway_events.processed MUST be true
    const ev = await db('payment_gateway_events').where({ event_id: eventId }).first();
    assert.strictEqual(ev.processed, true);

    // Gateway redelivery simulates crash right after DB commit
    const res2 = await service.processRazorpayWebhook(rawBody, sig);
    assert.strictEqual(res2.status, 'ALREADY_PROCESSED');
    assert.strictEqual(res2.duplicate, true);

    // Verify credits were granted exactly once
    const txs = await db('credit_transactions').where({ account_id: `acc_${custId}` });
    assert.strictEqual(txs.length, 1);
    assert.strictEqual(txs[0].amount_credits, 7500); // Pro plan
  });

  // T5: Crash before commit rollback (atomic rollback of partial state)
  test('T5: Failure during fulfillment rolls back business transaction completely and durably records error', async () => {
    const subId = 'sub_t5_005';
    const gwSubId = 'sub_gw_t5_005';
    const custId = 'cust_t5_005';
    const princId = 'usr_t5_005';

    await seedPurchase({
      subId,
      gatewaySubId: gwSubId,
      customerId: custId,
      principalId: princId,
      planId: 'plus',
      amountMinor: 39900,
      currency: 'INR',
      status: 'created'
    });

    const eventId = `evt_t5_${Date.now()}`;
    // Send payload with mismatched amount (fraud check trigger)
    const payload = {
      event: 'subscription.charged',
      id: eventId,
      payload: {
        subscription: {
          entity: {
            id: gwSubId
          }
        },
        payment: {
          entity: {
            id: 'pay_t5_500',
            amount: 100, // Expected 39900!
            currency: 'INR',
            status: 'captured'
          }
        }
      }
    };
    const rawBody = JSON.stringify(payload);
    const sig = crypto.createHmac('sha256', testSecret).update(rawBody).digest('hex');

    await assert.rejects(
      async () => {
        await service.processRazorpayWebhook(rawBody, sig);
      },
      /FRAUD_CHECK_FAILED: Amount mismatch/
    );

    // Verify business state was NOT touched
    const subRecord = await db('subscriptions').where({ id: subId }).first();
    assert.strictEqual(subRecord.status, 'created', 'Subscription status must NOT change on rollback');

    const txs = await db('credit_transactions').where({ account_id: `acc_${custId}` });
    assert.strictEqual(txs.length, 0, 'No credit transactions must be recorded on rollback');

    // Verify durable failure state was recorded in payment_gateway_events
    const ev = await db('payment_gateway_events').where({ event_id: eventId }).first();
    assert.ok(ev);
    assert.strictEqual(ev.processed, false);
    assert.match(ev.error, /TERMINAL_FAILURE/);
  });

  // T6: Concurrency lease expiry / worker race
  test('T6: Concurrency lease prevents simultaneous worker processing; expired lease permits takeover', async () => {
    const now = Date.now();
    const eventId = `evt_t6_${Date.now()}`;

    // Insert an in-progress event representing Worker A
    await db('payment_gateway_events').insert({
      id: `pge_t6_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      gateway: 'razorpay',
      event_id: eventId,
      event_type: 'subscription.charged',
      signature_valid: true,
      processed: false,
      error: 'PROCESSING',
      payload: JSON.stringify({
        _lifecycle: { state: 'PROCESSING', attempts: 1, lastAttemptAt: now }
      }),
      created_at: now
    });

    const rawBody = JSON.stringify({
      event: 'subscription.charged',
      id: eventId
    });
    const sig = crypto.createHmac('sha256', testSecret).update(rawBody).digest('hex');

    // Worker B attempts within 30s lease: CONCURRENTLY_PROCESSING
    const resB = await service.processRazorpayWebhook(rawBody, sig);
    assert.strictEqual(resB.status, 'CONCURRENTLY_PROCESSING');
    assert.strictEqual(resB.duplicate, true);

    // Simulate Worker A crashing and lease expiring (> 30s)
    await db('payment_gateway_events').where({ event_id: eventId }).update({
      payload: JSON.stringify({
        _lifecycle: { state: 'PROCESSING', attempts: 1, lastAttemptAt: now - 35000 }
      })
    });

    // Seed a valid subscription for Worker C
    const subId = 'sub_t6_006';
    const gwSubId = 'sub_gw_t6_006';
    const custId = 'cust_t6_006';
    const princId = 'usr_t6_006';
    await seedPurchase({
      subId,
      gatewaySubId: gwSubId,
      customerId: custId,
      principalId: princId,
      planId: 'plus',
      amountMinor: 39900,
      currency: 'INR',
      status: 'created'
    });

    const validPayload = {
      event: 'subscription.charged',
      id: eventId,
      payload: {
        subscription: {
          entity: {
            id: gwSubId,
            current_start: Math.floor(now / 1000),
            current_end: Math.floor((now + 30 * 86400000) / 1000),
            paid_count: 1
          }
        },
        payment: {
          entity: {
            id: 'pay_t6_600',
            amount: 39900,
            currency: 'INR',
            status: 'captured'
          }
        }
      }
    };
    const rawValid = JSON.stringify(validPayload);
    const sigValid = crypto.createHmac('sha256', testSecret).update(rawValid).digest('hex');

    // Worker C can now acquire and fulfill the expired lease
    const resC = await service.processRazorpayWebhook(rawValid, sigValid);
    assert.strictEqual(resC.status, 'PROCESSED');
    assert.strictEqual(resC.duplicate, false);
  });

  // T7: Out-of-order events (cancellation before charge)
  test('T7: Out-of-order charge arriving after cancellation is terminally rejected (INVALID_STATE_TRANSITION)', async () => {
    const now = Date.now();
    const subId = 'sub_t7_007';
    const gwSubId = 'sub_gw_t7_007';
    const custId = 'cust_t7_007';
    const princId = 'usr_t7_007';

    await seedPurchase({
      subId,
      gatewaySubId: gwSubId,
      customerId: custId,
      principalId: princId,
      planId: 'plus',
      amountMinor: 39900,
      currency: 'INR',
      status: 'active'
    });

    // 1. Process subscription.cancelled
    const cancelPayload = {
      event: 'subscription.cancelled',
      id: `evt_t7_cancel_${Date.now()}`,
      payload: {
        subscription: {
          entity: {
            id: gwSubId
          }
        }
      }
    };
    const rawCancel = JSON.stringify(cancelPayload);
    const sigCancel = crypto.createHmac('sha256', testSecret).update(rawCancel).digest('hex');

    const resCancel = await service.processRazorpayWebhook(rawCancel, sigCancel);
    assert.strictEqual(resCancel.status, 'PROCESSED');

    const cancelledSub = await db('subscriptions').where({ id: subId }).first();
    assert.strictEqual(cancelledSub.status, 'cancelled');

    // 2. Delayed subscription.charged arrives AFTER cancellation
    const chargePayload = {
      event: 'subscription.charged',
      id: `evt_t7_delayed_${Date.now()}`,
      payload: {
        subscription: {
          entity: {
            id: gwSubId,
            paid_count: 2
          }
        },
        payment: {
          entity: {
            id: 'pay_t7_delayed',
            amount: 39900,
            currency: 'INR',
            status: 'captured'
          }
        }
      }
    };
    const rawCharge = JSON.stringify(chargePayload);
    const sigCharge = crypto.createHmac('sha256', testSecret).update(rawCharge).digest('hex');

    await assert.rejects(
      async () => {
        await service.processRazorpayWebhook(rawCharge, sigCharge);
      },
      (err: any) => {
        assert.ok(err instanceof TerminalRejectionError);
        assert.match(err.message, /INVALID_STATE_TRANSITION: Cannot activate or renew cancelled subscription/);
        return true;
      }
    );

    // Verify subscription remains cancelled
    const subCheck = await db('subscriptions').where({ id: subId }).first();
    assert.strictEqual(subCheck.status, 'cancelled');
  });

  // T8: Financial mismatch (tampered currency and amount)
  test('T8: Tampered currency and non-integer amount are rejected with FRAUD_CHECK_FAILED', async () => {
    const subId = 'sub_t8_008';
    const gwSubId = 'sub_gw_t8_008';
    const custId = 'cust_t8_008';
    const princId = 'usr_t8_008';

    await seedPurchase({
      subId,
      gatewaySubId: gwSubId,
      customerId: custId,
      principalId: princId,
      planId: 'plus',
      amountMinor: 39900,
      currency: 'INR',
      status: 'created'
    });

    // Mismatched currency (USD instead of INR)
    const currencyPayload = {
      event: 'subscription.charged',
      id: `evt_t8_curr_${Date.now()}`,
      payload: {
        subscription: { entity: { id: gwSubId } },
        payment: { entity: { id: 'pay_t8_usd', amount: 39900, currency: 'USD', status: 'captured' } }
      }
    };
    const rawCurr = JSON.stringify(currencyPayload);
    const sigCurr = crypto.createHmac('sha256', testSecret).update(rawCurr).digest('hex');

    await assert.rejects(
      async () => { await service.processRazorpayWebhook(rawCurr, sigCurr); },
      /FRAUD_CHECK_FAILED: Currency mismatch/
    );

    // Non-integer amount
    const nonIntPayload = {
      event: 'subscription.charged',
      id: `evt_t8_float_${Date.now()}`,
      payload: {
        subscription: { entity: { id: gwSubId } },
        payment: { entity: { id: 'pay_t8_float', amount: 399.50, currency: 'INR', status: 'captured' } }
      }
    };
    const rawFloat = JSON.stringify(nonIntPayload);
    const sigFloat = crypto.createHmac('sha256', testSecret).update(rawFloat).digest('hex');

    await assert.rejects(
      async () => { await service.processRazorpayWebhook(rawFloat, sigFloat); },
      /FRAUD_CHECK_FAILED: Received invalid or non-integer minor-unit payment amount/
    );
  });

  // T9: Temporary failure recovery (retryable failure allows subsequent success)
  test('T9: Transient failure records RETRYABLE_FAILURE and allows recovery on retry', async () => {
    const now = Date.now();
    const eventId = `evt_t9_${Date.now()}`;

    // Record an event with a RETRYABLE_FAILURE (e.g. transient DB connection glitch)
    await db('payment_gateway_events').insert({
      id: `pge_t9_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      gateway: 'razorpay',
      event_id: eventId,
      event_type: 'subscription.charged',
      signature_valid: true,
      processed: false,
      error: 'RETRYABLE_FAILURE: Connection reset by peer',
      payload: JSON.stringify({
        _lifecycle: { state: 'RETRYABLE_FAILURE', attempts: 1, lastAttemptAt: now - 5000 }
      }),
      created_at: now
    });

    const subId = 'sub_t9_009';
    const gwSubId = 'sub_gw_t9_009';
    const custId = 'cust_t9_009';
    const princId = 'usr_t9_009';
    await seedPurchase({
      subId,
      gatewaySubId: gwSubId,
      customerId: custId,
      principalId: princId,
      planId: 'plus',
      amountMinor: 39900,
      currency: 'INR',
      status: 'created'
    });

    const validPayload = {
      event: 'subscription.charged',
      id: eventId,
      payload: {
        subscription: {
          entity: {
            id: gwSubId,
            current_start: Math.floor(now / 1000),
            current_end: Math.floor((now + 30 * 86400000) / 1000),
            paid_count: 1
          }
        },
        payment: {
          entity: {
            id: 'pay_t9_recovered',
            amount: 39900,
            currency: 'INR',
            status: 'captured'
          }
        }
      }
    };
    const rawBody = JSON.stringify(validPayload);
    const sig = crypto.createHmac('sha256', testSecret).update(rawBody).digest('hex');

    // Retry must succeed and clear the error
    const res = await service.processRazorpayWebhook(rawBody, sig);
    assert.strictEqual(res.status, 'PROCESSED');
    assert.strictEqual(res.duplicate, false);

    const ev = await db('payment_gateway_events').where({ event_id: eventId }).first();
    assert.strictEqual(ev.processed, true);
    assert.strictEqual(ev.error, null);
  });

  // T10: Commercial kill switch (fails closed on paid fulfillment, allows safe reconciliation)
  test('T10: Commercial kill switch rejects paid fulfillment fail-closed and allows safe reconciliation', async () => {
    process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'false';
    process.env.NODE_ENV = 'production';

    // 1. Paid fulfillment is rejected with BILLING_UNAVAILABLE
    for (const event of PAID_FULFILLMENT_EVENTS) {
      assert.throws(
        () => assertCommercialFulfillmentAllowed(event, 'razorpay', {}),
        /BILLING_UNAVAILABLE/
      );
    }

    // 2. Safe reconciliation events are allowed
    for (const event of SAFE_RECONCILIATION_EVENTS) {
      assert.doesNotThrow(
        () => assertCommercialFulfillmentAllowed(event, 'razorpay', {})
      );
    }
  });

  // T11: Dependency-safe fixture cleanup under strict PostgreSQL foreign keys
  test('T11: Regression — Subscriptions referenced by billing_invoices and billing_credit_notes are cleanly removable via dependency-safe cleanup without FK violation', async () => {
    const custId = 'cust_t11_fk';
    const princId = 'usr_t11_fk';
    const subId = 'sub_t11_fk';
    const now = Date.now();

    await seedPurchase({
      subId,
      gatewaySubId: 'sub_gw_t11_fk',
      customerId: custId,
      principalId: princId,
      planId: 'plus',
      amountMinor: 39900,
      currency: 'INR',
      status: 'active'
    });

    // Insert an invoice referencing subscription
    const hasInvTable = await db.schema.hasTable('billing_invoices');
    if (hasInvTable) {
      await db('billing_invoices').insert({
        id: 'inv_t11_fk_001',
        invoice_number: `INV-2026-T11-${Date.now()}`,
        customer_id: custId,
        subscription_id: subId,
        cycle_number: 1,
        billing_event_id: `evt_t11_fk_inv_${Date.now()}`,
        plan_tier: 'plus',
        currency: 'INR',
        total_amount: 399.00,
        taxable_base: 338.14,
        gst_amount: 60.86,
        sac_code: '998431',
        supplier_name: 'Virexa AI Ventures Private Limited',
        tax_compliance_status: 'TAX_INVOICE_ISSUED',
        place_of_supply: '07',
        status: 'Paid',
        gateway: 'razorpay',
        pdf_download_available: false,
        created_at: now,
        updated_at: now
      });

      // Insert a credit note referencing both invoice and subscription
      const hasCnTable = await db.schema.hasTable('billing_credit_notes');
      if (hasCnTable) {
        await db('billing_credit_notes').insert({
          id: 'cn_t11_fk_001',
          credit_note_number: `CN-2026-T11-${Date.now()}`,
          original_invoice_number: 'inv_t11_fk_001',
          customer_id: custId,
          subscription_id: subId,
          refund_id: `rfnd_t11_fk_${Date.now()}`,
          refund_amount: 399.00,
          currency: 'INR',
          is_partial_refund: false,
          supplier_name: 'Virexa AI Ventures Private Limited',
          status: 'Refunded',
          gateway: 'razorpay',
          created_at: now,
          updated_at: now
        });
      }

      // Proving PostgreSQL FK RESTRICT: deleting subscription directly MUST throw foreign key violation
      await assert.rejects(
        async () => {
          await db('subscriptions').where({ id: subId }).delete();
        },
        (err: any) => {
          return err.code === '23503' || err.code === '23001' || String(err.message).includes('foreign key constraint');
        },
        'Direct deletion of subscription referenced by billing_invoices must fail closed via PostgreSQL foreign key'
      );
    }

    // Now run dependency-safe cleanup: must succeed without error
    await cleanupTestData();

    // Verify all rows were cleanly removed
    const remainingSub = await db('subscriptions').where({ id: subId }).first();
    assert.strictEqual(remainingSub, undefined, 'Subscription must be cleanly deleted');
    if (hasInvTable) {
      const remainingInv = await db('billing_invoices').where({ id: 'inv_t11_fk_001' }).first();
      assert.strictEqual(remainingInv, undefined, 'Invoice must be cleanly deleted');
    }
  });
});
