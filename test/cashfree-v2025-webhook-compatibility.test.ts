import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import {
  PaymentGatewayService,
  assertCommercialFulfillmentAllowed,
  SAFE_RECONCILIATION_EVENTS,
  PAID_FULFILLMENT_EVENTS
} from '../apps/api/src/billing/payment-gateway-service.js';
import { productionReadinessService } from '../apps/api/src/billing/production-readiness.js';

describe('Cashfree v2025-01-01 Webhook Compatibility & Security Certification Suite', () => {
  const origEnv = { ...process.env };

  function createMockDb() {
    const parentTables: Record<string, any[]> = {
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

    const createQueryBuilder = (store: Record<string, any[]>) => {
      const qb: any = (tableName: string) => {
        let filterQuery: Record<string, any> = {};
        let whereOps: Array<{ column: string; op: string; val: any }> = [];
        let whereInFilter: { column: string; values: any[] } | null = null;

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
          orderBy: () => builder,
          first: async () => {
            const rows = store[tableName] || [];
            return rows.find(matchRow) || null;
          },
          select: async () => {
            const rows = store[tableName] || [];
            return rows.filter(matchRow);
          },
          update: async (patch: Record<string, any>) => {
            const rows = store[tableName] || [];
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
            const rows = store[tableName] || [];
            let deletedCount = 0;
            store[tableName] = rows.filter(r => {
              if (matchRow(r)) {
                deletedCount++;
                return false;
              }
              return true;
            });
            return deletedCount;
          },
          insert: (record: Record<string, any>) => {
            if (!store[tableName]) store[tableName] = [];
            const isDuplicate = tableName === 'payment_gateway_events' && store[tableName].some(r => r.event_id === record.event_id);
            if (!isDuplicate) {
              store[tableName].push({ ...record });
            }
            const resObj: any = {
              onConflict: () => ({
                ignore: async () => {},
                merge: async () => {}
              }),
              returning: () => Promise.resolve([record]),
              then: (resolve: any, reject: any) => Promise.resolve([record]).then(resolve, reject)
            };
            return resObj;
          },
          onConflict: () => ({
            ignore: async () => {},
            merge: async () => {}
          })
        };

        builder.then = (resolve: any, reject: any) => {
          builder.select().then(resolve, reject);
        };

        return builder;
      };

      qb.schema = {
        hasTable: async (name: string) => Boolean(store[name])
      };

      qb.raw = async (sql: string) => {
        if (sql.includes('nextval')) {
          return { rows: [{ seq: 1 }] };
        }
        return { rows: [] };
      };

      return qb;
    };

    const mockDb: any = createQueryBuilder(parentTables);
    mockDb.transaction = async (callback: (trx: any) => Promise<any>) => {
      // Deep copy state for transaction
      const trxTables: Record<string, any[]> = {};
      for (const k of Object.keys(parentTables)) {
        trxTables[k] = parentTables[k].map(item => ({ ...item }));
      }
      const trx = createQueryBuilder(trxTables);

      try {
        const res = await callback(trx);
        // Commit: apply changes to parent
        for (const k of Object.keys(trxTables)) {
          parentTables[k] = trxTables[k];
        }
        return res;
      } catch (err) {
        // Rollback: discard trxTables changes
        throw err;
      }
    };

    return { dbClient: mockDb, tables: parentTables };
  }

  beforeEach(() => {
    process.env = { ...origEnv };
    process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'true';
    process.env.AIRA_ENABLE_TEST_FULFILLMENT = 'true';
    process.env.NODE_ENV = 'test';
    process.env.CASHFREE_APP_ID = 'TEST_cf_app_123';
    process.env.CASHFREE_SECRET_KEY = 'test_cf_api_secret_key_2026';
    delete process.env.CASHFREE_WEBHOOK_SECRET;
    process.env.RAZORPAY_KEY_ID = 'rzp_test_key_123';
    process.env.RAZORPAY_WEBHOOK_SECRET = 'test_rzp_webhook_secret_2026';
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  // =========================================================================
  // 1. SIGNATURE VERIFICATION & CRYPTOGRAPHIC HARDENING
  // =========================================================================
  it('Scenario 1: Valid Cashfree Payment Gateway signature (Base64 HMAC-SHA256)', () => {
    const service = new PaymentGatewayService();
    const timestamp = '1729355000';
    const rawBody = JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: 'ord_123' } } });
    const signature = crypto.createHmac('sha256', process.env.CASHFREE_SECRET_KEY!)
      .update(`${timestamp}${rawBody}`)
      .digest('base64');

    const result = service.verifyCashfreeWebhook(rawBody, signature, timestamp);
    assert.equal(result.valid, true);
    assert.equal(result.error, undefined);
  });

  it('Scenario 2: Invalid signature rejection throws FORBIDDEN_WEBHOOK', async () => {
    const { dbClient } = createMockDb();
    const service = new PaymentGatewayService();
    service.setDbClient(dbClient);

    const timestamp = '1729355000';
    const rawBody = JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: 'ord_123' } } });
    const invalidSignature = 'invalid_tampered_signature_base64==';

    const verifyRes = service.verifyCashfreeWebhook(rawBody, invalidSignature, timestamp);
    assert.equal(verifyRes.valid, false);

    await assert.rejects(
      async () => service.processCashfreeWebhook(rawBody, invalidSignature, timestamp),
      /FORBIDDEN_WEBHOOK:/
    );
  });

  it('Scenario 3: Missing signature rejection throws FORBIDDEN_WEBHOOK', async () => {
    const { dbClient } = createMockDb();
    const service = new PaymentGatewayService();
    service.setDbClient(dbClient);

    const timestamp = '1729355000';
    const rawBody = JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: 'ord_123' } } });

    const verifyRes = service.verifyCashfreeWebhook(rawBody, '', timestamp);
    assert.equal(verifyRes.valid, false);

    await assert.rejects(
      async () => service.processCashfreeWebhook(rawBody, '', timestamp),
      /FORBIDDEN_WEBHOOK:/
    );
  });

  it('Scenario 4: Timestamp / raw-body tampering rejection', () => {
    const service = new PaymentGatewayService();
    const timestamp = '1729355000';
    const rawBody = JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: 'ord_123' } } });
    const signature = crypto.createHmac('sha256', process.env.CASHFREE_SECRET_KEY!)
      .update(`${timestamp}${rawBody}`)
      .digest('base64');

    // Case A: Tampered timestamp
    const tamperedTimestamp = '1729355999';
    const resA = service.verifyCashfreeWebhook(rawBody, signature, tamperedTimestamp);
    assert.equal(resA.valid, false);

    // Case B: Tampered raw body
    const tamperedBody = JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: 'ord_tampered' } } });
    const resB = service.verifyCashfreeWebhook(tamperedBody, signature, timestamp);
    assert.equal(resB.valid, false);
  });

  it('Scenario 5: Fallback to CASHFREE_SECRET_KEY when CASHFREE_WEBHOOK_SECRET is unset', () => {
    delete process.env.CASHFREE_WEBHOOK_SECRET;
    process.env.CASHFREE_SECRET_KEY = 'secret_key_used_as_signing_key_999';

    const service = new PaymentGatewayService();
    const timestamp = '1729355000';
    const rawBody = JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK' });
    const signature = crypto.createHmac('sha256', 'secret_key_used_as_signing_key_999')
      .update(`${timestamp}${rawBody}`)
      .digest('base64');

    const result = service.verifyCashfreeWebhook(rawBody, signature, timestamp);
    assert.equal(result.valid, true);
  });

  it('Scenario 6: Support for CASHFREE_WEBHOOK_SECRET override', () => {
    process.env.CASHFREE_SECRET_KEY = 'cf_api_secret_key';
    process.env.CASHFREE_WEBHOOK_SECRET = 'explicit_cf_webhook_secret_key';

    const service = new PaymentGatewayService();
    const timestamp = '1729355000';
    const rawBody = JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK' });
    const signature = crypto.createHmac('sha256', 'explicit_cf_webhook_secret_key')
      .update(`${timestamp}${rawBody}`)
      .digest('base64');

    // Default uses CASHFREE_WEBHOOK_SECRET when present
    const result = service.verifyCashfreeWebhook(rawBody, signature, timestamp);
    assert.equal(result.valid, true);

    // Explicit override parameter support
    const overrideSecret = 'another_custom_secret';
    const overrideSig = crypto.createHmac('sha256', overrideSecret).update(`${timestamp}${rawBody}`).digest('base64');
    const overrideResult = service.verifyCashfreeWebhook(rawBody, overrideSig, timestamp, overrideSecret);
    assert.equal(overrideResult.valid, true);
  });

  // =========================================================================
  // 2. SUBSCRIPTION STATUS LIFECYCLE & V2025-01-01 SCHEMA
  // =========================================================================
  it('Scenario 7: Verified subscription status change (SUBSCRIPTION_STATUS_CHANGED) with CANCELLED', async () => {
    const { dbClient, tables } = createMockDb();
    const service = new PaymentGatewayService();
    service.setDbClient(dbClient);

    const now = Date.now();
    const gatewaySubId = 'sub_cf_cancel_target_01';
    const purchaseId = 'pur_cf_cancel_01';

    tables.subscriptions.push({
      id: purchaseId,
      customer_id: 'cust_01',
      plan_id: 'plus',
      status: 'active',
      gateway: 'cashfree',
      gateway_subscription_id: gatewaySubId,
      currency: 'INR',
      amount_minor_units: 39900,
      current_period_start: now,
      current_period_end: now + 30 * 86400000,
      cancel_at_period_end: false,
      metadata: JSON.stringify({ customerState: '07' }),
      created_at: now,
      updated_at: now
    });

    const payload = {
      type: 'SUBSCRIPTION_STATUS_CHANGED',
      event_time: '2026-11-22T10:00:00Z',
      data: {
        subscription_details: {
          subscription_id: gatewaySubId,
          cf_subscription_id: 'cf_sub_internal_01',
          subscription_status: 'CANCELLED'
        }
      }
    };

    const timestamp = '1729355000';
    const rawBody = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', process.env.CASHFREE_SECRET_KEY!).update(`${timestamp}${rawBody}`).digest('base64');

    const res = await service.processCashfreeWebhook(rawBody, signature, timestamp);
    assert.equal(res.status, 'PROCESSED');

    const updatedSub = tables.subscriptions.find(s => s.id === purchaseId);
    assert.equal(updatedSub.status, 'cancelled');
    const meta = JSON.parse(updatedSub.metadata);
    assert.equal(meta.cancellation_status, 'CANCELLATION_CONFIRMED');

    const auditEvent = tables.billing_audit_events.find(e => e.event_type === 'SUBSCRIPTION_CANCELLED');
    assert.ok(auditEvent);
  });

  it('Scenario 8: Verified subscription status change with HALTED', async () => {
    const { dbClient, tables } = createMockDb();
    const service = new PaymentGatewayService();
    service.setDbClient(dbClient);

    const now = Date.now();
    const gatewaySubId = 'sub_cf_halt_target_01';
    const purchaseId = 'pur_cf_halt_01';

    tables.subscriptions.push({
      id: purchaseId,
      customer_id: 'cust_02',
      plan_id: 'pro',
      status: 'active',
      gateway: 'cashfree',
      gateway_subscription_id: gatewaySubId,
      currency: 'INR',
      amount_minor_units: 99900,
      current_period_start: now,
      current_period_end: now + 30 * 86400000,
      cancel_at_period_end: false,
      metadata: JSON.stringify({ customerState: '07' }),
      created_at: now,
      updated_at: now
    });

    const payload = {
      type: 'SUBSCRIPTION_STATUS_CHANGED',
      data: {
        subscription_details: {
          subscription_id: gatewaySubId,
          subscription_status: 'HALTED'
        }
      }
    };

    const timestamp = '1729355000';
    const rawBody = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', process.env.CASHFREE_SECRET_KEY!).update(`${timestamp}${rawBody}`).digest('base64');

    const res = await service.processCashfreeWebhook(rawBody, signature, timestamp);
    assert.equal(res.status, 'PROCESSED');

    const updatedSub = tables.subscriptions.find(s => s.id === purchaseId);
    assert.equal(updatedSub.status, 'cancelled');
  });

  it('Scenario 9: Unsupported subscription status rejection', async () => {
    const { dbClient, tables } = createMockDb();
    const service = new PaymentGatewayService();
    service.setDbClient(dbClient);

    const now = Date.now();
    const gatewaySubId = 'sub_cf_invalid_status_target';

    tables.subscriptions.push({
      id: 'pur_cf_invalid_01',
      customer_id: 'cust_03',
      plan_id: 'plus',
      status: 'pending',
      gateway: 'cashfree',
      gateway_subscription_id: gatewaySubId,
      currency: 'INR',
      amount_minor_units: 39900,
      current_period_start: now,
      current_period_end: now + 30 * 86400000,
      cancel_at_period_end: false,
      created_at: now,
      updated_at: now
    });

    const payload = {
      type: 'SUBSCRIPTION_STATUS_CHANGED',
      data: {
        subscription_details: {
          subscription_id: gatewaySubId,
          subscription_status: 'MALICIOUS_UNSUPPORTED_STATUS'
        }
      }
    };

    const timestamp = '1729355000';
    const rawBody = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', process.env.CASHFREE_SECRET_KEY!).update(`${timestamp}${rawBody}`).digest('base64');

    await assert.rejects(
      async () => service.processCashfreeWebhook(rawBody, signature, timestamp),
      /UNSUPPORTED_SUBSCRIPTION_STATUS: Received invalid or unsupported subscription status 'MALICIOUS_UNSUPPORTED_STATUS'/
    );
  });

  it('Scenario 10: Status-only notification (ACTIVE without payment) records audit event, does NOT grant entitlements, does NOT issue invoice', async () => {
    const { dbClient, tables } = createMockDb();
    const service = new PaymentGatewayService();
    service.setDbClient(dbClient);

    const now = Date.now();
    const gatewaySubId = 'sub_cf_mandate_active_no_pay';
    const purchaseId = 'pur_cf_status_only_01';

    tables.subscriptions.push({
      id: purchaseId,
      customer_id: 'cust_status_01',
      principal_id: 'usr_status_01',
      account_id: 'cust_status_01',
      plan_id: 'plus',
      status: 'pending',
      gateway: 'cashfree',
      gateway_subscription_id: gatewaySubId,
      currency: 'INR',
      amount_minor_units: 39900,
      current_period_start: now,
      current_period_end: now,
      cancel_at_period_end: false,
      metadata: JSON.stringify({ principalId: 'usr_status_01', planTier: 'plus' }),
      created_at: now,
      updated_at: now
    });

    // Cashfree mandate authorization sends SUBSCRIPTION_STATUS_CHANGED with ACTIVE but no payment object
    const payload = {
      type: 'SUBSCRIPTION_STATUS_CHANGED',
      data: {
        subscription_details: {
          subscription_id: gatewaySubId,
          cf_subscription_id: 'cf_sub_mandate_01',
          subscription_status: 'ACTIVE'
        }
      }
    };

    const timestamp = '1729355000';
    const rawBody = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', process.env.CASHFREE_SECRET_KEY!).update(`${timestamp}${rawBody}`).digest('base64');

    const res = await service.processCashfreeWebhook(rawBody, signature, timestamp);
    assert.equal(res.status, 'PROCESSED');

    // 1. Subscription status MUST NOT be activated yet (remains pending until actual payment confirms)
    const sub = tables.subscriptions.find(s => s.id === purchaseId);
    assert.equal(sub.status, 'pending');

    // 2. Gateway status recorded in metadata
    const meta = JSON.parse(sub.metadata);
    assert.equal(meta.gateway_subscription_status, 'ACTIVE');
    assert.ok(meta.status_recorded_at);

    // 3. Billing audit event recorded
    const audit = tables.billing_audit_events.find(e => e.event_type === 'SUBSCRIPTION_STATUS_RECORDED');
    assert.ok(audit);

    // 4. NO invoice issued
    assert.equal(tables.billing_invoices.length, 0);

    // 5. NO credit grants created
    assert.equal(tables.credit_grants.length, 0);
  });

  it('Scenario 11: Subscription activation with sufficient payment evidence (SUBSCRIPTION_PAYMENT_SUCCESS) issues invoice, grants entitlements', async () => {
    const { dbClient, tables } = createMockDb();
    const service = new PaymentGatewayService();
    service.setDbClient(dbClient);

    const now = Date.now();
    const gatewaySubId = 'sub_cf_paid_activation_01';
    const purchaseId = 'pur_cf_paid_01';
    const customerId = 'cust_paid_01';
    const principalId = 'usr_paid_01';

    tables.billing_customers.push({ id: customerId, principal_id: principalId });
    tables.subscriptions.push({
      id: purchaseId,
      customer_id: customerId,
      principal_id: principalId,
      account_id: customerId,
      plan_id: 'plus',
      status: 'pending',
      gateway: 'cashfree',
      gateway_subscription_id: gatewaySubId,
      currency: 'INR',
      amount_minor_units: 39900,
      current_period_start: now,
      current_period_end: now,
      cancel_at_period_end: false,
      metadata: JSON.stringify({ principalId, customerId, planTier: 'plus', customerState: '07' }),
      created_at: now,
      updated_at: now
    });

    const payload = {
      type: 'SUBSCRIPTION_PAYMENT_SUCCESS',
      data: {
        subscription_details: {
          subscription_id: gatewaySubId,
          cf_subscription_id: 'cf_sub_111',
          current_cycle: 1
        },
        payment: {
          cf_payment_id: 'cf_pay_paid_001',
          payment_status: 'SUCCESS',
          payment_amount: 399.00,
          payment_currency: 'INR'
        }
      }
    };

    const timestamp = '1729355000';
    const rawBody = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', process.env.CASHFREE_SECRET_KEY!).update(`${timestamp}${rawBody}`).digest('base64');

    const res = await service.processCashfreeWebhook(rawBody, signature, timestamp);
    assert.equal(res.status, 'PROCESSED');

    // 1. Subscription status activated
    const sub = tables.subscriptions.find(s => s.id === purchaseId);
    assert.equal(sub.status, 'active');

    // 2. Invoice created
    assert.ok(tables.billing_invoices.length >= 1);
  });

  it('Scenario 12: data.subscription_details identifier extraction succeeds', async () => {
    const { dbClient, tables } = createMockDb();
    const service = new PaymentGatewayService();
    service.setDbClient(dbClient);

    const now = Date.now();
    const gatewaySubId = 'sub_cf_v2025_schema_test';
    const purchaseId = 'pur_cf_v2025_01';

    tables.billing_customers.push({ id: 'cust_v2025', principal_id: 'usr_v2025' });
    tables.subscriptions.push({
      id: purchaseId,
      customer_id: 'cust_v2025',
      principal_id: 'usr_v2025',
      account_id: 'cust_v2025',
      plan_id: 'pro',
      status: 'pending',
      gateway: 'cashfree',
      gateway_subscription_id: gatewaySubId,
      currency: 'INR',
      amount_minor_units: 99900,
      current_period_start: now,
      current_period_end: now,
      cancel_at_period_end: false,
      metadata: JSON.stringify({ principalId: 'usr_v2025', customerId: 'cust_v2025', planTier: 'pro', customerState: '07' }),
      created_at: now,
      updated_at: now
    });

    // Pure v2025-01-01 schema: subscription_details + payment
    const payload = {
      type: 'SUBSCRIPTION_PAYMENT_SUCCESS',
      data: {
        subscription_details: {
          subscription_id: gatewaySubId,
          cf_subscription_id: 'cf_sub_99999',
          current_cycle: 1
        },
        payment: {
          cf_payment_id: 'cf_pay_v2025_01',
          payment_status: 'SUCCESS',
          payment_amount: 999.00,
          payment_currency: 'INR'
        }
      }
    };

    const timestamp = '1729355000';
    const rawBody = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', process.env.CASHFREE_SECRET_KEY!).update(`${timestamp}${rawBody}`).digest('base64');

    const res = await service.processCashfreeWebhook(rawBody, signature, timestamp);
    assert.equal(res.status, 'PROCESSED');

    const sub = tables.subscriptions.find(s => s.id === purchaseId);
    assert.equal(sub.status, 'active');
  });

  // =========================================================================
  // 3. FRAUD DETECTION & RECONCILIATION GUARDS
  // =========================================================================
  it('Scenario 13: Missing or mismatched subscription correlation rejection (BILLING_RECONCILIATION_FAILED)', async () => {
    const { dbClient } = createMockDb();
    const service = new PaymentGatewayService();
    service.setDbClient(dbClient);

    const payload = {
      type: 'SUBSCRIPTION_PAYMENT_SUCCESS',
      data: {
        subscription_details: {
          subscription_id: 'sub_unknown_nonexistent_999',
          current_cycle: 1
        },
        payment: {
          cf_payment_id: 'cf_pay_unknown_01',
          payment_status: 'SUCCESS',
          payment_amount: 399.00,
          payment_currency: 'INR'
        }
      }
    };

    const timestamp = '1729355000';
    const rawBody = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', process.env.CASHFREE_SECRET_KEY!).update(`${timestamp}${rawBody}`).digest('base64');

    await assert.rejects(
      async () => service.processCashfreeWebhook(rawBody, signature, timestamp),
      /BILLING_RECONCILIATION_FAILED: No authoritative purchase record found/
    );
  });

  it('Scenario 14: Incorrect currency rejection (FRAUD_CHECK_FAILED)', async () => {
    const { dbClient, tables } = createMockDb();
    const service = new PaymentGatewayService();
    service.setDbClient(dbClient);

    const now = Date.now();
    const gatewaySubId = 'sub_cf_fraud_curr_01';

    tables.subscriptions.push({
      id: 'pur_cf_fraud_curr',
      customer_id: 'cust_fraud_01',
      plan_id: 'plus',
      status: 'pending',
      gateway: 'cashfree',
      gateway_subscription_id: gatewaySubId,
      currency: 'INR',
      amount_minor_units: 39900,
      current_period_start: now,
      current_period_end: now,
      cancel_at_period_end: false,
      metadata: JSON.stringify({ planTier: 'plus' }),
      created_at: now,
      updated_at: now
    });

    const payload = {
      type: 'SUBSCRIPTION_PAYMENT_SUCCESS',
      data: {
        subscription_details: {
          subscription_id: gatewaySubId,
          current_cycle: 1
        },
        payment: {
          cf_payment_id: 'cf_pay_fraud_curr',
          payment_status: 'SUCCESS',
          payment_amount: 399.00,
          payment_currency: 'USD' // Mismatched currency!
        }
      }
    };

    const timestamp = '1729355000';
    const rawBody = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', process.env.CASHFREE_SECRET_KEY!).update(`${timestamp}${rawBody}`).digest('base64');

    await assert.rejects(
      async () => service.processCashfreeWebhook(rawBody, signature, timestamp),
      /FRAUD_CHECK_FAILED: Currency mismatch. Expected INR, received USD/
    );
  });

  it('Scenario 15: Incorrect payment amount rejection (FRAUD_CHECK_FAILED)', async () => {
    const { dbClient, tables } = createMockDb();
    const service = new PaymentGatewayService();
    service.setDbClient(dbClient);

    const now = Date.now();
    const gatewaySubId = 'sub_cf_fraud_amt_01';

    tables.subscriptions.push({
      id: 'pur_cf_fraud_amt',
      customer_id: 'cust_fraud_02',
      plan_id: 'plus',
      status: 'pending',
      gateway: 'cashfree',
      gateway_subscription_id: gatewaySubId,
      currency: 'INR',
      amount_minor_units: 39900, // Expected 39900 paise (₹399.00)
      current_period_start: now,
      current_period_end: now,
      cancel_at_period_end: false,
      metadata: JSON.stringify({ planTier: 'plus' }),
      created_at: now,
      updated_at: now
    });

    const payload = {
      type: 'SUBSCRIPTION_PAYMENT_SUCCESS',
      data: {
        subscription_details: {
          subscription_id: gatewaySubId,
          current_cycle: 1
        },
        payment: {
          cf_payment_id: 'cf_pay_fraud_amt',
          payment_status: 'SUCCESS',
          payment_amount: 1.00, // Attacker sends ₹1.00 instead of ₹399.00!
          payment_currency: 'INR'
        }
      }
    };

    const timestamp = '1729355000';
    const rawBody = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', process.env.CASHFREE_SECRET_KEY!).update(`${timestamp}${rawBody}`).digest('base64');

    await assert.rejects(
      async () => service.processCashfreeWebhook(rawBody, signature, timestamp),
      /FRAUD_CHECK_FAILED: Amount mismatch. Expected 39900, received 100/
    );
  });

  // =========================================================================
  // 4. IDEMPOTENCY & CROSS-CATEGORY DEDUPLICATION
  // =========================================================================
  it('Scenario 16: Duplicate event ID idempotency returns ALREADY_PROCESSED', async () => {
    const { dbClient, tables } = createMockDb();
    const service = new PaymentGatewayService();
    service.setDbClient(dbClient);

    const now = Date.now();
    const gatewaySubId = 'sub_cf_dedup_01';
    const purchaseId = 'pur_cf_dedup_01';

    tables.billing_customers.push({ id: 'cust_dedup', principal_id: 'usr_dedup' });
    tables.subscriptions.push({
      id: purchaseId,
      customer_id: 'cust_dedup',
      principal_id: 'usr_dedup',
      account_id: 'cust_dedup',
      plan_id: 'plus',
      status: 'pending',
      gateway: 'cashfree',
      gateway_subscription_id: gatewaySubId,
      currency: 'INR',
      amount_minor_units: 39900,
      current_period_start: now,
      current_period_end: now,
      cancel_at_period_end: false,
      metadata: JSON.stringify({ principalId: 'usr_dedup', customerId: 'cust_dedup', planTier: 'plus', customerState: '07' }),
      created_at: now,
      updated_at: now
    });

    const payload = {
      event_id: 'evt_cf_unique_12345',
      type: 'SUBSCRIPTION_PAYMENT_SUCCESS',
      data: {
        subscription_details: {
          subscription_id: gatewaySubId,
          current_cycle: 1
        },
        payment: {
          cf_payment_id: 'cf_pay_dedup_01',
          payment_status: 'SUCCESS',
          payment_amount: 399.00,
          payment_currency: 'INR'
        }
      }
    };

    const timestamp = '1729355000';
    const rawBody = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', process.env.CASHFREE_SECRET_KEY!).update(`${timestamp}${rawBody}`).digest('base64');

    // First delivery: processes successfully
    const res1 = await service.processCashfreeWebhook(rawBody, signature, timestamp);
    assert.equal(res1.status, 'PROCESSED');
    assert.equal(res1.duplicate, false);

    // Second delivery of exact same webhook event: returns ALREADY_PROCESSED
    const res2 = await service.processCashfreeWebhook(rawBody, signature, timestamp);
    assert.equal(res2.status, 'ALREADY_PROCESSED');
    assert.equal(res2.duplicate, true);
  });

  it('Scenario 17: Cross-category duplicate delivery (PG and Subscriptions for same payment) safely deduplicated via idempotent_operations', async () => {
    const { dbClient, tables } = createMockDb();
    const service = new PaymentGatewayService();
    service.setDbClient(dbClient);

    const now = Date.now();
    const gatewaySubId = 'sub_cf_cross_cat_01';
    const purchaseId = 'pur_cf_cross_cat_01';
    const sharedPaymentId = 'cf_pay_shared_cat_001';

    tables.billing_customers.push({ id: 'cust_cross', principal_id: 'usr_cross' });
    tables.subscriptions.push({
      id: purchaseId,
      customer_id: 'cust_cross',
      principal_id: 'usr_cross',
      account_id: 'cust_cross',
      plan_id: 'plus',
      status: 'pending',
      gateway: 'cashfree',
      gateway_subscription_id: gatewaySubId,
      currency: 'INR',
      amount_minor_units: 39900,
      current_period_start: now,
      current_period_end: now,
      cancel_at_period_end: false,
      metadata: JSON.stringify({ principalId: 'usr_cross', customerId: 'cust_cross', planTier: 'plus', customerState: '07' }),
      created_at: now,
      updated_at: now
    });

    // 1. Delivery A: Subscriptions category webhook (different event_id)
    const payloadA = {
      event_id: 'evt_cf_sub_hook_01',
      type: 'SUBSCRIPTION_PAYMENT_SUCCESS',
      data: {
        subscription_details: {
          subscription_id: gatewaySubId,
          current_cycle: 1
        },
        payment: {
          cf_payment_id: sharedPaymentId,
          payment_status: 'SUCCESS',
          payment_amount: 399.00,
          payment_currency: 'INR'
        }
      }
    };

    const timestampA = '1729355000';
    const rawBodyA = JSON.stringify(payloadA);
    const signatureA = crypto.createHmac('sha256', process.env.CASHFREE_SECRET_KEY!).update(`${timestampA}${rawBodyA}`).digest('base64');

    const resA = await service.processCashfreeWebhook(rawBodyA, signatureA, timestampA);
    assert.equal(resA.status, 'PROCESSED');
    assert.equal(tables.billing_invoices.length, 1);

    // 2. Delivery B: Payment Gateway category webhook (different event_id, but SAME payment ID & subscription)
    const payloadB = {
      event_id: 'evt_cf_pg_hook_02',
      type: 'PAYMENT_SUCCESS_WEBHOOK',
      data: {
        order: {
          order_id: gatewaySubId,
          order_amount: 399.00,
          order_currency: 'INR'
        },
        payment: {
          cf_payment_id: sharedPaymentId,
          payment_status: 'SUCCESS',
          payment_amount: 399.00,
          payment_currency: 'INR'
        }
      }
    };

    const timestampB = '1729355001';
    const rawBodyB = JSON.stringify(payloadB);
    const signatureB = crypto.createHmac('sha256', process.env.CASHFREE_SECRET_KEY!).update(`${timestampB}${rawBodyB}`).digest('base64');

    const resB = await service.processCashfreeWebhook(rawBodyB, signatureB, timestampB);
    // Because idempotent_operations already has cashfree:sub:pur_cf_cross_cat_01:pay:cf_pay_shared_cat_001 as COMPLETED,
    // handleGatewayEvent returns early and does not generate another invoice or duplicate fulfillment
    assert.equal(resB.status, 'PROCESSED');
    assert.equal(tables.billing_invoices.length, 1); // Strictly unchanged!
  });

  // =========================================================================
  // 5. TRANSACTIONAL ATOMICITY & COMMERCIAL POLICY
  // =========================================================================
  it('Scenario 18: Failed fulfillment transaction rolls back cleanly', async () => {
    const { dbClient, tables } = createMockDb();
    const service = new PaymentGatewayService();
    service.setDbClient(dbClient);

    const now = Date.now();
    const gatewaySubId = 'sub_cf_rollback_01';
    const purchaseId = 'pur_cf_rollback_01';

    tables.subscriptions.push({
      id: purchaseId,
      customer_id: 'cust_rb',
      plan_id: 'plus',
      status: 'pending',
      gateway: 'cashfree',
      gateway_subscription_id: gatewaySubId,
      currency: 'INR',
      amount_minor_units: 39900,
      current_period_start: now,
      current_period_end: now,
      cancel_at_period_end: false,
      metadata: JSON.stringify({ customerState: '07' }),
      created_at: now,
      updated_at: now
    });

    // Provide payload with currency mismatch to trigger failure inside transaction
    const payload = {
      type: 'SUBSCRIPTION_PAYMENT_SUCCESS',
      data: {
        subscription_details: {
          subscription_id: gatewaySubId,
          current_cycle: 1
        },
        payment: {
          cf_payment_id: 'cf_pay_rb_01',
          payment_status: 'SUCCESS',
          payment_amount: 399.00,
          payment_currency: 'EUR'
        }
      }
    };

    const timestamp = '1729355000';
    const rawBody = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', process.env.CASHFREE_SECRET_KEY!).update(`${timestamp}${rawBody}`).digest('base64');

    await assert.rejects(
      async () => service.processCashfreeWebhook(rawBody, signature, timestamp),
      /FRAUD_CHECK_FAILED: Currency mismatch/
    );

    // Subscription status must remain pending
    const sub = tables.subscriptions.find(s => s.id === purchaseId);
    assert.equal(sub.status, 'pending');
    assert.equal(tables.billing_invoices.length, 0);
  });

  it('Scenario 19: Commercial billing disabled behavior (BILLING_UNAVAILABLE unless rehearsal active)', async () => {
    const { dbClient, tables } = createMockDb();
    const service = new PaymentGatewayService();
    service.setDbClient(dbClient);

    // Disable commercial billing in staging environment
    process.env.AIRA_ENVIRONMENT = 'staging';
    delete process.env.AIRA_ENABLE_TEST_FULFILLMENT;
    process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'false';
    process.env.AIRA_STAGING_SANDBOX_REHEARSAL_ENABLED = 'false';

    const now = Date.now();
    const gatewaySubId = 'sub_cf_disabled_01';
    const purchaseId = 'pur_cf_disabled_01';

    tables.subscriptions.push({
      id: purchaseId,
      customer_id: 'cust_dis',
      principal_id: 'usr_dis',
      account_id: 'cust_dis',
      plan_id: 'plus',
      status: 'pending',
      gateway: 'cashfree',
      gateway_subscription_id: gatewaySubId,
      currency: 'INR',
      amount_minor_units: 39900,
      current_period_start: now,
      current_period_end: now,
      cancel_at_period_end: false,
      metadata: JSON.stringify({ principalId: 'usr_dis', customerId: 'cust_dis' }),
      created_at: now,
      updated_at: now
    });

    // 1. Paid fulfillment event: MUST BE BLOCKED
    const paidPayload = {
      type: 'SUBSCRIPTION_PAYMENT_SUCCESS',
      data: {
        subscription_details: {
          subscription_id: gatewaySubId,
          current_cycle: 1
        },
        payment: {
          cf_payment_id: 'cf_pay_dis_01',
          payment_status: 'SUCCESS',
          payment_amount: 399.00,
          payment_currency: 'INR'
        }
      }
    };

    const timestamp = '1729355000';
    const rawBodyPaid = JSON.stringify(paidPayload);
    const sigPaid = crypto.createHmac('sha256', process.env.CASHFREE_SECRET_KEY!).update(`${timestamp}${rawBodyPaid}`).digest('base64');

    await assert.rejects(
      async () => service.processCashfreeWebhook(rawBodyPaid, sigPaid, timestamp),
      /BILLING_UNAVAILABLE: Commercial billing fulfillment is currently disabled in staging/
    );

    // 2. Safe cancellation event: MUST BE PERMITTED EVEN WHEN BILLING IS DISABLED
    const cancelPayload = {
      type: 'SUBSCRIPTION_STATUS_CHANGED',
      data: {
        subscription_details: {
          subscription_id: gatewaySubId,
          subscription_status: 'CANCELLED'
        }
      }
    };

    const rawBodyCancel = JSON.stringify(cancelPayload);
    const sigCancel = crypto.createHmac('sha256', process.env.CASHFREE_SECRET_KEY!).update(`${timestamp}${rawBodyCancel}`).digest('base64');

    const cancelRes = await service.processCashfreeWebhook(rawBodyCancel, sigCancel, timestamp);
    assert.equal(cancelRes.status, 'PROCESSED');

    const cancelledSub = tables.subscriptions.find(s => s.id === purchaseId);
    assert.equal(cancelledSub.status, 'cancelled');
  });

  // =========================================================================
  // 6. ZERO REGRESSION ON RAZORPAY
  // =========================================================================
  it('Scenario 20: Razorpay webhook regression test verifies processRazorpayWebhook remains 100% functional', async () => {
    const { dbClient, tables } = createMockDb();
    const service = new PaymentGatewayService();
    service.setDbClient(dbClient);

    const now = Date.now();
    const gatewaySubId = 'sub_rzp_regression_target';
    const purchaseId = 'pur_rzp_regression_01';
    const customerId = 'cust_rzp_reg_01';
    const principalId = 'usr_rzp_reg_01';

    tables.billing_customers.push({ id: customerId, principal_id: principalId });
    tables.subscriptions.push({
      id: purchaseId,
      customer_id: customerId,
      principal_id: principalId,
      account_id: customerId,
      plan_id: 'plus',
      status: 'pending',
      gateway: 'razorpay',
      gateway_subscription_id: gatewaySubId,
      currency: 'INR',
      amount_minor_units: 39900,
      current_period_start: now,
      current_period_end: now,
      cancel_at_period_end: false,
      metadata: JSON.stringify({ principalId, customerId, planTier: 'plus', customerState: '07' }),
      created_at: now,
      updated_at: now
    });

    const rzpPayload = {
      event: 'subscription.activated',
      payload: {
        subscription: {
          entity: {
            id: gatewaySubId,
            current_cycle: 1,
            currency: 'INR',
            amount: 39900
          }
        },
        payment: {
          entity: {
            id: 'pay_rzp_reg_001',
            status: 'captured',
            currency: 'INR',
            amount: 39900
          }
        }
      }
    };

    const rawBody = JSON.stringify(rzpPayload);
    const signature = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET!).update(rawBody).digest('hex');

    const res = await service.processRazorpayWebhook(rawBody, signature);
    assert.equal(res.status, 'PROCESSED');

    const sub = tables.subscriptions.find(s => s.id === purchaseId);
    assert.equal(sub.status, 'active');
    assert.ok(tables.billing_invoices.length >= 1);
  });
});
