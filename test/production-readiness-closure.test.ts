import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ProductionReadinessService } from '../apps/api/src/billing/production-readiness.js';
import {
  PaymentGatewayService,
  isPriceApprovedForProduction,
  isInternationalUsdBillingEnabled
} from '../apps/api/src/billing/payment-gateway-service.js';

describe('Production Release Readiness & Distributed Safety Closure', () => {
  it('1. ProductionReadinessService removes hardcoded VERIFIED, stale SHA, and wrong env names', () => {
    const origEnv = { ...process.env };
    try {
      delete process.env.RAZORPAY_KEY_ID;
      delete process.env.RAZORPAY_KEY_SECRET;
      delete process.env.CASHFREE_APP_ID;
      delete process.env.CASHFREE_SECRET_KEY;
      delete process.env.CASHFREE_ENV;
      delete process.env.RAZORPAY_WEBHOOK_SECRET;
      delete process.env.CASHFREE_WEBHOOK_SECRET;
      delete process.env.AIRA_INTERNAL_WORKER_KEY;
      delete process.env.CRON_SECRET;
      delete process.env.VERCEL_GIT_COMMIT_SHA;
      delete process.env.GIT_COMMIT_SHA;
      process.env.NODE_ENV = 'production';

      const svc = new ProductionReadinessService();
      const report = svc.audit();

      assert.notEqual(report.commitSha, '03078b8e08a62f093c20c0318144632a136f4399');
      assert.equal(report.commitSha, 'UNKNOWN');
      assert.equal(report.overallVerdict, 'COMMERCIAL PLATFORM BLOCKED — REMEDIATION REQUIRED');

      const gate01 = report.gates.find(g => g.id === 'GATE_01_MERCHANT_KYC')!;
      assert.equal(gate01.outcome, 'PENDING_OWNER_ACTION');
      assert.ok(gate01.evidence.includes('Cashfree') && gate01.evidence.includes('Razorpay'));

      const gate02 = report.gates.find(g => g.id === 'GATE_02_DOMESTIC_RECURRING')!;
      assert.equal(gate02.outcome, 'FAIL');
      assert.ok(gate02.requiredConfiguration.includes('RAZORPAY_PLAN_ID_PLUS_INR'));
      assert.ok(gate02.requiredConfiguration.includes('CASHFREE_PLAN_ID_PRO_INR'));

      // Unverified DB/CI/Secrets must report UNKNOWN rather than fake VERIFIED
      const gate04 = report.gates.find(g => g.id === 'GATE_04_GATEWAY_KEYS_PROTECTION')!;
      const gate11 = report.gates.find(g => g.id === 'GATE_11_FRAUD_ABUSE_CONTROLS')!;
      const gate12 = report.gates.find(g => g.id === 'GATE_12_PRODUCTION_MONITORING')!;
      assert.equal(gate04.status, 'UNKNOWN');
      assert.equal(gate04.outcome, 'UNKNOWN');
      assert.equal(gate11.status, 'UNKNOWN');
      assert.equal(gate12.status, 'UNKNOWN');
      assert.ok(!gate11.requiredConfiguration.includes('33 applied migrations'));
      assert.ok(!JSON.stringify(report).includes('Next.js'));

      // Supplying verified runtime evidence resolves DB/Secrets/Worker checks cleanly
      process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_rzp_live';
      process.env.CASHFREE_WEBHOOK_SECRET = 'whsec_cf_live';
      process.env.RAZORPAY_PLAN_ID_PLUS_INR = 'plan_rzp_plus';
      process.env.RAZORPAY_PLAN_ID_PRO_INR = 'plan_rzp_pro';
      process.env.CASHFREE_PLAN_ID_PLUS_INR = 'plan_cf_plus';
      process.env.CASHFREE_PLAN_ID_PRO_INR = 'plan_cf_pro';
      process.env.AIRA_INTERNAL_WORKER_KEY = 'wkr_live_key';
      process.env.AIRA_ENABLE_PRODUCTION_FINANCIAL_WORKER = 'true';

      const verifiedReport = svc.audit({
        dbVerified: true,
        appliedMigrationsCount: 35,
        expectedMigrationsCount: 35,
        testSecretsVerified: true,
        workerVerified: true,
        commitSha: '29e7c2708c3238204e886c9d0c44a996bc97a74e'
      });

      assert.equal(verifiedReport.unknownCount, 0);
      assert.equal(verifiedReport.blockedCount, 0);
      assert.equal(verifiedReport.gates.find(g => g.id === 'GATE_11_FRAUD_ABUSE_CONTROLS')!.outcome, 'PASS');
      assert.equal(verifiedReport.gates.find(g => g.id === 'GATE_13_RECONCILIATION_JOBS')!.outcome, 'PASS');
    } finally {
      process.env = origEnv;
    }
  });

  it('2. Production USD recurring checkout fails closed unless AIRA_INTERNATIONAL_USD_BILLING_ENABLED=true', () => {
    const origUsd = process.env.AIRA_INTERNATIONAL_USD_BILLING_ENABLED;
    try {
      delete process.env.AIRA_INTERNATIONAL_USD_BILLING_ENABLED;
      assert.equal(isInternationalUsdBillingEnabled(), false);
      assert.equal(isPriceApprovedForProduction('plus', 'INR'), true);
      assert.equal(isPriceApprovedForProduction('pro', 'INR'), true);
      assert.equal(isPriceApprovedForProduction('plus', 'USD'), false);
      assert.equal(isPriceApprovedForProduction('pro', 'USD'), false);

      process.env.AIRA_INTERNATIONAL_USD_BILLING_ENABLED = 'true';
      assert.equal(isInternationalUsdBillingEnabled(), true);
      assert.equal(isPriceApprovedForProduction('plus', 'USD'), true);
    } finally {
      if (origUsd !== undefined) process.env.AIRA_INTERNATIONAL_USD_BILLING_ENABLED = origUsd;
      else delete process.env.AIRA_INTERNATIONAL_USD_BILLING_ENABLED;
    }
  });

  it('3. Properly superseded checkout is hidden from pending lifecycle, while uncancelled legacy pending surfaces safely', async () => {
    const svc = new PaymentGatewayService();
    const now = Date.now();
    const subs = [
      {
        id: 'pur_stale_pending_plus',
        customer_id: 'cust_stale_1',
        plan_id: 'plus',
        status: 'superseded',
        gateway: 'razorpay',
        currency: 'INR',
        amount_minor_units: 39900,
        metadata: JSON.stringify({}),
        created_at: now - 100000,
        updated_at: now - 10000
      },
      {
        id: 'pur_active_pro',
        customer_id: 'cust_stale_1',
        plan_id: 'pro',
        status: 'active',
        gateway: 'razorpay',
        currency: 'INR',
        amount_minor_units: 99900,
        current_period_start: now - 10000,
        current_period_end: now + 30 * 86400000,
        cancel_at_period_end: false,
        metadata: JSON.stringify({}),
        created_at: now - 10000,
        updated_at: now - 10000
      }
    ];

    const makeBuilder = (table: string, filters: Record<string, unknown> = {}, whereInCol?: string, whereInVals?: unknown[]) => {
      const filterRows = () => {
        if (table === 'billing_customers') {
          return filters.principal_id === 'usr_stale_1' || filters.id === 'cust_stale_1'
            ? [{ id: 'cust_stale_1', principal_id: 'usr_stale_1' }]
            : [];
        }
        if (table === 'subscriptions') {
          return subs
            .filter(r => Object.entries(filters).every(([k, v]) => (r as any)[k] === v))
            .filter(r => !whereInCol || !whereInVals || whereInVals.includes((r as any)[whereInCol]))
            .sort((a, b) => Number(b.created_at) - Number(a.created_at));
        }
        return [];
      };
      const builder: any = {
        whereIn: (col: string, vals: unknown[]) => makeBuilder(table, filters, col, vals),
        orderBy: () => builder,
        first: async () => filterRows()[0] || null,
        select: async () => filterRows(),
        update: async () => 1
      };
      return builder;
    };

    const mockDb: any = (table: string) => ({
      where: (filters: Record<string, unknown>) => makeBuilder(table, filters),
      insert: async () => 1
    });

    svc.setDbClient(mockDb);
    const lifecycle = await svc.getCustomerBillingLifecycleState('usr_stale_1');
    assert.equal(lifecycle.activeSubscription?.id, 'pur_active_pro');
    assert.equal(lifecycle.pendingSubscription, null, 'Properly superseded checkout must not surface as pending');

    // Conversely, an unresolved row still in pending status MUST surface transparently (never silently ignored locally)
    subs[0].status = 'pending';
    subs[0].metadata = JSON.stringify({ gateway_auth_status: 'ACTIVE', gateway_subscription_status: 'ACTIVE' });
    const withMandate = await svc.getCustomerBillingLifecycleState('usr_stale_1');
    assert.equal(withMandate.pendingSubscription?.id, 'pur_stale_pending_plus');
    assert.equal(withMandate.pendingSubscription?.hasAuthorizedMandate, true);
  });

  it('4. Outbox workers enforce fencing_token CAS on completion/retry updates', async () => {
    const svc = new PaymentGatewayService();
    const outboxRows = [
      {
        id: 'sco_fence_1',
        subscription_id: 'sub_fence_1',
        customer_id: 'cust_fence_1',
        principal_id: 'usr_fence_1',
        gateway: 'razorpay',
        gateway_subscription_id: 'sub_rzp_fence_1',
        state: 'PENDING',
        attempts: 0,
        max_attempts: 5,
        fencing_token: 0,
        created_at: Date.now() - 5000,
        updated_at: Date.now() - 5000
      }
    ];

    const origNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      // Simulate stale lease lost between claim (token 1) and completion update (DB stolen by another worker -> token 2)
      svc.setGatewayTransport(async () => {
        outboxRows[0].fencing_token = 2;
        (outboxRows[0] as any).claimed_by = 'wkr_other';
        return { success: true, orderId: 'sub_fence_1', gatewayOrderId: 'sub_rzp_fence_1' };
      });

      const makeMockOutboxDb: any = (table: string) => {
        const makeQ = (cond: Record<string, unknown> = {}) => {
          const matches = (row: any) => Object.entries(cond).every(([k, v]) => row[k] === v);
          const q: any = {
            andWhere: (arg: any) => {
              if (typeof arg === 'object' && arg !== null) Object.assign(cond, arg);
              return q;
            },
            orderBy: () => q,
            limit: async () => (table === 'subscription_cancellation_outbox' ? outboxRows.filter(r => r.state === 'PENDING') : []),
            update: async (patch: Record<string, unknown>) => {
              const target = table === 'subscription_cancellation_outbox' ? outboxRows.find(matches) : undefined;
              if (!target) return 0;
              Object.assign(target, patch);
              return 1;
            },
            then: (resolve: any) => resolve(table === 'subscription_cancellation_outbox' ? outboxRows.filter(matches) : [])
          };
          return q;
        };
        return {
          where: (cond: Record<string, unknown>) => makeQ({ ...cond }),
          insert: async () => 1
        };
      };
      makeMockOutboxDb.schema = { hasTable: async (t: string) => t === 'subscription_cancellation_outbox' };

      const res = await svc.processCancellationOutboxTasks({
        dbOverride: makeMockOutboxDb,
        workerId: 'wkr_stolen',
        batchSize: 5
      });

      assert.equal(res.succeeded, 0, 'Stale worker losing fencing_token must not report COMPLETED success');
      assert.equal(res.tasks[0]?.status, 'STALE_LEASE_LOST');
      assert.equal(outboxRows[0].state, 'CLAIMED', 'Winning worker state must not be overwritten');
      assert.equal(outboxRows[0].fencing_token, 2);
    } finally {
      svc.setGatewayTransport(null as any);
      process.env.NODE_ENV = origNodeEnv;
    }
  });

  it('5. SettingsModal recognizes backend billingStatus="active" as Live Billing Active', () => {
    const settingsSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/SettingsModal.tsx'),
      'utf8'
    );
    assert.ok(
      settingsSrc.includes("usageData.billingStatus === 'active' || usageData.billingStatus === 'live'"),
      'SettingsModal must recognize active billingStatus from /api/billing/summary'
    );
  });
});
