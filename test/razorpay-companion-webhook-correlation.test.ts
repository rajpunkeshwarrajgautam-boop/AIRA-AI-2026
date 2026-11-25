import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import {
  PaymentGatewayService,
  TerminalRejectionError
} from '../apps/api/src/billing/payment-gateway-service.js';

describe('Gate 4 Razorpay Recurring Subscription Companion Webhook Correlation Suite', () => {
  const origEnv = { ...process.env };
  const WEBHOOK_SECRET = 'test_rzp_webhook_secret_p0_repair';
  const PRINCIPAL_ID = 'neon_user_fc6f9c72-6ebb-4fd2-960a-5a8779e59cb7';
  const CUSTOMER_ID = 'cust_9e1e096ced03407aba9db0a71f6c3253';
  const PURCHASE_ID = 'pur_8150add7f93743e38138b5617f727188';
  const GATEWAY_SUB_ID = 'sub_U3VmcSATvHNdhX';
  const PAYMENT_ID = 'pay_U3W8gDtuakYZGC';
  const INVOICE_ID = 'inv_U3VmdHENwVC9aT';
  const ORDER_ID = 'order_U3VmdPkgNqeQHN';

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
        whereIn: (column: string, values: any[]) => {
          whereInFilter = { column, values };
          return builder;
        },
        andWhere: (queryOrCol: any, opOrVal?: any, val?: any) => {
          return builder.where(queryOrCol, opOrVal, val);
        },
        forUpdate: () => builder,
        orderBy: () => builder,
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
          for (const r of rows) {
            if (matchRow(r)) {
              Object.assign(r, patch);
            }
          }
          return rows.length;
        },
        delete: async () => {
          const rows = tables[tableName] || [];
          tables[tableName] = rows.filter(r => !matchRow(r));
          return 1;
        },
        insert: (record: any) => {
          if (!tables[tableName]) tables[tableName] = [];
          const toInsert = Array.isArray(record) ? record : [record];
          for (const item of toInsert) {
            tables[tableName].push({ ...item });
          }
          const resObj: any = {
            rowCount: toInsert.length,
            length: toInsert.length,
            [0]: toInsert[0],
            onConflict: () => ({
              ignore: () => ({
                returning: () => Promise.resolve(toInsert),
                then: (resolve: any, reject: any) => Promise.resolve(toInsert).then(resolve, reject)
              }),
              merge: async () => {}
            }),
            returning: () => Promise.resolve(toInsert),
            then: (resolve: any, reject: any) => Promise.resolve(toInsert).then(resolve, reject)
          };
          return resObj;
        },
        onConflict: () => ({
          ignore: () => ({
            returning: async () => [],
            then: (resolve: any, reject: any) => Promise.resolve([]).then(resolve, reject)
          }),
          merge: async () => {}
        })
      };

      builder.then = (resolve: any, reject: any) => {
        builder.select().then(resolve, reject);
      };

      return builder;
    };

    dbClient.client = { config: { client: 'pg' } };
    dbClient.schema = {
      hasTable: async (name: string) => Boolean(tables[name])
    };
    dbClient.raw = async (sql: string) => {
      if (sql.includes('nextval')) {
        return { rows: [{ seq: 1 }] };
      }
      return { rows: [] };
    };
    dbClient.transaction = async (callback: (trx: any) => Promise<any>) => {
      return callback(dbClient);
    };

    return { dbClient, tables };
  }

  function signPayload(body: string, secret = WEBHOOK_SECRET): string {
    return crypto.createHmac('sha256', secret).update(body).digest('hex');
  }

  function setupInitialPendingSubscription(tables: Record<string, any[]>) {
    tables.billing_customers.push({
      id: CUSTOMER_ID,
      principal_id: PRINCIPAL_ID,
      default_currency: 'INR',
      country_code: 'IN'
    });

    tables.credit_accounts.push({
      id: 'cacc_test_1',
      customer_id: CUSTOMER_ID,
      balance_credits: 100,
      reserved_credits: 0,
      lifetime_granted_credits: 100,
      lifetime_spent_credits: 0
    });

    tables.credit_grants.push({
      id: 'grant_free_welcome',
      account_id: 'cacc_test_1',
      amount_credits: 100,
      remaining_credits: 100,
      grant_type: 'subscription_monthly',
      expires_at: Date.now() + 30 * 86400000
    });

    tables.subscriptions.push({
      id: PURCHASE_ID,
      customer_id: CUSTOMER_ID,
      plan_id: 'pro',
      status: 'pending',
      gateway: 'razorpay',
      gateway_subscription_id: GATEWAY_SUB_ID,
      currency: 'INR',
      amount_minor_units: 99900,
      current_period_start: Date.now(),
      current_period_end: Date.now() + 30 * 86400000,
      metadata: JSON.stringify({
        principalId: PRINCIPAL_ID,
        customerId: CUSTOMER_ID,
        planTier: 'pro',
        amount: 99900,
        reconciliationStatus: 'AWAITING_PAYMENT'
      }),
      created_at: Date.now(),
      updated_at: Date.now()
    });
  }

  beforeEach(() => {
    process.env = { ...origEnv };
    process.env.NODE_ENV = 'test';
    process.env.AIRA_ENVIRONMENT = 'test';
    process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'true';
    process.env.AIRA_ENABLE_TEST_FULFILLMENT = 'true';
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('1. Successfully processes subscription.charged and transitions subscription to active', async () => {
    const { dbClient, tables } = createMockDb();
    setupInitialPendingSubscription(tables);

    const service = new PaymentGatewayService();
    service.setDbClient(dbClient);
    service.setRazorpaySecret(WEBHOOK_SECRET);

    const payload = {
      event: 'subscription.charged',
      id: 'evt_charged_001',
      payload: {
        subscription: {
          entity: {
            id: GATEWAY_SUB_ID,
            status: 'active',
            current_start: Math.floor(Date.now() / 1000),
            current_end: Math.floor((Date.now() + 30 * 86400000) / 1000),
            paid_count: 1
          }
        },
        payment: {
          entity: {
            id: PAYMENT_ID,
            amount: 99900,
            currency: 'INR',
            status: 'captured'
          }
        }
      }
    };

    const rawBody = JSON.stringify(payload);
    const signature = signPayload(rawBody);

    const res = await service.processRazorpayWebhook(rawBody, signature);
    assert.equal(res.status, 'PROCESSED');

    const sub = tables.subscriptions.find(s => s.id === PURCHASE_ID);
    assert.equal(sub.status, 'active');

    const subMeta = JSON.parse(sub.metadata);
    assert.equal(subMeta.lastPaymentId, PAYMENT_ID);
    assert.equal(subMeta.fulfilledCycle, 1);

    // Verified GST invoice generated
    assert.equal(tables.billing_invoices.length, 1);
    assert.equal(tables.billing_invoices[0].billing_event_id, PAYMENT_ID);
    assert.equal(Number(tables.billing_invoices[0].total_amount), 999);
  });

  it('2. invoice.paid without top-level subscription entity correlates cleanly to parent subscription', async () => {
    const { dbClient, tables } = createMockDb();
    setupInitialPendingSubscription(tables);

    const service = new PaymentGatewayService();
    service.setDbClient(dbClient);
    service.setRazorpaySecret(WEBHOOK_SECRET);

    // First process subscription.charged
    const chargedBody = JSON.stringify({
      event: 'subscription.charged',
      id: 'evt_charged_002',
      payload: {
        subscription: {
          entity: {
            id: GATEWAY_SUB_ID,
            status: 'active',
            paid_count: 1
          }
        },
        payment: {
          entity: {
            id: PAYMENT_ID,
            amount: 99900,
            currency: 'INR',
            status: 'captured'
          }
        }
      }
    });
    await service.processRazorpayWebhook(chargedBody, signPayload(chargedBody));

    // Now deliver real-world Razorpay invoice.paid event (contains ONLY order, invoice, payment)
    const invoicePaidBody = JSON.stringify({
      event: 'invoice.paid',
      id: 'evt_invoice_paid_002',
      payload: {
        invoice: {
          entity: {
            id: INVOICE_ID,
            subscription_id: GATEWAY_SUB_ID,
            order_id: ORDER_ID,
            payment_id: PAYMENT_ID,
            amount_paid: 99900,
            currency: 'INR',
            status: 'paid'
          }
        },
        payment: {
          entity: {
            id: PAYMENT_ID,
            order_id: ORDER_ID,
            invoice_id: INVOICE_ID,
            amount: 99900,
            currency: 'INR',
            status: 'captured'
          }
        },
        order: {
          entity: {
            id: ORDER_ID,
            amount: 99900,
            status: 'paid'
          }
        }
      }
    });

    const res = await service.processRazorpayWebhook(invoicePaidBody, signPayload(invoicePaidBody));
    assert.equal(res.status, 'PROCESSED');

    // Confirmed exactly-once fulfillment: no duplicate invoices
    assert.equal(tables.billing_invoices.length, 1);
    assert.equal(Number(tables.billing_invoices[0].total_amount), 999);

    // Confirmed audit event recorded
    const companionAudit = tables.billing_audit_events.find(a => a.event_type === 'COMPANION_EVENT_ACKNOWLEDGED');
    assert.ok(companionAudit);
  });

  it('3. order.paid with child order ID correlates via authoritative payment ID and no-ops idempotently', async () => {
    const { dbClient, tables } = createMockDb();
    setupInitialPendingSubscription(tables);

    const service = new PaymentGatewayService();
    service.setDbClient(dbClient);
    service.setRazorpaySecret(WEBHOOK_SECRET);

    // Setup active subscription with existing payment record
    const sub = tables.subscriptions[0];
    sub.status = 'active';
    sub.metadata = JSON.stringify({
      principalId: PRINCIPAL_ID,
      customerId: CUSTOMER_ID,
      planTier: 'pro',
      lastPaymentId: PAYMENT_ID,
      initialPaymentId: PAYMENT_ID,
      fulfilledCycle: 1
    });

    tables.billing_invoices.push({
      id: 'inv_existing',
      invoice_number: 'INV-2026-0001',
      customer_id: CUSTOMER_ID,
      subscription_id: PURCHASE_ID,
      billing_event_id: PAYMENT_ID,
      total_amount: '999.00'
    });

    const orderPaidBody = JSON.stringify({
      event: 'order.paid',
      id: 'evt_order_paid_003',
      payload: {
        order: {
          entity: {
            id: ORDER_ID,
            amount: 99900,
            status: 'paid'
          }
        },
        payment: {
          entity: {
            id: PAYMENT_ID,
            order_id: ORDER_ID,
            invoice_id: INVOICE_ID,
            amount: 99900,
            currency: 'INR',
            status: 'captured'
          }
        }
      }
    });

    const res = await service.processRazorpayWebhook(orderPaidBody, signPayload(orderPaidBody));
    assert.equal(res.status, 'PROCESSED');

    // Zero duplicate invoices
    assert.equal(tables.billing_invoices.length, 1);
  });

  it('4. payment.captured with child order ID correlates via authoritative payment ID and no-ops idempotently', async () => {
    const { dbClient, tables } = createMockDb();
    setupInitialPendingSubscription(tables);

    const service = new PaymentGatewayService();
    service.setDbClient(dbClient);
    service.setRazorpaySecret(WEBHOOK_SECRET);

    const sub = tables.subscriptions[0];
    sub.status = 'active';
    sub.metadata = JSON.stringify({
      principalId: PRINCIPAL_ID,
      customerId: CUSTOMER_ID,
      planTier: 'pro',
      lastPaymentId: PAYMENT_ID,
      initialPaymentId: PAYMENT_ID,
      fulfilledCycle: 1
    });

    tables.billing_invoices.push({
      id: 'inv_existing',
      invoice_number: 'INV-2026-0001',
      customer_id: CUSTOMER_ID,
      subscription_id: PURCHASE_ID,
      billing_event_id: PAYMENT_ID,
      total_amount: '999.00'
    });

    const paymentCapturedBody = JSON.stringify({
      event: 'payment.captured',
      id: 'evt_payment_captured_004',
      payload: {
        payment: {
          entity: {
            id: PAYMENT_ID,
            order_id: ORDER_ID,
            invoice_id: INVOICE_ID,
            amount: 99900,
            currency: 'INR',
            status: 'captured'
          }
        }
      }
    });

    const res = await service.processRazorpayWebhook(paymentCapturedBody, signPayload(paymentCapturedBody));
    assert.equal(res.status, 'PROCESSED');
    assert.equal(tables.billing_invoices.length, 1);
  });

  it('5. Handles out-of-order delivery where invoice.paid arrives BEFORE subscription.charged', async () => {
    const { dbClient, tables } = createMockDb();
    setupInitialPendingSubscription(tables);

    const service = new PaymentGatewayService();
    service.setDbClient(dbClient);
    service.setRazorpaySecret(WEBHOOK_SECRET);

    // 1. invoice.paid arrives first
    const invoicePaidBody = JSON.stringify({
      event: 'invoice.paid',
      id: 'evt_invoice_first',
      payload: {
        invoice: {
          entity: {
            id: INVOICE_ID,
            subscription_id: GATEWAY_SUB_ID,
            payment_id: PAYMENT_ID,
            amount_paid: 99900,
            currency: 'INR',
            status: 'paid'
          }
        },
        payment: {
          entity: {
            id: PAYMENT_ID,
            amount: 99900,
            currency: 'INR',
            status: 'captured'
          }
        }
      }
    });

    const res1 = await service.processRazorpayWebhook(invoicePaidBody, signPayload(invoicePaidBody));
    assert.equal(res1.status, 'PROCESSED');

    // Subscription activated by invoice.paid
    const sub = tables.subscriptions.find(s => s.id === PURCHASE_ID);
    assert.equal(sub.status, 'active');
    assert.equal(tables.billing_invoices.length, 1);
    assert.equal(Number(tables.billing_invoices[0].total_amount), 999);

    // 2. subscription.charged arrives 2 seconds later
    const chargedBody = JSON.stringify({
      event: 'subscription.charged',
      id: 'evt_charged_later',
      payload: {
        subscription: {
          entity: {
            id: GATEWAY_SUB_ID,
            status: 'active',
            paid_count: 1
          }
        },
        payment: {
          entity: {
            id: PAYMENT_ID,
            amount: 99900,
            currency: 'INR',
            status: 'captured'
          }
        }
      }
    });

    const res2 = await service.processRazorpayWebhook(chargedBody, signPayload(chargedBody));
    assert.equal(res2.status, 'PROCESSED');

    // Exactly-once: still 1 invoice, subscription remains active
    assert.equal(tables.billing_invoices.length, 1);
    assert.equal(tables.subscriptions.find(s => s.id === PURCHASE_ID).status, 'active');
  });

  it('6. Rejects webhook with invalid HMAC signature before accessing database', async () => {
    const { dbClient } = createMockDb();
    const service = new PaymentGatewayService();
    service.setDbClient(dbClient);
    service.setRazorpaySecret(WEBHOOK_SECRET);

    const body = JSON.stringify({ event: 'invoice.paid', id: 'evt_bad_sig' });
    const invalidSignature = crypto.createHash('sha256').update('wrong_signature').digest('hex');

    await assert.rejects(
      async () => service.processRazorpayWebhook(body, invalidSignature),
      (err: any) => {
        assert.ok(err.message.includes('FORBIDDEN_WEBHOOK'));
        assert.ok(err.message.includes('Signature verification failed'));
        return true;
      }
    );
  });

  it('7. Rejects missing subscription correlation with TerminalRejectionError', async () => {
    const { dbClient } = createMockDb();
    const service = new PaymentGatewayService();
    service.setDbClient(dbClient);
    service.setRazorpaySecret(WEBHOOK_SECRET);

    const body = JSON.stringify({
      event: 'invoice.paid',
      id: 'evt_orphan_invoice',
      payload: {
        invoice: {
          entity: {
            id: 'inv_orphan_999',
            subscription_id: 'sub_nonexistent_888',
            payment_id: 'pay_orphan_777',
            amount_paid: 99900,
            currency: 'INR',
            status: 'paid'
          }
        },
        payment: {
          entity: {
            id: 'pay_orphan_777',
            amount: 99900,
            currency: 'INR',
            status: 'captured'
          }
        }
      }
    });

    await assert.rejects(
      async () => service.processRazorpayWebhook(body, signPayload(body)),
      (err: any) => {
        assert.ok(err instanceof TerminalRejectionError);
        assert.ok(err.message.includes('BILLING_RECONCILIATION_FAILED: No authoritative purchase record found'));
        return true;
      }
    );
  });

  it('8. Rejects cross-customer payment correlation to prevent privilege escalation', async () => {
    const { dbClient, tables } = createMockDb();
    setupInitialPendingSubscription(tables);

    const service = new PaymentGatewayService();
    service.setDbClient(dbClient);
    service.setRazorpaySecret(WEBHOOK_SECRET);

    // Existing invoice belongs to a DIFFERENT customer
    tables.billing_invoices.push({
      id: 'inv_cross_customer',
      invoice_number: 'INV-2026-0099',
      customer_id: 'cust_attacker_other_tenant',
      subscription_id: PURCHASE_ID,
      billing_event_id: 'pay_shared_spoofed',
      total_amount: '999.00'
    });

    const paymentBody = JSON.stringify({
      event: 'payment.captured',
      id: 'evt_cross_account',
      payload: {
        payment: {
          entity: {
            id: 'pay_shared_spoofed',
            order_id: 'order_unknown',
            invoice_id: 'inv_unknown',
            amount: 99900,
            currency: 'INR',
            status: 'captured'
          }
        }
      }
    });

    await assert.rejects(
      async () => service.processRazorpayWebhook(paymentBody, signPayload(paymentBody)),
      (err: any) => {
        assert.ok(err instanceof TerminalRejectionError);
        assert.ok(err.message.includes('CROSS_CUSTOMER_CORRELATION_DETECTED'));
        return true;
      }
    );
  });

  it('9. Rejects ambiguous multiple-subscription payment correlation', async () => {
    const { dbClient, tables } = createMockDb();
    setupInitialPendingSubscription(tables);

    // Create a second subscription claiming the exact same lastPaymentId
    tables.subscriptions.push({
      id: 'pur_ambiguous_second',
      customer_id: CUSTOMER_ID,
      plan_id: 'pro',
      status: 'active',
      gateway: 'razorpay',
      gateway_subscription_id: 'sub_second_duplicate',
      currency: 'INR',
      amount_minor_units: 99900,
      metadata: JSON.stringify({
        principalId: PRINCIPAL_ID,
        lastPaymentId: 'pay_ambiguous_123'
      })
    });
    tables.subscriptions[0].metadata = JSON.stringify({
      principalId: PRINCIPAL_ID,
      lastPaymentId: 'pay_ambiguous_123'
    });

    const service = new PaymentGatewayService();
    service.setDbClient(dbClient);
    service.setRazorpaySecret(WEBHOOK_SECRET);

    const paymentBody = JSON.stringify({
      event: 'payment.captured',
      id: 'evt_ambiguous',
      payload: {
        payment: {
          entity: {
            id: 'pay_ambiguous_123',
            amount: 99900,
            currency: 'INR',
            status: 'captured'
          }
        }
      }
    });

    await assert.rejects(
      async () => service.processRazorpayWebhook(paymentBody, signPayload(paymentBody)),
      (err: any) => {
        assert.ok(err instanceof TerminalRejectionError);
        assert.ok(err.message.includes('AMBIGUOUS_CORRELATION'));
        return true;
      }
    );
  });

  it('10. End-to-end full wave of 5 events certifies exactly-once fulfillment', async () => {
    const { dbClient, tables } = createMockDb();
    setupInitialPendingSubscription(tables);

    const service = new PaymentGatewayService();
    service.setDbClient(dbClient);
    service.setRazorpaySecret(WEBHOOK_SECRET);

    // Simulate real webhook arrival wave:
    // Event 1: payment.captured (delivered, awaiting subscription) -> retryable or acknowledged
    // Event 2: subscription.charged (authoritative activation)
    const chargedBody = JSON.stringify({
      event: 'subscription.charged',
      id: 'evt_wave_charged',
      payload: {
        subscription: {
          entity: {
            id: GATEWAY_SUB_ID,
            status: 'active',
            paid_count: 1
          }
        },
        payment: {
          entity: {
            id: PAYMENT_ID,
            amount: 99900,
            currency: 'INR',
            status: 'captured'
          }
        }
      }
    });
    await service.processRazorpayWebhook(chargedBody, signPayload(chargedBody));

    // Event 3: subscription.activated
    const activatedBody = JSON.stringify({
      event: 'subscription.activated',
      id: 'evt_wave_activated',
      payload: {
        subscription: {
          entity: {
            id: GATEWAY_SUB_ID,
            status: 'active',
            currency: 'INR'
          }
        }
      }
    });
    await service.processRazorpayWebhook(activatedBody, signPayload(activatedBody));

    // Event 4: invoice.paid
    const invoiceBody = JSON.stringify({
      event: 'invoice.paid',
      id: 'evt_wave_invoice',
      payload: {
        invoice: {
          entity: {
            id: INVOICE_ID,
            subscription_id: GATEWAY_SUB_ID,
            order_id: ORDER_ID,
            payment_id: PAYMENT_ID,
            amount_paid: 99900,
            currency: 'INR',
            status: 'paid'
          }
        },
        payment: {
          entity: {
            id: PAYMENT_ID,
            order_id: ORDER_ID,
            invoice_id: INVOICE_ID,
            amount: 99900,
            currency: 'INR',
            status: 'captured'
          }
        }
      }
    });
    await service.processRazorpayWebhook(invoiceBody, signPayload(invoiceBody));

    // Event 5: order.paid
    const orderBody = JSON.stringify({
      event: 'order.paid',
      id: 'evt_wave_order',
      payload: {
        order: {
          entity: {
            id: ORDER_ID,
            amount: 99900,
            status: 'paid'
          }
        },
        payment: {
          entity: {
            id: PAYMENT_ID,
            order_id: ORDER_ID,
            invoice_id: INVOICE_ID,
            amount: 99900,
            currency: 'INR',
            status: 'captured'
          }
        }
      }
    });
    await service.processRazorpayWebhook(orderBody, signPayload(orderBody));

    // Event 6: payment.captured
    const paymentBody = JSON.stringify({
      event: 'payment.captured',
      id: 'evt_wave_payment',
      payload: {
        payment: {
          entity: {
            id: PAYMENT_ID,
            order_id: ORDER_ID,
            invoice_id: INVOICE_ID,
            amount: 99900,
            currency: 'INR',
            status: 'captured'
          }
        }
      }
    });
    await service.processRazorpayWebhook(paymentBody, signPayload(paymentBody));

    // Final Invariant Checks
    assert.equal(tables.subscriptions[0].status, 'active');
    assert.equal(tables.billing_invoices.length, 1);
    assert.equal(tables.billing_invoices[0].invoice_number, 'INV-2026-0001');

    assert.equal(Number(tables.billing_invoices[0].total_amount), 999);
    assert.equal(tables.payment_gateway_events.length, 5);

    const companionAudits = tables.billing_audit_events.filter(a => a.event_type === 'COMPANION_EVENT_ACKNOWLEDGED');
    assert.ok(companionAudits.length >= 3, 'Expected at least 3 companion event acknowledgments');
  });
});
