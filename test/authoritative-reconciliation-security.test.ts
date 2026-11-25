import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { paymentGatewayService } from '../apps/api/src/billing/payment-gateway-service.js';
import { createBillingRoutes } from '../apps/api/src/billing-routes.js';
import express from 'express';

describe('V-01: Authoritative Reconciliation Security Suite', () => {
  function createMockDb() {
    const tables: Record<string, any[]> = {
      billing_customers: [
        { id: 'cust_recon_test', principal_id: 'neon_user_recon', name: 'Recon User', cashfree_customer_id: 'cf_cust_123', razorpay_customer_id: 'rzp_cust_123' },
        { id: 'cust_attacker', principal_id: 'neon_user_attacker', name: 'Attacker User' }
      ],
      subscriptions: [
        {
          id: 'sub_ambiguous_123',
          customer_id: 'cust_recon_test',
          plan_id: 'pro',
          price_id: 'price_pro_inr',
          status: 'ambiguous_timeout',
          gateway: 'cashfree',
          gateway_subscription_id: 'cf_sub_ambig_999',
          currency: 'INR',
          amount_minor_units: 99900,
          current_period_start: Date.now() - 3600000,
          current_period_end: Date.now() + 2592000000,
          created_at: Date.now() - 600000,
          updated_at: Date.now() - 600000
        }
      ],
      idempotent_operations: [
        {
          key: 'checkout:sub:cust_recon_test',
          principal_id: 'neon_user_recon',
          operation_id: 'op_recon_test',
          status: 'AMBIGUOUS',
          locked_until: 0,
          created_at: Date.now() - 600000,
          updated_at: Date.now() - 600000
        }
      ],
      billing_audit_events: [],
      payment_gateway_events: []
    };

    const mockDb: any = ((tableName: string) => {
      let filterQuery: Record<string, any> = {};
      const builder: any = {
        where: (queryOrCol: any, val?: any) => {
          if (typeof queryOrCol === 'string') {
            filterQuery[queryOrCol] = val;
          } else if (typeof queryOrCol === 'object') {
            Object.assign(filterQuery, queryOrCol);
          }
          return builder;
        },
        andWhere: (queryOrCol: any, val?: any) => builder.where(queryOrCol, val),
        first: async () => {
          const list = tables[tableName] || [];
          return list.find(r => Object.entries(filterQuery).every(([k, v]) => r[k] === v)) || null;
        },
        update: async (data: any) => {
          const list = tables[tableName] || [];
          let count = 0;
          for (const row of list) {
            if (Object.entries(filterQuery).every(([k, v]) => row[k] === v)) {
              Object.assign(row, data);
              count++;
            }
          }
          return count;
        },
        insert: async (data: any) => {
          if (!tables[tableName]) tables[tableName] = [];
          if (Array.isArray(data)) tables[tableName].push(...data);
          else tables[tableName].push(data);
          return [1];
        },
        orderBy: () => builder
      };
      return builder;
    });

    mockDb.transaction = async (cb: (trx: any) => Promise<any>) => cb(mockDb);
    mockDb.schema = { hasTable: async () => true };

    return { mockDb, tables };
  }

  // 1. Operator assertion without provider evidence is rejected
  it('1. rejects operator assertion without provider evidence (fails closed)', async () => {
    const { mockDb } = createMockDb();
    paymentGatewayService.setDbClient(mockDb);

    await assert.rejects(
      async () => {
        await paymentGatewayService.reconcileAmbiguousSubscription(
          'sub_ambiguous_123',
          mockDb,
          'failed',
          {
            operatorAuth: {
              operatorId: 'admin_operator_1',
              justification: 'Customer told me on phone that payment failed',
              evidenceReference: 'TICKET-9999'
            }
          }
        );
      },
      /OPERATOR_ASSERTION_WITHOUT_PROVIDER_EVIDENCE_REJECTED|UNVERIFIED_MANUAL_RESOLUTION_REJECTED/
    );
  });

  // 2. Arbitrary providerEvidence object is rejected
  it('2. rejects arbitrary unverified providerEvidence object', async () => {
    const { mockDb } = createMockDb();
    paymentGatewayService.setDbClient(mockDb);

    await assert.rejects(
      async () => {
        await paymentGatewayService.reconcileAmbiguousSubscription(
          'sub_ambiguous_123',
          mockDb,
          'failed',
          {
            providerEvidence: {
              arbitraryString: 'trust me bro, order does not exist',
              exists: false
            }
          }
        );
      },
      /UNVERIFIED_PROVIDER_EVIDENCE_REJECTED/
    );
  });

  // 3. Unsigned or fabricated webhook evidence is rejected
  it('3. rejects unsigned or fabricated webhook evidence', async () => {
    const { mockDb } = createMockDb();
    paymentGatewayService.setDbClient(mockDb);

    await assert.rejects(
      async () => {
        await paymentGatewayService.reconcileAmbiguousSubscription(
          'sub_ambiguous_123',
          mockDb,
          'active',
          {
            webhookPayload: {
              event: 'subscription.activated',
              subscription_id: 'cf_sub_ambig_999'
            },
            webhookSignature: 'invalid_forged_signature_hex'
          }
        );
      },
      /INVALID_WEBHOOK_SIGNATURE|UNVERIFIED_WEBHOOK_EVIDENCE/
    );
  });

  // 4. Incorrect customer correlation is rejected
  it('4. rejects provider evidence with mismatched customer correlation', async () => {
    const { mockDb } = createMockDb();
    paymentGatewayService.setDbClient(mockDb);

    await assert.rejects(
      async () => {
        await paymentGatewayService.reconcileAmbiguousSubscription(
          'sub_ambiguous_123',
          mockDb,
          'active',
          {
            providerEvidence: {
              trustedServerVerified: true,
              gateway: 'cashfree',
              environment: 'sandbox',
              gatewaySubscriptionId: 'cf_sub_ambig_999',
              customerId: 'cust_WRONG_CUSTOMER', // Mismatched customer!
              status: 'active'
            }
          }
        );
      },
      /CORRELATION_MISMATCH_CUSTOMER/
    );
  });

  // 5. Incorrect gateway or environment is rejected
  it('5. rejects provider evidence with mismatched gateway or environment', async () => {
    const { mockDb } = createMockDb();
    paymentGatewayService.setDbClient(mockDb);

    await assert.rejects(
      async () => {
        await paymentGatewayService.reconcileAmbiguousSubscription(
          'sub_ambiguous_123',
          mockDb,
          'active',
          {
            providerEvidence: {
              trustedServerVerified: true,
              gateway: 'razorpay', // Subscription is cashfree!
              environment: 'sandbox',
              gatewaySubscriptionId: 'cf_sub_ambig_999',
              customerId: 'cust_recon_test',
              status: 'active'
            }
          }
        );
      },
      /GATEWAY_MISMATCH|ENVIRONMENT_MISMATCH/
    );
  });

  // 6. Provider communication failure preserves unresolved state
  it('6. provider communication failure preserves unresolved state', async () => {
    const { mockDb, tables } = createMockDb();
    paymentGatewayService.setDbClient(mockDb);
    paymentGatewayService.setGatewayTransport(async () => {
      throw new Error('ETIMEDOUT: Connection to provider upstream timed out');
    });

    const result = await paymentGatewayService.reconcileAmbiguousSubscription(
      'sub_ambiguous_123',
      mockDb
    );

    assert.strictEqual(result.reconciled, false);
    assert.strictEqual(result.status, 'ambiguous_timeout');
    const sub = tables.subscriptions.find(s => s.id === 'sub_ambiguous_123');
    assert.strictEqual(sub?.status, 'ambiguous_timeout');
  });

  // 7. Verified authoritative provider evidence permits the correct transition
  it('7. verified authoritative provider evidence permits the correct transition', async () => {
    const { mockDb, tables } = createMockDb();
    paymentGatewayService.setDbClient(mockDb);

    const result = await paymentGatewayService.reconcileAmbiguousSubscription(
      'sub_ambiguous_123',
      mockDb,
      'failed',
      {
        providerEvidence: {
          trustedServerVerified: true,
          gateway: 'cashfree',
          environment: 'sandbox',
          gatewaySubscriptionId: 'cf_sub_ambig_999',
          customerId: 'cust_recon_test',
          orderId: 'sub_ambiguous_123',
          exists: false,
          status: 'NOT_FOUND',
          verificationTimestamp: Date.now()
        },
        operatorAuth: {
          operatorId: 'admin_operator_1',
          justification: 'Confirmed non-existence via verified Cashfree query',
          evidenceReference: 'CF-DASHBOARD-VERIFY-123'
        }
      }
    );

    assert.strictEqual(result.reconciled, true);
    assert.strictEqual(result.status, 'failed');
    const sub = tables.subscriptions.find(s => s.id === 'sub_ambiguous_123');
    assert.strictEqual(sub?.status, 'failed');
    const idemp = tables.idempotent_operations.find(op => op.key === 'checkout:sub:cust_recon_test');
    assert.strictEqual(idemp?.status, 'RESOLVED_FAILED');
  });

  // 8. Unauthorized reconciliation route access is rejected
  it('8. rejects unauthorized access to internal reconciliation route', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/billing', createBillingRoutes());

    // Without internal worker / operator authorization header
    const res = await new Promise<{ status: number; body: any }>((resolve) => {
      const server = app.listen(0, async () => {
        const port = (server.address() as any).port;
        try {
          const resp = await fetch(`http://127.0.0.1:${port}/api/billing/internal/reconcile-ambiguous`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscriptionId: 'sub_ambiguous_123' })
          });
          const body = await resp.json().catch(() => ({}));
          resolve({ status: resp.status, body });
        } finally {
          server.close();
        }
      });
    });

    assert.strictEqual(res.status, 401, 'Must reject unauthorized request with 401');
  });

  // 9. Duplicate reconciliation remains idempotent
  it('9. duplicate reconciliation of already resolved subscription is idempotent', async () => {
    const { mockDb, tables } = createMockDb();
    tables.subscriptions[0].status = 'failed';
    paymentGatewayService.setDbClient(mockDb);

    const result = await paymentGatewayService.reconcileAmbiguousSubscription(
      'sub_ambiguous_123',
      mockDb,
      'failed'
    );

    assert.strictEqual(result.reconciled, true);
    assert.strictEqual(result.status, 'failed');
  });

  // 10. Audit evidence persists atomically
  it('10. records reconciliation audit evidence atomically in billing_audit_events', async () => {
    const { mockDb, tables } = createMockDb();
    paymentGatewayService.setDbClient(mockDb);

    await paymentGatewayService.reconcileAmbiguousSubscription(
      'sub_ambiguous_123',
      mockDb,
      'failed',
      {
        providerEvidence: {
          trustedServerVerified: true,
          gateway: 'cashfree',
          environment: 'sandbox',
          gatewaySubscriptionId: 'cf_sub_ambig_999',
          customerId: 'cust_recon_test',
          orderId: 'sub_ambiguous_123',
          exists: false,
          status: 'NOT_FOUND',
          verificationTimestamp: Date.now()
        },
        operatorAuth: {
          operatorId: 'admin_operator_1',
          justification: 'Authoritative audit verification test',
          evidenceReference: 'AUDIT-REF-456'
        }
      }
    );

    const auditEvent = tables.billing_audit_events.find(
      e => e.event_type === 'SUBSCRIPTION_AUTHORITATIVELY_RECONCILED' || e.event_type === 'SUBSCRIPTION_MANUALLY_RECONCILED'
    );
    assert.ok(auditEvent, 'Must create reconciliation audit event');
    assert.strictEqual(auditEvent.customer_id, 'cust_recon_test');
    assert.strictEqual(auditEvent.actor_id, 'admin_operator_1');
  });

  // 11. Trust boundary: rejects authorized operator submitting fabricated evidence with trustedServerVerified: true via HTTP route
  it('11. rejects authorized operator submitting fabricated evidence with trustedServerVerified: true via HTTP route', async () => {
    process.env.AIRA_INTERNAL_WORKER_KEY = 'test_worker_key_secret_123';
    const app = express();
    app.use(express.json());
    app.use('/api/billing', createBillingRoutes());

    const res = await new Promise<{ status: number; body: any }>((resolve) => {
      const server = app.listen(0, async () => {
        const port = (server.address() as any).port;
        try {
          const resp = await fetch(`http://127.0.0.1:${port}/api/billing/internal/reconcile-ambiguous`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-internal-worker-key': 'test_worker_key_secret_123'
            },
            body: JSON.stringify({
              subscriptionId: 'sub_ambiguous_123',
              manualResolution: 'active',
              reconciliationEvidence: {
                providerEvidence: {
                  trustedServerVerified: true,
                  gateway: 'cashfree',
                  environment: 'sandbox',
                  customerId: 'cust_recon_test',
                  orderId: 'sub_ambiguous_123'
                }
              }
            })
          });
          const body = await resp.json().catch(() => ({}));
          resolve({ status: resp.status, body });
        } finally {
          server.close();
        }
      });
    });

    assert.strictEqual(res.status, 400, 'Must reject fabricated trustedServerVerified from HTTP body with 400');
    assert.ok(res.body.error.includes('TRUST_BOUNDARY_VIOLATION'), 'Error must specify TRUST_BOUNDARY_VIOLATION');
  });

  // 12. Trust boundary: rejects caller attempting to supply raw webhookPayload via HTTP route
  it('12. rejects caller attempting to supply raw webhookPayload via HTTP route', async () => {
    process.env.AIRA_INTERNAL_WORKER_KEY = 'test_worker_key_secret_123';
    const app = express();
    app.use(express.json());
    app.use('/api/billing', createBillingRoutes());

    const res = await new Promise<{ status: number; body: any }>((resolve) => {
      const server = app.listen(0, async () => {
        const port = (server.address() as any).port;
        try {
          const resp = await fetch(`http://127.0.0.1:${port}/api/billing/internal/reconcile-ambiguous`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-internal-worker-key': 'test_worker_key_secret_123'
            },
            body: JSON.stringify({
              subscriptionId: 'sub_ambiguous_123',
              manualResolution: 'active',
              reconciliationEvidence: {
                webhookPayload: {
                  event: 'subscription.charged',
                  subscription_id: 'sub_ambiguous_123'
                },
                webhookSignature: 'arbitrary_fake_signature_hex_123456789'
              }
            })
          });
          const body = await resp.json().catch(() => ({}));
          resolve({ status: resp.status, body });
        } finally {
          server.close();
        }
      });
    });

    assert.strictEqual(res.status, 400, 'Must reject fabricated webhookPayload from HTTP body with 400');
    assert.ok(res.body.error.includes('TRUST_BOUNDARY_VIOLATION'), 'Error must specify TRUST_BOUNDARY_VIOLATION');
  });
});
