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
      credit_grants: []
    };

    const dbClient: any = (tableName: string) => {
      let filterQuery: Record<string, any> = {};
      let whereInFilter: { column: string; values: any[] } | null = null;
      let orderCol: string | null = null;
      let orderDir: string = 'asc';

      const builder: any = {
        where: (query: Record<string, any>) => {
          Object.assign(filterQuery, query);
          return builder;
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
          return rows.find(r => {
            const matchesObj = Object.entries(filterQuery).every(([k, v]) => r[k] === v);
            if (!matchesObj) return false;
            if (whereInFilter) {
              return whereInFilter.values.includes(r[whereInFilter.column]);
            }
            return true;
          }) || null;
        },
        select: async () => {
          const rows = tables[tableName] || [];
          return rows.filter(r => {
            const matchesObj = Object.entries(filterQuery).every(([k, v]) => r[k] === v);
            if (!matchesObj) return false;
            if (whereInFilter) {
              return whereInFilter.values.includes(r[whereInFilter.column]);
            }
            return true;
          });
        },
        update: async (patch: Record<string, any>) => {
          const rows = tables[tableName] || [];
          for (const r of rows) {
            const matchesObj = Object.entries(filterQuery).every(([k, v]) => r[k] === v);
            const matchesIn = !whereInFilter || whereInFilter.values.includes(r[whereInFilter.column]);
            if (matchesObj && matchesIn) {
              Object.assign(r, patch);
            }
          }
        },
        delete: async () => {
          const rows = tables[tableName] || [];
          tables[tableName] = rows.filter(r => {
            const matchesObj = Object.entries(filterQuery).every(([k, v]) => r[k] === v);
            const matchesIn = !whereInFilter || whereInFilter.values.includes(r[whereInFilter.column]);
            return !(matchesObj && matchesIn);
          });
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
        }
      };
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
        'cashfree'
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

      const timestamp = '1729355000';
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
          'x-webhook-timestamp': '1729350000'
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
      tables.subscriptions.push({
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
        created_at: now,
        updated_at: now
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
