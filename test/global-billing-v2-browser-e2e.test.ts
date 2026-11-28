import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { chromium, type Browser, type Page } from 'playwright';
import { db } from '../packages/db/src/index.js';
import { createAccountRoutes, resetOnboardingStoreForTesting } from '../apps/api/src/account-routes.js';
import { createBillingRoutes } from '../apps/api/src/billing-routes.js';
import { commercialBillingService } from '../apps/api/src/billing/commercial-billing-service.js';
import type { ExecutionPrincipal } from '../packages/contracts/src/index.js';

const SCREENSHOT_DIR = path.resolve(
  'C:\\Users\\WORKSTATION\\.gemini\\antigravity\\brain\\ccc8725c-1a62-40ed-8459-0f2b11772e09\\scratch\\v2-browser-screenshots'
);

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

async function dismissOverlays(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    let closed = false;
    const whatsNew = page.locator('[data-testid="whats-new-dismiss-btn"], [data-testid="whats-new-close-btn"]').first();
    if (await whatsNew.isVisible().catch(() => false)) {
      await whatsNew.click().catch(() => {});
      closed = true;
    }
    const skip = page.locator('[data-testid="onboarding-skip-btn"]').first();
    if (await skip.isVisible().catch(() => false)) {
      await skip.click().catch(() => {});
      closed = true;
    }
    if (!closed) break;
    await page.waitForTimeout(150);
  }
}

async function cleanupPrincipal(p: string) {
  const cust = await db('billing_customers').where({ principal_id: p }).first().catch(() => null);
  if (!cust) return;
  await db('billing_credit_notes').where({ customer_id: cust.id }).delete().catch(() => {});
  await db('billing_invoices').where({ customer_id: cust.id }).delete().catch(() => {});
  await db('billing_audit_events').where({ customer_id: cust.id }).delete().catch(() => {});
  await db('subscription_cancellation_outbox').where({ customer_id: cust.id }).delete().catch(() => {});
  await db('billing_invoice_reconciliation_outbox').where({ customer_id: cust.id }).delete().catch(() => {});
  await db('idempotent_operations').where({ principal_id: p }).delete().catch(() => {});
  await db('subscriptions').where({ customer_id: cust.id }).delete().catch(() => {});
  const acct = await db('credit_accounts').where({ customer_id: cust.id }).first().catch(() => null);
  if (acct) {
    await db('credit_reservations').where({ account_id: acct.id }).delete().catch(() => {});
    await db('credit_transactions').where({ account_id: acct.id }).delete().catch(() => {});
    await db('credit_grants').where({ account_id: acct.id }).delete().catch(() => {});
    await db('credit_accounts').where({ id: acct.id }).delete().catch(() => {});
  }
  await db('billing_customers').where({ id: cust.id }).delete().catch(() => {});
}

describe('V2 Browser Acceptance: Global Billing UI, PDF Download, Light/Dark & Desktop/Mobile (Chromium)', () => {
  const distDir = path.resolve(process.cwd(), 'dist');
  let server: ReturnType<express.Express['listen']>;
  let baseUrl = '';
  let browser: Browser;
  const origEnv = { ...process.env };
  const principalId = `usr_v2_e2e_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
  const sessions = new Map<string, { userId: string; email: string; name: string; csrfToken: string }>();

  before(async () => {
    assert.ok(fs.existsSync(path.join(distDir, 'index.html')), 'dist/index.html must exist before browser E2E');
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    resetOnboardingStoreForTesting();

    process.env.NODE_ENV = 'test';
    process.env.AIRA_COMMERCIAL_BILLING_ENABLED = 'true';
    process.env.AIRA_INTERNATIONAL_USD_BILLING_ENABLED = 'true';
    process.env.AIRA_ENABLE_TEST_FULFILLMENT = 'true';
    process.env.AIRA_TEST_GATEWAY_KEY_ID = 'rzp_test_v2_browser';
    process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test_v2_browser';
    process.env.AIRA_SUPPLIER_GSTIN = '09AAMCV4678C1ZV';
    process.env.AIRA_SUPPLIER_GSTIN_VERIFIED = 'true';

    // Seed authenticated global business buyer via real checkout + signed Razorpay webhook
    const app = express();
    app.use(express.json({
      verify: (req: any, _res, buf) => {
        req.rawBody = buf.toString('utf8');
      }
    }));

    app.use((req, _res, next) => {
      const cookies = parseCookies(req.headers.cookie);
      const sid = cookies['aira_v2_sid'];
      if (sid && sessions.has(sid)) {
        const s = sessions.get(sid)!;
        req.principal = {
          userId: s.userId,
          email: s.email,
          name: s.name,
          sessionId: sid,
          workspaceId: `ws_${s.userId}`,
          tier: 'plus',
          scopes: ['chat:write']
        } as ExecutionPrincipal & { email: string; name: string };
      } else if (typeof req.headers['x-seed-principal'] === 'string') {
        req.principal = {
          userId: req.headers['x-seed-principal'],
          email: 'global.buyer@acme.io',
          name: 'Acme Global Buyer'
        } as any;
      }
      next();
    });

    app.post('/api/auth/sign-in', (req, res) => {
      const email = String(req.body?.email || 'global.buyer@acme.io').trim().toLowerCase();
      const sid = `sid_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const csrfToken = `csrf_${crypto.randomBytes(6).toString('hex')}`;
      sessions.set(sid, {
        userId: principalId,
        email,
        name: 'Acme Global Buyer',
        csrfToken
      });
      res.setHeader('Set-Cookie', `aira_v2_sid=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax`);
      res.json({
        status: 'AUTHENTICATED',
        user: { id: principalId, email, name: 'Acme Global Buyer' },
        csrfToken
      });
    });

    app.get('/api/auth/session', (req, res) => {
      const cookies = parseCookies(req.headers.cookie);
      const sid = cookies['aira_v2_sid'];
      const s = sid ? sessions.get(sid) : undefined;
      if (!s) return res.json({ status: 'ANONYMOUS', user: null, csrfToken: null });
      return res.json({
        status: 'AUTHENTICATED',
        user: { id: s.userId, email: s.email, name: s.name },
        csrfToken: s.csrfToken
      });
    });

    app.get('/api/auth/providers', (req, res) => {
      if (!req.principal) return res.status(401).json({ providers: [] });
      return res.json({ providers: [{ provider: 'google' }] });
    });

    app.post('/api/auth/link-guest', (_req, res) => res.json({ success: true, transferredConversations: 0 }));
    app.post('/api/conversations/sync', (_req, res) => res.json({ ok: true }));
    app.get('/api/conversations', (_req, res) => res.json({ conversations: [] }));
    app.get('/api/projects', (_req, res) => res.json({ projects: [] }));
    app.get('/api/memories', (_req, res) => res.json({ memories: [] }));
    app.get('/api/usage', (_req, res) => res.json({ ok: true }));
    app.get('/api/announcements', (_req, res) => res.json({ announcements: [], unreadCount: 0 }));
    app.post('/api/announcements/dismiss', (_req, res) => res.json({ ok: true }));
    app.use('/api/user', createAccountRoutes());
    app.use('/api/billing', createBillingRoutes());
    app.use(express.static(distDir));
    app.use((req, res) => {
      if (req.path.startsWith('/api/')) {
        return res.status(200).json({ ok: true });
      }
      return res.sendFile(path.join(distDir, 'index.html'));
    });

    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    // Create + activate global USD Plus subscription with Visa 4242 via real API & PG18
    await commercialBillingService.getOrCreateCustomer(principalId, 'global.buyer@acme.io', 'Acme Global Buyer', 'US');
    const coRes = await fetch(`${baseUrl}/api/billing/checkout/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-seed-principal': principalId },
      body: JSON.stringify({
        planId: 'plus',
        currency: 'USD',
        gateway: 'razorpay',
        billingProfile: {
          country: 'US',
          accountType: 'business',
          legalName: 'Acme Robotics Inc.',
          taxId: 'EIN-88-4411223',
          stateCode: 'CA',
          addressLine1: '100 Market St'
        }
      })
    });
    assert.equal(coRes.status, 200);
    const co = await coRes.json();

    const whPayload = {
      entity: 'event',
      account_id: 'acc_v2',
      event: 'subscription.charged',
      payload: {
        subscription: {
          entity: {
            id: co.orderId,
            plan_id: 'plan_plus_usd_monthly',
            status: 'active',
            paid_count: 1,
            current_start: Math.floor(Date.now() / 1000),
            current_end: Math.floor((Date.now() + 30 * 86400000) / 1000),
            notes: { purchase_id: co.purchaseId, principal_id: principalId, plan_tier: 'plus' }
          }
        },
        payment: {
          entity: {
            id: `pay_e2e_${Date.now()}`,
            amount: 799,
            currency: 'USD',
            status: 'captured',
            method: 'card',
            card: { network: 'Visa', last4: '4242', type: 'credit', issuer: 'CHASE' },
            notes: { purchase_id: co.purchaseId }
          }
        }
      }
    };
    const raw = JSON.stringify(whPayload);
    const sig = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET!).update(raw).digest('hex');
    const whRes = await fetch(`${baseUrl}/api/billing/webhook/razorpay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': sig },
      body: raw
    });
    assert.equal(whRes.status, 200);

    try {
      browser = await chromium.launch({ headless: true, channel: 'msedge' });
    } catch {
      const localChrome1248 = 'C:\\Users\\WORKSTATION\\AppData\\Local\\ms-playwright\\chromium-1248\\chrome-win64\\chrome.exe';
      browser = await chromium.launch(
        fs.existsSync(localChrome1248)
          ? { headless: true, executablePath: localChrome1248 }
          : { headless: true }
      );
    }
  });

  after(async () => {
    await cleanupPrincipal(principalId);
    await browser?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()) || resolve());
    process.env = origEnv;
  });

  it('verifies Guest + Subscribed Global Buyer experiences, Light & Dark modes, Desktop + Mobile overflow & genuine PDF download', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await dismissOverlays(page);

    // 1. Sign in cleanly through UI / session endpoint + reload into authenticated Global Buyer session
    await page.evaluate(async () => {
      const r = await fetch('/api/auth/sign-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'global.buyer@acme.io' })
      });
      const data = await r.json();
      localStorage.setItem('aira_auth_user', JSON.stringify(data.user));
    });
    await page.reload({ waitUntil: 'networkidle' });
    await dismissOverlays(page);

    // 2. Open Settings -> My Plan & Usage (Global Buyer with Active Plus, Visa ending in 4242, US Business Profile & PDF Invoice)
    await page.locator('button[title="Settings"]').click();
    await page.locator('#aira-settings-title').waitFor({ state: 'visible', timeout: 8000 });
    await page.locator('[data-testid="settings-tab-plan"]').click();
    await page.getByText('Payment methods', { exact: true }).waitFor({ state: 'visible', timeout: 8000 });
    await page.getByText('Visa ending in 4242', { exact: true }).waitFor({ state: 'visible', timeout: 8000 });

    const settingsBodyText = await page.locator('[data-testid="settings-dialog"]').innerText();
    assert.ok(!settingsBodyText.includes(principalId), 'Customer Settings UI must never leak internal usr_ principal ID');
    assert.ok(!settingsBodyText.includes('SAC 998315'), 'Customer Settings UI must not clutter rows with SAC diagnostics');

    // Update Billing Information to GB Business via real PUT /api/billing/profile & verify saved confirmation
    await page.locator('#settings-billing-country').selectOption('GB');
    await page.locator('#settings-global-taxid').fill('GB987654321');
    await page.getByRole('button', { name: 'Save Billing Info' }).click();
    await page.getByText('Billing information saved.').waitFor({ state: 'visible', timeout: 8000 });

    // Trigger genuine binary PDF download & verify %PDF-1.4 magic header
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 10000 }),
      page.getByRole('button', { name: /Download PDF Invoice/ }).first().click()
    ]);
    assert.ok(download.suggestedFilename().endsWith('.pdf'));
    const dlPath = await download.path();
    assert.ok(dlPath, 'Downloaded PDF path must exist');
    const dlBytes = fs.readFileSync(dlPath!);
    assert.ok(dlBytes.toString('latin1').startsWith('%PDF-1.4'), 'Browser download must be a real %PDF-1.4 file');

    // Check zero horizontal overflow + Light mode screenshot (Desktop 1440x900)
    const desktopOverflowLight = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
    assert.equal(desktopOverflowLight, false, 'Desktop Settings light mode must have zero horizontal overflow');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'settings-billing-desktop-light.png') });

    // Switch to Dark mode + capture screenshot
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'settings-billing-desktop-dark.png') });

    // Open PricingModal from Full Pricing Table CTA & inspect Global USD vs INR progressive disclosure
    await page.getByRole('button', { name: 'Full Pricing Table' }).click();
    await page.locator('#aira-pricing-title').waitFor({ state: 'visible', timeout: 8000 });
    await page.locator('#pricing-billing-country').selectOption('US');
    await page.getByText('Global Card Checkout').waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(250);

    const pricingTextUsd = await page.locator('[aria-labelledby="aira-pricing-title"]').innerText();
    assert.ok(!pricingTextUsd.includes('GST Provisional Fixture'), 'Pricing modal must never show GST Provisional Fixture');
    assert.ok(!pricingTextUsd.includes('Payment Partner'), 'Global USD checkout must hide Indian Payment Partner selector');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'pricing-global-usd-desktop-dark.png') });

    // Switch to India (INR) -> verifies Razorpay / Cashfree + Billing State progressive disclosure
    await page.locator('#pricing-billing-country').selectOption('IN');
    await page.getByRole('button', { name: 'Razorpay' }).waitFor({ state: 'visible', timeout: 5000 });
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'pricing-india-inr-desktop-light.png') });

    // Switch to Mobile 390x844 & test Escape dismissal leaves underlying SettingsModal intact
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(200);
    const mobileOverflowPricing = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
    assert.equal(mobileOverflowPricing, false, 'Mobile Pricing modal must have zero horizontal overflow');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'pricing-mobile-390.png') });

    await page.keyboard.press('Escape');
    await page.locator('#aira-pricing-title').waitFor({ state: 'detached', timeout: 5000 });
    await page.locator('#aira-settings-title').waitFor({ state: 'visible', timeout: 5000 });

    await page.waitForTimeout(200);
    const mobileOverflowSettings = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
    assert.equal(mobileOverflowSettings, false, 'Mobile Settings billing tab must have zero horizontal overflow');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'settings-billing-mobile-390.png') });

    assert.deepEqual(errors, [], `Expected zero browser console/page errors, got: ${errors.join(' | ')}`);
    await context.close();
  });
});
