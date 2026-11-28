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

      const gatewaySubId = `sub_gw_${Date.now()}`;
      const unseededRawBody = JSON.stringify({
        event_id: `evt_unseeded_${Date.now()}`,
        event: 'subscription.halted',
        subscription: { id: gatewaySubId }
      });
      const unseededSig = crypto.createHmac('sha256', testSecret).update(unseededRawBody).digest('hex');
      await assert.rejects(
        async () => gateway.processRazorpayWebhook(unseededRawBody, unseededSig),
        /BILLING_RECONCILIATION_FAILED: No authoritative subscription record found/
      );

      await mockDb('subscriptions').insert({
        id: `sub_dedup_rec_${Date.now()}`,
        customer_id: 'cust_dedup_1',
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

      const eventId = `evt_dedup_${Date.now()}`;
      const payload = {
        event_id: eventId,
        event: 'subscription.halted',
        subscription: {
          id: gatewaySubId
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
    it('fails closed with BILLING_UNAVAILABLE on subscription checkout when disabled', async () => {
      const gateway = new PaymentGatewayService();

      const origBillingEnabled = process.env.AIRA_COMMERCIAL_BILLING_ENABLED;
      try {
        delete process.env.AIRA_COMMERCIAL_BILLING_ENABLED;

        await assert.rejects(
          async () => {
            await gateway.createSubscriptionCheckout('usr_buyer_1', 'plus', 'INR');
          },
          /BILLING_UNAVAILABLE: Live checkout has not been approved or integrated/
        );

        await assert.rejects(
          async () => {
            await gateway.createSubscriptionCheckout('usr_buyer_2', 'pro', 'USD');
          },
          /BILLING_UNAVAILABLE: Live checkout has not been approved or integrated/
        );
      } finally {
        if (origBillingEnabled !== undefined) process.env.AIRA_COMMERCIAL_BILLING_ENABLED = origBillingEnabled;
        else delete process.env.AIRA_COMMERCIAL_BILLING_ENABLED;
      }
    });

    it('creates checkout session and links authoritative purchase order when commercial billing toggle is enabled', async () => {
      const mockDb = createMockBillingDb();
      const gateway = new PaymentGatewayService();
      gateway.setDbClient(mockDb);
      gateway.setRazorpaySecret(testSecret);

      const origBillingEnabled = process.env.AIRA_COMMERCIAL_BILLING_ENABLED;
      const origTestFulfillment = process.env.AIRA_ENABLE_TEST_FULFILLMENT;
      const origKeyId = process.env.RAZORPAY_KEY_ID;

      try {
        process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'true';
        process.env.AIRA_ENABLE_TEST_FULFILLMENT = 'true';
        delete process.env.RAZORPAY_KEY_ID;
        delete process.env.CASHFREE_APP_ID;
        delete process.env.AIRA_TEST_GATEWAY_KEY_ID;

        // Fails closed if credentials are missing even when toggle is enabled
        await assert.rejects(
          async () => {
            await gateway.createSubscriptionCheckout('usr_buyer_1', 'plus', 'INR');
          },
          /BILLING_UNAVAILABLE: Gateway credentials not configured/
        );

        // When gateway credentials are configured
        process.env.RAZORPAY_KEY_ID = 'rzp_test_key_sample123';

        const checkout = await gateway.createSubscriptionCheckout('usr_buyer_1', 'plus', 'INR');
        assert.ok(checkout.orderId);
        assert.ok(checkout.purchaseId);
        assert.equal(checkout.keyId, 'rzp_test_key_sample123');
        assert.equal(checkout.amount, 39900);
        assert.equal(checkout.currency, 'INR');
        assert.equal(checkout.isSandbox, true);
        // Invariant: No synthetic checkout URL presented as real
        assert.equal(checkout.checkoutUrl, undefined);

        // Verify authoritative database purchase record linking
        const purchaseRecord = await mockDb('subscriptions').where({ id: checkout.purchaseId }).first();
        assert.ok(purchaseRecord);
        assert.equal(purchaseRecord.status, 'pending');
        assert.equal(purchaseRecord.gateway_subscription_id, checkout.orderId);
        assert.equal(purchaseRecord.amount_minor_units, 39900);
        assert.equal(purchaseRecord.currency, 'INR');

        // Verify authoritative audit ledger event linking order to principal
        const auditEvent = await mockDb('billing_audit_events').where({ customer_id: purchaseRecord.customer_id }).first();
        assert.ok(auditEvent);
        assert.equal(auditEvent.event_type, 'CHECKOUT_ORDER_CREATED');
        assert.equal(auditEvent.actor_id, 'usr_buyer_1');

        const payload = JSON.parse(auditEvent.payload as string);
        assert.equal(payload.orderId, checkout.orderId);
        assert.equal(payload.principalId, 'usr_buyer_1');
        assert.equal(payload.planTier, 'plus');
        assert.equal(payload.amount, 39900);
        assert.equal(payload.currency, 'INR');
        assert.equal(payload.status, 'PENDING_PAYMENT');

        // Test Pro USD checkout
        const proCheckout = await gateway.createSubscriptionCheckout('usr_buyer_pro', 'pro', 'USD');
        assert.equal(proCheckout.amount, 1999);
        assert.equal(proCheckout.currency, 'USD');
        assert.equal(proCheckout.isSandbox, true);
        assert.equal(proCheckout.checkoutUrl, undefined);

        // Test Pro INR checkout (reconciled to 99900 paise / ₹999 inclusive of GST)
        const proInrCheckout = await gateway.createSubscriptionCheckout('usr_buyer_pro_inr', 'pro', 'INR');
        assert.equal(proInrCheckout.amount, 99900);
        assert.equal(proInrCheckout.currency, 'INR');

        // Test production pricing gating: in production mode, unapproved currency fails closed
        const origNodeEnv = process.env.NODE_ENV;
        const origTestFulfillment = process.env.AIRA_ENABLE_TEST_FULFILLMENT;
        try {
          process.env.NODE_ENV = 'production';
          delete process.env.AIRA_ENABLE_TEST_FULFILLMENT;

          await assert.rejects(
            async () => {
              await gateway.createSubscriptionCheckout('usr_buyer_prod', 'plus', 'EUR' as any);
            },
            /BILLING_UNAVAILABLE: Production plan pricing for plus \(EUR\) has not received documented owner approval/
          );

          // In production mode without live gateway secrets or mock transport, checkout fails closed securely
          await assert.rejects(
            async () => {
              await gateway.createSubscriptionCheckout('usr_buyer_prod', 'plus', 'INR');
            },
            /BILLING_UNAVAILABLE: Live gateway secret keys not configured for order creation/
          );
        } finally {
          process.env.NODE_ENV = origNodeEnv;
          if (origTestFulfillment !== undefined) process.env.AIRA_ENABLE_TEST_FULFILLMENT = origTestFulfillment;
        }

        // Test legitimate webhook reconciliation against authoritative purchase record
        const webhookEventId = `evt_recon_${Date.now()}`;
        const webhookPayload = {
          event_id: webhookEventId,
          event: 'subscription.charged',
          payload: {
            subscription: {
              entity: {
                id: checkout.orderId,
                currency: 'INR',
                amount: 39900
              }
            }
          }
        };
        const rawBody = JSON.stringify(webhookPayload);
        const signature = crypto.createHmac('sha256', testSecret).update(rawBody).digest('hex');

        // Fulfillment reconciles with pre-existing pending purchase record
        const reconResult = await gateway.processRazorpayWebhook(rawBody, signature);
        assert.equal(reconResult.status, 'PROCESSED');

        // Verify purchase record status transitioned to 'active'
        const updatedPurchase = await mockDb('subscriptions').where({ id: checkout.purchaseId }).first();
        assert.ok(updatedPurchase);
        assert.equal(updatedPurchase.status, 'active');

        // Test un-reconciled webhook (missing purchase record) is rejected
        const fakeOrderId = `order_unreconciled_${Date.now()}`;
        const badPayload = {
          event_id: `evt_bad_${Date.now()}`,
          event: 'subscription.charged',
          payload: {
            subscription: {
              entity: {
                id: fakeOrderId,
                currency: 'INR',
                amount: 39900
              }
            }
          }
        };
        const badRaw = JSON.stringify(badPayload);
        const badSig = crypto.createHmac('sha256', testSecret).update(badRaw).digest('hex');

        await assert.rejects(
          async () => {
            await gateway.processRazorpayWebhook(badRaw, badSig);
          },
          /BILLING_RECONCILIATION_FAILED: No authoritative purchase record found/
        );

        // Test currency fraud detection
        const fraudOrderId = `sub_fraud_${Date.now()}`;
        await mockDb('subscriptions').insert({
          id: `pur_fraud_1`,
          customer_id: 'cust_fraud_1',
          plan_id: 'plus',
          price_id: 'price_plus_inr',
          status: 'pending',
          gateway: 'razorpay',
          gateway_subscription_id: fraudOrderId,
          currency: 'INR',
          amount_minor_units: 39900,
          current_period_start: Date.now(),
          current_period_end: Date.now(),
          cancel_at_period_end: false,
          metadata: JSON.stringify({ principalId: 'usr_fraud_target' }),
          created_at: Date.now(),
          updated_at: Date.now()
        });

        const fraudCurrencyPayload = {
          event_id: `evt_fraud_curr_${Date.now()}`,
          event: 'subscription.charged',
          payload: {
            subscription: {
              entity: {
                id: fraudOrderId,
                currency: 'USD', // Fraudulent currency injection
                amount: 39900
              }
            }
          }
        };
        const fraudRaw = JSON.stringify(fraudCurrencyPayload);
        const fraudSig = crypto.createHmac('sha256', testSecret).update(fraudRaw).digest('hex');

        await assert.rejects(
          async () => {
            await gateway.processRazorpayWebhook(fraudRaw, fraudSig);
          },
          /FRAUD_CHECK_FAILED: Currency mismatch/
        );
      } finally {
        if (origBillingEnabled !== undefined) process.env.AIRA_COMMERCIAL_BILLING_ENABLED = origBillingEnabled;
        else delete process.env.AIRA_COMMERCIAL_BILLING_ENABLED;
        if (origTestFulfillment !== undefined) process.env.AIRA_ENABLE_TEST_FULFILLMENT = origTestFulfillment;
        else delete process.env.AIRA_ENABLE_TEST_FULFILLMENT;
        if (origKeyId !== undefined) process.env.RAZORPAY_KEY_ID = origKeyId;
        else delete process.env.RAZORPAY_KEY_ID;
      }
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
        assert.ok(gateIds.includes('GATE_08_GST_COMPLIANCE'));
        assert.ok(gateIds.includes('GATE_09_INVOICE_COMPLIANCE'));
        assert.ok(gateIds.includes('GATE_14_EMERGENCY_ROLLBACK'));
      } finally {
        if (originalRazorpay !== undefined) process.env.RAZORPAY_WEBHOOK_SECRET = originalRazorpay;
        else delete process.env.RAZORPAY_WEBHOOK_SECRET;
      }
    });
  });
});
