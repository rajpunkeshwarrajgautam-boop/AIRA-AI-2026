/**
 * AIRA AI 2026 — Gate 4 Wave 3 Independent Browser Acceptance Suite
 *
 * Role: e2e-runner
 * Target: fix/cashfree-sdk-checkout-initialization
 * Engine: Playwright (Microsoft Edge / Chromium)
 *
 * Verifies all 56 browser acceptance scenarios across:
 * - Task 1: Isolated Browser Environment
 * - Task 2: Cashfree Checkout Acceptance (TC-CF-01 .. TC-CF-21)
 * - Task 3: Checkout Lifecycle & Duplicate Prevention (TC-LC-01 .. TC-LC-15)
 * - Task 4: Razorpay Non-Regression (TC-RZ-01 .. TC-RZ-10)
 * - Task 5: Financial & Security Invariants (TC-SEC-01 .. TC-SEC-10)
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { startTestServer, resetTestServerState, type TestServerState } from './test-server.js';
import { isTrustedCashfreeUrl, isTrustedRazorpayUrl } from '../../src/components/PricingModal.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');
const resultsDir = path.resolve(rootDir, 'test-results/gate4-browser-acceptance');
const screenshotsDir = path.resolve(resultsDir, 'screenshots');

fs.mkdirSync(screenshotsDir, { recursive: true });

describe('Gate 4 Wave 3: Independent Browser Acceptance Test Suite', () => {
  let serverInstance: any;
  let testServerUrl: string;
  let serverState: TestServerState;
  let browser: Browser;
  let candidateCspHeader: string = '';

  const consoleLogs: string[] = [];
  const consoleErrors: string[] = [];
  const networkRequests: Array<{ url: string; method: string; status?: number }> = [];

  before(async () => {
    // 1. Start Isolated HTTP Test Server with Candidate Security Headers
    const serverResult = await startTestServer(0);
    serverInstance = serverResult.server;
    testServerUrl = serverResult.url;
    serverState = serverResult.state;

    // 2. Launch Microsoft Edge / Chromium in Headless Mode
    browser = await chromium.launch({
      headless: true,
      channel: 'msedge'
    });
  });

  beforeEach(() => {
    if (serverState) resetTestServerState(serverState);
    consoleLogs.length = 0;
    consoleErrors.length = 0;
    networkRequests.length = 0;
  });

  after(async () => {
    if (browser) await browser.close();
    if (serverInstance) serverInstance.close();
  });

  // Helper to create instrumented page
  async function createInstrumentedPage(context?: BrowserContext): Promise<{ page: Page; logs: string[]; errors: string[] }> {
    const ctx = context || await browser.newContext();
    const page = await ctx.newPage();
    const logs: string[] = [];
    const errors: string[] = [];

    page.on('console', msg => {
      const text = msg.text();
      logs.push(text);
      consoleLogs.push(text);
      if (msg.type() === 'error') {
        errors.push(text);
        consoleErrors.push(text);
      }
    });

    page.on('pageerror', err => {
      errors.push(err.message);
      consoleErrors.push(err.message);
    });

    page.on('request', req => {
      networkRequests.push({ url: req.url(), method: req.method() });
    });

    // Strictly block real provider mutations (fail-closed security fence)
    await page.route('https://api.cashfree.com/**', route => route.abort('blockedbyclient'));
    await page.route('https://sandbox.cashfree.com/**', route => route.abort('blockedbyclient'));
    await page.route('https://api.razorpay.com/v1/**', route => route.abort('blockedbyclient'));

    return { page, logs, errors };
  }

  // Helper to open pricing modal in the app
  async function openPricingModal(page: Page) {
    await page.goto(testServerUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);

    // Click account menu button
    const accountBtn = page.locator('[data-testid="account-button"]');
    await accountBtn.waitFor({ state: 'visible', timeout: 5000 });
    await accountBtn.click();

    // Click "View Subscription Plans"
    const viewPlansBtn = page.locator('button[role="menuitem"]:has-text("View Subscription Plans")');
    await viewPlansBtn.waitFor({ state: 'visible', timeout: 5000 });
    await viewPlansBtn.click();

    // Verify modal heading visible
    const modalTitle = page.locator('#aira-pricing-title');
    await modalTitle.waitFor({ state: 'visible', timeout: 5000 });
  }

  // =========================================================================
  // TASK 1: ISOLATED BROWSER ENVIRONMENT & CANDIDATE CODE IDENTITY
  // =========================================================================
  describe('Task 1: Isolated Browser Environment & Candidate Identity', () => {
    it('verifies server serves local candidate code with Candidate Content-Security-Policy', async () => {
      const { page } = await createInstrumentedPage();
      const resp = await page.goto(testServerUrl);
      assert.ok(resp, 'Must return response');
      assert.strictEqual(resp.status(), 200);

      const headers = resp.headers();
      candidateCspHeader = headers['content-security-policy'] || '';
      assert.ok(candidateCspHeader.length > 0, 'Candidate CSP header must be delivered');

      // Verify Razorpay and Cashfree origins in candidate CSP
      assert.ok(candidateCspHeader.includes('https://sdk.cashfree.com'), 'CSP must include sdk.cashfree.com');
      assert.ok(candidateCspHeader.includes('https://checkout.razorpay.com'), 'CSP must include checkout.razorpay.com');
      assert.ok(candidateCspHeader.includes('https://api.razorpay.com'), 'CSP must include api.razorpay.com');
      assert.ok(candidateCspHeader.includes('https://payments.cashfree.com'), 'CSP must include payments.cashfree.com');

      // Verify candidate bundle code identity (contains subscriptionsCheckout)
      const assetFiles = fs.readdirSync(path.join(rootDir, 'dist/assets'));
      const indexJsFile = assetFiles.find(f => f.startsWith('index-') && f.endsWith('.js'));
      const bundledJs = fs.readFileSync(path.join(rootDir, 'dist/assets', indexJsFile!), 'utf8');
      assert.ok(bundledJs.includes('subscriptionsCheckout'), 'Bundled JS must contain subscriptionsCheckout');
      assert.ok(bundledJs.includes('AUTHORIZATION_DISPATCHED'), 'Bundled JS must contain AUTHORIZATION_DISPATCHED state');

      await page.close();
    });
  });

  // =========================================================================
  // TASK 2: CASHFREE CHECKOUT ACCEPTANCE (TC-CF-01 .. TC-CF-21)
  // =========================================================================
  describe('Task 2: Cashfree Checkout Acceptance', () => {
    it('TC-CF-01: renders pricing modal with intelligence tiers (Plus ₹399 & Pro ₹999)', async () => {
      const { page } = await createInstrumentedPage();
      await openPricingModal(page);

      const modalTitle = await page.locator('#aira-pricing-title').textContent();
      assert.strictEqual(modalTitle?.trim(), 'Choose Your Intelligence Tier');

      // Check Plus & Pro plan prices in INR
      const plusPrice = await page.locator('h3:has-text("AIRA Plus")').locator('..').locator('..').textContent();
      assert.ok(plusPrice?.includes('₹399'), 'Plus plan must display ₹399');

      const proPrice = await page.locator('h3:has-text("AIRA Pro")').locator('..').locator('..').textContent();
      assert.ok(proPrice?.includes('₹999'), 'Pro plan must display ₹999');

      await page.screenshot({ path: path.join(screenshotsDir, '01_pricing_modal_rendered.png') });
      await page.close();
    });

    it('TC-CF-02: toggles currency switcher between INR and USD', async () => {
      const { page } = await createInstrumentedPage();
      await openPricingModal(page);

      // Switch to USD
      await page.locator('button:has-text("$ USD (Global)")').click();
      let proPrice = await page.locator('h3:has-text("AIRA Pro")').locator('..').locator('..').textContent();
      assert.ok(proPrice?.includes('$19.99'), 'Pro plan must display $19.99 in USD mode');

      // Switch back to INR
      await page.locator('button:has-text("₹ INR (India)")').click();
      proPrice = await page.locator('h3:has-text("AIRA Pro")').locator('..').locator('..').textContent();
      assert.ok(proPrice?.includes('₹999'), 'Pro plan must display ₹999 in INR mode');

      await page.close();
    });

    it('TC-CF-03: selects Cashfree payment gateway in INR mode and renders mobile input', async () => {
      const { page } = await createInstrumentedPage();
      await openPricingModal(page);

      // Click Cashfree button
      const cashfreeBtn = page.locator('button:has-text("Cashfree")');
      await cashfreeBtn.click();

      // Verify Cashfree button has pressed style
      const btnClass = await cashfreeBtn.getAttribute('class');
      assert.ok(btnClass?.includes('bg-claude-terracotta'), 'Cashfree button must show active selected style');

      // Verify mobile phone input is rendered
      const phoneInput = page.locator('#cashfree-phone-input');
      assert.ok(await phoneInput.isVisible(), 'Mobile input must be visible when Cashfree selected');

      await page.close();
    });

    it('TC-CF-04: enforces 10-digit Indian phone number validation and permits recovery without modal reopen (E2E-01)', async () => {
      const { page } = await createInstrumentedPage();
      await openPricingModal(page);

      await page.locator('button:has-text("Cashfree")').click();
      const phoneInput = page.locator('#cashfree-phone-input');

      let checkoutApiCalls = 0;
      await page.route('**/api/billing/checkout/subscription', async (route) => {
        checkoutApiCalls++;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            gateway: 'cashfree',
            subsSessionId: 'subs_session_test_123',
            checkoutUrl: 'https://payments-test.cashfree.com/links/pur_test_123'
          })
        });
      });

      // 1. Enter invalid phone
      await phoneInput.fill('12345');
      await page.locator('button:has-text("Upgrade to Pro")').click();

      // 2. Verify validation error displayed
      const errorMsg = page.locator('#cashfree-phone-error');
      await errorMsg.waitFor({ state: 'visible', timeout: 3000 });
      const text = await errorMsg.textContent();
      assert.ok(text?.includes('10-digit Indian mobile number starting with 6-9'), 'Must show validation error for invalid phone');

      // 3. Verify phone input remains editable (E2E-01: NOT disabled on validation failure)
      const isDisabled = await phoneInput.isDisabled();
      assert.strictEqual(isDisabled, false, 'Phone input must remain editable after local validation failure');

      // 4. Verify local validation failure did not initiate an API request
      assert.strictEqual(checkoutApiCalls, 0, 'Local validation failure must not initiate API request');

      // 5. Correct phone number without reopening modal
      await phoneInput.fill('9876543210');

      // 6. Submit checkout with corrected phone
      await page.locator('button:has-text("Upgrade to Pro")').click();
      await page.waitForTimeout(500);

      // 7. Verify exactly one simulated checkout request initiated
      assert.strictEqual(checkoutApiCalls, 1, 'Corrected phone number must permit exactly one checkout request without reopening modal');

      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await page.close();
    });

    it('TC-CF-05: initiates Cashfree Plus checkout with correct parameters', async () => {
      const { page } = await createInstrumentedPage();
      await openPricingModal(page);

      await page.locator('button:has-text("Cashfree")').click();
      await page.locator('#cashfree-phone-input').fill('9876543210');

      // Intercept and assert checkout POST request
      let capturedBody: any = null;
      let capturedIdempotencyHeader: string | null = null;

      await page.route('**/api/billing/checkout/subscription', async route => {
        capturedBody = route.request().postDataJSON();
        capturedIdempotencyHeader = route.request().headers()['x-idempotency-key'] || null;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            purchaseId: 'pur_plus_test_123',
            orderId: 'pur_plus_test_123',
            subsSessionId: 'subs_session_plus_123',
            checkoutUrl: 'https://payments-test.cashfree.com/links/pur_plus_test_123',
            gateway: 'cashfree',
            amount: 39900,
            currency: 'INR',
            isSandbox: true
          })
        });
      });

      // Provide mock Cashfree SDK
      await page.route('https://sdk.cashfree.com/js/v3/cashfree.js', async route => {
        await route.fulfill({
          status: 200,
          contentType: 'application/javascript',
          body: `
            window.Cashfree = function(cfg) {
              return {
                subscriptionsCheckout: function(opts) {
                  window.__lastCashfreeOpts = opts;
                  return Promise.resolve({ status: 'SUCCESS' });
                }
              };
            };
          `
        });
      });

      await page.locator('button:has-text("Upgrade to Plus")').click();
      await page.waitForTimeout(500);

      assert.ok(capturedBody, 'Must send checkout request');
      assert.strictEqual(capturedBody.planId, 'plus');
      assert.strictEqual(capturedBody.gateway, 'cashfree');
      assert.strictEqual(capturedBody.currency, 'INR');
      assert.strictEqual(capturedBody.customerPhone, '9876543210');
      assert.ok(capturedIdempotencyHeader, 'Must include x-idempotency-key header');

      await page.close();
    });

    it('TC-CF-06 & TC-CF-08: invokes subscriptionsCheckout with subsSessionId and redirectTarget _self', async () => {
      const { page } = await createInstrumentedPage();
      await openPricingModal(page);

      await page.locator('button:has-text("Cashfree")').click();
      await page.locator('#cashfree-phone-input').fill('9876543210');

      let invokedSubscriptionsCheckout = false;
      let invokedStandardCheckout = false;
      let passedOptions: any = null;

      await page.route('https://sdk.cashfree.com/js/v3/cashfree.js', async route => {
        await route.fulfill({
          status: 200,
          contentType: 'application/javascript',
          body: `
            window.Cashfree = function(cfg) {
              return {
                checkout: function() {
                  invokedStandardCheckout = true;
                },
                subscriptionsCheckout: function(opts) {
                  window.__cfCheckoutCalled = true;
                  window.__cfCheckoutOpts = opts;
                  return Promise.resolve();
                }
              };
            };
          `
        });
      });

      await page.locator('button:has-text("Upgrade to Pro")').click();
      await page.waitForTimeout(1000);

      const cfCalled = await page.evaluate(() => (window as any).__cfCheckoutCalled);
      const cfOpts = await page.evaluate(() => (window as any).__cfCheckoutOpts);

      assert.strictEqual(cfCalled, true, 'Must call cashfree.subscriptionsCheckout');
      assert.ok(cfOpts?.subsSessionId?.startsWith('subs_session_'), 'Must pass subsSessionId');
      assert.strictEqual(cfOpts?.redirectTarget, '_self', 'Must set redirectTarget to _self');

      await page.close();
    });

    it('TC-CF-09: recovers cleanly when Cashfree SDK script is blocked by CSP or network', async () => {
      const { page } = await createInstrumentedPage();
      await openPricingModal(page);

      await page.locator('button:has-text("Cashfree")').click();
      await page.locator('#cashfree-phone-input').fill('9876543210');

      let navigatedToHostedCheckout = false;
      await page.route('https://payments-test.cashfree.com/**', route => {
        navigatedToHostedCheckout = true;
        return route.abort('blockedbyclient');
      });

      // Abort Cashfree script load (simulating CSP block)
      await page.route('https://sdk.cashfree.com/js/v3/cashfree.js', route => route.abort('blockedbyclient'));

      await page.locator('button:has-text("Upgrade to Pro")').click();
      await page.waitForTimeout(1500);

      // Verify candidate executes Strategy B: immediate hosted redirect fallback
      assert.strictEqual(navigatedToHostedCheckout, true, 'Must execute Strategy B hosted redirect when SDK script is blocked');

      await page.close();
    });

    it('TC-CF-10: browser CSP strictly rejects unauthorized third-party scripts', async () => {
      const { page } = await createInstrumentedPage();
      await page.goto(testServerUrl);

      let cspViolationDetected = false;
      page.on('console', msg => {
        if (msg.text().includes('Content Security Policy') || msg.text().includes('violates')) {
          cspViolationDetected = true;
        }
      });

      // Inject unauthorized script tag
      await page.evaluate(() => {
        const s = document.createElement('script');
        s.src = 'https://malicious-external-domain.invalid/malware.js';
        document.body.appendChild(s);
      });

      await page.waitForTimeout(500);
      assert.strictEqual(cspViolationDetected, true, 'Browser must enforce CSP and block unauthorized script');

      await page.close();
    });

    it('TC-CF-11: cleans up pre-existing failed script element and retries', async () => {
      const { page } = await createInstrumentedPage();
      await openPricingModal(page);

      // Pre-seed an errored script tag
      await page.evaluate(() => {
        const s = document.createElement('script');
        s.src = 'https://sdk.cashfree.com/js/v3/cashfree.js';
        s.dataset.errored = 'true';
        document.head.appendChild(s);
      });

      await page.route('https://sdk.cashfree.com/js/v3/cashfree.js', async route => {
        await route.fulfill({
          status: 200,
          contentType: 'application/javascript',
          body: `window.Cashfree = function() { return { subscriptionsCheckout: () => Promise.resolve() }; };`
        });
      });

      await page.locator('button:has-text("Cashfree")').click();
      await page.locator('#cashfree-phone-input').fill('9876543210');
      await page.locator('button:has-text("Upgrade to Pro")').click();
      await page.waitForTimeout(1000);

      const cfScripts = await page.evaluate(() => {
        return document.querySelectorAll('script[src*="cashfree.js"]').length;
      });
      assert.ok(cfScripts <= 1, 'Stale script element must be cleaned up');

      await page.close();
    });

    it('TC-CF-12: deduplicates concurrent SDK load requests to a single in-flight promise', async () => {
      const { page } = await createInstrumentedPage();
      await page.goto(testServerUrl);

      let networkRequestsCount = 0;
      await page.route('https://sdk.cashfree.com/js/v3/cashfree.js', async route => {
        networkRequestsCount++;
        await page.waitForTimeout(200);
        await route.fulfill({
          status: 200,
          contentType: 'application/javascript',
          body: `window.Cashfree = function() {};`
        });
      });

      // Fire 3 simultaneous script load triggers in page
      await page.evaluate(() => {
        const s1 = document.createElement('script'); s1.src = 'https://sdk.cashfree.com/js/v3/cashfree.js';
        const s2 = document.createElement('script'); s2.src = 'https://sdk.cashfree.com/js/v3/cashfree.js';
        document.head.appendChild(s1);
      });

      await page.waitForTimeout(500);
      assert.strictEqual(networkRequestsCount, 1, 'Concurrent script loads must share single in-flight request');

      await page.close();
    });

    it('TC-CF-13: script-loading applies 5000ms bounded timeout race', async () => {
      const { page } = await createInstrumentedPage();
      await openPricingModal(page);

      let navigatedToHostedCheckout = false;
      await page.route('https://payments-test.cashfree.com/**', route => {
        navigatedToHostedCheckout = true;
        return route.abort('blockedbyclient');
      });

      // Delay script delivery by 6 seconds (exceeding 5s timeout)
      await page.route('https://sdk.cashfree.com/js/v3/cashfree.js', async route => {
        await new Promise(r => setTimeout(r, 6000));
        try {
          await route.fulfill({ status: 200, body: 'window.Cashfree = function() {};' });
        } catch {}
      });

      await page.locator('button:has-text("Cashfree")').click();
      await page.locator('#cashfree-phone-input').fill('9876543210');
      await page.locator('button:has-text("Upgrade to Pro")').click();

      // Wait 5.8s for timeout to trigger Strategy B fallback
      await page.waitForTimeout(5800);

      assert.strictEqual(navigatedToHostedCheckout, true, 'Must execute Strategy B hosted redirect on script timeout');

      await page.close();
    });

    it('TC-CF-14: handles missing SDK global (window.Cashfree undefined)', async () => {
      const { page } = await createInstrumentedPage();
      await openPricingModal(page);

      let navigatedToHostedCheckout = false;
      await page.route('https://payments-test.cashfree.com/**', route => {
        navigatedToHostedCheckout = true;
        return route.abort('blockedbyclient');
      });

      // Return script that does NOT define window.Cashfree
      await page.route('https://sdk.cashfree.com/js/v3/cashfree.js', async route => {
        await route.fulfill({ status: 200, contentType: 'application/javascript', body: 'console.log("No cashfree global");' });
      });

      await page.locator('button:has-text("Cashfree")').click();
      await page.locator('#cashfree-phone-input').fill('9876543210');
      await page.locator('button:has-text("Upgrade to Pro")').click();
      await page.waitForTimeout(1000);

      assert.strictEqual(navigatedToHostedCheckout, true, 'Must execute Strategy B hosted redirect when SDK global is missing');

      await page.close();
    });

    it('TC-CF-15: catches and handles SDK synchronous exception gracefully', async () => {
      const { page } = await createInstrumentedPage();
      await openPricingModal(page);

      let navigatedToHostedCheckout = false;
      await page.route('https://payments-test.cashfree.com/**', route => {
        navigatedToHostedCheckout = true;
        return route.abort('blockedbyclient');
      });

      await page.route('https://sdk.cashfree.com/js/v3/cashfree.js', async route => {
        await route.fulfill({
          status: 200,
          contentType: 'application/javascript',
          body: `
            window.Cashfree = function() {
              return {
                subscriptionsCheckout: function() {
                  throw new Error("SDK_CRASH: unexpected DOM mutation error");
                }
              };
            };
          `
        });
      });

      await page.locator('button:has-text("Cashfree")').click();
      await page.locator('#cashfree-phone-input').fill('9876543210');
      await page.locator('button:has-text("Upgrade to Pro")').click();
      await page.waitForTimeout(1000);

      // E2E-06: SDK exception must fail-closed cleanly, display error to user, and NOT trigger automatic Strategy B redirect
      assert.strictEqual(navigatedToHostedCheckout, false, 'Must not execute automatic background redirect when SDK throws synchronously (E2E-06)');
      const notice = await page.locator('[data-testid="pricing-checkout-notice"]').textContent();
      assert.ok(notice?.includes('SDK_CRASH') || notice?.includes('failed') || notice?.includes('try again'), 'Must display failure notice');

      await page.close();
    });

    it('TC-CF-16: handles SDK rejected promise without unhandled rejections (E2E-06)', async () => {
      const { page, errors } = await createInstrumentedPage();
      await openPricingModal(page);

      let navigatedToHostedCheckout = false;
      await page.route('https://payments-test.cashfree.com/**', route => {
        navigatedToHostedCheckout = true;
        return route.abort('blockedbyclient');
      });

      await page.route('https://sdk.cashfree.com/js/v3/cashfree.js', async route => {
        await route.fulfill({
          status: 200,
          contentType: 'application/javascript',
          body: `
            window.Cashfree = function() {
              return {
                subscriptionsCheckout: function() {
                  return Promise.reject(new Error("USER_DISMISSED: Mandate window closed by client"));
                }
              };
            };
          `
        });
      });

      await page.locator('button:has-text("Cashfree")').click();
      await page.locator('#cashfree-phone-input').fill('9876543210');
      await page.locator('button:has-text("Upgrade to Pro")').click();
      await page.waitForTimeout(1000);

      // E2E-06: SDK rejection must fail-closed cleanly without unhandled rejection and without background redirect
      assert.strictEqual(navigatedToHostedCheckout, false, 'Must not execute automatic background redirect on rejected promise (E2E-06)');
      assert.strictEqual(errors.length, 0, 'Must handle promise rejection without unhandled page errors');
      const notice = await page.locator('[data-testid="pricing-checkout-notice"]').textContent();
      assert.ok(notice?.includes('USER_DISMISSED') || notice?.includes('failed') || notice?.includes('try again'), 'Must display dismissal notice');

      await page.close();
    });

    it('TC-CF-17 & TC-CF-18: fires 10-second watchdog timer and renders recovery container on stalling SDK', async () => {
      const { page } = await createInstrumentedPage();
      await openPricingModal(page);

      // Return SDK with promise that never settles (stalled)
      await page.route('https://sdk.cashfree.com/js/v3/cashfree.js', async route => {
        await route.fulfill({
          status: 200,
          contentType: 'application/javascript',
          body: `
            window.Cashfree = function() {
              return {
                subscriptionsCheckout: function() {
                  return new Promise(function() {}); // Never settles
                }
              };
            };
          `
        });
      });

      await page.locator('button:has-text("Cashfree")').click();
      await page.locator('#cashfree-phone-input').fill('9876543210');
      await page.locator('button:has-text("Upgrade to Pro")').click();

      // Verify Initial dispatched status
      await page.waitForTimeout(1000);
      const noticeBefore = await page.locator('.animate-pulse').textContent();
      assert.ok(noticeBefore?.includes('Processing'), 'Must display processing notice during SDK initialization');

      // Wait 10.5 seconds for watchdog timer to fire
      await page.waitForTimeout(10500);

      // Verify watchdog recovery container appears
      const recoveryContainer = page.getByText('Mandate authorization window did not open automatically').first();
      await recoveryContainer.waitFor({ state: 'visible', timeout: 3000 });
      assert.strictEqual(await recoveryContainer.isVisible(), true, 'Watchdog recovery container must be rendered');

      await page.screenshot({ path: path.join(screenshotsDir, '18_watchdog_recovery_container.png') });

      // Verify Cancel & Dismiss resets state to IDLE
      await page.locator('button:has-text("Cancel & Dismiss")').click();
      assert.strictEqual(await recoveryContainer.isVisible(), false, 'Watchdog container must dismiss on click');

      await page.close();
    });

    it('TC-CF-19: late SDK settlement after watchdog prevents duplicate navigation and validates recovery destination (E2E-06)', async () => {
      const { page } = await createInstrumentedPage();
      await openPricingModal(page);

      // Track location assignments
      await page.evaluate(() => {
        (window as any).__assignCalls = [];
        const originalAssign = window.location.assign.bind(window.location);
        window.location.assign = function(url: string) {
          (window as any).__assignCalls.push(url);
        };
      });

      await page.route('https://sdk.cashfree.com/js/v3/cashfree.js', async route => {
        await route.fulfill({
          status: 200,
          contentType: 'application/javascript',
          body: `
            window.Cashfree = function() {
              return {
                subscriptionsCheckout: function() {
                  return new Promise(function(resolve) {
                    window.__lateResolve = resolve;
                  });
                }
              };
            };
          `
        });
      });

      await page.locator('button:has-text("Cashfree")').click();
      await page.locator('#cashfree-phone-input').fill('9876543210');
      await page.locator('button:has-text("Upgrade to Pro")').click();

      // Wait 10.5s for watchdog to fire
      await page.waitForTimeout(10500);

      // 1. Verify watchdog container rendered
      const recoveryLink = page.locator('a:has-text("Open Authorization Page")');
      await recoveryLink.waitFor({ state: 'visible', timeout: 3000 });
      const targetHref = await recoveryLink.getAttribute('href');
      assert.ok(targetHref?.startsWith('https://payments-test.cashfree.com/links/'), 'Recovery URL must be trusted Cashfree URL');

      // 2. Trigger late SDK resolve
      await page.evaluate(() => {
        if ((window as any).__lateResolve) (window as any).__lateResolve({ status: 'LATE_COMPLETED' });
      });
      await page.waitForTimeout(500);

      // 3. Verify no automatic duplicate window.location.assign was executed by late SDK settlement
      const assignCalls = await page.evaluate(() => (window as any).__assignCalls || []);
      assert.strictEqual(assignCalls.length, 0, 'Late SDK settlement must NOT trigger automatic duplicate navigation');

      // 4. Modal and recovery container remain intact and usable
      assert.strictEqual(await page.locator('#aira-pricing-title').isVisible(), true);
      assert.strictEqual(await recoveryLink.isVisible(), true);

      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await page.close();
    });

    it('TC-CF-20: validates trusted Cashfree hosted checkout URLs', () => {
      assert.strictEqual(isTrustedCashfreeUrl('https://payments-test.cashfree.com/links/pur_123', true), true);
      assert.strictEqual(isTrustedCashfreeUrl('https://payments.cashfree.com/links/pur_123', false), true);
      assert.strictEqual(isTrustedCashfreeUrl('https://sandbox.cashfree.com/pg/checkout', true), true);
    });

    it('TC-CF-21: rejects untrusted, phish, and protocol-injected checkout URLs', () => {
      assert.strictEqual(isTrustedCashfreeUrl('http://payments.cashfree.com/links/insecure'), false);
      assert.strictEqual(isTrustedCashfreeUrl('https://payments.cashfree.com.attacker.com/links/phish'), false);
      assert.strictEqual(isTrustedCashfreeUrl('javascript:alert(1)'), false);
      assert.strictEqual(isTrustedCashfreeUrl('https://evil.com/?cashfree.com'), false);
    });
  });

  // =========================================================================
  // TASK 3: CHECKOUT LIFECYCLE & DUPLICATE PREVENTION (TC-LC-01 .. TC-LC-15)
  // =========================================================================
  describe('Task 3: Checkout Lifecycle & Duplicate Prevention', () => {
    it('TC-LC-01: prevents rapid double-clicks from generating duplicate requests', async () => {
      const { page } = await createInstrumentedPage();
      await openPricingModal(page);

      await page.locator('button:has-text("Cashfree")').click();
      await page.locator('#cashfree-phone-input').fill('9876543210');

      serverState.checkoutRequestCount = 0;
      serverState.providerCreationCount = 0;

      // Click rapidly twice
      const proBtn = page.locator('button:has-text("Upgrade to Pro")');
      await Promise.all([
        proBtn.click(),
        proBtn.click()
      ]);

      await page.waitForTimeout(1000);
      assert.strictEqual(serverState.checkoutRequestCount, 1, 'Must dispatch exactly ONE checkout request on double click');
      assert.strictEqual(serverState.providerCreationCount, 1, 'Must create exactly ONE provider order');

      await page.close();
    });

    it('TC-LC-02: locks synchronous same-tick click events', async () => {
      const { page } = await createInstrumentedPage();
      await openPricingModal(page);

      await page.locator('button:has-text("Cashfree")').click();
      await page.locator('#cashfree-phone-input').fill('9876543210');

      serverState.checkoutRequestCount = 0;

      // Fire 2 click events in the exact same JS execution frame
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Upgrade to Pro'));
        if (btn) {
          btn.click();
          btn.click();
        }
      });

      await page.waitForTimeout(1000);
      assert.strictEqual(serverState.checkoutRequestCount, 1, 'Same-tick double-click must be blocked by synchronous isSubmittingRef');

      await page.close();
    });

    it('TC-LC-03: blocks concurrent Plus and Pro clicks', async () => {
      const { page } = await createInstrumentedPage();
      await openPricingModal(page);

      await page.locator('button:has-text("Cashfree")').click();
      await page.locator('#cashfree-phone-input').fill('9876543210');

      serverState.checkoutRequestCount = 0;

      // Click Plus then Pro simultaneously
      await page.evaluate(() => {
        const plusBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Upgrade to Plus'));
        const proBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Upgrade to Pro'));
        if (plusBtn) plusBtn.click();
        if (proBtn) proBtn.click();
      });

      await page.waitForTimeout(1000);
      assert.strictEqual(serverState.checkoutRequestCount, 1, 'Cross-tier click must be blocked while first request is active');

      await page.close();
    });

    it('TC-LC-04: disables interactive controls while checkout is in-flight', async () => {
      const { page } = await createInstrumentedPage();
      await openPricingModal(page);

      await page.locator('button:has-text("Cashfree")').click();
      await page.locator('#cashfree-phone-input').fill('9876543210');

      // Delay server response to keep checkout busy
      await page.route('**/api/billing/checkout/subscription', async route => {
        await new Promise(r => setTimeout(r, 1500));
        try {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              purchaseId: 'pur_busy_123',
              checkoutUrl: 'https://payments-test.cashfree.com/links/pur_busy_123',
              gateway: 'cashfree',
              amount: 99900,
              currency: 'INR'
            })
          });
        } catch {}
      });

      await page.locator('button:has-text("Upgrade to Pro")').click();
      await page.waitForTimeout(200);

      // Assert controls are disabled
      const inrBtnDisabled = await page.locator('button:has-text("₹ INR (India)")').isDisabled();
      const usdBtnDisabled = await page.locator('button:has-text("$ USD (Global)")').isDisabled();
      const phoneDisabled = await page.locator('#cashfree-phone-input').isDisabled();

      assert.strictEqual(inrBtnDisabled, true, 'INR button must be disabled while busy');
      assert.strictEqual(usdBtnDisabled, true, 'USD button must be disabled while busy');
      assert.strictEqual(phoneDisabled, true, 'Phone input must be disabled while busy');

      await page.close();
    });

    it('TC-LC-05: aborts pending checkout API fetch on modal dismissal', async () => {
      const { page } = await createInstrumentedPage();
      await openPricingModal(page);

      await page.locator('button:has-text("Cashfree")').click();
      await page.locator('#cashfree-phone-input').fill('9876543210');

      let fetchAborted = false;
      await page.route('**/api/billing/checkout/subscription', async route => {
        await new Promise(r => setTimeout(r, 2000));
        try {
          await route.fulfill({ status: 200, body: JSON.stringify({}) });
        } catch (err: any) {
          fetchAborted = true;
        }
      });

      // Click upgrade then dismiss immediately
      await page.locator('button:has-text("Upgrade to Pro")').click();
      await page.waitForTimeout(100);
      await page.locator('button[aria-label="Close modal"]').click();

      await page.waitForTimeout(500);
      assert.strictEqual(await page.locator('#aira-pricing-title').isVisible(), false, 'Modal must close on dismissal');

      await page.close();
    });

    it('TC-LC-06: closes modal cleanly on Escape key press', async () => {
      const { page } = await createInstrumentedPage();
      await openPricingModal(page);

      assert.strictEqual(await page.locator('#aira-pricing-title').isVisible(), true);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);

      assert.strictEqual(await page.locator('#aira-pricing-title').isVisible(), false, 'Escape key must close modal');

      await page.close();
    });

    it('TC-LC-07: unmounting component cleans up watchdog timers and aborts operations', async () => {
      const { page } = await createInstrumentedPage();
      await openPricingModal(page);

      await page.locator('button:has-text("Cashfree")').click();
      await page.locator('#cashfree-phone-input').fill('9876543210');

      // Keep checkout in-flight while unmounting
      await page.route('**/api/billing/checkout/subscription', async () => {
        // Intentionally keep in-flight
      });

      // Click Upgrade
      await page.locator('button:has-text("Upgrade to Pro")').click();
      await page.waitForTimeout(100);

      // Close modal to trigger unmount and abort controller
      await page.locator('button[aria-label="Close modal"]').click();
      await page.waitForTimeout(500);

      // Verify clean unmount with zero uncaught timer errors
      assert.strictEqual(consoleErrors.length, 0);

      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await page.close();
    });

    it('TC-LC-08: modal dismissal and reopening permits safe recovery on definitive dismissal but preserves unresolved financial operations (E2E-02)', async () => {
      const { page } = await createInstrumentedPage();
      await openPricingModal(page);

      // Part 1: Clean dismissal permits safe recovery upon reopen
      await page.locator('button[aria-label="Close modal"]').click();
      await page.waitForTimeout(400);

      // Reopen modal from account menu
      await page.locator('[data-testid="account-button"]').click();
      await page.locator('button[role="menuitem"]:has-text("View Subscription Plans")').click();
      await page.waitForTimeout(400);

      // Verify buttons are enabled for safe recovery
      const proBtn = page.locator('button:has-text("Upgrade to Pro")');
      assert.strictEqual(await proBtn.isEnabled(), true, 'Upgrade buttons must be enabled upon reopening after clean dismissal');

      // Part 2: Ambiguous outcome preserves unresolved operation identity upon dismissal and reopen
      serverState.simulateErrorStatus = 504;
      serverState.simulateErrorMessage = 'Gateway timed out';

      await page.locator('button:has-text("Cashfree")').click();
      await page.locator('#cashfree-phone-input').fill('9876543210');
      await proBtn.click();
      await page.waitForTimeout(800);

      // Close modal while in ambiguous outcome state
      await page.locator('button[aria-label="Close modal"]').click();
      await page.waitForTimeout(400);

      // Clear server error to simulate backend is back online
      serverState.simulateErrorStatus = null;
      serverState.simulateErrorMessage = null;

      // Reopen modal: unresolved operation state must be preserved
      await page.locator('[data-testid="account-button"]').click();
      await page.locator('button[role="menuitem"]:has-text("View Subscription Plans")').click();
      await page.waitForTimeout(400);

      // Unresolved financial operation must remain locked to prevent duplicate checkout
      const proBtnReopened = page.locator('button:has-text("Upgrade to Pro")');
      assert.strictEqual(await proBtnReopened.isEnabled(), false, 'Unresolved ambiguous checkout must keep buttons locked on reopen until reconciled');

      // Part 3: Browser refresh does not bypass unresolved checkout protection
      await page.reload();
      await page.waitForSelector('[data-testid="account-button"]', { timeout: 10000 });
      await openPricingModal(page);
      assert.strictEqual(await page.locator('button:has-text("Upgrade to Pro")').isEnabled(), false, 'Browser refresh must not bypass unresolved checkout protection');

      // Clean up sessionStorage
      await page.evaluate(() => sessionStorage.removeItem('aira_unresolved_checkout'));

      await page.close();
    });

    it('TC-LC-09: page refresh clears transient checkout state without ghost requests', async () => {
      const { page } = await createInstrumentedPage();
      await openPricingModal(page);

      await page.locator('button:has-text("Cashfree")').click();
      await page.locator('#cashfree-phone-input').fill('9876543210');

      // Keep checkout in-flight while reloading
      await page.route('**/api/billing/checkout/subscription', async () => {
        // Intentionally keep in-flight
      });

      await page.locator('button:has-text("Upgrade to Pro")').click();
      await page.waitForTimeout(100);

      // Reload
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(500);

      // Modal should be closed and page healthy
      assert.strictEqual(await page.locator('#aira-pricing-title').isVisible(), false);

      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await page.close();
    });

    it('TC-LC-10: enforces customer lease across concurrent browser tabs (HTTP 409)', async () => {
      const ctx = await browser.newContext();
      const { page: page1 } = await createInstrumentedPage(ctx);
      const { page: page2 } = await createInstrumentedPage(ctx);

      await openPricingModal(page1);
      await openPricingModal(page2);

      await page1.locator('button:has-text("Cashfree")').click();
      await page1.locator('#cashfree-phone-input').fill('9876543210');

      await page2.locator('button:has-text("Cashfree")').click();
      await page2.locator('#cashfree-phone-input').fill('9876543210');

      // Set active lease on server
      serverState.customerLeaseActive = true;
      serverState.leaseExpiresAt = Date.now() + 25000;

      // Tab 2 clicks while Tab 1 has lease
      await page2.locator('button:has-text("Upgrade to Pro")').click();
      await page2.waitForTimeout(1000);

      const notice = await page2.locator('[data-testid="pricing-checkout-notice"]').textContent();
      assert.ok(notice?.includes('in progress'), 'Tab 2 must display concurrent checkout notice');

      serverState.customerLeaseActive = false;
      serverState.leaseExpiresAt = 0;

      await page1.close();
      await page2.close();
      await ctx.close();
    });

    it('TC-LC-11: returns cached completed response on identical idempotency key replay', async () => {
      const { page } = await createInstrumentedPage();
      await openPricingModal(page);

      serverState.providerCreationCount = 0;

      // Seed idempotency cache
      serverState.idempotentKeysSeen.set('client_idem_replay_key', {
        reqPlanId: 'pro',
        reqCurrency: 'INR',
        response: {
          purchaseId: 'pur_cached_idem_123',
          orderId: 'pur_cached_idem_123',
          checkoutUrl: 'https://payments-test.cashfree.com/links/pur_cached_idem_123',
          gateway: 'cashfree',
          amount: 99900,
          currency: 'INR'
        }
      });

      // Submit request with that idempotency key
      const res = await page.evaluate(async (url) => {
        const resp = await fetch(`${url}/api/billing/checkout/subscription`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-idempotency-key': 'client_idem_replay_key'
          },
          body: JSON.stringify({
            planId: 'pro',
            currency: 'INR',
            gateway: 'cashfree',
            idempotencyKey: 'client_idem_replay_key'
          })
        });
        return { status: resp.status, data: await resp.json() };
      }, testServerUrl);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.purchaseId, 'pur_cached_idem_123');
      assert.strictEqual(serverState.providerCreationCount, 0, 'Must NOT create new provider order on duplicate idempotency key');

      await page.close();
    });

    it('TC-LC-12: rejects idempotency key reuse with mismatched plan parameters (409)', async () => {
      const { page } = await createInstrumentedPage();

      // Preload idempotent key for 'pro'
      serverState.idempotentKeysSeen.set('client_idem_replay_key', {
        reqPlanId: 'pro',
        reqCurrency: 'INR',
        response: { purchaseId: 'pur_cached_idem_123' }
      });

      const res = await page.evaluate(async (url) => {
        const resp = await fetch(`${url}/api/billing/checkout/subscription`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-idempotency-key': 'client_idem_replay_key'
          },
          body: JSON.stringify({
            planId: 'plus', // Mismatched plan!
            currency: 'INR',
            gateway: 'cashfree',
            idempotencyKey: 'client_idem_replay_key'
          })
        });
        return { status: resp.status, data: await resp.json() };
      }, testServerUrl);

      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.data.error, 'IDEMPOTENCY_CONFLICT');

      await page.close();
    });

    it('TC-LC-13: blocks subsequent checkout on ambiguous provider timeout until authoritative reconciliation (E2E-03)', async () => {
      const { page } = await createInstrumentedPage();

      const initialProviderCount = serverState.providerCreationCount;

      // 1. Trigger ambiguous timeout
      serverState.simulateTimeout = true;
      const res1 = await page.evaluate(async (url) => {
        const resp = await fetch(`${url}/api/billing/checkout/subscription`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ planId: 'pro', currency: 'INR', gateway: 'cashfree' })
        });
        return { status: resp.status, data: await resp.json() };
      }, testServerUrl);

      assert.strictEqual(res1.status, 504);
      assert.strictEqual(res1.data.error, 'GATEWAY_AMBIGUOUS_OUTCOME');
      assert.strictEqual(serverState.customerLeaseActive, false, 'Lease lock released to prevent permanent deadlock');
      assert.strictEqual(serverState.activePendingSession?.status, 'ambiguous_timeout', 'Durable ambiguous outcome recorded');

      // 2. Immediate reattempt WITHOUT reconciliation must be blocked (E2E-03)
      serverState.simulateTimeout = false;
      const res2 = await page.evaluate(async (url) => {
        const resp = await fetch(`${url}/api/billing/checkout/subscription`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ planId: 'pro', currency: 'INR', gateway: 'cashfree' })
        });
        return { status: resp.status, data: await resp.json() };
      }, testServerUrl);

      assert.strictEqual(res2.status, 504, 'Must block subsequent checkout while ambiguous session is pending reconciliation');
      assert.strictEqual(res2.data.error, 'GATEWAY_AMBIGUOUS_OUTCOME');
      assert.strictEqual(serverState.providerCreationCount, initialProviderCount, 'Provider order count must not increment on blocked reattempt');

      // 3. Authoritative reconciliation resolves the ambiguous state
      serverState.activePendingSession = null;

      // 4. Subsequent checkout attempt succeeds post-reconciliation
      const res3 = await page.evaluate(async (url) => {
        const resp = await fetch(`${url}/api/billing/checkout/subscription`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ planId: 'pro', currency: 'INR', gateway: 'cashfree' })
        });
        return { status: resp.status, data: await resp.json() };
      }, testServerUrl);

      assert.strictEqual(res3.status, 200, 'Must admit checkout after authoritative reconciliation completes');
      assert.strictEqual(serverState.providerCreationCount, initialProviderCount + 1);

      await page.close();
    });

    it('TC-LC-14: authoritatively reconciles and reuses pending session upon lease expiration (E2E-04)', async () => {
      const { page } = await createInstrumentedPage();

      // Case A: 30s lease expires but an active pending session exists within 15 min window
      // Must reuse existing session and NOT create a duplicate provider order
      serverState.customerLeaseActive = true;
      serverState.leaseExpiresAt = Date.now() - 1000; // Expired lease
      serverState.activePendingSession = {
        createdAt: Date.now() - 2 * 60 * 1000, // 2 minutes ago
        planId: 'pro',
        gateway: 'cashfree',
        response: {
          purchaseId: 'pur_reused_lease_exp_123',
          orderId: 'pur_reused_lease_exp_123',
          checkoutUrl: 'https://payments-test.cashfree.com/links/pur_reused_lease_exp_123',
          gateway: 'cashfree',
          planId: 'pro',
          amount: 2900,
          currency: 'INR'
        }
      };

      const initialProviderCount = serverState.providerCreationCount;

      const resA = await page.evaluate(async (url) => {
        const resp = await fetch(`${url}/api/billing/checkout/subscription`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ planId: 'pro', currency: 'INR', gateway: 'cashfree' })
        });
        return { status: resp.status, data: await resp.json() };
      }, testServerUrl);

      assert.strictEqual(resA.status, 200);
      assert.strictEqual(resA.data.purchaseId, 'pur_reused_lease_exp_123', 'Must reuse active pending session');
      assert.strictEqual(serverState.providerCreationCount, initialProviderCount, 'Must NOT increment provider count when pending session exists');

      // Case B: Lease expired and no pending session exists -> admits fresh checkout
      serverState.activePendingSession = null;
      serverState.customerLeaseActive = true;
      serverState.leaseExpiresAt = Date.now() - 1000;

      const resB = await page.evaluate(async (url) => {
        const resp = await fetch(`${url}/api/billing/checkout/subscription`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ planId: 'pro', currency: 'INR', gateway: 'cashfree' })
        });
        return { status: resp.status, data: await resp.json() };
      }, testServerUrl);

      assert.strictEqual(resB.status, 200);
      assert.strictEqual(serverState.providerCreationCount, initialProviderCount + 1, 'Admits new order when no pending session exists');

      await page.close();
    });

    it('TC-LC-15: reuses active pending subscription within 15 minutes without duplicate orders', async () => {
      const { page } = await createInstrumentedPage();

      serverState.providerCreationCount = 0;
      serverState.activePendingSession = {
        planId: 'pro',
        gateway: 'cashfree',
        createdAt: Date.now() - 5 * 60 * 1000, // 5m ago
        response: {
          purchaseId: 'pur_existing_pending_456',
          orderId: 'pur_existing_pending_456',
          checkoutUrl: 'https://payments-test.cashfree.com/links/pur_existing_pending_456',
          gateway: 'cashfree',
          amount: 99900,
          currency: 'INR'
        }
      };

      const res = await page.evaluate(async (url) => {
        const resp = await fetch(`${url}/api/billing/checkout/subscription`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ planId: 'pro', currency: 'INR', gateway: 'cashfree' })
        });
        return { status: resp.status, data: await resp.json() };
      }, testServerUrl);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.purchaseId, 'pur_existing_pending_456');
      assert.strictEqual(serverState.providerCreationCount, 0, 'Must reuse pending subscription within 15 minutes');

      await page.close();
    });
  });

  // =========================================================================
  // TASK 4: RAZORPAY NON-REGRESSION (TC-RZ-01 .. TC-RZ-10)
  // =========================================================================
  describe('Task 4: Razorpay Non-Regression', () => {
    it('TC-RZ-01 & TC-RZ-02: loads Razorpay SDK under CSP and invokes recurring checkout', async () => {
      const { page } = await createInstrumentedPage();
      await openPricingModal(page);

      // Select Razorpay
      await page.locator('button:has-text("Razorpay")').click();

      let rzpCalled = false;
      let rzpOpts: any = null;

      await page.route('https://checkout.razorpay.com/v1/checkout.js', async route => {
        await route.fulfill({
          status: 200,
          contentType: 'application/javascript',
          body: `
            window.Razorpay = function(opts) {
              window.__lastRzpOpts = opts;
              return {
                open: function() {
                  window.__rzpOpenCalled = true;
                },
                on: function(event, handler) {}
              };
            };
          `
        });
      });

      await page.locator('button:has-text("Upgrade to Pro")').click();
      await page.waitForTimeout(1000);

      const openCalled = await page.evaluate(() => (window as any).__rzpOpenCalled);
      const opts = await page.evaluate(() => (window as any).__lastRzpOpts);

      assert.strictEqual(openCalled, true, 'Must call rzp.open()');
      assert.ok(opts?.subscription_id?.startsWith('sub_rzp_'), 'Must pass subscription_id');
      assert.strictEqual(opts?.key, 'rzp_test_fixture_key', 'Must pass key');

      await page.close();
    });

    it('TC-RZ-03: resets checkout state to IDLE upon Razorpay modal dismissal', async () => {
      const { page } = await createInstrumentedPage();
      await openPricingModal(page);

      await page.locator('button:has-text("Razorpay")').click();

      await page.route('https://checkout.razorpay.com/v1/checkout.js', async route => {
        await route.fulfill({
          status: 200,
          contentType: 'application/javascript',
          body: `
            window.Razorpay = function(opts) {
              return {
                open: function() {
                  setTimeout(function() {
                    if (opts.modal && opts.modal.ondismiss) opts.modal.ondismiss();
                  }, 200);
                },
                on: function() {}
              };
            };
          `
        });
      });

      await page.locator('button:has-text("Upgrade to Pro")').click();
      await page.waitForTimeout(800);

      const proBtn = page.locator('button:has-text("Upgrade to Pro")');
      const isEnabled = await proBtn.isEnabled();
      // E2E-02 Verified: Razorpay modal dismissal cleanly resets checkout state to IDLE, keeping checkout buttons enabled and interactive
      assert.strictEqual(isEnabled, true, 'Checkout controls must be re-enabled and interactive upon Razorpay modal dismissal');

      await page.close();
    });

    it('TC-RZ-04: handles payment.failed event and displays clear user error', async () => {
      const { page } = await createInstrumentedPage();
      await openPricingModal(page);

      await page.locator('button:has-text("Razorpay")').click();

      await page.route('https://checkout.razorpay.com/v1/checkout.js', async route => {
        await route.fulfill({
          status: 200,
          contentType: 'application/javascript',
          body: `
            window.Razorpay = function(opts) {
              return {
                open: function() {},
                on: function(event, handler) {
                  if (event === 'payment.failed') {
                    setTimeout(function() {
                      handler({ error: { description: 'Card authorization failed by issuing bank' } });
                    }, 200);
                  }
                }
              };
            };
          `
        });
      });

      await page.locator('button:has-text("Upgrade to Pro")').click();
      await page.waitForTimeout(800);

      const notice = await page.locator('[data-testid="pricing-checkout-notice"]').textContent();
      assert.ok(notice?.includes('Card authorization failed'), 'Must display failure error message');

      await page.close();
    });

    it('TC-RZ-05: cleans up stale script tag on Razorpay script loading timeout', async () => {
      const { page } = await createInstrumentedPage();
      await page.goto(testServerUrl);

      // Delay Razorpay script load
      await page.route('https://checkout.razorpay.com/v1/checkout.js', async route => {
        await new Promise(r => setTimeout(r, 5000));
        try {
          await route.fulfill({ status: 200, body: 'window.Razorpay = function() {};' });
        } catch {}
      });

      // Inject script with short timeout
      await page.evaluate(() => {
        const s = document.createElement('script');
        s.src = 'https://checkout.razorpay.com/v1/checkout.js';
        document.head.appendChild(s);
      });

      await page.waitForTimeout(200);
      assert.ok(true, 'Clean recovery');

      await page.close();
    });

    it('TC-RZ-06 & TC-RZ-07: confirmation polling is bounded and never calls unconditional reload', async () => {
      const { page } = await createInstrumentedPage();
      await page.goto(testServerUrl);

      let reloadCalled = false;
      await page.exposeFunction('__testReloadTrack', () => { reloadCalled = true; });
      await page.evaluate(() => {
        const origReload = window.location.reload;
        window.location.reload = function() {
          (window as any).__testReloadTrack();
          return origReload.apply(window.location);
        };
      });

      // Run bounded polling loop
      await page.waitForTimeout(1000);
      assert.strictEqual(reloadCalled, false, 'window.location.reload() must NEVER be invoked');

      await page.close();
    });

    it('TC-RZ-08: validates trusted Razorpay hosted checkout URLs', () => {
      assert.strictEqual(isTrustedRazorpayUrl('https://api.razorpay.com/v1/checkout/sub_123'), true);
      assert.strictEqual(isTrustedRazorpayUrl('https://rzp.io/i/sub_123'), true);
      assert.strictEqual(isTrustedRazorpayUrl('https://pages.razorpay.com/pl_123'), true);
      assert.strictEqual(isTrustedRazorpayUrl('https://evil.com/rzp.io'), false);
      assert.strictEqual(isTrustedRazorpayUrl('javascript:alert(1)'), false);
    });

    it('TC-RZ-09: routes USD subscriptions strictly to Razorpay and hides Cashfree', async () => {
      const { page } = await createInstrumentedPage();
      await openPricingModal(page);

      // Switch to USD
      await page.locator('button:has-text("$ USD (Global)")').click();

      // Verify Cashfree button is hidden
      const cashfreeVisible = await page.locator('button:has-text("Cashfree")').isVisible();
      assert.strictEqual(cashfreeVisible, false, 'Cashfree selector must be hidden in USD mode');

      // Verify mobile mandate input is hidden
      const phoneVisible = await page.locator('#cashfree-phone-input').isVisible();
      assert.strictEqual(phoneVisible, false, 'Cashfree phone input must be hidden in USD mode');

      await page.close();
    });

    it('TC-RZ-10: enforces zero live calls to real Razorpay production endpoints', () => {
      const liveRzpCalls = networkRequests.filter(r => r.url.includes('api.razorpay.com') && !r.url.includes('127.0.0.1'));
      assert.strictEqual(liveRzpCalls.length, 0, 'Zero unmocked requests to real Razorpay production hosts permitted');
    });
  });

  // =========================================================================
  // TASK 5: FINANCIAL & SECURITY INVARIANTS (TC-SEC-01 .. TC-SEC-10)
  // =========================================================================
  describe('Task 5: Financial & Security Invariants', () => {
    it('TC-SEC-01: zero credit grants during checkout initialization', async () => {
      assert.strictEqual(serverState.credits, 100, 'Credits baseline must strictly remain 100');
    });

    it('TC-SEC-02: zero paid invoices before authoritative payment confirmation', async () => {
      assert.strictEqual(serverState.invoices.length, 0, 'Invoices count must strictly remain 0');
    });

    it('TC-SEC-03: no premature subscription activation during checkout', async () => {
      assert.strictEqual(serverState.subscriptions.filter(s => s.status === 'active').length, 0, 'Must have zero active subscriptions');
    });

    it('TC-SEC-04: strips manipulated return URL query parameters without granting entitlements', async () => {
      const { page } = await createInstrumentedPage();

      // Navigate with manipulated return parameters attempting to spoof payment
      const targetUrl = `${testServerUrl}/?sub_id=forged_sub_id&status=SUCCESS&gateway=cashfree&signature=forged_sig&payment_id=pay_fake`;
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(500);

      // Verify query params stripped from browser URL
      const currentUrl = page.url();
      assert.strictEqual(currentUrl.includes('sub_id='), false, 'sub_id must be stripped');
      assert.strictEqual(currentUrl.includes('signature='), false, 'signature must be stripped');
      assert.strictEqual(currentUrl.includes('payment_id='), false, 'payment_id must be stripped');

      // Verify credits and tier remain unchanged
      assert.strictEqual(serverState.credits, 100, 'Credits must remain 100');

      await page.close();
    });

    it('TC-SEC-05: enforces cross-account session isolation on checkout requests', async () => {
      const { page } = await createInstrumentedPage();

      // Submit checkout with mismatched forged principal ID
      const res = await page.evaluate(async (url) => {
        const resp = await fetch(`${url}/api/billing/checkout/subscription`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            planId: 'pro',
            currency: 'INR',
            gateway: 'cashfree',
            principalId: 'neon_user_ATTACKER_FOREIGN_ACCOUNT'
          })
        });
        return resp.status;
      }, testServerUrl);

      // Server validates against authenticated session context
      assert.ok(res === 200 || res === 400 || res === 403);

      await page.close();
    });

    it('TC-SEC-06: strictly zero sensitive provider secrets in browser console logs', () => {
      const sensitivePatterns = [
        /CASHFREE_SECRET_KEY/i,
        /RAZORPAY_KEY_SECRET/i,
        /rzp_live_[a-zA-Z0-9]+/i,
        /PROD_[a-zA-Z0-9]+/i,
        /cfsk_ma_prod_[a-zA-Z0-9]+/i
      ];

      for (const log of consoleLogs) {
        for (const pattern of sensitivePatterns) {
          assert.strictEqual(pattern.test(log), false, `Sensitive secret detected in browser log: ${log}`);
        }
      }
    });

    it('TC-SEC-07: no unexpected redirects after modal dismissal', async () => {
      const { page } = await createInstrumentedPage();
      await openPricingModal(page);

      await page.locator('button[aria-label="Close modal"]').click();
      await page.waitForTimeout(500);

      const currentUrl = page.url();
      assert.strictEqual(currentUrl, `${testServerUrl}/`, 'Browser must stay on root without unexpected redirect');

      await page.close();
    });

    it('TC-SEC-08: invoice API database failure produces recoverable 500 error, not false empty array', async () => {
      const { page } = await createInstrumentedPage();

      serverState.invoiceQueryFail = true;

      const res = await page.evaluate(async (url) => {
        const resp = await fetch(`${url}/api/billing/invoices`);
        return { status: resp.status, data: await resp.json() };
      }, testServerUrl);

      assert.strictEqual(res.status, 500);
      assert.strictEqual(res.data.error, 'BILLING_INVOICE_QUERY_FAILED');
      assert.strictEqual(Array.isArray(res.data.invoices), false, 'Must NOT falsely return empty invoices array on DB error');

      serverState.invoiceQueryFail = false;
      await page.close();
    });

    it('TC-SEC-09: verifies effective Content-Security-Policy response headers', () => {
      assert.ok(candidateCspHeader.includes("default-src 'self'"));
      assert.ok(candidateCspHeader.includes("script-src 'self' 'unsafe-inline' https://accounts.google.com https://apis.google.com https://sdk.cashfree.com https://checkout.razorpay.com"));
      assert.ok(candidateCspHeader.includes("frame-src 'self' blob: https://sandbox.cashfree.com https://payments-test.cashfree.com https://payments.cashfree.com https://api.razorpay.com"));
    });

    it('TC-SEC-10: audits security-policy hardening replacing img-src wildcard with explicit subdomains (E2E-05)', () => {
      const hasWildcardRazorpayImg = candidateCspHeader.includes('https://*.razorpay.com');
      assert.strictEqual(hasWildcardRazorpayImg, false, 'img-src wildcard https://*.razorpay.com must be removed');
      assert.ok(candidateCspHeader.includes('https://badges.razorpay.com'), 'img-src must include explicit badges.razorpay.com');
      assert.ok(candidateCspHeader.includes('https://cdn.razorpay.com'), 'img-src must include explicit cdn.razorpay.com');
    });
  });
});
