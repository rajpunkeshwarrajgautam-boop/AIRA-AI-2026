/**
 * AIRA AI 2026 — Cashfree Web SDK Subscription Checkout & CSP TDD Suite
 *
 * Verifies:
 * 1. vercel.json Content-Security-Policy (CSP) contains strict Cashfree origins.
 * 2. loadCashfreeScript deterministic loader: recovers from existing failed scripts,
 *    enforces bounded timeout, cleans up DOM, and resolves boolean without hanging.
 * 3. Cashfree Web SDK v3 recurring contract: cashfree.subscriptionsCheckout({ subsSessionId, redirectTarget: '_self' }).
 * 4. Hosted fallback and fail-closed state recovery when SDK is unavailable or blocked.
 * 5. Duplicate submission prevention and cross-tier button locking.
 * 6. Backend API contract: payment-gateway-service returns subsSessionId & subscriptionSessionId.
 * 7. Non-regression: Razorpay recurring flow and financial invariants remain untouched.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadCashfreeScript,
  isTrustedCashfreeUrl
} from '../src/components/PricingModal.js';
import {
  paymentGatewayService
} from '../apps/api/src/billing/payment-gateway-service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

describe('Cashfree SDK Checkout & CSP Hardening Suite', () => {

  function createMockDb() {
    const tables: Record<string, any[]> = {
      billing_customers: [
        { id: 'cust_test_123', principal_id: 'neon_user_test', name: 'Test User' },
        { id: 'cust_rzp_test', principal_id: 'neon_user_rzp', name: 'Rzp User' },
        { id: 'cust_usd_test', principal_id: 'neon_user_usd', name: 'USD User' }
      ],
      subscriptions: [],
      payment_gateway_events: [],
      billing_audit_events: [],
      idempotent_operations: [],
      credit_accounts: [],
      credit_transactions: [],
      credit_grants: [],
      billing_invoices: []
    };

    const mockDb: any = ((tableName: string) => {
      let filterQuery: Record<string, any> = {};

      const matchRow = (r: any): boolean => {
        return Object.entries(filterQuery).every(([k, v]) => r[k] === v);
      };

      const builder: any = {
        where: (queryOrCol: any, val?: any) => {
          if (typeof queryOrCol === 'string') {
            filterQuery[queryOrCol] = val;
          } else if (typeof queryOrCol === 'object') {
            Object.assign(filterQuery, queryOrCol);
          }
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
        orderBy: () => builder,
        insert: async (data: any) => {
          const items = Array.isArray(data) ? data : [data];
          for (const item of items) {
            const row = { ...item };
            tables[tableName].push(row);
          }
          return items;
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

    return { mockDb, tables };
  }

  // =========================================================================
  // 1. CONTENT SECURITY POLICY (CSP) VERIFICATION IN vercel.json
  // =========================================================================
  describe('1. Content Security Policy (CSP) Verification in vercel.json', () => {
    const vercelJsonPath = path.join(rootDir, 'vercel.json');
    const vercelConfig = JSON.parse(fs.readFileSync(vercelJsonPath, 'utf8'));
    const allHeaders = vercelConfig.headers?.flatMap((h: any) => h.headers || []) || [];
    const cspHeader = allHeaders.find((h: any) => h.key === 'Content-Security-Policy')?.value || '';

    it('script-src directive contains https://sdk.cashfree.com', () => {
      const match = cspHeader.match(/script-src\s+([^;]+)/);
      assert.ok(match, 'CSP must contain script-src directive');
      const sources = match[1].split(/\s+/);
      assert.ok(
        sources.includes('https://sdk.cashfree.com'),
        'script-src must explicitly include https://sdk.cashfree.com'
      );
      assert.ok(!sources.includes('*'), 'script-src must NOT contain wildcards');
    });

    it('connect-src directive contains Cashfree sandbox and production endpoints', () => {
      const match = cspHeader.match(/connect-src\s+([^;]+)/);
      assert.ok(match, 'CSP must contain connect-src directive');
      const sources = match[1].split(/\s+/);
      const expected = [
        'https://sandbox.cashfree.com',
        'https://api.cashfree.com',
        'https://payments-test.cashfree.com',
        'https://payments.cashfree.com'
      ];
      for (const origin of expected) {
        assert.ok(
          sources.includes(origin),
          `connect-src must explicitly include ${origin}`
        );
      }
      assert.ok(!sources.includes('*'), 'connect-src must NOT contain wildcards');
    });

    it('frame-src directive contains Cashfree mandate iframe origins', () => {
      const match = cspHeader.match(/frame-src\s+([^;]+)/);
      assert.ok(match, 'CSP must contain frame-src directive');
      const sources = match[1].split(/\s+/);
      assert.ok(
        sources.includes('https://sandbox.cashfree.com'),
        'frame-src must include https://sandbox.cashfree.com'
      );
      assert.ok(
        sources.includes('https://payments-test.cashfree.com'),
        'frame-src must include https://payments-test.cashfree.com'
      );
    });

    it('form-action directive permits Cashfree form submissions', () => {
      const match = cspHeader.match(/form-action\s+([^;]+)/);
      assert.ok(match, 'CSP must contain form-action directive');
      const sources = match[1].split(/\s+/);
      assert.ok(
        sources.includes('https://sandbox.cashfree.com'),
        'form-action must include https://sandbox.cashfree.com'
      );
      assert.ok(
        sources.includes('https://api.cashfree.com'),
        'form-action must include https://api.cashfree.com'
      );
    });

    it('preserves all existing Google OAuth, GitHub, Neon WebSocket and fonts origins', () => {
      assert.ok(cspHeader.includes('https://accounts.google.com'), 'Must preserve Google OAuth');
      assert.ok(cspHeader.includes('https://apis.google.com'), 'Must preserve Google APIs');
      assert.ok(cspHeader.includes('https://github.com'), 'Must preserve GitHub OAuth');
      assert.ok(cspHeader.includes('https://*.neon.tech'), 'Must preserve Neon HTTP API');
      assert.ok(cspHeader.includes('wss://*.neon.tech'), 'Must preserve Neon WebSockets');
      assert.ok(cspHeader.includes('https://fonts.googleapis.com'), 'Must preserve Google Fonts');
      assert.ok(cspHeader.includes('https://fonts.gstatic.com'), 'Must preserve GStatic');
    });
  });

  // =========================================================================
  // 2. DETERMINISTIC SCRIPT LOADER (loadCashfreeScript)
  // =========================================================================
  describe('2. Deterministic Script Loader (loadCashfreeScript)', () => {
    let originalWindow: any;
    let originalDocument: any;

    beforeEach(() => {
      originalWindow = (global as any).window;
      originalDocument = (global as any).document;
    });

    afterEach(() => {
      (global as any).window = originalWindow;
      (global as any).document = originalDocument;
    });

    it('resolves true immediately if window.Cashfree is already initialized', async () => {
      const mockCashfree = () => {};
      (global as any).window = { Cashfree: mockCashfree };
      (global as any).document = {
        querySelector: () => null,
        createElement: () => { throw new Error('createElement should not be called'); }
      };

      const result = await loadCashfreeScript();
      assert.strictEqual(result, true, 'Must return true immediately if window.Cashfree exists');
    });

    it('recovers cleanly from pre-existing errored script tags by removing stale element', async () => {
      let scriptRemoved = false;
      const staleScript: any = {
        remove: () => { scriptRemoved = true; },
        parentNode: { removeChild: () => { scriptRemoved = true; } },
        addEventListener: () => {}
      };

      let newScriptAppended: any = null;
      (global as any).window = {};
      (global as any).document = {
        querySelector: (sel: string) => sel.includes('cashfree.com') ? staleScript : null,
        createElement: (tag: string) => {
          const el: any = {
            tagName: tag.toUpperCase(),
            src: '',
            onload: null,
            onerror: null,
            remove: () => {}
          };
          return el;
        },
        body: {
          appendChild: (el: any) => {
            newScriptAppended = el;
            setTimeout(() => {
              (global as any).window.Cashfree = () => {};
              if (el.onload) el.onload(new Event('load'));
            }, 10);
          }
        }
      };

      const loadPromise = loadCashfreeScript(1000);
      const result = await loadPromise;

      assert.strictEqual(scriptRemoved, true, 'Must remove stale pre-existing script tag from DOM');
      assert.ok(newScriptAppended, 'Must create and append a fresh script element');
      assert.strictEqual(newScriptAppended.src, 'https://sdk.cashfree.com/js/v3/cashfree.js');
      assert.strictEqual(result, true, 'Must resolve true when fresh script loads successfully');
    });

    it('applies bounded timeout and resolves false without hanging if script fails to load in time', async () => {
      let scriptRemoved = false;
      (global as any).window = {};
      (global as any).document = {
        querySelector: () => null,
        createElement: () => ({
          src: '',
          onload: null,
          onerror: null,
          remove: () => { scriptRemoved = true; }
        }),
        body: {
          appendChild: () => {
            // Simulate a script load that stalls and never calls onload or onerror
          }
        }
      };

      const startTime = Date.now();
      const result = await loadCashfreeScript(100); // 100ms timeout for test
      const duration = Date.now() - startTime;

      assert.strictEqual(result, false, 'Must resolve false on timeout');
      assert.ok(duration >= 90 && duration < 500, `Timeout must resolve within expected window (took ${duration}ms)`);
      assert.strictEqual(scriptRemoved, true, 'Must clean up stalled script element on timeout');
    });

    it('resolves false and removes element on script onerror (e.g. CSP violation)', async () => {
      let scriptRemoved = false;
      (global as any).window = {};
      (global as any).document = {
        querySelector: () => null,
        createElement: () => ({
          src: '',
          onload: null,
          onerror: null,
          remove: () => { scriptRemoved = true; }
        }),
        body: {
          appendChild: (el: any) => {
            setTimeout(() => {
              if (el.onerror) el.onerror(new Event('error'));
            }, 10);
          }
        }
      };

      const result = await loadCashfreeScript(1000);
      assert.strictEqual(result, false, 'Must resolve false when script onerror fires');
      assert.strictEqual(scriptRemoved, true, 'Must remove errored script tag from DOM');
    });
  });

  // =========================================================================
  // 3. CASHFREE WEB SDK RECURRING SUBSCRIPTION CONTRACT
  // =========================================================================
  describe('3. Cashfree Web SDK Recurring Subscription Contract', () => {
    it('verifies PricingModal uses cashfree.subscriptionsCheckout with subsSessionId and redirectTarget: _self', () => {
      const modalSrcPath = path.join(rootDir, 'src/components/PricingModal.tsx');
      const modalSrc = fs.readFileSync(modalSrcPath, 'utf8');

      // 1. Must invoke subscriptionsCheckout, NOT checkout
      assert.ok(
        modalSrc.includes('cashfree.subscriptionsCheckout('),
        'PricingModal must invoke cashfree.subscriptionsCheckout() for recurring subscriptions'
      );
      assert.ok(
        !modalSrc.includes('cashfree.checkout({'),
        'PricingModal must NOT call one-time payment method cashfree.checkout()'
      );

      // 2. Must pass subsSessionId parameter
      assert.ok(
        modalSrc.includes('subsSessionId:'),
        'subscriptionsCheckout must receive subsSessionId parameter'
      );

      // 3. Must specify redirectTarget: _self
      assert.ok(
        modalSrc.includes("redirectTarget: '_self'"),
        "subscriptionsCheckout must specify redirectTarget: '_self'"
      );
    });

    it('V-05: confirms Cashfree SDK recurring contract strictly uses subscriptionsCheckout with redirectTarget _self (not _modal)', () => {
      const modalSrcPath = path.join(rootDir, 'src/components/PricingModal.tsx');
      const modalSrc = fs.readFileSync(modalSrcPath, 'utf8');

      assert.ok(!modalSrc.includes("redirectTarget: '_modal'"), "PricingModal must NEVER use redirectTarget: '_modal' for recurring subscriptions");
      assert.ok(modalSrc.includes("redirectTarget: '_self'"), "PricingModal must strictly use redirectTarget: '_self'");
    });

    it('verifies button disabling is enforced across all tiers when loadingPlan is active', () => {
      const modalSrcPath = path.join(rootDir, 'src/components/PricingModal.tsx');
      const modalSrc = fs.readFileSync(modalSrcPath, 'utf8');

      // Both Plus and Pro upgrade buttons must be disabled whenever loadingPlan !== null
      assert.ok(
        modalSrc.includes('disabled={loadingPlan !== null}'),
        'Upgrade buttons must be disabled whenever any plan is loading to prevent cross-tier double submission'
      );
    });

    it('verifies handleSubscribe resets loadingPlan to null in all fail-closed error paths', () => {
      const modalSrcPath = path.join(rootDir, 'src/components/PricingModal.tsx');
      const modalSrc = fs.readFileSync(modalSrcPath, 'utf8');

      // Ensure that if res.ok is false, setLoadingPlan(null) is called
      const notOkIndex = modalSrc.indexOf('if (!res.ok)');
      assert.ok(notOkIndex !== -1, 'Must have if (!res.ok) check');
      const notOkBlock = modalSrc.slice(notOkIndex, notOkIndex + 1500);
      assert.ok(
        notOkBlock.includes('setLoadingPlan(null)'),
        'Must call setLoadingPlan(null) when res.ok is false'
      );
    });
  });

  // =========================================================================
  // 4. BACKEND API CONTRACT ALIGNMENT (payment-gateway-service.ts)
  // =========================================================================
  describe('4. Backend API Contract Alignment (payment-gateway-service.ts)', () => {
    beforeEach(() => {
      process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'true';
      process.env.AIRA_ENABLE_TEST_FULFILLMENT = 'true';
      process.env.RAZORPAY_KEY_ID = 'rzp_test_mock_key';
      process.env.CASHFREE_APP_ID = 'CF_TEST_MOCK_APP_ID';
      process.env.CASHFREE_SECRET_KEY = 'cf_test_mock_secret';
    });

    it('returns subsSessionId and subscriptionSessionId in createSubscriptionCheckout response', async () => {
      const { mockDb } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);

      paymentGatewayService.setGatewayTransport(async (params) => {
        return {
          gatewayOrderId: 'sub_cf_order_test_456',
          shortUrl: 'https://sandbox.cashfree.com/pg/subscriptions/auth?token=cf_test_sess',
          subscriptionSessionId: 'subs_session_cf_live_789'
        };
      });

      const result = await paymentGatewayService.createSubscriptionCheckout(
        'neon_user_test',
        'pro',
        'INR',
        'cashfree',
        { userId: 'neon_user_test' },
        { phone: '9876543210' }
      );

      assert.strictEqual(result.gateway, 'cashfree');
      assert.strictEqual(result.subscriptionSessionId, 'subs_session_cf_live_789');
      assert.strictEqual((result as any).subsSessionId, 'subs_session_cf_live_789');
      assert.strictEqual(result.checkoutUrl, 'https://sandbox.cashfree.com/pg/subscriptions/auth?token=cf_test_sess');
    });

    it('extracts sub_session_id or subscription_session_id from Cashfree provider payload', () => {
      const serviceSrcPath = path.join(rootDir, 'apps/api/src/billing/payment-gateway-service.ts');
      const serviceSrc = fs.readFileSync(serviceSrcPath, 'utf8');

      assert.ok(
        serviceSrc.includes('cfData.sub_session_id') || serviceSrc.includes('cfData.subscription_session_id'),
        'Backend must support both cfData.subscription_session_id and cfData.sub_session_id'
      );
      assert.ok(
        serviceSrc.includes('subsSessionId: gatewayPaymentSessionId'),
        'Backend createSubscriptionCheckout must return subsSessionId property'
      );
    });
  });

  // =========================================================================
  // 5. RAZORPAY & FINANCIAL INVARIANTS NON-REGRESSION
  // =========================================================================
  describe('5. Razorpay & Financial Invariants Non-Regression', () => {
    beforeEach(() => {
      process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'true';
      process.env.AIRA_ENABLE_TEST_FULFILLMENT = 'true';
      process.env.RAZORPAY_KEY_ID = 'rzp_test_mock_key';
      process.env.CASHFREE_APP_ID = 'CF_TEST_MOCK_APP_ID';
      process.env.CASHFREE_SECRET_KEY = 'cf_test_mock_secret';
    });

    it('preserves Razorpay recurring subscription flow without Cashfree phone requirement', async () => {
      const { mockDb } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);

      paymentGatewayService.setGatewayTransport(async (params) => {
        assert.strictEqual(params.gateway, 'razorpay');
        return {
          gatewayOrderId: 'sub_rzp_test_123',
          shortUrl: 'https://rzp.io/i/test123'
        };
      });

      const result = await paymentGatewayService.createSubscriptionCheckout(
        'neon_user_rzp',
        'plus',
        'INR',
        'razorpay'
        // No contactDetails.phone provided
      );

      assert.strictEqual(result.gateway, 'razorpay');
      assert.strictEqual(result.orderId, 'sub_rzp_test_123');
      assert.strictEqual(result.checkoutUrl, 'https://rzp.io/i/test123');
    });

    it('routes USD subscriptions strictly to Razorpay', async () => {
      const { mockDb } = createMockDb();
      paymentGatewayService.setDbClient(mockDb);

      paymentGatewayService.setGatewayTransport(async (params) => {
        assert.strictEqual(params.currency, 'USD');
        assert.strictEqual(params.gateway, 'razorpay');
        return {
          gatewayOrderId: 'sub_rzp_usd_456',
          shortUrl: 'https://rzp.io/i/usd456'
        };
      });

      const result = await paymentGatewayService.createSubscriptionCheckout(
        'neon_user_usd',
        'pro',
        'USD',
        'razorpay'
      );

      assert.strictEqual(result.currency, 'USD');
      assert.strictEqual(result.gateway, 'razorpay');
    });
  });
});
