import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import {
  COMMERCIAL_PLANS,
  type PlanTier,
  type CurrencyCode
} from '../packages/contracts/src/commercial.js';
import {
  PaymentGatewayService,
  type PaymentDbClient
} from '../apps/api/src/billing/payment-gateway-service.js';
import { ProductionReadinessService } from '../apps/api/src/billing/production-readiness.js';

function createMockBillingDb(): PaymentDbClient {
  const store = new Map<string, Record<string, unknown>[]>();
  return (tableName: string) => {
    if (!store.has(tableName)) store.set(tableName, []);
    const table = store.get(tableName)!;
    return {
      where: (query: Record<string, unknown>) => ({
        first: async () => table.find(row => Object.entries(query).every(([k, v]) => row[k] === v)) || null,
        update: async (patch: Record<string, unknown>) => {
          for (const row of table) {
            if (Object.entries(query).every(([k, v]) => row[k] === v)) {
              Object.assign(row, patch);
            }
          }
        },
        delete: async () => {
          const remaining = table.filter(row => !Object.entries(query).every(([k, v]) => row[k] === v));
          store.set(tableName, remaining);
        },
        orderBy: async (column: string, direction = 'asc') => {
          return [...table].sort((a, b) => {
            const valA = String(a[column] ?? '');
            const valB = String(b[column] ?? '');
            if (direction === 'desc') return valB.localeCompare(valA);
            return valA.localeCompare(valB);
          }) as unknown as import('../apps/api/src/billing/payment-gateway-service.js').SubscriptionRow[];
        }
      }),
      insert: async (record: Record<string, unknown>) => {
        table.push({ ...record });
      }
    };
  };
}

describe('F1 — Plus/Pro Billing Integration and Subscription Readiness', () => {
  const testSecret = 'test_webhook_hmac_secret_2026_xyz!';

  describe('Cryptographic Webhook Signature Verification', () => {
    const gateway = new PaymentGatewayService();
    gateway.setRazorpaySecret(testSecret);
    gateway.setCashfreeSecret(testSecret);

    it('verifies valid Razorpay HMAC-SHA256 signature using constant-time comparison', () => {
      const rawBody = JSON.stringify({ event: 'subscription.charged', id: 'sub_123' });
      const validSig = crypto.createHmac('sha256', testSecret).update(rawBody).digest('hex');

      const result = gateway.verifyRazorpayWebhook(rawBody, validSig, testSecret);
      assert.equal(result.valid, true);
      assert.equal(result.error, undefined);
    });

    it('strictly rejects tampered payload with invalid signature', () => {
      const rawBody = JSON.stringify({ event: 'subscription.charged', id: 'sub_123' });
      const validSig = crypto.createHmac('sha256', testSecret).update(rawBody).digest('hex');
      const tamperedBody = JSON.stringify({ event: 'subscription.charged', id: 'sub_123', tampered: true });

      const result = gateway.verifyRazorpayWebhook(tamperedBody, validSig, testSecret);
      assert.equal(result.valid, false);
      assert.match(result.error || '', /Signature verification failed/);
    });

    it('rejects webhooks with signature length mismatch or wrong secret', () => {
      const rawBody = JSON.stringify({ event: 'subscription.charged' });
      const wrongSecretSig = crypto.createHmac('sha256', 'wrong_secret').update(rawBody).digest('hex');
      const badResult = gateway.verifyRazorpayWebhook(rawBody, wrongSecretSig, testSecret);
      assert.equal(badResult.valid, false);

      const truncatedResult = gateway.verifyRazorpayWebhook(rawBody, 'short_sig', testSecret);
      assert.equal(truncatedResult.valid, false);
      assert.match(truncatedResult.error || '', /Signature length mismatch/);
    });

    it('verifies Cashfree webhook signature with timestamp binding', () => {
      const timestamp = String(Date.now());
      const rawBody = JSON.stringify({ type: 'SUBSCRIPTION_PAYMENT_SUCCESS' });
      const expectedSig = crypto.createHmac('sha256', testSecret).update(`${timestamp}${rawBody}`).digest('base64');

      const result = gateway.verifyCashfreeWebhook(rawBody, expectedSig, timestamp, testSecret);
      assert.equal(result.valid, true);

      // Tampered timestamp
      const badTimeResult = gateway.verifyCashfreeWebhook(rawBody, expectedSig, '1234567890', testSecret);
      assert.equal(badTimeResult.valid, false);
    });
  });

  describe('Webhook Event Deduplication & Idempotency', () => {
    it('records first event as PROCESSED and deduplicates identical retry as ALREADY_PROCESSED', async () => {
      const mockDb = createMockBillingDb();
      const gateway = new PaymentGatewayService();
      gateway.setRazorpaySecret(testSecret);
      gateway.setDbClient(mockDb);

      const eventId = `evt_dedup_${Date.now()}`;
      const payload = {
        event_id: eventId,
        event: 'subscription.halted',
        subscription: {
          id: `sub_gw_${Date.now()}`
        }
      };
      const rawBody = JSON.stringify(payload);
      const signature = crypto.createHmac('sha256', testSecret).update(rawBody).digest('hex');

      // First delivery: processes event
      const res1 = await gateway.processRazorpayWebhook(rawBody, signature);
      assert.equal(res1.status, 'PROCESSED');
      assert.equal(res1.duplicate, false);

      // Replay delivery: skips processing idempotently
      const res2 = await gateway.processRazorpayWebhook(rawBody, signature);
      assert.equal(res2.status, 'ALREADY_PROCESSED');
      assert.equal(res2.duplicate, true);
    });
  });

  describe('Commercial Subscription Lifecycle & State Machine', () => {
    it('updates subscription status to cancelled on subscription.cancelled event', async () => {
      const mockDb = createMockBillingDb();
      const gateway = new PaymentGatewayService();
      gateway.setRazorpaySecret(testSecret);
      gateway.setDbClient(mockDb);

      const gatewaySubId = `sub_active_to_cancel_${Date.now()}`;

      // Insert pre-existing active subscription row in mock DB
      await mockDb('subscriptions').insert({
        id: `sub_rec_${Date.now()}`,
        customer_id: 'cust_alpha_1',
        plan_id: 'plus',
        price_id: 'price_plus_inr',
        status: 'active',
        gateway: 'razorpay',
        gateway_subscription_id: gatewaySubId,
        currency: 'INR',
        amount_minor_units: 39900,
        current_period_start: Date.now() - 5000,
        current_period_end: Date.now() + 25 * 24 * 60 * 60 * 1000,
        cancel_at_period_end: false,
        created_at: Date.now(),
        updated_at: Date.now()
      });

      const eventId = `evt_cancel_${Date.now()}`;
      const payload = {
        event_id: eventId,
        event: 'subscription.cancelled',
        payload: {
          subscription: {
            entity: {
              id: gatewaySubId
            }
          }
        }
      };

      const rawBody = JSON.stringify(payload);
      const signature = crypto.createHmac('sha256', testSecret).update(rawBody).digest('hex');

      const result = await gateway.processRazorpayWebhook(rawBody, signature);
      assert.equal(result.status, 'PROCESSED');

      // Verify DB record status transitioned to 'cancelled'
      const updatedSub = await mockDb('subscriptions').where({ gateway_subscription_id: gatewaySubId }).first();
      assert.ok(updatedSub);
      assert.equal(updatedSub.status, 'cancelled');
      assert.ok(updatedSub.cancelled_at);
    });
  });

  describe('Production Gating & Fail-Closed Security', () => {
    it('fails closed with BILLING_UNAVAILABLE on subscription checkout', async () => {
      const gateway = new PaymentGatewayService();

      await assert.rejects(
        async () => {
          await gateway.createSubscriptionCheckout('usr_buyer_1', 'plus', 'INR');
        },
        /BILLING_UNAVAILABLE/
      );

      await assert.rejects(
        async () => {
          await gateway.createSubscriptionCheckout('usr_buyer_2', 'pro', 'USD');
        },
        /BILLING_UNAVAILABLE/
      );
    });

    it('ProductionReadinessService audits all 14 mandatory production payment gates', () => {
      const originalRazorpay = process.env.RAZORPAY_WEBHOOK_SECRET;
      try {
        delete process.env.RAZORPAY_WEBHOOK_SECRET;
        delete process.env.CASHFREE_WEBHOOK_SECRET;

        const readiness = new ProductionReadinessService();
        const blockedReport = readiness.audit();
        assert.equal(blockedReport.totalGates, 14);
        assert.equal(blockedReport.overallVerdict, 'COMMERCIAL PLATFORM BLOCKED — REMEDIATION REQUIRED');
        assert.ok(blockedReport.blockedCount > 0);

        // When sandbox webhook secret is configured
        process.env.RAZORPAY_WEBHOOK_SECRET = 'sandbox_test_secret_123';
        const readyReport = readiness.audit();
        assert.equal(readyReport.overallVerdict, 'COMMERCIAL PLATFORM PARTIALLY READY — EXTERNAL ACTION REQUIRED');
        assert.equal(readyReport.blockedCount, 0);
        assert.ok(readyReport.pendingOwnerCount > 0);

        const gateIds = readyReport.gates.map(g => g.id);
        assert.ok(gateIds.includes('GATE_01_MERCHANT_KYC'));
        assert.ok(gateIds.includes('GATE_02_DOMESTIC_RECURRING'));
        assert.ok(gateIds.includes('GATE_04_GATEWAY_KEYS_PROTECTION'));
        assert.ok(gateIds.includes('GATE_05_WEBHOOK_VERIFICATION'));
        assert.ok(gateIds.includes('GATE_06_BUSINESS_IDENTITY'));
        assert.ok(gateIds.includes('GATE_08_GST_TAX_COMPLIANCE'));
        assert.ok(gateIds.includes('GATE_09_INVOICE_COMPLIANCE'));
        assert.ok(gateIds.includes('GATE_14_EMERGENCY_KILL_SWITCH'));
      } finally {
        if (originalRazorpay !== undefined) process.env.RAZORPAY_WEBHOOK_SECRET = originalRazorpay;
        else delete process.env.RAZORPAY_WEBHOOK_SECRET;
      }
    });
  });
});
