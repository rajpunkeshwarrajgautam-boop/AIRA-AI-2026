/**
 * AIRA AI 2026 — Checkout Concurrency, Idempotency & Database Integrity Suite
 *
 * Verifies:
 * 1. Customer Concurrency Locking (DB-03, DB-04, SF-04)
 * 2. Active Pending Session Deduplication (DB-08, SF-03)
 * 3. Gateway Timeout & Ambiguous Outcome Handling (DB-05, SF-01, SF-02)
 * 4. Two-Phase Reservation State Transitions (DB-01, DB-02, DB-06)
 * 5. Savepoint Isolation & Invoice Failure Resilience (DB-07, SF-08)
 * 6. Upgrade Mandate Superseding & Asynchronous Cancellation (SF-05)
 * 7. Webhook Freshness & Replay Window Enforcement (SEC-03)
 * 8. Invoices Truthful Failure Propagation (SF-09)
 * 9. Migration 034 Database Constraints (DB-01, DB-02)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paymentGatewayService } from '../apps/api/src/billing/payment-gateway-service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

describe('Checkout Concurrency, Idempotency & DB Integrity Suite', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'true';
    process.env.AIRA_ENABLE_TEST_FULFILLMENT = 'true';
    process.env.RAZORPAY_KEY_ID = 'rzp_test_concurrency';
    process.env.RAZORPAY_KEY_SECRET = 'rzp_test_concurrency_secret';
    process.env.RAZORPAY_WEBHOOK_SECRET = 'rzp_test_concurrency_secret';
    process.env.CASHFREE_APP_ID = 'cf_test_concurrency';
    process.env.CASHFREE_SECRET_KEY = 'cf_test_concurrency_secret';
    process.env.CASHFREE_WEBHOOK_SECRET = 'cf_test_concurrency_secret';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function createMockDb() {
    const tables: Record<string, any[]> = {
      billing_customers: [
        { id: 'cust_concurrency_test', principal_id: 'neon_user_concurrency', name: 'Concurrency User' },
        { id: 'cust_upgrade_test', principal_id: 'neon_user_upgrade', name: 'Upgrade User' },
        { id: 'cust_dedup_test', principal_id: 'neon_user_dedup', name: 'Dedup User' },
        { id: 'cust_fail_test', principal_id: 'neon_user_fail', name: 'Fail User' }
      ],
      subscriptions: [],
      payment_gateway_events: [],
      billing_audit_events: [],
      idempotent_operations: [],
      credit_accounts: [],
      credit_transactions: [],
      credit_grants: [],
      billing_invoices: [],
      subscription_cancellation_outbox: [],
      billing_invoice_reconciliation_outbox: []
    };

    const mockDb: any = ((tableName: string) => {
      let filterQuery: Record<string, any> = {};
      let notFilterQuery: Record<string, any> = {};
      let comparisonFilters: Array<(r: any) => boolean> = [];
      let limitCount: number | null = null;

      const matchRow = (r: any): boolean => {
        const matchesEq = Object.entries(filterQuery).every(([k, v]) => r[k] === v);
        const matchesNot = Object.entries(notFilterQuery).every(([k, v]) => r[k] !== v);
        const matchesComp = comparisonFilters.every(fn => fn(r));
        return matchesEq && matchesNot && matchesComp;
      };

      const builder: any = {
        where: (queryOrCol: any, opOrVal?: any, val?: any) => {
          if (typeof queryOrCol === 'function') {
            comparisonFilters.push(r => {
              if (r.state !== undefined) {
                const stateOk = r.state === 'PENDING' || (r.state === 'CLAIMED' && Number(r.lease_until) <= Date.now());
                const nextAttemptOk = r.next_attempt_at === null || r.next_attempt_at === undefined || Number(r.next_attempt_at) <= Date.now();
                return stateOk && nextAttemptOk;
              }
              return true;
            });
          } else if (typeof queryOrCol === 'string') {
            if (val !== undefined) {
              const op = opOrVal;
              if (op === '>') comparisonFilters.push(r => Number(r[queryOrCol]) > Number(val));
              else if (op === '<') comparisonFilters.push(r => Number(r[queryOrCol]) < Number(val));
              else if (op === '>=') comparisonFilters.push(r => Number(r[queryOrCol]) >= Number(val));
              else if (op === '<=') comparisonFilters.push(r => Number(r[queryOrCol]) <= Number(val));
              else filterQuery[queryOrCol] = val;
            } else {
              filterQuery[queryOrCol] = opOrVal;
            }
          } else if (typeof queryOrCol === 'object') {
            Object.assign(filterQuery, queryOrCol);
          }
          return builder;
        },
        andWhere: (queryOrCol: any, opOrVal?: any, val?: any) => builder.where(queryOrCol, opOrVal, val),
        whereNot: (queryOrCol: any, val?: any) => {
          if (typeof queryOrCol === 'string') {
            notFilterQuery[queryOrCol] = val;
          } else if (typeof queryOrCol === 'object') {
            Object.assign(notFilterQuery, queryOrCol);
          }
          return builder;
        },
        whereIn: (col: string, values: any[]) => {
          comparisonFilters.push(r => values.includes(r[col]));
          return builder;
        },
        whereNull: (col: string) => {
          comparisonFilters.push(r => r[col] === null || r[col] === undefined);
          return builder;
        },
        orWhere: () => builder,
        limit: (n: number) => {
          limitCount = n;
          return builder;
        },
        first: async () => {
          const rows = tables[tableName] || [];
          return rows.find(matchRow) || null;
        },
        select: async () => {
          const rows = tables[tableName] || [];
          const filtered = rows.filter(matchRow);
          return limitCount !== null ? filtered.slice(0, limitCount) : filtered;
        },
        then: (onfulfilled?: any, onrejected?: any) => {
          return builder.select().then(onfulfilled, onrejected);
        },
        orderBy: () => builder,
        insert: (data: any) => {
          const items = Array.isArray(data) ? data : [data];
          const queryBuilder: any = Promise.resolve().then(() => {
            for (const item of items) {
              const pk = item.id || item.key;
              const existingIdx = tables[tableName]?.findIndex(r => (r.id && r.id === pk) || (r.key && r.key === pk));
              if (existingIdx !== undefined && existingIdx !== -1) {
                tables[tableName][existingIdx] = { ...tables[tableName][existingIdx], ...item };
              } else {
                if (!tables[tableName]) tables[tableName] = [];
                tables[tableName].push({ ...item });
              }
            }
            return items;
          });
          queryBuilder.onConflict = (_target: string | string[]) => {
            return {
              merge: (updateData: any) => {
                return Promise.resolve().then(() => {
                  for (const item of items) {
                    const pk = item.id || item.key;
                    const existingIdx = tables[tableName]?.findIndex(r => (r.id && r.id === pk) || (r.key && r.key === pk));
                    if (existingIdx !== undefined && existingIdx !== -1) {
                      tables[tableName][existingIdx] = { ...tables[tableName][existingIdx], ...updateData };
                    } else {
                      if (!tables[tableName]) tables[tableName] = [];
                      tables[tableName].push({ ...item });
                    }
                  }
                  return items;
                });
              },
              ignore: () => queryBuilder
            };
          };
          return queryBuilder;
        },
        update: async (data: any) => {
          const rows = tables[tableName] || [];
          let count = 0;
          for (const row of rows) {
            if (matchRow(row)) {
              Object.assign(row, data);
              count++;
            }
          }
          return count;
        }
      };
      return builder;
    });

    mockDb.transaction = async (cb: (trx: any) => Promise<any>) => {
      return cb(mockDb);
    };

    mockDb.raw = async () => ({ rows: [] });
    mockDb.schema = {
      hasTable: async () => true
    };

    return { mockDb, tables };
  }

  // =========================================================================
  // 1. CUSTOMER CONCURRENCY LOCKING (DB-03, DB-04, SF-04)
  // =========================================================================
  describe('1. Customer Concurrency Locking & Idempotent Operations', () => {
    it('rejects concurrent checkout request for the same customer while lease is active', async () => {
      const { mockDb, tables } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);

      // Pre-seed an active IN_PROGRESS lease for the customer
      tables.idempotent_operations.push({
        key: 'checkout:sub:cust_concurrency_test',
        principal_id: 'neon_user_concurrency',
        operation_id: 'op_existing_active_session',
        operation_type: 'subscription_checkout',
        payload_hash: 'hash123',
        status: 'IN_PROGRESS',
        locked_until: Date.now() + 25000,
        created_at: Date.now(),
        updated_at: Date.now()
      });

      await assert.rejects(
        async () => {
          await paymentGatewayService.createSubscriptionCheckout(
            'neon_user_concurrency',
            'pro',
            'INR',
            'razorpay',
            { userId: 'neon_user_concurrency' },
            undefined,
            'op_new_concurrent_attempt'
          );
        },
        (err: any) => {
          assert.ok(err.message.includes('CONCURRENT_CHECKOUT_IN_PROGRESS'));
          return true;
        }
      );
    });

    it('returns cached completed response when client sends duplicate idempotency key with matching payload', async () => {
      const { mockDb, tables } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);

      const cachedPayload = {
        purchaseId: 'pur_cached_123',
        orderId: 'sub_cached_gateway_order',
        keyId: 'rzp_test_mock',
        amount: 99900,
        currency: 'INR',
        gateway: 'razorpay',
        isSandbox: true,
        checkoutUrl: 'https://rzp.io/i/sub_cached'
      };

      const expectedPayloadHash = crypto
        .createHash('sha256')
        .update('cust_concurrency_test:pro:INR:razorpay')
        .digest('hex');

      tables.idempotent_operations.push({
        key: 'op_res:op_client_dedup_key',
        principal_id: 'neon_user_concurrency',
        operation_id: 'op_client_dedup_key',
        operation_type: 'subscription_checkout',
        payload_hash: expectedPayloadHash,
        status: 'COMPLETED',
        response_status: 200,
        response_body: JSON.stringify(cachedPayload),
        locked_until: 0,
        created_at: Date.now() - 5000,
        updated_at: Date.now() - 5000
      });

      const res = await paymentGatewayService.createSubscriptionCheckout(
        'neon_user_concurrency',
        'pro',
        'INR',
        'razorpay',
        { userId: 'neon_user_concurrency' },
        undefined,
        'op_client_dedup_key'
      );

      assert.strictEqual(res.purchaseId, 'pur_cached_123');
      assert.strictEqual(res.orderId, 'sub_cached_gateway_order');
      assert.strictEqual(res.checkoutUrl, 'https://rzp.io/i/sub_cached');
    });

    it('rejects duplicate idempotency key when request payload parameters conflict (E2E-03)', async () => {
      const { mockDb, tables } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);

      const cachedPayload = {
        purchaseId: 'pur_cached_123',
        orderId: 'sub_cached_gateway_order',
        gateway: 'razorpay'
      };

      // Hash generated for plan 'plus'
      const plusHash = crypto
        .createHash('sha256')
        .update(JSON.stringify({ planTier: 'plus', currency: 'INR', gateway: 'razorpay', customerId: 'cust_concurrency_test' }))
        .digest('hex');

      tables.idempotent_operations.push({
        key: 'op_res:op_conflict_key',
        principal_id: 'neon_user_concurrency',
        operation_id: 'op_conflict_key',
        operation_type: 'subscription_checkout',
        payload_hash: plusHash,
        status: 'COMPLETED',
        response_status: 200,
        response_body: JSON.stringify(cachedPayload),
        locked_until: 0,
        created_at: Date.now() - 5000,
        updated_at: Date.now() - 5000
      });

      // Attempting with 'pro' should trigger IDEMPOTENCY_KEY_PAYLOAD_MISMATCH
      await assert.rejects(
        async () => {
          await paymentGatewayService.createSubscriptionCheckout(
            'neon_user_concurrency',
            'pro', // Mismatched tier!
            'INR',
            'razorpay',
            { userId: 'neon_user_concurrency' },
            undefined,
            'op_conflict_key'
          );
        },
        (err: any) => {
          assert.ok(err.message.includes('IDEMPOTENCY_KEY_PAYLOAD_MISMATCH'));
          return true;
        }
      );
    });
  });

  // =========================================================================
  // 2. ACTIVE PENDING SESSION DEDUPLICATION (DB-08, SF-03)
  // =========================================================================
  describe('2. Active Pending Session Deduplication', () => {
    it('returns existing pending checkout within 15 minutes instead of generating duplicate provider orders', async () => {
      const { mockDb, tables } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);

      // Pre-seed an existing pending subscription created 5 minutes ago
      tables.subscriptions.push({
        id: 'pur_existing_pending_sub',
        customer_id: 'cust_dedup_test',
        plan_id: 'pro',
        price_id: 'price_pro_inr',
        status: 'pending',
        gateway: 'cashfree',
        gateway_subscription_id: 'cf_sub_order_456',
        currency: 'INR',
        amount_minor_units: 99900,
        metadata: JSON.stringify({
          subsSessionId: 'subs_session_active_dedup_123',
          checkoutUrl: 'https://payments-test.cashfree.com/links/cf_sub_order_456'
        }),
        created_at: Date.now() - 5 * 60 * 1000,
        updated_at: Date.now() - 5 * 60 * 1000
      });

      const res = await paymentGatewayService.createSubscriptionCheckout(
        'neon_user_dedup',
        'pro',
        'INR',
        'cashfree',
        { userId: 'neon_user_dedup' },
        { phone: '9876543210' }
      );

      assert.strictEqual(res.purchaseId, 'pur_existing_pending_sub');
      assert.strictEqual(res.subsSessionId, 'subs_session_active_dedup_123');
      assert.strictEqual(res.checkoutUrl, 'https://payments-test.cashfree.com/links/cf_sub_order_456');
    });
  });

  // =========================================================================
  // 3. GATEWAY TIMEOUT & AMBIGUOUS OUTCOME HANDLING (DB-05, SF-01, SF-02)
  // =========================================================================
  describe('3. Gateway Timeout & Ambiguous Failure Classification', () => {
    it('marks initiating subscription as ambiguous_timeout, sets lease to AMBIGUOUS, and blocks subsequent checkouts (E2E-03)', async () => {
      const { mockDb, tables } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);

      // Inject custom transport that simulates an AbortError / TimeoutError
      paymentGatewayService.setGatewayTransport(async () => {
        const timeoutErr = new Error('Gateway dispatch timed out after 15 seconds');
        timeoutErr.name = 'TimeoutError';
        throw timeoutErr;
      });

      await assert.rejects(
        async () => {
          await paymentGatewayService.createSubscriptionCheckout(
            'neon_user_fail',
            'plus',
            'INR',
            'razorpay',
            { userId: 'neon_user_fail' },
            undefined,
            'op_timeout_test'
          );
        },
        (err: any) => {
          assert.ok(err.message.includes('GATEWAY_AMBIGUOUS_OUTCOME'));
          return true;
        }
      );

      // Verify subscriptions record transitioned to ambiguous_timeout
      const sub = tables.subscriptions.find(s => s.customer_id === 'cust_fail_test');
      assert.ok(sub, 'Must persist subscription row');
      assert.strictEqual(sub.status, 'ambiguous_timeout');

      const meta = JSON.parse(sub.metadata);
      assert.strictEqual(meta.reconciliationStatus, 'MANUAL_OR_WEBHOOK_RECONCILIATION_REQUIRED');

      // Verify idempotent operations lease was released with status AMBIGUOUS and 504
      const lease = tables.idempotent_operations.find(op => op.key === 'checkout:sub:cust_fail_test');
      assert.ok(lease, 'Lease record must exist');
      assert.strictEqual(lease.status, 'AMBIGUOUS');
      assert.strictEqual(lease.response_status, 504);
      assert.strictEqual(lease.locked_until, 0);

      // E2E-03 Assertion: Verify subsequent checkout attempt is BLOCKED while ambiguous_timeout remains unresolved
      paymentGatewayService.setGatewayTransport(async () => {
        return { gatewayOrderId: 'sub_would_be_duplicate' };
      });

      await assert.rejects(
        async () => {
          await paymentGatewayService.createSubscriptionCheckout(
            'neon_user_fail',
            'plus',
            'INR',
            'razorpay',
            { userId: 'neon_user_fail' }
          );
        },
        (err: any) => {
          assert.ok(err.message.includes('GATEWAY_AMBIGUOUS_OUTCOME'));
          assert.ok(err.message.includes('pending reconciliation'));
          return true;
        }
      );

      // Authoritative reconciliation resolves the ambiguous subscription with verified provider query evidence and authorized operator audit trail (V-01)
      const reconResult = await paymentGatewayService.reconcileAmbiguousSubscription(sub.id, mockDb, 'failed', {
        providerEvidence: {
          trustedServerVerified: true,
          gateway: 'razorpay',
          environment: 'sandbox',
          customerId: 'cust_fail_test',
          orderId: sub.id,
          exists: false,
          status: 'NOT_FOUND',
          verificationTimestamp: Date.now()
        },
        operatorAuth: {
          operatorId: 'op_compliance_officer',
          justification: 'Gateway query confirmed order was never created after timeout',
          evidenceReference: 'AUDIT_REF_TIMEOUT_504'
        }
      });
      assert.strictEqual(reconResult.reconciled, true);
      assert.strictEqual(reconResult.status, 'failed');
      assert.strictEqual(sub.status, 'failed');

      // Subsequent attempt post-reconciliation now succeeds
      const postReconRes = await paymentGatewayService.createSubscriptionCheckout(
        'neon_user_fail',
        'plus',
        'INR',
        'razorpay',
        { userId: 'neon_user_fail' }
      );
      assert.ok(postReconRes.purchaseId);

      // Clean up transport
      paymentGatewayService.setGatewayTransport(null as any);
    });
  });

  // =========================================================================
  // 4. TWO-PHASE RESERVATION STATE TRANSITIONS (DB-01, DB-02, DB-06)
  // =========================================================================
  describe('4. Two-Phase Reservation State Transitions', () => {
    it('transitions reservation from initiating to pending on successful gateway order dispatch', async () => {
      const { mockDb, tables } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);

      // Use custom transport to verify successful dispatch
      paymentGatewayService.setGatewayTransport(async (params) => {
        return {
          gatewayOrderId: `sub_dispatched_${params.orderId}`,
          shortUrl: 'https://rzp.io/i/test_dispatched'
        };
      });

      const res = await paymentGatewayService.createSubscriptionCheckout(
        'neon_user_concurrency',
        'plus',
        'INR',
        'razorpay',
        { userId: 'neon_user_concurrency' },
        undefined,
        'op_two_phase_test'
      );

      assert.ok(res.purchaseId.startsWith('pur_'));
      assert.strictEqual(res.orderId, `sub_dispatched_${res.purchaseId}`);

      const sub = tables.subscriptions.find(s => s.id === res.purchaseId);
      assert.ok(sub, 'Subscription record must exist');
      assert.strictEqual(sub.status, 'pending', 'Must transition to pending upon successful provider creation');
      assert.strictEqual(sub.gateway_subscription_id, res.orderId);

      // Clean up transport
      paymentGatewayService.setGatewayTransport(null as any);
    });
  });

  // =========================================================================
  // 5. SAVEPOINT ISOLATION & INVOICE FAILURE RESILIENCE (DB-07, SF-08, TQ-04)
  // =========================================================================
  describe('5. Savepoint Isolation & Invoice Failure Resilience (TQ-04)', () => {
    it('isolates invoice failure in savepoint and persists durable task in billing_invoice_reconciliation_outbox', async () => {
      const { mockDb, tables } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);

      const customerId = 'cust_concurrency_test';
      const principalId = 'neon_user_concurrency';
      const subId = 'pur_test_inv_fail';

      tables.subscriptions.push({
        id: subId,
        customer_id: customerId,
        plan_id: 'plus',
        status: 'pending',
        gateway: 'razorpay',
        gateway_subscription_id: 'sub_test_inv_fail',
        currency: 'INR',
        amount_minor_units: 99900,
        current_period_start: Date.now(),
        current_period_end: Date.now() + 30 * 24 * 3600 * 1000,
        cancel_at_period_end: false,
        metadata: JSON.stringify({ principalId }),
        created_at: Date.now(),
        updated_at: Date.now()
      });

      // Override issueDurableInvoice temporarily to throw an error simulating database constraint or numbering failure
      const originalIssueInvoice = paymentGatewayService.issueDurableInvoice.bind(paymentGatewayService);
      (paymentGatewayService as any).issueDurableInvoice = async () => {
        throw new Error('SIMULATED_TAX_INVOICE_DB_ERROR: Sequence allocation collision');
      };

      try {
        const rawPayload = JSON.stringify({
          entity: 'event',
          event: 'subscription.charged',
          contains: ['subscription', 'payment'],
          payload: {
            subscription: {
              entity: {
                id: 'sub_test_inv_fail',
                customer_id: 'cust_rzp_mock',
                plan_id: 'plan_plus_monthly',
                status: 'active',
                current_start: Math.floor(Date.now() / 1000),
                current_end: Math.floor((Date.now() + 30 * 24 * 3600 * 1000) / 1000),
                notes: { purchaseId: subId }
              }
            },
            payment: {
              entity: {
                id: 'pay_sim_inv_fail',
                amount: 99900,
                currency: 'INR',
                status: 'captured'
              }
            }
          }
        });

        const secret = process.env.RAZORPAY_KEY_SECRET || 'rzp_test_concurrency_secret';
        const signature = crypto.createHmac('sha256', secret).update(rawPayload).digest('hex');

        await paymentGatewayService.processRazorpayWebhook(rawPayload, signature);

        // 1. Subscription must STILL be active (savepoint protected activation from invoice failure!)
        const sub = tables.subscriptions.find(s => s.id === subId);
        assert.ok(sub, 'Subscription must exist');
        assert.strictEqual(sub.status, 'active', 'Subscription must be activated despite invoice generation failure');

        // 2. Metadata marks invoice as PENDING_RECONCILIATION
        const meta = typeof sub.metadata === 'string' ? JSON.parse(sub.metadata) : sub.metadata;
        assert.strictEqual(meta.invoice_status, 'PENDING_RECONCILIATION');
        assert.ok(meta.invoice_correlation_id);

        // 3. Billing audit event must record TAX_INVOICE_PENDING_RECONCILIATION
        const auditEv = tables.billing_audit_events.find(e => e.event_type === 'TAX_INVOICE_PENDING_RECONCILIATION');
        assert.ok(auditEv, 'Must log TAX_INVOICE_PENDING_RECONCILIATION audit event');

        // 4. Outbox record must be persisted in billing_invoice_reconciliation_outbox
        const outboxTask = tables.billing_invoice_reconciliation_outbox.find(t => t.subscription_id === subId);
        assert.ok(outboxTask, 'Must persist task in billing_invoice_reconciliation_outbox');
        assert.strictEqual(outboxTask.state, 'PENDING');
        assert.strictEqual(outboxTask.plan_tier, 'plus');
        assert.strictEqual(outboxTask.gateway, 'razorpay');
      } finally {
        (paymentGatewayService as any).issueDurableInvoice = originalIssueInvoice;
      }
    });

    it('processInvoiceReconciliationTasks claims and completes outbox tasks idempotently', async () => {
      const { mockDb, tables } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);

      tables.billing_invoice_reconciliation_outbox.push({
        id: 'biro_test_reconcile_1',
        subscription_id: 'pur_reconcile_test',
        cycle_number: 1,
        customer_id: 'cust_concurrency_test',
        principal_id: 'neon_user_concurrency',
        gateway: 'razorpay',
        plan_tier: 'plus',
        amount_minor_units: 99900,
        currency: 'INR',
        actual_payment_id: 'pay_rec_test_1',
        gateway_order_id: 'sub_rec_test_1',
        correlation_id: 'rec_corr_test_1',
        state: 'PENDING',
        attempts: 0,
        max_attempts: 5,
        fencing_token: 0,
        payload: JSON.stringify({}),
        created_at: Date.now(),
        updated_at: Date.now()
      });

      tables.subscriptions.push({
        id: 'pur_reconcile_test',
        customer_id: 'cust_concurrency_test',
        plan_id: 'plus',
        status: 'active',
        currency: 'INR',
        amount_minor_units: 99900,
        metadata: JSON.stringify({})
      });

      const procResult = await paymentGatewayService.processInvoiceReconciliationTasks({
        workerId: 'wkr_test_invoice_worker',
        dbOverride: mockDb
      });

      assert.strictEqual(procResult.processed, 1);
      assert.strictEqual(procResult.succeeded, 1);
      assert.strictEqual(procResult.failed, 0);

      const updatedTask = tables.billing_invoice_reconciliation_outbox.find(t => t.id === 'biro_test_reconcile_1');
      assert.strictEqual(updatedTask?.state, 'COMPLETED');
      assert.ok(updatedTask?.completed_at);

      // Verify second execution does not duplicate work
      const retryResult = await paymentGatewayService.processInvoiceReconciliationTasks({
        workerId: 'wkr_test_invoice_worker',
        dbOverride: mockDb
      });
      assert.strictEqual(retryResult.processed, 0, 'Completed tasks must not be re-processed');
    });
  });

  // =========================================================================
  // 6. UPGRADE MANDATE SUPERSEDING & DURABLE OUTBOX CANCELLATION (SF-05, TQ-03)
  // =========================================================================
  describe('6. Upgrade Mandate Superseding & Durable Outbox Cancellation (TQ-03)', () => {
    it('supersedes active subscription and durably persists cancellation task in outbox on upgrade', async () => {
      const { mockDb, tables } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);

      const customerId = 'cust_upgrade_test';
      const principalId = 'neon_user_upgrade';
      const oldSubId = 'pur_old_plus_active';
      const newSubId = 'pur_new_pro_upgrade';

      // Seed existing active Plus subscription
      tables.subscriptions.push({
        id: oldSubId,
        customer_id: customerId,
        plan_id: 'plus',
        status: 'active',
        gateway: 'razorpay',
        gateway_subscription_id: 'sub_old_mandate_rzp',
        currency: 'INR',
        amount_minor_units: 99900,
        current_period_start: Date.now() - 5 * 24 * 3600 * 1000,
        current_period_end: Date.now() + 25 * 24 * 3600 * 1000,
        cancel_at_period_end: false,
        metadata: JSON.stringify({ principalId }),
        created_at: Date.now() - 5 * 24 * 3600 * 1000,
        updated_at: Date.now() - 5 * 24 * 3600 * 1000
      });

      // Seed pending new Pro subscription
      tables.subscriptions.push({
        id: newSubId,
        customer_id: customerId,
        plan_id: 'pro',
        status: 'pending',
        gateway: 'razorpay',
        gateway_subscription_id: 'sub_new_pro_rzp',
        currency: 'INR',
        amount_minor_units: 199900,
        current_period_start: Date.now(),
        current_period_end: Date.now() + 30 * 24 * 3600 * 1000,
        cancel_at_period_end: false,
        metadata: JSON.stringify({ principalId }),
        created_at: Date.now(),
        updated_at: Date.now()
      });

      // Execute webhook activating the new Pro subscription
      const rawPayload = JSON.stringify({
        entity: 'event',
        event: 'subscription.charged',
        contains: ['subscription', 'payment'],
        payload: {
          subscription: {
            entity: {
              id: 'sub_new_pro_rzp',
              customer_id: 'cust_rzp_mock',
              plan_id: 'plan_pro_monthly',
              status: 'active',
              current_start: Math.floor(Date.now() / 1000),
              current_end: Math.floor((Date.now() + 30 * 24 * 3600 * 1000) / 1000),
              notes: { purchaseId: newSubId }
            }
          },
          payment: {
            entity: {
              id: 'pay_new_pro_active',
              amount: 199900,
              currency: 'INR',
              status: 'captured'
            }
          }
        }
      });

      const secret = process.env.RAZORPAY_KEY_SECRET || 'rzp_test_concurrency_secret';
      const signature = crypto.createHmac('sha256', secret).update(rawPayload).digest('hex');

      await paymentGatewayService.processRazorpayWebhook(rawPayload, signature);

      // 1. Old subscription status must be 'superseded'
      const oldSub = tables.subscriptions.find(s => s.id === oldSubId);
      assert.strictEqual(oldSub?.status, 'superseded', 'Previous subscription must be marked superseded');

      // 2. New subscription status must be 'active'
      const newSub = tables.subscriptions.find(s => s.id === newSubId);
      assert.strictEqual(newSub?.status, 'active', 'Upgraded subscription must be active');

      // 3. SUBSCRIPTION_SUPERSEDED audit event must be written
      const superEv = tables.billing_audit_events.find(e => e.event_type === 'SUBSCRIPTION_SUPERSEDED');
      assert.ok(superEv, 'Must record SUBSCRIPTION_SUPERSEDED audit event');

      // 4. MANDATE_CANCELLATION_SCHEDULED audit event must be written
      const schedEv = tables.billing_audit_events.find(e => e.event_type === 'MANDATE_CANCELLATION_SCHEDULED');
      assert.ok(schedEv, 'Must record MANDATE_CANCELLATION_SCHEDULED audit event');

      // 5. Durable task must be persisted in subscription_cancellation_outbox
      const outboxTask = tables.subscription_cancellation_outbox.find(t => t.subscription_id === oldSubId);
      assert.ok(outboxTask, 'Must persist cancellation task in subscription_cancellation_outbox');
      assert.strictEqual(outboxTask.gateway, 'razorpay');
      assert.strictEqual(outboxTask.gateway_subscription_id, 'sub_old_mandate_rzp');
      assert.strictEqual(outboxTask.replacement_subscription_id, newSubId);
      assert.strictEqual(outboxTask.state, 'PENDING');
    });

    it('processCancellationOutboxTasks claims tasks and executes gateway cancellation with bounded retries', async () => {
      const { mockDb, tables } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);

      tables.subscription_cancellation_outbox.push({
        id: 'sco_test_cancel_1',
        subscription_id: 'sub_old_to_cancel',
        customer_id: 'cust_upgrade_test',
        principal_id: 'neon_user_upgrade',
        gateway: 'razorpay',
        gateway_subscription_id: 'sub_old_rzp_mandate',
        replacement_subscription_id: 'pur_new_pro',
        state: 'PENDING',
        attempts: 0,
        max_attempts: 5,
        fencing_token: 0,
        payload: JSON.stringify({}),
        created_at: Date.now(),
        updated_at: Date.now()
      });

      let transportCancelled = false;
      paymentGatewayService.setGatewayTransport(async (params) => {
        if (params.action === 'cancel_subscription') {
          transportCancelled = true;
          return { success: true };
        }
        return {};
      });

      const procResult = await paymentGatewayService.processCancellationOutboxTasks({
        workerId: 'wkr_test_cancellation',
        dbOverride: mockDb
      });

      assert.strictEqual(procResult.processed, 1);
      assert.strictEqual(procResult.succeeded, 1);
      assert.strictEqual(transportCancelled, true, 'Gateway transport cancel action must be called');

      const updatedTask = tables.subscription_cancellation_outbox.find(t => t.id === 'sco_test_cancel_1');
      assert.strictEqual(updatedTask?.state, 'COMPLETED');
      assert.ok(updatedTask?.completed_at);

      paymentGatewayService.setGatewayTransport(null as any);
    });
  });

  // =========================================================================
  // 7. WEBHOOK FRESHNESS & REPLAY WINDOW ENFORCEMENT (SEC-03)
  // =========================================================================
  describe('7. Webhook Freshness & Replay Window Enforcement', () => {
    it('rejects Cashfree webhook signatures when timestamp is older than 24 hours', () => {
      const now = Date.now();
      const oldTimestamp = String(now - 25 * 60 * 60 * 1000); // 25 hours ago
      const rawPayload = JSON.stringify({ type: 'SUBSCRIPTION_STATUS_CHANGE', data: {} });

      const res = paymentGatewayService.verifyCashfreeWebhook(
        rawPayload,
        'mock_signature',
        oldTimestamp,
        'mock_secret_key'
      );

      assert.strictEqual(res.valid, false, 'Must reject stale webhook older than 24h');
      assert.ok(res.error?.includes('expired') || res.error?.includes('24 hours'));
    });

    it('rejects Cashfree webhook signatures when timestamp has future clock drift > 5 minutes', () => {
      const now = Date.now();
      const futureTimestamp = String(now + 10 * 60 * 1000); // 10 minutes in future
      const rawPayload = JSON.stringify({ type: 'SUBSCRIPTION_STATUS_CHANGE', data: {} });

      const res = paymentGatewayService.verifyCashfreeWebhook(
        rawPayload,
        'mock_signature',
        futureTimestamp,
        'mock_secret_key'
      );

      assert.strictEqual(res.valid, false, 'Must reject webhook with excessive future clock drift');
      assert.ok(res.error?.includes('drift') || res.error?.includes('future'));
    });
  });

  // =========================================================================
  // 8. INVOICES TRUTHFUL FAILURE PROPAGATION (SF-09)
  // =========================================================================
  describe('8. Invoices Truthful Failure Propagation', () => {
    it('throws BILLING_INVOICE_QUERY_FAILED instead of swallowing errors and returning empty array', async () => {
      const mockDb: any = (() => {
        const builder: any = {
          where: () => builder,
          first: async () => ({ id: 'cust_err', principal_id: 'neon_err_user' }),
          orderBy: () => builder,
          select: async () => {
            throw new Error('Neon PostgreSQL connection terminated unexpectedly');
          }
        };
        return builder;
      });
      mockDb.schema = {
        hasTable: async () => { throw new Error('Database connection failed'); }
      };

      paymentGatewayService.setDbClient(mockDb);

      await assert.rejects(
        async () => {
          await paymentGatewayService.getInvoices('neon_err_user');
        },
        (err: any) => {
          assert.ok(
            err.message.includes('BILLING_INVOICE_QUERY_FAILED'),
            'Must propagate BILLING_INVOICE_QUERY_FAILED error'
          );
          return true;
        }
      );
    });
  });

  // =========================================================================
  // 9. MIGRATION 034 DATABASE CONSTRAINTS BEHAVIORAL VERIFICATION (DB-01, DB-02)
  // =========================================================================
  describe('9. Migration 034 Database Constraints Behavioral Verification', () => {
    it('preflight check throws MIGRATION_034_PREFLIGHT_FAILED when duplicate active subscriptions exist', async () => {
      const { up } = await import('../packages/db/src/migrations/034_unique_active_subscription_per_customer.js');

      const mockKnexDuplicates: any = () => {
        const query: any = {
          where: () => query,
          groupBy: () => query,
          havingRaw: () => query,
          select: () => query,
          count: async () => [{ customer_id: 'cust_dup_active', count: '2' }]
        };
        return query;
      };
      mockKnexDuplicates.schema = {
        hasTable: async () => true
      };
      mockKnexDuplicates.raw = async () => {};

      await assert.rejects(
        async () => {
          await up(mockKnexDuplicates);
        },
        (err: any) => {
          assert.ok(err.message.includes('MIGRATION_034_PREFLIGHT_FAILED'));
          return true;
        }
      );
    });

    it('creates uniq_subscriptions_customer_active and uniq_subscriptions_gateway_sub_id when preflight passes', async () => {
      const { up, down } = await import('../packages/db/src/migrations/034_unique_active_subscription_per_customer.js');

      const executedSql: string[] = [];
      const mockKnexClean: any = () => {
        const query: any = {
          where: () => query,
          groupBy: () => query,
          havingRaw: () => query,
          select: () => query,
          count: async () => []
        };
        return query;
      };
      mockKnexClean.schema = {
        hasTable: async () => true
      };
      mockKnexClean.raw = async (sql: string) => {
        executedSql.push(sql.trim());
      };

      await up(mockKnexClean);
      assert.ok(executedSql.some(sql => sql.includes('uniq_subscriptions_customer_active') && sql.includes("WHERE status = 'active'")));
      assert.ok(executedSql.some(sql => sql.includes('uniq_subscriptions_gateway_sub_id') && sql.includes('gateway_subscription_id IS NOT NULL')));

      const downSql: string[] = [];
      mockKnexClean.raw = async (sql: string) => {
        downSql.push(sql.trim());
      };
      await down(mockKnexClean);
      assert.ok(downSql.some(sql => sql.includes('DROP INDEX IF EXISTS uniq_subscriptions_customer_active')));
      assert.ok(downSql.some(sql => sql.includes('DROP INDEX IF EXISTS uniq_subscriptions_gateway_sub_id')));
    });
  });

  // =========================================================================
  // 10. MIGRATION 035 OUTBOX TABLES & TQ-05 / TQ-06 INVARIANTS
  // =========================================================================
  describe('10. Migration 035 Outbox Tables & Authoritative Reconciliation (TQ-05, TQ-06)', () => {
    it('migration 035 up and down successfully creates and drops outbox tables', async () => {
      const { up, down } = await import('../packages/db/src/migrations/035_subscription_cancellation_and_invoice_outbox.js');

      const createdTables: string[] = [];
      const droppedTables: string[] = [];

      const mockKnex: any = {};
      mockKnex.schema = {
        hasTable: async () => false,
        createTable: async (tblName: string, cb: any) => {
          createdTables.push(tblName);
          const tableBuilder = {
            string: () => tableBuilder,
            integer: () => tableBuilder,
            bigInteger: () => tableBuilder,
            text: () => tableBuilder,
            jsonb: () => tableBuilder,
            primary: () => tableBuilder,
            notNullable: () => tableBuilder,
            nullable: () => tableBuilder,
            defaultTo: () => tableBuilder,
            index: () => tableBuilder,
            unique: () => tableBuilder,
            check: () => tableBuilder
          };
          cb(tableBuilder);
        },
        dropTableIfExists: async (tblName: string) => {
          droppedTables.push(tblName);
        }
      };

      await up(mockKnex);
      assert.ok(createdTables.includes('subscription_cancellation_outbox'));
      assert.ok(createdTables.includes('billing_invoice_reconciliation_outbox'));

      await down(mockKnex);
      assert.ok(droppedTables.includes('subscription_cancellation_outbox'));
      assert.ok(droppedTables.includes('billing_invoice_reconciliation_outbox'));
    });

    it('reconcileAmbiguousSubscription rejects unverified manualResolution (TQ-05)', async () => {
      const { mockDb, tables } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);

      tables.subscriptions.push({
        id: 'pur_ambig_test_unverified',
        customer_id: 'cust_fail_test',
        status: 'ambiguous_timeout',
        gateway: 'cashfree',
        plan_id: 'plus',
        amount_minor_units: 99900,
        currency: 'INR'
      });

      await assert.rejects(
        async () => {
          await paymentGatewayService.reconcileAmbiguousSubscription(
            'pur_ambig_test_unverified',
            mockDb,
            'failed'
          );
        },
        (err: any) => {
          assert.ok(err.message.includes('UNVERIFIED_MANUAL_RESOLUTION_REJECTED'));
          return true;
        }
      );
    });

    it('in-flight initiating subscription < 30s blocks checkout with CONCURRENT_CHECKOUT_IN_PROGRESS (TQ-06)', async () => {
      const { mockDb, tables } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);

      tables.subscriptions.push({
        id: 'pur_inflight_initiating',
        customer_id: 'cust_concurrency_test',
        status: 'initiating',
        gateway: 'razorpay',
        plan_id: 'plus',
        amount_minor_units: 99900,
        currency: 'INR',
        created_at: Date.now() - 5000 // 5 seconds old (< 30s)
      });

      await assert.rejects(
        async () => {
          await paymentGatewayService.createSubscriptionCheckout(
            'neon_user_concurrency',
            'pro',
            'INR',
            'razorpay',
            { userId: 'neon_user_concurrency' }
          );
        },
        (err: any) => {
          assert.ok(err.message.includes('CONCURRENT_CHECKOUT_IN_PROGRESS'));
          assert.ok(err.message.includes('in flight'));
          return true;
        }
      );
    });

    it('stalled initiating subscription > 30s transitions to ambiguous_timeout and blocks replacement (TQ-06)', async () => {
      const { mockDb, tables } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);

      tables.subscriptions.push({
        id: 'pur_stalled_initiating',
        customer_id: 'cust_concurrency_test',
        status: 'initiating',
        gateway: 'razorpay',
        plan_id: 'plus',
        amount_minor_units: 99900,
        currency: 'INR',
        created_at: Date.now() - 40000 // 40 seconds old (> 30s)
      });

      await assert.rejects(
        async () => {
          await paymentGatewayService.createSubscriptionCheckout(
            'neon_user_concurrency',
            'pro',
            'INR',
            'razorpay',
            { userId: 'neon_user_concurrency' }
          );
        },
        (err: any) => {
          assert.ok(err.message.includes('GATEWAY_AMBIGUOUS_OUTCOME'));
          return true;
        }
      );

      const sub = tables.subscriptions.find(s => s.id === 'pur_stalled_initiating');
      assert.strictEqual(sub?.status, 'ambiguous_timeout', 'Stalled initiating subscription must transition to ambiguous_timeout');
    });
  });
});
