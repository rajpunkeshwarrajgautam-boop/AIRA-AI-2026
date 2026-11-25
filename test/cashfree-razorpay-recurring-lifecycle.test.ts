import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import type { Request } from 'express';
import {
  PaymentGatewayService,
  resolvePaymentGateway,
  CANDIDATE_RAZORPAY_PLANS,
  CANDIDATE_CASHFREE_PLANS,
  isTerminalError,
  assertCommercialFulfillmentAllowed,
  SAFE_RECONCILIATION_EVENTS,
  PAID_FULFILLMENT_EVENTS
} from '../apps/api/src/billing/payment-gateway-service.js';
import { productionReadinessService } from '../apps/api/src/billing/production-readiness.js';
import { verifyCsrfAndOrigin } from '../apps/api/src/auth/bff-session.js';

describe('Cashfree & Razorpay Recurring Subscriptions, Webhook Security & GST Invoicing Suite', () => {
  const origEnv = { ...process.env };

  function createMockDb() {
    const tables: Record<string, any[]> = {
      billing_customers: [],
      subscriptions: [],
      payment_gateway_events: [],
      billing_audit_events: [],
      idempotent_operations: [],
      credit_accounts: [],
      credit_transactions: [],
      credit_grants: [],
      billing_invoices: [],
      billing_credit_notes: []
    };

    const dbClient: any = (tableName: string) => {
      let filterQuery: Record<string, any> = {};
      let whereOps: Array<{ column: string; op: string; val: any }> = [];
      let whereInFilter: { column: string; values: any[] } | null = null;
      let orderCol: string | null = null;
      let orderDir: string = 'asc';

      const matchRow = (r: any): boolean => {
        const matchesObj = Object.entries(filterQuery).every(([k, v]) => r[k] === v);
        if (!matchesObj) return false;
        if (whereInFilter && !whereInFilter.values.includes(r[whereInFilter.column])) {
          return false;
        }
        for (const opClause of whereOps) {
          const colVal = r[opClause.column];
          if (opClause.op === '<=' && !(Number(colVal) <= Number(opClause.val))) return false;
          if (opClause.op === '>=' && !(Number(colVal) >= Number(opClause.val))) return false;
          if (opClause.op === '<' && !(Number(colVal) < Number(opClause.val))) return false;
          if (opClause.op === '>' && !(Number(colVal) > Number(opClause.val))) return false;
          if (opClause.op === '=' && colVal !== opClause.val) return false;
        }
        return true;
      };

      const builder: any = {
        where: (queryOrCol: any, opOrVal?: any, val?: any) => {
          if (typeof queryOrCol === 'string') {
            if (val === undefined) {
              filterQuery[queryOrCol] = opOrVal;
            } else {
              whereOps.push({ column: queryOrCol, op: opOrVal, val });
            }
          } else if (typeof queryOrCol === 'object') {
            Object.assign(filterQuery, queryOrCol);
          }
          return builder;
        },
        andWhere: (queryOrCol: any, opOrVal?: any, val?: any) => {
          return builder.where(queryOrCol, opOrVal, val);
        },
        whereIn: (column: string, values: any[]) => {
          whereInFilter = { column, values };
          return builder;
        },
        forUpdate: () => builder,
        orderBy: (column: string, direction = 'asc') => {
          orderCol = column;
          orderDir = direction.toLowerCase();
          return builder;
        },
        first: async () => {
          const rows = tables[tableName] || [];
          return rows.find(matchRow) || null;
        },
        select: async () => {
          const rows = tables[tableName] || [];
          return rows.filter(matchRow);
        },
        update: async (patch: Record<string, any>) => {
          const rows = tables[tableName] || [];
          let updatedCount = 0;
          for (const r of rows) {
            if (matchRow(r)) {
              Object.assign(r, patch);
              updatedCount++;
            }
          }
          return updatedCount;
        },
        delete: async () => {
          const rows = tables[tableName] || [];
          let deletedCount = 0;
          tables[tableName] = rows.filter(r => {
            if (matchRow(r)) {
              deletedCount++;
              return false;
            }
            return true;
          });
          return deletedCount;
        }
      };

      builder.then = (resolve: any, reject: any) => {
        builder.select().then(resolve, reject);
      };

      return {
        ...builder,
        insert: async (record: Record<string, any>) => {
          if (!tables[tableName]) tables[tableName] = [];
          tables[tableName].push({ ...record });
          return [record];
        }
      };
    };

    dbClient.schema = {
      hasTable: async (name: string) => Boolean(tables[name])
    };

    dbClient.raw = async (sql: string) => {
      if (sql.includes('nextval')) {
        return { rows: [{ seq: 1 }] };
      }
      return { rows: [] };
    };

    return { dbClient, tables };
  }

  beforeEach(() => {
    process.env = { ...origEnv };
    process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'true';
    process.env.AIRA_ENABLE_TEST_FULFILLMENT = 'true';
    process.env.NODE_ENV = 'test';
    process.env.RAZORPAY_KEY_ID = 'rzp_test_key_123';
    process.env.RAZORPAY_WEBHOOK_SECRET = 'test_rzp_webhook_secret_2026';
    process.env.CASHFREE_APP_ID = 'cf_test_app_123';
    process.env.CASHFREE_WEBHOOK_SECRET = 'test_cf_webhook_secret_2026';
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  // =========================================================================
  // 1. GATEWAY SELECTION RESOLUTION & POLICY
  // =========================================================================
  describe('1. Payment Gateway Selection & Policy Engine', () => {
    it('resolves default gateway based on environment configuration', () => {
      process.env.AIRA_PAYMENT_GATEWAY_DEFAULT = 'cashfree';
      process.env.AIRA_ALLOWED_PAYMENT_GATEWAYS = 'razorpay,cashfree';
      assert.equal(resolvePaymentGateway(), 'cashfree');

      process.env.AIRA_PAYMENT_GATEWAY_DEFAULT = 'razorpay';
      assert.equal(resolvePaymentGateway(), 'razorpay');
    });

    it('respects client requested gateway when permitted by allowed policy', () => {
      process.env.AIRA_ALLOWED_PAYMENT_GATEWAYS = 'razorpay,cashfree';
      assert.equal(resolvePaymentGateway('cashfree'), 'cashfree');
      assert.equal(resolvePaymentGateway('razorpay'), 'razorpay');
    });

    it('rejects requested gateway with BILLING_UNAVAILABLE when disallowed by policy', () => {
      process.env.AIRA_ALLOWED_PAYMENT_GATEWAYS = 'razorpay';
      assert.throws(
        () => resolvePaymentGateway('cashfree'),
        /BILLING_UNAVAILABLE: Requested payment gateway 'cashfree' is not permitted by policy/
      );
    });
  });

  // =========================================================================
  // 2. RAZORPAY RECURRING SUBSCRIPTIONS & E-MANDATES
  // =========================================================================
  describe('2. Razorpay Recurring Subscriptions Lifecycle', () => {
    it('creates a recurring subscription checkout with mapped plan and candidate pricing', async () => {
      const { dbClient, tables } = createMockDb();
      const service = new PaymentGatewayService();
      service.setDbClient(dbClient);

      let capturedTransportParams: any = null;
      service.setGatewayTransport(async (params) => {
        capturedTransportParams = params;
        return {
          gatewayOrderId: `sub_rzp_${Date.now()}`,
          shortUrl: 'https://rzp.io/i/sub_test_checkout'
        };
      });

      const checkout = await service.createSubscriptionCheckout(
        'usr_rzp_sub_01',
        'plus',
        'INR',
        'razorpay'
      );

      assert.equal(checkout.gateway, 'razorpay');
      assert.equal(checkout.amount, 39900);
      assert.equal(checkout.currency, 'INR');
      assert.ok(checkout.orderId.startsWith('sub_rzp_'));
      assert.equal(checkout.checkoutUrl, 'https://rzp.io/i/sub_test_checkout');

      assert.equal(capturedTransportParams.action, 'create_subscription');
      assert.equal(capturedTransportParams.gateway, 'razorpay');
      assert.equal(capturedTransportParams.planId, CANDIDATE_RAZORPAY_PLANS.plus.INR);

      // Verify purchase record persisted with status 'pending'
      const subRecord = tables.subscriptions.find(s => s.id === checkout.purchaseId);
      assert.ok(subRecord, 'Subscription record must be written');
      assert.equal(subRecord.status, 'pending');
      assert.equal(subRecord.gateway, 'razorpay');
      assert.equal(subRecord.amount_minor_units, 39900);

      // Verify audit log
      const auditLog = tables.billing_audit_events.find(a => a.event_type === 'CHECKOUT_ORDER_CREATED');
      assert.ok(auditLog, 'Audit event must be logged');
    });

    it('activates Razorpay recurring subscription via signed webhook and deduplicates retries deterministically', async () => {
      const { dbClient, tables } = createMockDb();
      const service = new PaymentGatewayService();
      service.setDbClient(dbClient);

      const secret = 'test_rzp_webhook_secret_2026';
      service.setRazorpaySecret(secret);

      const purchaseId = 'pur_rzp_act_01';
      const gatewaySubId = 'sub_rzp_live_123';
      const now = Date.now();

      tables.subscriptions.push({
        id: purchaseId,
        customer_id: 'cust_rzp_01',
        plan_id: 'plus',
        status: 'pending',
        gateway: 'razorpay',
        gateway_subscription_id: gatewaySubId,
        currency: 'INR',
        amount_minor_units: 39900,
        current_period_start: now,
        current_period_end: now,
        cancel_at_period_end: false,
        metadata: JSON.stringify({ principalId: 'usr_rzp_01', customerId: 'cust_rzp_01', planTier: 'plus' }),
        created_at: now,
        updated_at: now
      });

      const webhookPayload = {
        event: 'subscription.charged',
        payload: {
          subscription: {
            entity: {
              id: gatewaySubId,
              current_start: Math.floor(now / 1000),
              current_end: Math.floor((now + 30 * 86400000) / 1000),
              paid_count: 1
            }
          },
          payment: {
            entity: {
              id: 'pay_rzp_initial_01',
              amount: 39900,
              currency: 'INR',
              status: 'captured'
            }
          }
        }
      };

      const rawBody = JSON.stringify(webhookPayload);
      const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

      // 1. Initial Webhook delivery
      const res1 = await service.processRazorpayWebhook(rawBody, signature);
      assert.equal(res1.status, 'PROCESSED');
      assert.equal(res1.duplicate, false);
      assert.ok(res1.eventId.startsWith('evt_rzp_'), 'Fallback event ID must use deterministic SHA256 prefix');

      // Verify DB transition
      const sub = tables.subscriptions.find(s => s.id === purchaseId);
      assert.equal(sub.status, 'active');
      assert.equal(sub.cancel_at_period_end, false);

      // 2. Retry delivery (same rawBody and signature)
      const res2 = await service.processRazorpayWebhook(rawBody, signature);
      assert.equal(res2.status, 'ALREADY_PROCESSED');
      assert.equal(res2.duplicate, true);
      assert.equal(res2.eventId, res1.eventId, 'Deterministic event ID must match across retries');
    });

    it('processes legitimate recurring renewal anchoring billing period to previous end', async () => {
      const { dbClient, tables } = createMockDb();
      const service = new PaymentGatewayService();
      service.setDbClient(dbClient);

      const secret = 'test_rzp_webhook_secret_2026';
      service.setRazorpaySecret(secret);

      const purchaseId = 'pur_rzp_renew_01';
      const gatewaySubId = 'sub_rzp_renew_123';
      const baseStart = Math.floor(Date.now() / 1000) * 1000;
      const initialPeriodEnd = baseStart + 30 * 86400000;

      tables.subscriptions.push({
        id: purchaseId,
        customer_id: 'cust_rzp_01',
        plan_id: 'plus',
        status: 'active',
        gateway: 'razorpay',
        gateway_subscription_id: gatewaySubId,
        currency: 'INR',
        amount_minor_units: 39900,
        current_period_start: baseStart,
        current_period_end: initialPeriodEnd,
        cancel_at_period_end: false,
        metadata: JSON.stringify({
          principalId: 'usr_rzp_01',
          customerId: 'cust_rzp_01',
          planTier: 'plus',
          fulfilledCycle: 1,
          lastPaymentId: 'pay_rzp_initial_01'
        }),
        created_at: baseStart,
        updated_at: baseStart
      });

      const newPeriodEndSeconds = Math.floor((initialPeriodEnd + 30 * 86400000) / 1000);
      const renewalPayload = {
        event: 'subscription.renewed',
        payload: {
          subscription: {
            entity: {
              id: gatewaySubId,
              current_start: Math.floor(initialPeriodEnd / 1000),
              current_end: newPeriodEndSeconds,
              paid_count: 2
            }
          },
          payment: {
            entity: {
              id: 'pay_rzp_renewal_02',
              amount: 39900,
              currency: 'INR',
              status: 'captured'
            }
          }
        }
      };

      const rawBody = JSON.stringify(renewalPayload);
      const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

      const res = await service.processRazorpayWebhook(rawBody, signature);
      assert.equal(res.status, 'PROCESSED');

      const sub = tables.subscriptions.find(s => s.id === purchaseId);
      assert.equal(Number(sub.current_period_start), initialPeriodEnd, 'Renewal start must anchor to previous end');
      assert.equal(Number(sub.current_period_end), newPeriodEndSeconds * 1000);

      const auditEvent = tables.billing_audit_events.find(a => a.event_type === 'SUBSCRIPTION_RENEWED');
      assert.ok(auditEvent, 'Renewal audit event must be present');
    });
  });

  // =========================================================================
  // 3. CASHFREE RECURRING SUBSCRIPTIONS & WEBHOOKS
  // =========================================================================
  describe('3. Cashfree Recurring Subscriptions Lifecycle', () => {
    it('creates a Cashfree recurring subscription checkout with mapped plan', async () => {
      const { dbClient, tables } = createMockDb();
      const service = new PaymentGatewayService();
      service.setDbClient(dbClient);

      let capturedParams: any = null;
      service.setGatewayTransport(async (params) => {
        capturedParams = params;
        return {
          gatewayOrderId: `sub_cf_${Date.now()}`,
          shortUrl: 'https://payments.cashfree.com/pg/subscriptions/session_123'
        };
      });

      const checkout = await service.createSubscriptionCheckout(
        'usr_cf_sub_01',
        'pro',
        'INR',
        'cashfree',
        undefined,
        { phone: '9876543210' }
      );

      assert.equal(checkout.gateway, 'cashfree');
      assert.equal(checkout.amount, 99900);
      assert.equal(checkout.currency, 'INR');
      assert.ok(checkout.orderId.startsWith('sub_cf_'));
      assert.equal(capturedParams.action, 'create_subscription');
      assert.equal(capturedParams.planId, CANDIDATE_CASHFREE_PLANS.pro.INR);

      const subRecord = tables.subscriptions.find(s => s.id === checkout.purchaseId);
      assert.ok(subRecord);
      assert.equal(subRecord.status, 'pending');
      assert.equal(subRecord.gateway, 'cashfree');
    });

    it('verifies Cashfree webhook HMAC-SHA256 signature with timestamp and activates subscription', async () => {
      const { dbClient, tables } = createMockDb();
      const service = new PaymentGatewayService();
      service.setDbClient(dbClient);

      const cfSecret = 'test_cf_webhook_secret_2026';
      service.setCashfreeSecret(cfSecret);

      const purchaseId = 'pur_cf_act_01';
      const gatewaySubId = 'sub_cf_live_999';
      const now = Date.now();

      tables.subscriptions.push({
        id: purchaseId,
        customer_id: 'cust_cf_01',
        plan_id: 'pro',
        status: 'pending',
        gateway: 'cashfree',
        gateway_subscription_id: gatewaySubId,
        currency: 'INR',
        amount_minor_units: 99900,
        current_period_start: now,
        current_period_end: now,
        cancel_at_period_end: false,
        metadata: JSON.stringify({ principalId: 'usr_cf_01', customerId: 'cust_cf_01', planTier: 'pro' }),
        created_at: now,
        updated_at: now
      });

      const cfPayload = {
        type: 'SUBSCRIPTION_ACTIVATED',
        data: {
          subscription: {
            subscription_id: gatewaySubId,
            current_cycle: 1,
            subscription_status: 'ACTIVE'
          },
          payment: {
            cf_payment_id: 'cf_pay_001',
            payment_status: 'SUCCESS',
            payment_amount: 999.00,
            amount: 99900,
            currency: 'INR'
          }
        }
      };

      const timestamp = String(Math.floor(Date.now() / 1000));
      const rawBody = JSON.stringify(cfPayload);
      const signature = crypto.createHmac('sha256', cfSecret).update(`${timestamp}${rawBody}`).digest('base64');

      // Verify signature calculation
      const verifyRes = service.verifyCashfreeWebhook(rawBody, signature, timestamp, cfSecret);
      assert.equal(verifyRes.valid, true);

      // Process Cashfree webhook
      const res = await service.processCashfreeWebhook(rawBody, signature, timestamp);
      assert.equal(res.status, 'PROCESSED');
      assert.equal(res.duplicate, false);

      const sub = tables.subscriptions.find(s => s.id === purchaseId);
      assert.equal(sub.status, 'active');
    });
  });

  // =========================================================================
  // 4. PROVIDER-SIDE CANCELLATIONS & REFUNDS
  // =========================================================================
  describe('4. Provider-Side Subscription Cancellation & Refund Handling', () => {
    it('calls provider-side cancellation and marks cancel_at_period_end in database', async () => {
      const { dbClient, tables } = createMockDb();
      const service = new PaymentGatewayService();
      service.setDbClient(dbClient);

      let providerCancelCalled = false;
      service.setGatewayTransport(async (params) => {
        if (params.action === 'cancel_subscription') {
          providerCancelCalled = true;
          return { gatewayOrderId: params.orderId, cancelled: true };
        }
        return { gatewayOrderId: 'test' };
      });

      const now = Date.now();
      const customerId = 'cust_cancel_01';
      tables.billing_customers.push({ id: customerId, principal_id: 'usr_cancel_01' });
      tables.subscriptions.push({
        id: 'pur_sub_cancel_01',
        customer_id: customerId,
        plan_id: 'plus',
        status: 'active',
        gateway: 'razorpay',
        gateway_subscription_id: 'sub_rzp_cancel_target',
        currency: 'INR',
        amount_minor_units: 39900,
        current_period_start: now,
        current_period_end: now + 20 * 86400000,
        cancel_at_period_end: false,
        metadata: JSON.stringify({ customerState: '07' }),
        created_at: now,
        updated_at: now
      });

      const cancelRes = await service.cancelSubscription('usr_cancel_01');
      assert.equal(cancelRes.success, true);
      assert.equal(cancelRes.gatewayCancelled, true);
      assert.equal(providerCancelCalled, true, 'Provider transport cancel action must be called');

      const sub = tables.subscriptions.find(s => s.id === 'pur_sub_cancel_01');
      assert.equal(sub.cancel_at_period_end, true);

      const audit = tables.billing_audit_events.find(a => a.event_type === 'SUBSCRIPTION_CANCEL_SCHEDULED');
      assert.ok(audit);
    });

    it('reconciles refund webhook events and updates subscription status to refunded', async () => {
      const { dbClient, tables } = createMockDb();
      const service = new PaymentGatewayService();
      service.setDbClient(dbClient);

      const secret = 'test_rzp_webhook_secret_2026';
      service.setRazorpaySecret(secret);

      const purchaseId = 'pur_refund_01';
      const gatewaySubId = 'sub_rzp_refund_target';
      const now = Date.now();

      tables.subscriptions.push({
        id: purchaseId,
        customer_id: 'cust_refund_01',
        plan_id: 'plus',
        status: 'active',
        gateway: 'razorpay',
        gateway_subscription_id: gatewaySubId,
        currency: 'INR',
        amount_minor_units: 39900,
        current_period_start: now,
        current_period_end: now + 30 * 86400000,
        cancel_at_period_end: false,
        metadata: JSON.stringify({ principalId: 'usr_refund_01', lastPaymentId: 'pay_refund_src_01' }),
        created_at: now,
        updated_at: now
      });

      const refundPayload = {
        event: 'refund.processed',
        payload: {
          refund: {
            entity: {
              id: 'rfnd_001',
              payment_id: 'pay_refund_src_01',
              amount: 39900
            }
          },
          payment: {
            entity: {
              id: 'pay_refund_src_01',
              order_id: gatewaySubId
            }
          }
        }
      };

      const rawBody = JSON.stringify(refundPayload);
      const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

      const res = await service.processRazorpayWebhook(rawBody, signature);
      assert.equal(res.status, 'PROCESSED');

      const sub = tables.subscriptions.find(s => s.id === purchaseId);
      assert.equal(sub.status, 'refunded');

      const audit = tables.billing_audit_events.find(a => a.event_type === 'SUBSCRIPTION_REFUNDED');
      assert.ok(audit);
    });

    it('handles cancellation state machine: records CANCELLATION_REQUESTED then CANCELLATION_CONFIRMED on webhook', async () => {
      const { dbClient, tables } = createMockDb();
      const service = new PaymentGatewayService();
      service.setDbClient(dbClient);
      const secret = 'test_rzp_webhook_secret_2026';
      service.setRazorpaySecret(secret);

      service.setGatewayTransport(async (params) => {
        if (params.action === 'cancel_subscription') {
          return { gatewayOrderId: params.orderId, cancelled: true };
        }
        return { gatewayOrderId: 'test' };
      });

      const now = Date.now();
      const customerId = 'cust_cancel_flow_01';
      const principalId = 'usr_cancel_flow_01';
      const gatewaySubId = 'sub_rzp_cancel_flow_target';

      tables.billing_customers.push({ id: customerId, principal_id: principalId });
      tables.subscriptions.push({
        id: 'pur_sub_cancel_flow_01',
        customer_id: customerId,
        plan_id: 'plus',
        status: 'active',
        gateway: 'razorpay',
        gateway_subscription_id: gatewaySubId,
        currency: 'INR',
        amount_minor_units: 39900,
        current_period_start: now,
        current_period_end: now + 15 * 86400000,
        cancel_at_period_end: false,
        metadata: JSON.stringify({ customerState: '07' }),
        created_at: now,
        updated_at: now
      });

      // 1. Principal initiates cancellation -> CANCELLATION_REQUESTED
      const res = await service.cancelSubscription(principalId);
      assert.equal(res.success, true);
      assert.equal(res.gatewayCancelled, true);

      const requestedSub = tables.subscriptions.find(s => s.id === 'pur_sub_cancel_flow_01');
      assert.equal(requestedSub.cancel_at_period_end, true);
      const requestedMeta = JSON.parse(requestedSub.metadata);
      assert.equal(requestedMeta.cancellation_status, 'CANCELLATION_REQUESTED');

      // 2. Gateway delivers subscription.cancelled webhook -> CANCELLATION_CONFIRMED & status: 'cancelled'
      const cancelWebhookPayload = {
        event: 'subscription.cancelled',
        payload: {
          subscription: {
            entity: {
              id: gatewaySubId,
              status: 'cancelled'
            }
          }
        }
      };
      const rawBody = JSON.stringify(cancelWebhookPayload);
      const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

      const hookRes = await service.processRazorpayWebhook(rawBody, signature);
      assert.equal(hookRes.status, 'PROCESSED');

      const confirmedSub = tables.subscriptions.find(s => s.id === 'pur_sub_cancel_flow_01');
      assert.equal(confirmedSub.status, 'cancelled');
      const confirmedMeta = JSON.parse(confirmedSub.metadata);
      assert.equal(confirmedMeta.cancellation_status, 'CANCELLATION_CONFIRMED');
    });

    it('fails closed and refuses to cancel if provider gateway cancellation returns failure', async () => {
      const { dbClient, tables } = createMockDb();
      const service = new PaymentGatewayService();
      service.setDbClient(dbClient);

      service.setGatewayTransport(async () => {
        return { gatewayOrderId: 'sub_fail', cancelled: false };
      });

      const now = Date.now();
      const customerId = 'cust_fail_cancel';
      const principalId = 'usr_fail_cancel';

      tables.billing_customers.push({ id: customerId, principal_id: principalId });
      tables.subscriptions.push({
        id: 'pur_sub_fail_cancel',
        customer_id: customerId,
        plan_id: 'plus',
        status: 'active',
        gateway: 'razorpay',
        gateway_subscription_id: 'sub_rzp_failing',
        currency: 'INR',
        amount_minor_units: 39900,
        current_period_start: now,
        current_period_end: now + 10 * 86400000,
        cancel_at_period_end: false,
        metadata: JSON.stringify({ customerState: '07' }),
        created_at: now,
        updated_at: now
      });

      const res = await service.cancelSubscription(principalId);
      assert.equal(res.success, false);
      assert.equal(res.gatewayCancelled, false);

      const sub = tables.subscriptions.find(s => s.id === 'pur_sub_fail_cancel');
      assert.equal(sub.cancel_at_period_end, false, 'cancel_at_period_end must not be marked true on provider failure');
    });

    it('handles refund.created as REFUND_INITIATED audit event without revoking subscription status', async () => {
      const { dbClient, tables } = createMockDb();
      const service = new PaymentGatewayService();
      service.setDbClient(dbClient);
      const secret = 'test_rzp_webhook_secret_2026';
      service.setRazorpaySecret(secret);

      const now = Date.now();
      const subId = 'pur_sub_init_ref';
      const gatewaySubId = 'sub_rzp_init_target';

      tables.subscriptions.push({
        id: subId,
        customer_id: 'cust_init_ref',
        plan_id: 'plus',
        status: 'active',
        gateway: 'razorpay',
        gateway_subscription_id: gatewaySubId,
        currency: 'INR',
        amount_minor_units: 39900,
        current_period_start: now,
        current_period_end: now + 30 * 86400000,
        cancel_at_period_end: false,
        metadata: JSON.stringify({ principalId: 'usr_init_ref', lastPaymentId: 'pay_init_ref' }),
        created_at: now,
        updated_at: now
      });

      const refundCreatedPayload = {
        event: 'refund.created',
        payload: {
          refund: {
            entity: {
              id: 'rfnd_created_01',
              payment_id: 'pay_init_ref',
              amount: 39900
            }
          },
          payment: {
            entity: {
              id: 'pay_init_ref',
              order_id: gatewaySubId
            }
          }
        }
      };

      const rawBody = JSON.stringify(refundCreatedPayload);
      const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

      const hookRes = await service.processRazorpayWebhook(rawBody, signature);
      assert.equal(hookRes.status, 'PROCESSED');

      const sub = tables.subscriptions.find(s => s.id === subId);
      assert.equal(sub.status, 'active', 'Subscription must remain active on refund.created (not yet settled)');

      const audit = tables.billing_audit_events.find(a => a.event_type === 'REFUND_INITIATED');
      assert.ok(audit, 'Audit trail must record REFUND_INITIATED');
    });

    it('distinguishes partial from full refund: partial refund updates metadata without setting status to refunded', async () => {
      const { dbClient, tables } = createMockDb();
      const service = new PaymentGatewayService();
      service.setDbClient(dbClient);
      const secret = 'test_rzp_webhook_secret_2026';
      service.setRazorpaySecret(secret);

      const now = Date.now();
      const subId = 'pur_sub_partial_ref';
      const gatewaySubId = 'sub_rzp_partial_target';

      tables.subscriptions.push({
        id: subId,
        customer_id: 'cust_partial_ref',
        plan_id: 'plus',
        status: 'active',
        gateway: 'razorpay',
        gateway_subscription_id: gatewaySubId,
        currency: 'INR',
        amount_minor_units: 39900,
        current_period_start: now,
        current_period_end: now + 30 * 86400000,
        cancel_at_period_end: false,
        metadata: JSON.stringify({ principalId: 'usr_partial_ref', lastPaymentId: 'pay_partial_ref' }),
        created_at: now,
        updated_at: now
      });

      // Partial refund of 10000 paise (out of 39900)
      const partialPayload = {
        event: 'refund.processed',
        payload: {
          refund: {
            entity: {
              id: 'rfnd_part_01',
              payment_id: 'pay_partial_ref',
              amount: 10000
            }
          },
          payment: {
            entity: {
              id: 'pay_partial_ref',
              order_id: gatewaySubId
            }
          }
        }
      };

      const rawBody = JSON.stringify(partialPayload);
      const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

      const hookRes = await service.processRazorpayWebhook(rawBody, signature);
      assert.equal(hookRes.status, 'PROCESSED');

      const sub = tables.subscriptions.find(s => s.id === subId);
      assert.equal(sub.status, 'active', 'Partial refund must not cancel or revoke active subscription status');
      const meta = JSON.parse(sub.metadata);
      assert.equal(meta.partialRefund, true);
      assert.equal(meta.refundAmount, 100);
      assert.equal(meta.refundAmountMinorUnits, 10000);

      const audit = tables.billing_audit_events.find(a => a.event_type === 'SUBSCRIPTION_PARTIALLY_REFUNDED');
      assert.ok(audit, 'Audit trail must record SUBSCRIPTION_PARTIALLY_REFUNDED');
    });
  });

  // =========================================================================
  // 5. WEBHOOK CSRF EXEMPTION & ORIGIN VALIDATION
  // =========================================================================
  describe('5. Webhook CSRF Admission Security', () => {
    it('admits legitimate Razorpay webhook requests with valid x-razorpay-signature header without CSRF tokens', () => {
      const mockReq: Partial<Request> = {
        method: 'POST',
        path: '/api/billing/webhook/razorpay',
        headers: {
          'x-razorpay-signature': 'mock_valid_hmac_sig'
        }
      };

      const allowed = verifyCsrfAndOrigin(mockReq as Request, null);
      assert.equal(allowed, true, 'Server-to-server webhook with valid HMAC signature header must pass CSRF check');
    });

    it('admits legitimate Cashfree webhook requests with x-webhook-signature or x-cashfree-signature header', () => {
      const mockReq1: Partial<Request> = {
        method: 'POST',
        path: '/api/billing/webhook/cashfree',
        headers: {
          'x-webhook-signature': 'cf_sig_123',
          'x-webhook-timestamp': String(Math.floor(Date.now() / 1000))
        }
      };
      assert.equal(verifyCsrfAndOrigin(mockReq1 as Request, null), true);

      const mockReq2: Partial<Request> = {
        method: 'POST',
        path: '/api/billing/webhook/cashfree',
        headers: {
          'x-cashfree-signature': 'cf_sig_456'
        }
      };
      assert.equal(verifyCsrfAndOrigin(mockReq2 as Request, null), true);
    });

    it('rejects unsigned webhook requests attempting to bypass CSRF', () => {
      delete process.env.VERCEL_ENV;
      process.env.NODE_ENV = 'production';

      const mockReq: Partial<Request> = {
        method: 'POST',
        path: '/api/billing/webhook/razorpay',
        headers: {} // No signature header!
      };

      const allowed = verifyCsrfAndOrigin(mockReq as Request, null);
      assert.equal(allowed, false, 'Unsigned POST to webhook path must be rejected');
    });
  });

  // =========================================================================
  // 6. GST-COMPLIANT INVOICE GENERATION (SAC 998431)
  // =========================================================================
  describe('6. Tax-Compliant Invoicing Engine (SAC 998431, 18% GST)', () => {
    it('generates compliant tax invoices for paid subscriptions with split CGST/SGST', async () => {
      const { dbClient, tables } = createMockDb();
      const service = new PaymentGatewayService();
      service.setDbClient(dbClient);

      const customerId = 'cust_inv_01';
      const principalId = 'usr_invoice_tester';
      tables.billing_customers.push({ id: customerId, principal_id: principalId });

      const now = Date.now();
      const subRecord = {
        id: 'pur_inv_test_01',
        customer_id: customerId,
        plan_id: 'plus',
        status: 'active',
        gateway: 'razorpay',
        currency: 'INR',
        amount_minor_units: 39900,
        current_period_start: now,
        current_period_end: now + 30 * 86400000,
        cancel_at_period_end: false,
        metadata: JSON.stringify({
          principalId,
          customerId,
          customerState: '07',
          initialPaymentId: 'pay_tax_cgst_01',
          lastPaymentId: 'pay_tax_cgst_01',
          fulfilledCycle: 1
        }),
        created_at: now,
        updated_at: now
      };
      tables.subscriptions.push(subRecord);
      tables.billing_audit_events.push({
        id: 'bae_tax_act_01',
        customer_id: customerId,
        event_type: 'SUBSCRIPTION_ACTIVATED',
        actor_type: 'gateway_webhook',
        actor_id: subRecord.id,
        payload: JSON.stringify({
          purchaseId: subRecord.id,
          actualPaymentId: 'pay_tax_cgst_01',
          amount: 39900,
          currency: 'INR'
        }),
        created_at: now
      });

      await service.issueDurableInvoice({
        trx: dbClient,
        customerId,
        principalId,
        purchaseRecord: subRecord,
        planTier: 'plus',
        gateway: 'razorpay',
        actualPaymentId: 'pay_tax_cgst_01',
        cycleNumber: 1,
        now
      });

      const invoices = await service.getInvoices(principalId);
      assert.equal(invoices.length, 1);

      const inv = invoices[0];
      assert.equal(inv.plan, 'AIRA Plus');
      assert.equal(inv.currency, 'INR');
      assert.equal(inv.totalAmount, 399.00);
      assert.equal(inv.sacCode, '998431');
      assert.equal(inv.supplierName, 'Virexa AI Ventures Private Limited');
      assert.equal(inv.status, 'Paid');

      // Verify 18% GST tax breakdown:
      // total = base * 1.18 => 399 / 1.18 = 338.14
      // gst = 399 - 338.14 = 60.86
      // cgst = 30.43, sgst = 30.43
      assert.equal(inv.taxableBase, 338.14);
      assert.equal(inv.gstAmount, 60.86);
      assert.equal(inv.cgstAmount, 30.43);
      assert.equal(inv.sgstAmount, 30.43);
      assert.ok(inv.invoiceNumber.startsWith('INV-2026-'));
    });

    it('calculates 18% IGST for inter-state customer transactions outside Delhi', async () => {
      const { dbClient, tables } = createMockDb();
      const service = new PaymentGatewayService();
      service.setDbClient(dbClient);

      const customerId = 'cust_inv_ka';
      const principalId = 'usr_invoice_ka';
      tables.billing_customers.push({ id: customerId, principal_id: principalId });

      const now = Date.now();
      const subRecord = {
        id: 'pur_inv_ka_01',
        customer_id: customerId,
        plan_id: 'pro',
        status: 'active',
        gateway: 'cashfree',
        currency: 'INR',
        amount_minor_units: 99900, // ₹999
        current_period_start: now,
        current_period_end: now + 30 * 86400000,
        cancel_at_period_end: false,
        metadata: JSON.stringify({
          principalId,
          customerId,
          customerState: 'Karnataka',
          initialPaymentId: 'cf_tax_igst_01',
          lastPaymentId: 'cf_tax_igst_01',
          fulfilledCycle: 1
        }),
        created_at: now,
        updated_at: now
      };
      tables.subscriptions.push(subRecord);
      tables.billing_audit_events.push({
        id: 'bae_tax_ka_act_01',
        customer_id: customerId,
        event_type: 'SUBSCRIPTION_ACTIVATED',
        actor_type: 'gateway_webhook',
        actor_id: subRecord.id,
        payload: JSON.stringify({
          purchaseId: subRecord.id,
          actualPaymentId: 'cf_tax_igst_01',
          amount: 99900,
          currency: 'INR'
        }),
        created_at: now
      });

      await service.issueDurableInvoice({
        trx: dbClient,
        customerId,
        principalId,
        purchaseRecord: subRecord,
        planTier: 'pro',
        gateway: 'cashfree',
        actualPaymentId: 'cf_tax_igst_01',
        cycleNumber: 1,
        now
      });

      const invoices = await service.getInvoices(principalId);
      assert.equal(invoices.length, 1);
      const inv = invoices[0];

      // 999 / 1.18 = 846.61
      // gst = 999 - 846.61 = 152.39 (all IGST for Karnataka inter-state)
      assert.equal(inv.totalAmount, 999.00);
      assert.equal(inv.taxableBase, 846.61);
      assert.equal(inv.gstAmount, 152.39);
      assert.equal(inv.igstAmount, 152.39);
      assert.equal(inv.cgstAmount, undefined);
      assert.equal(inv.sgstAmount, undefined);
    });

    it('calculates 0% export under LUT for international USD subscriptions', async () => {
      const { dbClient, tables } = createMockDb();
      const service = new PaymentGatewayService();
      service.setDbClient(dbClient);

      const customerId = 'cust_inv_usd';
      const principalId = 'usr_invoice_usd';
      tables.billing_customers.push({ id: customerId, principal_id: principalId });

      const now = Date.now();
      const subRecord = {
        id: 'pur_inv_usd_01',
        customer_id: customerId,
        plan_id: 'pro',
        status: 'active',
        gateway: 'razorpay',
        currency: 'USD',
        amount_minor_units: 1999, // $19.99
        current_period_start: now,
        current_period_end: now + 30 * 86400000,
        cancel_at_period_end: false,
        metadata: JSON.stringify({
          principalId,
          customerId,
          country: 'US',
          initialPaymentId: 'pay_tax_usd_01',
          lastPaymentId: 'pay_tax_usd_01',
          fulfilledCycle: 1
        }),
        created_at: now,
        updated_at: now
      };
      tables.subscriptions.push(subRecord);
      tables.billing_audit_events.push({
        id: 'bae_tax_usd_act_01',
        customer_id: customerId,
        event_type: 'SUBSCRIPTION_ACTIVATED',
        actor_type: 'gateway_webhook',
        actor_id: subRecord.id,
        payload: JSON.stringify({
          purchaseId: subRecord.id,
          actualPaymentId: 'pay_tax_usd_01',
          amount: 1999,
          currency: 'USD'
        }),
        created_at: now
      });

      await service.issueDurableInvoice({
        trx: dbClient,
        customerId,
        principalId,
        purchaseRecord: subRecord,
        planTier: 'pro',
        gateway: 'razorpay',
        actualPaymentId: 'pay_tax_usd_01',
        cycleNumber: 1,
        now
      });

      const invoices = await service.getInvoices(principalId);
      assert.equal(invoices.length, 1);
      const inv = invoices[0];

      assert.equal(inv.currency, 'USD');
      assert.equal(inv.totalAmount, 19.99);
      assert.equal(inv.taxableBase, 19.99);
      assert.equal(inv.gstAmount, 0);
      assert.equal(inv.cgstAmount, undefined);
      assert.equal(inv.sgstAmount, undefined);
      assert.equal(inv.igstAmount, undefined);
    });

    it('tracks official GSTIN verification state via AIRA_SUPPLIER_GSTIN', async () => {
      const { dbClient, tables } = createMockDb();
      const service = new PaymentGatewayService();
      service.setDbClient(dbClient);

      const customerId1 = 'cust_gstin_check_1';
      const principalId1 = 'usr_gstin_check_1';
      const customerId2 = 'cust_gstin_check_2';
      const principalId2 = 'usr_gstin_check_2';
      tables.billing_customers.push(
        { id: customerId1, principal_id: principalId1 },
        { id: customerId2, principal_id: principalId2 }
      );

      const now = Date.now();
      const sub1 = {
        id: 'pur_gstin_01',
        customer_id: customerId1,
        plan_id: 'plus',
        status: 'active',
        gateway: 'razorpay',
        currency: 'INR',
        amount_minor_units: 39900,
        current_period_start: now,
        current_period_end: now + 30 * 86400000,
        cancel_at_period_end: false,
        metadata: JSON.stringify({
          principalId: principalId1,
          customerId: customerId1,
          customerState: '07',
          initialPaymentId: 'pay_gstin_01',
          lastPaymentId: 'pay_gstin_01',
          fulfilledCycle: 1
        }),
        created_at: now,
        updated_at: now
      };
      const sub2 = {
        id: 'pur_gstin_02',
        customer_id: customerId2,
        plan_id: 'plus',
        status: 'active',
        gateway: 'razorpay',
        currency: 'INR',
        amount_minor_units: 39900,
        current_period_start: now,
        current_period_end: now + 30 * 86400000,
        cancel_at_period_end: false,
        metadata: JSON.stringify({
          principalId: principalId2,
          customerId: customerId2,
          customerState: '07',
          initialPaymentId: 'pay_gstin_02',
          lastPaymentId: 'pay_gstin_02',
          fulfilledCycle: 1
        }),
        created_at: now,
        updated_at: now
      };
      tables.subscriptions.push(sub1, sub2);
      tables.billing_audit_events.push(
        {
          id: 'bae_gstin_act_1',
          customer_id: customerId1,
          event_type: 'SUBSCRIPTION_ACTIVATED',
          actor_type: 'gateway_webhook',
          actor_id: sub1.id,
          payload: JSON.stringify({ purchaseId: sub1.id, actualPaymentId: 'pay_gstin_01', amount: 39900, currency: 'INR' }),
          created_at: now
        },
        {
          id: 'bae_gstin_act_2',
          customer_id: customerId2,
          event_type: 'SUBSCRIPTION_ACTIVATED',
          actor_type: 'gateway_webhook',
          actor_id: sub2.id,
          payload: JSON.stringify({ purchaseId: sub2.id, actualPaymentId: 'pay_gstin_02', amount: 39900, currency: 'INR' }),
          created_at: now
        }
      );

      // 1. Without AIRA_SUPPLIER_GSTIN configured
      delete process.env.AIRA_SUPPLIER_GSTIN;
      await service.issueDurableInvoice({
        trx: dbClient,
        customerId: customerId1,
        principalId: principalId1,
        purchaseRecord: sub1,
        planTier: 'plus',
        gateway: 'razorpay',
        actualPaymentId: 'pay_gstin_01',
        cycleNumber: 1,
        now
      });
      const invWithoutGstin = await service.getInvoices(principalId1);
      assert.equal(invWithoutGstin[0].taxComplianceStatus, 'PROVISIONAL_PENDING_GSTIN');
      assert.equal(invWithoutGstin[0].supplierGstin, undefined);

      // 2. With valid 15-character GSTIN configured
      process.env.AIRA_SUPPLIER_GSTIN = '07AAACV2026E1Z5';
      await service.issueDurableInvoice({
        trx: dbClient,
        customerId: customerId2,
        principalId: principalId2,
        purchaseRecord: sub2,
        planTier: 'plus',
        gateway: 'razorpay',
        actualPaymentId: 'pay_gstin_02',
        cycleNumber: 1,
        now
      });
      const invWithGstin = await service.getInvoices(principalId2);
      assert.equal(invWithGstin[0].taxComplianceStatus, 'COMPLIANT');
      assert.equal(invWithGstin[0].supplierGstin, '07AAACV2026E1Z5');
    });

    it('issues durable sequential tax invoice into billing_audit_events upon subscription activation webhook and retrieves it', async () => {
      const { dbClient, tables } = createMockDb();
      const service = new PaymentGatewayService();
      service.setDbClient(dbClient);
      const secret = 'test_rzp_webhook_secret_2026';
      service.setRazorpaySecret(secret);

      const customerId = 'cust_durable_01';
      const principalId = 'usr_durable_01';
      const subId = 'pur_sub_durable_01';
      const rzpSubId = 'sub_rzp_durable_01';

      tables.billing_customers.push({ id: customerId, principal_id: principalId });
      tables.subscriptions.push({
        id: subId,
        customer_id: customerId,
        plan_id: 'plus',
        status: 'pending',
        gateway: 'razorpay',
        gateway_subscription_id: rzpSubId,
        currency: 'INR',
        amount_minor_units: 99900,
        current_period_start: 0,
        current_period_end: 0,
        cancel_at_period_end: false,
        metadata: JSON.stringify({ principalId, customerId, planTier: 'plus', customerState: '07' }),
        created_at: Date.now(),
        updated_at: Date.now()
      });

      const body = JSON.stringify({
        event: 'subscription.charged',
        payload: {
          subscription: {
            entity: {
              id: rzpSubId,
              plan_id: 'plan_plus_test',
              status: 'active',
              current_start: Math.floor(Date.now() / 1000),
              current_end: Math.floor(Date.now() / 1000) + 30 * 86400,
              paid_count: 1
            }
          },
          payment: {
            entity: {
              id: 'pay_durable_101',
              order_id: 'order_rzp_101',
              amount: 99900,
              currency: 'INR',
              status: 'captured'
            }
          }
        }
      });
      const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');

      const res = await service.processRazorpayWebhook(body, sig);
      assert.equal(res.status, 'PROCESSED');

      // Verify durable invoice emitted in billing_audit_events
      const invoiceEvents = tables.billing_audit_events.filter(e => e.event_type === 'TAX_INVOICE_ISSUED');
      assert.equal(invoiceEvents.length, 1);
      assert.equal(invoiceEvents[0].actor_id, 'INV-2026-0001');

      // Verify retrieval via getInvoices
      const invoices = await service.getInvoices(principalId);
      assert.equal(invoices.length, 1);
      assert.equal(invoices[0].invoiceNumber, 'INV-2026-0001');
      assert.equal(invoices[0].totalAmount, 999);
      assert.equal(invoices[0].taxableBase, 846.61);
      assert.equal(invoices[0].gstAmount, 152.39);
      assert.equal(invoices[0].cgstAmount, 76.19);
      assert.equal(invoices[0].sgstAmount, 76.2);
      assert.equal(invoices[0].status, 'Paid');
      assert.equal(invoices[0].sacCode, '998431');
    });

    it('enforces idempotency on durable tax invoice issuance for duplicate webhooks', async () => {
      const { dbClient, tables } = createMockDb();
      const service = new PaymentGatewayService();
      service.setDbClient(dbClient);
      const secret = 'test_rzp_webhook_secret_2026';
      service.setRazorpaySecret(secret);

      const customerId = 'cust_durable_idem';
      const principalId = 'usr_durable_idem';
      const subId = 'pur_sub_durable_idem';
      const rzpSubId = 'sub_rzp_durable_idem';

      tables.billing_customers.push({ id: customerId, principal_id: principalId });
      tables.subscriptions.push({
        id: subId,
        customer_id: customerId,
        plan_id: 'pro',
        status: 'pending',
        gateway: 'razorpay',
        gateway_subscription_id: rzpSubId,
        currency: 'INR',
        amount_minor_units: 199900,
        current_period_start: 0,
        current_period_end: 0,
        cancel_at_period_end: false,
        metadata: JSON.stringify({ principalId, customerId, planTier: 'pro', customerState: '29' }), // Karnataka
        created_at: Date.now(),
        updated_at: Date.now()
      });

      const body = JSON.stringify({
        event: 'subscription.charged',
        payload: {
          subscription: {
            entity: {
              id: rzpSubId,
              plan_id: 'plan_pro_test',
              status: 'active',
              current_start: Math.floor(Date.now() / 1000),
              current_end: Math.floor(Date.now() / 1000) + 30 * 86400,
              paid_count: 1
            }
          },
          payment: {
            entity: {
              id: 'pay_durable_idem_01',
              order_id: 'order_rzp_idem_01',
              amount: 199900,
              currency: 'INR',
              status: 'captured'
            }
          }
        }
      });
      const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');

      // First webhook
      const res1 = await service.processRazorpayWebhook(body, sig);
      assert.equal(res1.status, 'PROCESSED');
      // Retry webhook with same payload
      const res2 = await service.processRazorpayWebhook(body, sig);
      assert.equal(res2.status, 'ALREADY_PROCESSED');

      const invoiceEvents = tables.billing_audit_events.filter(e => e.event_type === 'TAX_INVOICE_ISSUED');
      assert.equal(invoiceEvents.length, 1, 'Duplicate webhooks must not create duplicate invoices');

      const invoices = await service.getInvoices(principalId);
      assert.equal(invoices.length, 1);
      assert.equal(invoices[0].igstAmount, 304.93);
    });

    it('issues durable credit note upon refund webhook and links it to original invoice', async () => {
      const { dbClient, tables } = createMockDb();
      const service = new PaymentGatewayService();
      service.setDbClient(dbClient);
      const secret = 'test_rzp_webhook_secret_2026';
      service.setRazorpaySecret(secret);

      const customerId = 'cust_durable_ref';
      const principalId = 'usr_durable_ref';
      const subId = 'pur_sub_durable_ref';
      const rzpSubId = 'sub_rzp_durable_ref';
      const paymentId = 'pay_durable_ref_01';

      tables.billing_customers.push({ id: customerId, principal_id: principalId });
      tables.subscriptions.push({
        id: subId,
        customer_id: customerId,
        plan_id: 'plus',
        status: 'pending',
        gateway: 'razorpay',
        gateway_subscription_id: rzpSubId,
        currency: 'INR',
        amount_minor_units: 99900,
        current_period_start: 0,
        current_period_end: 0,
        cancel_at_period_end: false,
        metadata: JSON.stringify({ principalId, customerId, planTier: 'plus', customerState: '07' }),
        created_at: Date.now(),
        updated_at: Date.now()
      });

      // 1. Activate subscription and issue invoice
      const actBody = JSON.stringify({
        event: 'subscription.charged',
        payload: {
          subscription: {
            entity: {
              id: rzpSubId,
              status: 'active',
              current_start: Math.floor(Date.now() / 1000),
              current_end: Math.floor(Date.now() / 1000) + 30 * 86400,
              paid_count: 1
            }
          },
          payment: {
            entity: { id: paymentId, order_id: rzpSubId, amount: 99900, currency: 'INR', status: 'captured' }
          }
        }
      });
      const actSig = crypto.createHmac('sha256', secret).update(actBody).digest('hex');
      const actRes = await service.processRazorpayWebhook(actBody, actSig);
      assert.equal(actRes.status, 'PROCESSED');

      // Invoices prior to refund
      const initialInvoices = await service.getInvoices(principalId);
      assert.equal(initialInvoices[0].status, 'Paid');
      const invoiceNumber = initialInvoices[0].invoiceNumber;

      // 2. Process refund webhook
      const refBody = JSON.stringify({
        event: 'refund.processed',
        payload: {
          payment: { entity: { id: paymentId, order_id: rzpSubId } },
          refund: { entity: { id: 'rfnd_durable_01', payment_id: paymentId, amount: 99900, status: 'processed' } }
        }
      });
      const refSig = crypto.createHmac('sha256', secret).update(refBody).digest('hex');
      const refRes = await service.processRazorpayWebhook(refBody, refSig);
      assert.equal(refRes.status, 'PROCESSED');

      // Verify CREDIT_NOTE_ISSUED in billing_audit_events
      const creditNoteEvents = tables.billing_audit_events.filter(e => e.event_type === 'CREDIT_NOTE_ISSUED');
      assert.equal(creditNoteEvents.length, 1);
      assert.equal(creditNoteEvents[0].actor_id, 'CN-2026-0001');
      const cnPayload = JSON.parse(creditNoteEvents[0].payload);
      assert.equal(cnPayload.originalInvoiceNumber, invoiceNumber);

      // Verify invoice retrieval shows updated Refunded status and linked Credit Note number
      const updatedInvoices = await service.getInvoices(principalId);
      assert.equal(updatedInvoices[0].status, 'Refunded');
      assert.equal(updatedInvoices[0].creditNoteNumber, 'CN-2026-0001');
      assert.equal(updatedInvoices[0].refundAmount, 999);
    });
  });

  // =========================================================================
  // 7. PRODUCTION PAYMENT READINESS AUDIT
  // =========================================================================
  describe('7. Production Payment Readiness 14-Gate Audit', () => {
    it('evaluates all 14 gates with evidence-based status checks and correct overall verdict', () => {
      delete process.env.RAZORPAY_KEY_ID;
      process.env.RAZORPAY_WEBHOOK_SECRET = 'secret_rzp';

      const report = productionReadinessService.audit();
      assert.equal(report.totalGates, 14);
      assert.equal(report.gates.length, 14);

      // Verify that no gates have unverified hardcoded 'PASSED' without evidence checks
      for (const gate of report.gates) {
        assert.ok(
          gate.status === 'VERIFIED' || gate.status === 'PENDING_OWNER_ACTION' || gate.status === 'BLOCKED',
          `Gate ${gate.id} must have evidence-based status, got ${gate.status}`
        );
        assert.ok(gate.evidence && gate.evidence.length > 5, `Gate ${gate.id} must include tangible evidence`);
      }

      // In sandbox mode without live KYC, overall verdict must be PARTIALLY READY
      assert.equal(report.overallVerdict, 'COMMERCIAL PLATFORM PARTIALLY READY — EXTERNAL ACTION REQUIRED');
      assert.ok(report.pendingOwnerCount >= 2, 'Pending owner actions (KYC, international toggle) must be tracked');
    });
  });
});
