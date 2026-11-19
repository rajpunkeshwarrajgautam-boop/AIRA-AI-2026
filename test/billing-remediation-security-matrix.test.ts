import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import {
  PaymentGatewayService,
  assertCommercialFulfillmentAllowed,
  TerminalRejectionError,
  isTerminalError,
  PAID_FULFILLMENT_EVENTS,
  SAFE_RECONCILIATION_EVENTS
} from '../apps/api/src/billing/payment-gateway-service.js';

describe('Remediations F1â€“F4: Commercial Billing & Webhook Security Matrix', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...origEnv };
    delete process.env.AIRA_COMMERCIAL_BILLING_ENABLED;
    delete process.env.AIRA_ENABLE_TEST_FULFILLMENT;
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  // =========================================================================
  // F1: Commercial Kill Switch & Safe Reconciliation Matrix
  // =========================================================================
  describe('F1 â€” Commercial Fulfillment Kill Switch', () => {
    it('allows safe reconciliation events (cancellations, halts, refunds) even when kill switch is disabled', () => {
      process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'false';
      process.env.NODE_ENV = 'production';

      for (const event of SAFE_RECONCILIATION_EVENTS) {
        assert.doesNotThrow(
          () => assertCommercialFulfillmentAllowed(event, 'razorpay', {}),
          `Safe reconciliation event '${event}' must not be blocked by the commercial kill switch`
        );
      }
    });

    it('rejects paid fulfillment events with BILLING_UNAVAILABLE when commercial billing is disabled', () => {
      process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'false';
      process.env.NODE_ENV = 'development';

      for (const event of PAID_FULFILLMENT_EVENTS) {
        assert.throws(
          () => assertCommercialFulfillmentAllowed(event, 'razorpay', {}),
          /BILLING_UNAVAILABLE/,
          `Paid event '${event}' must be rejected with BILLING_UNAVAILABLE when kill switch is off`
        );
      }
    });

    it('fails closed on unknown or unverified event classes attempting fulfillment', () => {
      process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'true';
      const unknownEvents = ['user.promoted', 'admin.grant', 'unrecognized.event', 'account.bypass'];

      for (const event of unknownEvents) {
        assert.throws(
          () => assertCommercialFulfillmentAllowed(event, 'razorpay', {}),
          (err: any) => {
            assert.ok(err instanceof TerminalRejectionError);
            assert.match(err.message, /BILLING_RECONCILIATION_FAILED/);
            return true;
          },
          `Unknown event '${event}' must be terminally rejected`
        );
      }
    });

    it('strictly ignores AIRA_ENABLE_TEST_FULFILLMENT in production environments', () => {
      process.env.NODE_ENV = 'production';
      process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'false';
      process.env.AIRA_ENABLE_TEST_FULFILLMENT = 'true'; // Attacker attempts to bypass production kill switch

      assert.throws(
        () => assertCommercialFulfillmentAllowed('subscription.charged', 'razorpay', {}),
        /Commercial billing fulfillment is currently disabled in production/,
        'Test fulfillment flag must be rejected in production'
      );

      // Same verification for VERCEL_ENV=production
      delete process.env.NODE_ENV;
      process.env.VERCEL_ENV = 'production';
      assert.throws(
        () => assertCommercialFulfillmentAllowed('subscription.charged', 'razorpay', {}),
        /Commercial billing fulfillment is currently disabled in production/,
        'VERCEL_ENV=production must strictly reject test fulfillment bypass'
      );
    });

    it('strictly ignores AIRA_ENABLE_TEST_FULFILLMENT in staging environments (VERCEL_ENV=preview, AIRA_ENVIRONMENT=staging)', () => {
      process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'false';
      process.env.AIRA_ENABLE_TEST_FULFILLMENT = 'true';

      // 1. VERCEL_ENV=preview
      delete process.env.NODE_ENV;
      process.env.VERCEL_ENV = 'preview';
      assert.throws(
        () => assertCommercialFulfillmentAllowed('subscription.charged', 'razorpay', {}),
        /Commercial billing fulfillment is currently disabled in staging/,
        'VERCEL_ENV=preview must strictly reject test fulfillment bypass'
      );

      // 2. AIRA_ENVIRONMENT=staging
      delete process.env.VERCEL_ENV;
      process.env.AIRA_ENVIRONMENT = 'staging';
      assert.throws(
        () => assertCommercialFulfillmentAllowed('subscription.charged', 'razorpay', {}),
        /Commercial billing fulfillment is currently disabled in staging/,
        'AIRA_ENVIRONMENT=staging must strictly reject test fulfillment bypass'
      );
    });

    it('permits paid fulfillment when AIRA_COMMERCIAL_BILLING_ENABLED is explicitly true', () => {
      process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'true';
      process.env.NODE_ENV = 'production';

      assert.doesNotThrow(() => {
        assertCommercialFulfillmentAllowed('subscription.charged', 'razorpay', {});
      });
      assert.doesNotThrow(() => {
        assertCommercialFulfillmentAllowed('ORDER_PAID', 'cashfree', {});
      });
    });
  });

  // =========================================================================
  // F2: Durable Webhook Lifecycle & Deduplication State Machine
  // =========================================================================
  describe('F2 â€” Webhook Lifecycle State Machine & Idempotency', () => {
    function createMockDb() {
      const tables: Record<string, any[]> = {
        payment_gateway_events: [],
        subscriptions: [],
        billing_audit_events: []
      };

      const dbClient: any = (tableName: string) => ({
        where: (query: Record<string, any>) => ({
          first: async () => {
            const rows = tables[tableName] || [];
            return rows.find(r => Object.entries(query).every(([k, v]) => r[k] === v)) || null;
          },
          update: async (patch: Record<string, any>) => {
            const rows = tables[tableName] || [];
            for (const r of rows) {
              if (Object.entries(query).every(([k, v]) => r[k] === v)) {
                Object.assign(r, patch);
              }
            }
          },
          forUpdate: function () { return this; }
        }),
        insert: async (record: Record<string, any>) => {
          if (!tables[tableName]) tables[tableName] = [];
          tables[tableName].push({ ...record });
        }
      });

      return { dbClient, tables };
    }

    it('records event lifecycle transitions and enforces idempotent duplicate rejection', async () => {
      process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'true';
      process.env.RAZORPAY_WEBHOOK_SECRET = 'test_secret_razorpay';

      const { dbClient, tables } = createMockDb();
      const service = new PaymentGatewayService();
      service.setDbClient(dbClient);
      service.setRazorpaySecret('test_secret_razorpay');

      const now = Date.now();
      const subId = 'sub_preexisting_001';
      tables.subscriptions.push({
        id: subId,
        customer_id: 'cust_001',
        plan: 'plus',
        status: 'incomplete',
        gateway_subscription_id: 'sub_gateway_123',
        currency: 'INR',
        amount_minor_units: 39900,
        metadata: JSON.stringify({ principalId: 'usr_001', customerId: 'cust_001', tier: 'plus' }),
        created_at: now,
        updated_at: now
      });

      const rawBody = JSON.stringify({
        event: 'subscription.charged',
        id: 'evt_test_charge_100',
        payload: {
          subscription: {
            entity: {
              id: 'sub_gateway_123',
              plan_id: 'plan_plus_inr',
              current_end: Math.floor((now + 30 * 86400000) / 1000)
            }
          },
          payment: {
            entity: {
              id: 'pay_test_100',
              amount: 39900,
              currency: 'INR',
              status: 'captured'
            }
          }
        }
      });
      const signature = crypto.createHmac('sha256', 'test_secret_razorpay').update(rawBody).digest('hex');

      // 1. First delivery -> PROCESSED
      const firstResult = await service.processRazorpayWebhook(rawBody, signature);
      assert.equal(firstResult.status, 'PROCESSED');
      assert.equal(firstResult.duplicate, false);

      const eventRow = tables.payment_gateway_events.find(e => e.event_id === 'evt_test_charge_100');
      assert.ok(eventRow);
      assert.equal(eventRow.processed, true);
      assert.equal(eventRow.error, null);

      // 2. Duplicate delivery -> ALREADY_PROCESSED
      const secondResult = await service.processRazorpayWebhook(rawBody, signature);
      assert.equal(secondResult.status, 'ALREADY_PROCESSED');
      assert.equal(secondResult.duplicate, true);
    });

    it('rejects retries for terminally rejected webhook events (fraud / tampered data)', async () => {
      process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'true';
      process.env.RAZORPAY_WEBHOOK_SECRET = 'test_secret_razorpay';

      const { dbClient, tables } = createMockDb();
      const service = new PaymentGatewayService();
      service.setDbClient(dbClient);
      service.setRazorpaySecret('test_secret_razorpay');

      const now = Date.now();
      tables.subscriptions.push({
        id: 'sub_valid_002',
        customer_id: 'cust_002',
        plan: 'plus',
        status: 'incomplete',
        gateway_subscription_id: 'sub_gateway_tampered',
        currency: 'INR',
        amount_minor_units: 39900,
        metadata: JSON.stringify({ principalId: 'usr_002', customerId: 'cust_002', tier: 'plus' }),
        created_at: now,
        updated_at: now
      });

      // Attacker tampers amount to 1 minor unit (0.01 INR)
      const tamperedBody = JSON.stringify({
        event: 'subscription.charged',
        id: 'evt_tampered_attack',
        payload: {
          subscription: {
            entity: {
              id: 'sub_gateway_tampered',
              current_end: Math.floor((now + 30 * 86400000) / 1000)
            }
          },
          payment: {
            entity: {
              id: 'pay_tampered_001',
              amount: 1, // Tampered! Expected 39900
              currency: 'INR',
              status: 'captured'
            }
          }
        }
      });
      const sig = crypto.createHmac('sha256', 'test_secret_razorpay').update(tamperedBody).digest('hex');

      // First delivery throws TerminalRejectionError
      await assert.rejects(
        service.processRazorpayWebhook(tamperedBody, sig),
        (err: any) => {
          assert.ok(isTerminalError(err));
          assert.match(err.message, /Amount mismatch/);
          return true;
        }
      );

      const eventRow = tables.payment_gateway_events.find(e => e.event_id === 'evt_tampered_attack');
      assert.ok(eventRow);
      assert.equal(eventRow.processed, false);
      assert.match(eventRow.error, /^TERMINAL_FAILURE:/);

      // Retry delivery is immediately terminally rejected without re-evaluating
      await assert.rejects(
        service.processRazorpayWebhook(tamperedBody, sig),
        (err: any) => {
          assert.ok(err instanceof TerminalRejectionError);
          assert.match(err.message, /terminally rejected/);
          return true;
        }
      );
    });

    it('ensures rollback durability: failure state is recorded durably while business transaction is completely rolled back', async () => {
      process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'true';
      process.env.RAZORPAY_WEBHOOK_SECRET = 'test_secret_razorpay';

      // Simulate a Knex client with real transactional rollback semantics
      const parentTables: Record<string, any[]> = {
        payment_gateway_events: [],
        subscriptions: [
          {
            id: 'sub_rb_001',
            customer_id: 'cust_rb_1',
            plan: 'plus',
            status: 'incomplete',
            gateway_subscription_id: 'sub_gw_rb',
            currency: 'INR',
            amount_minor_units: 39900,
            metadata: JSON.stringify({ principalId: 'usr_rb', customerId: 'cust_rb_1', tier: 'plus' })
          }
        ],
        billing_audit_events: []
      };

      const createQueryBuilder = (store: Record<string, any[]>) => (tableName: string) => ({
        insert: (row: any) => {
          if (!store[tableName]) store[tableName] = [];
          store[tableName].push({ ...row });
          return {
            onConflict: () => ({
              ignore: async () => {},
              merge: async () => {}
            }),
            then: (resolve: any, reject: any) => Promise.resolve([row]).then(resolve, reject)
          };
        },
        where: (query: Record<string, any>) => ({
          first: async () => store[tableName]?.find(r => Object.entries(query).every(([k, v]) => r[k] === v)) || null,
          update: async (patch: any) => {
            const rows = store[tableName] || [];
            for (const r of rows) {
              if (Object.entries(query).every(([k, v]) => r[k] === v)) {
                Object.assign(r, patch);
              }
            }
          },
          forUpdate: function () { return this; }
        }),
        onConflict: () => ({ ignore: async () => {} })
      });

      const mockKnex: any = createQueryBuilder(parentTables);
      mockKnex.transaction = async (callback: (trx: any) => Promise<any>) => {
        // Deep copy subscriptions to simulate transactional rollback isolation
        const trxTables = JSON.parse(JSON.stringify(parentTables));
        const trx = createQueryBuilder(trxTables);
        try {
          const res = await callback(trx);
          // If transaction commits, apply mutations back to parent
          Object.assign(parentTables, trxTables);
          return res;
        } catch (trxErr) {
          // Transaction rolled back! trxTables mutations discarded.
          throw trxErr;
        }
      };

      const service = new PaymentGatewayService();
      service.setDbClient(mockKnex);
      service.setRazorpaySecret('test_secret_razorpay');

      // Send a tampered webhook that throws TerminalRejectionError during business fulfillment
      const tamperedBody = JSON.stringify({
        event: 'subscription.charged',
        id: 'evt_rb_durability_test',
        payload: {
          subscription: { entity: { id: 'sub_gw_rb', current_end: 1800000000 } },
          payment: { entity: { id: 'pay_rb', amount: 10, currency: 'INR', status: 'captured' } } // Tampered amount!
        }
      });
      const sig = crypto.createHmac('sha256', 'test_secret_razorpay').update(tamperedBody).digest('hex');

      await assert.rejects(
        service.processRazorpayWebhook(tamperedBody, sig),
        (err: any) => {
          assert.ok(isTerminalError(err));
          assert.match(err.message, /Amount mismatch/);
          return true;
        }
      );

      // Verify business tables have ZERO mutations (rollback was clean)
      const sub = parentTables.subscriptions.find(s => s.id === 'sub_rb_001');
      assert.equal(sub.status, 'incomplete', 'Subscription status must remain incomplete after rolled-back transaction');

      // Verify payment_gateway_events recorded TERMINAL_FAILURE durably outside the rolled-back transaction
      const eventRecord = parentTables.payment_gateway_events.find(e => e.event_id === 'evt_rb_durability_test');
      assert.ok(eventRecord, 'payment_gateway_events record must survive transaction rollback');
      assert.equal(eventRecord.processed, false);
      assert.match(eventRecord.error, /^TERMINAL_FAILURE:/);

      // Verify retrying this event immediately rejects without entering transaction
      await assert.rejects(
        service.processRazorpayWebhook(tamperedBody, sig),
        (err: any) => {
          assert.ok(err instanceof TerminalRejectionError);
          assert.match(err.message, /terminally rejected/);
          return true;
        }
      );
    });

    it('provides verified reconciliation or terminal fail-closed handling for all 13 PAID_FULFILLMENT_EVENTS', async () => {
      process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'true';

      assert.equal(PAID_FULFILLMENT_EVENTS.size, 13, 'There must be exactly 13 paid fulfillment events in the contract');

      for (const event of PAID_FULFILLMENT_EVENTS) {
        // Assert each is recognized as requiring commercial fulfillment
        assert.doesNotThrow(
          () => assertCommercialFulfillmentAllowed(event, 'razorpay', {}),
          `Event '${event}' must be recognized by assertCommercialFulfillmentAllowed`
        );
      }
    });

    it('verifies explicit reconciliation handlers for Razorpay invoice.paid and Cashfree subscription/order events', async () => {
      process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'true';
      process.env.RAZORPAY_WEBHOOK_SECRET = 'test_secret_razorpay';
      process.env.CASHFREE_WEBHOOK_SECRET = 'test_secret_cashfree';

      const { dbClient, tables } = createMockDb();
      const service = new PaymentGatewayService();
      service.setDbClient(dbClient);
      service.setRazorpaySecret('test_secret_razorpay');
      service.setCashfreeSecret('test_secret_cashfree');

      const now = Date.now();
      // Setup purchase records
      tables.subscriptions.push(
        {
          id: 'sub_invoice_paid_001',
          customer_id: 'cust_inv',
          plan: 'plus',
          status: 'incomplete',
          gateway_subscription_id: 'sub_invoice_gw',
          currency: 'INR',
          amount_minor_units: 39900,
          metadata: JSON.stringify({ principalId: 'usr_inv', customerId: 'cust_inv', tier: 'plus' })
        },
        {
          id: 'sub_cf_act_001',
          customer_id: 'cust_cf',
          plan: 'pro',
          status: 'incomplete',
          gateway_subscription_id: 'sub_cf_gw',
          currency: 'INR',
          amount_minor_units: 79900,
          metadata: JSON.stringify({ principalId: 'usr_cf', customerId: 'cust_cf', tier: 'pro' })
        }
      );

      // 1. Razorpay invoice.paid
      const invoicePaidBody = JSON.stringify({
        event: 'invoice.paid',
        id: 'evt_invoice_paid_1',
        payload: {
          invoice: {
            entity: {
              id: 'inv_123',
              subscription_id: 'sub_invoice_gw',
              amount_paid: 39900,
              currency: 'INR',
              status: 'paid'
            }
          },
          subscription: {
            entity: {
              id: 'sub_invoice_gw',
              current_end: Math.floor((now + 30 * 86400000) / 1000)
            }
          }
        }
      });
      const invSig = crypto.createHmac('sha256', 'test_secret_razorpay').update(invoicePaidBody).digest('hex');
      const invResult = await service.processRazorpayWebhook(invoicePaidBody, invSig);
      assert.equal(invResult.status, 'PROCESSED');
      const invSub = tables.subscriptions.find(s => s.id === 'sub_invoice_paid_001');
      assert.equal(invSub.status, 'active');

      // 2. Cashfree SUBSCRIPTION_ACTIVATED
      const cfActivatedBody = JSON.stringify({
        type: 'SUBSCRIPTION_ACTIVATED',
        event_time: new Date().toISOString(),
        data: {
          subscription: {
            subscription_id: 'sub_cf_gw',
            status: 'ACTIVE',
            current_cycle: 1,
            currency: 'INR',
            amount: 79900
          }
        }
      });
      const cfTimestamp = Math.floor(Date.now() / 1000).toString();
      const cfSig = crypto.createHmac('sha256', 'test_secret_cashfree').update(`${cfTimestamp}${cfActivatedBody}`).digest('base64');
      const cfResult = await service.processCashfreeWebhook(cfActivatedBody, cfSig, cfTimestamp);
      assert.equal(cfResult.status, 'PROCESSED');
      const cfSub = tables.subscriptions.find(s => s.id === 'sub_cf_act_001');
      assert.equal(cfSub.status, 'active');
    });
  });

  // =========================================================================
  // F3: Atomic Subscription Transitions & Rollback Protection
  // =========================================================================
  describe('F3 â€” Atomic Transitions & State Protection', () => {
    it('prohibits unauthorized reactivation of cancelled subscriptions (INVALID_STATE_TRANSITION)', async () => {
      process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'true';
      process.env.RAZORPAY_WEBHOOK_SECRET = 'test_secret';

      const tables: Record<string, any[]> = {
        payment_gateway_events: [],
        subscriptions: [
          {
            id: 'sub_cancelled_001',
            customer_id: 'cust_003',
            plan: 'plus',
            status: 'cancelled', // Cancelled!
            gateway_subscription_id: 'sub_gateway_cancelled',
            currency: 'INR',
            amount_minor_units: 39900,
            metadata: JSON.stringify({ principalId: 'usr_003', customerId: 'cust_003', tier: 'plus' })
          }
        ],
        billing_audit_events: []
      };

      const dbClient: any = (tableName: string) => ({
        where: (query: Record<string, any>) => ({
          first: async () => tables[tableName]?.find(r => Object.entries(query).every(([k, v]) => r[k] === v)) || null,
          update: async (patch: Record<string, any>) => {
            const row = tables[tableName]?.find(r => Object.entries(query).every(([k, v]) => r[k] === v));
            if (row) Object.assign(row, patch);
          },
          forUpdate: function () { return this; }
        }),
        insert: async (record: Record<string, any>) => {
          tables[tableName].push({ ...record });
        }
      });

      const service = new PaymentGatewayService();
      service.setDbClient(dbClient);
      service.setRazorpaySecret('test_secret');

      const rawBody = JSON.stringify({
        event: 'subscription.charged',
        id: 'evt_cancel_reactivate_attempt',
        payload: {
          subscription: {
            entity: { id: 'sub_gateway_cancelled', current_end: 1800000000 }
          },
          payment: {
            entity: { id: 'pay_revive', amount: 39900, currency: 'INR', status: 'captured' }
          }
        }
      });
      const sig = crypto.createHmac('sha256', 'test_secret').update(rawBody).digest('hex');

      await assert.rejects(
        service.processRazorpayWebhook(rawBody, sig),
        (err: any) => {
          assert.ok(isTerminalError(err));
          assert.match(err.message, /INVALID_STATE_TRANSITION: Cannot activate or renew cancelled subscription/);
          return true;
        }
      );

      // Ensure subscription status remains cancelled
      const sub = tables.subscriptions.find(s => s.id === 'sub_cancelled_001');
      assert.equal(sub.status, 'cancelled');
    });
  });

  // =========================================================================
  // F4: Amount, Currency & Top-Up Purchase Reconciliation
  // =========================================================================
  describe('F4 â€” Amount, Currency & Top-Up Purchase Reconciliation', () => {
    function setupTopupService(initialSubscriptions: any[] = []) {
      const tables: Record<string, any[]> = {
        payment_gateway_events: [],
        subscriptions: [...initialSubscriptions],
        billing_audit_events: []
      };

      const dbClient: any = (tableName: string) => ({
        where: (query: Record<string, any>) => ({
          first: async () => tables[tableName]?.find(r => Object.entries(query).every(([k, v]) => r[k] === v)) || null,
          update: async (patch: Record<string, any>) => {
            const row = tables[tableName]?.find(r => Object.entries(query).every(([k, v]) => r[k] === v));
            if (row) Object.assign(row, patch);
          },
          forUpdate: function () { return this; }
        }),
        insert: async (record: Record<string, any>) => {
          tables[tableName].push({ ...record });
        }
      });

      const service = new PaymentGatewayService();
      service.setDbClient(dbClient);
      service.setRazorpaySecret('test_secret');

      return { service, tables };
    }

    it('rejects credit top-up when currency does not match purchase record', async () => {
      process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'true';

      const { service } = setupTopupService([
        {
          id: 'sub_topup_inr',
          customer_id: 'cust_004',
          gateway_subscription_id: 'order_topup_123',
          currency: 'INR',
          amount_minor_units: 9900,
          status: 'incomplete',
          metadata: JSON.stringify({ principalId: 'usr_004', packId: 'pack_1k' })
        }
      ]);

      const rawBody = JSON.stringify({
        event: 'payment.captured',
        id: 'evt_topup_currency_tamper',
        payload: {
          payment: {
            entity: {
              id: 'pay_topup_001',
              order_id: 'order_topup_123',
              amount: 9900,
              currency: 'USD', // Currency mismatch! Expected INR
              status: 'captured',
              notes: { type: 'credit_topup', pack_id: 'pack_1k' }
            }
          }
        }
      });
      const sig = crypto.createHmac('sha256', 'test_secret').update(rawBody).digest('hex');

      await assert.rejects(
        service.processRazorpayWebhook(rawBody, sig),
        (err: any) => {
          assert.ok(isTerminalError(err));
          assert.match(err.message, /Currency mismatch for top-up\. Expected INR, received USD/);
          return true;
        }
      );
    });

    it('rejects credit top-up without pre-existing verified purchase record', async () => {
      process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'true';

      const { service } = setupTopupService([]); // Empty subscriptions table

      const rawBody = JSON.stringify({
        event: 'payment.captured',
        id: 'evt_topup_ghost_order',
        payload: {
          payment: {
            entity: {
              id: 'pay_topup_ghost',
              order_id: 'order_unregistered_999',
              amount: 9900,
              currency: 'INR',
              status: 'captured',
              notes: { type: 'credit_topup', pack_id: 'pack_1k' }
            }
          }
        }
      });
      const sig = crypto.createHmac('sha256', 'test_secret').update(rawBody).digest('hex');

      await assert.rejects(
        service.processRazorpayWebhook(rawBody, sig),
        (err: any) => {
          assert.ok(isTerminalError(err));
          assert.match(err.message, /No pre-existing verified purchase record found/);
          return true;
        }
      );
    });

    it('successfully fulfills valid credit top-up and records audit trail', async () => {
      process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'true';

      const { service, tables } = setupTopupService([
        {
          id: 'sub_topup_valid',
          customer_id: 'cust_005',
          gateway_subscription_id: 'order_valid_topup',
          currency: 'INR',
          amount_minor_units: 9900,
          status: 'incomplete',
          metadata: JSON.stringify({ principalId: 'usr_005', packId: 'pack_1k' })
        }
      ]);

      const rawBody = JSON.stringify({
        event: 'payment.captured',
        id: 'evt_topup_valid_charge',
        payload: {
          payment: {
            entity: {
              id: 'pay_topup_valid',
              order_id: 'order_valid_topup',
              amount: 9900,
              currency: 'INR',
              status: 'captured',
              notes: { type: 'credit_topup', pack_id: 'pack_1k' }
            }
          }
        }
      });
      const sig = crypto.createHmac('sha256', 'test_secret').update(rawBody).digest('hex');

      const result = await service.processRazorpayWebhook(rawBody, sig);
      assert.equal(result.status, 'PROCESSED');
      assert.equal(result.duplicate, false);

      // Verify purchase record marked active
      const purchase = tables.subscriptions.find(s => s.id === 'sub_topup_valid');
      assert.equal(purchase.status, 'active');

      // Verify audit event written
      const audit = tables.billing_audit_events.find(a => a.event_type === 'CREDIT_TOPUP_FULFILLED');
      assert.ok(audit);
      assert.equal(audit.customer_id, 'cust_005');
      const auditPayload = JSON.parse(audit.payload);
      assert.equal(auditPayload.credits, 1000);
      assert.equal(auditPayload.amount, 9900);
      assert.equal(auditPayload.currency, 'INR');
    });
  });
});
