import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');
const distDir = path.resolve(rootDir, 'dist');

export interface TestServerState {
  requests: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body?: any; timestamp: number }>;
  checkoutRequestCount: number;
  providerCreationCount: number;
  idempotentKeysSeen: Map<string, any>;
  customerLeaseActive: boolean;
  leaseExpiresAt: number;
  activePendingSession: any | null;
  simulateTimeout: boolean;
  simulateFailure: boolean;
  simulateErrorStatus: number | null;
  simulateErrorMessage: string | null;
  razorpayHostedFallback: boolean;
  razorpayHostedOnly?: boolean;
  razorpayUntrustedUrl?: boolean;
  unknownGateway?: boolean;
  invoiceQueryFail: boolean;
  credits: number;
  invoices: any[];
  subscriptions: any[];
}

export function createInitialTestState(): TestServerState {
  return {
    requests: [],
    checkoutRequestCount: 0,
    providerCreationCount: 0,
    idempotentKeysSeen: new Map(),
    customerLeaseActive: false,
    leaseExpiresAt: 0,
    activePendingSession: null,
    simulateTimeout: false,
    simulateFailure: false,
    simulateErrorStatus: null,
    simulateErrorMessage: null,
    razorpayHostedFallback: false,
    razorpayHostedOnly: false,
    razorpayUntrustedUrl: false,
    unknownGateway: false,
    invoiceQueryFail: false,
    credits: 100,
    invoices: [],
    subscriptions: []
  };
}

export function resetTestServerState(state: TestServerState): void {
  state.requests = [];
  state.checkoutRequestCount = 0;
  state.providerCreationCount = 0;
  state.idempotentKeysSeen.clear();
  state.customerLeaseActive = false;
  state.leaseExpiresAt = 0;
  state.activePendingSession = null;
  state.simulateTimeout = false;
  state.simulateFailure = false;
  state.simulateErrorStatus = null;
  state.simulateErrorMessage = null;
  state.razorpayHostedFallback = false;
  state.razorpayHostedOnly = false;
  state.razorpayUntrustedUrl = false;
  state.unknownGateway = false;
  state.invoiceQueryFail = false;
  state.credits = 100;
  state.invoices = [];
  state.subscriptions = [];
}

export function startTestServer(port = 4173, initialState?: Partial<TestServerState>) {
  const state: TestServerState = { ...createInitialTestState(), ...(initialState || {}) };

  const vercelConfig = JSON.parse(fs.readFileSync(path.join(rootDir, 'vercel.json'), 'utf8'));
  const candidateHeaders: Record<string, string> = {};
  if (vercelConfig.headers && Array.isArray(vercelConfig.headers)) {
    for (const hEntry of vercelConfig.headers) {
      if (hEntry.headers && Array.isArray(hEntry.headers)) {
        for (const h of hEntry.headers) {
          candidateHeaders[h.key] = h.value;
        }
      }
    }
  }

  const mimeTypes: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.png': 'image/png'
  };

  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    let body = '';
    req.on('data', chunk => { body += chunk; });
    await new Promise(r => req.on('end', r));

    let parsedBody: any = null;
    if (body) {
      try { parsedBody = JSON.parse(body); } catch { parsedBody = body; }
    }

    state.requests.push({
      method: req.method || 'GET',
      url: req.url || '/',
      headers: req.headers,
      body: parsedBody,
      timestamp: Date.now()
    });

    // Apply Candidate Security Headers to all responses
    for (const [k, v] of Object.entries(candidateHeaders)) {
      res.setHeader(k, v);
    }

    // CORS & Cache control for testing
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Cache-Control', 'no-store, max-age=0');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 1. API ROUTES
    if (pathname === '/api/auth/session' || pathname === '/api/auth/me') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        user: {
          id: 'neon_user_3aea147c-fc80-4ad4-9df8-df2f5c07c91a',
          name: 'Synthetic Test Account',
          email: 'test-synthetic@aira.local'
        }
      }));
      return;
    }

    if (pathname === '/api/billing/plans') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        checkoutAvailable: true,
        billingStatus: 'OPERATIONAL',
        supportedGateways: ['cashfree', 'razorpay'],
        plans: [
          { id: 'plus', name: 'AIRA Plus', priceInr: 399, priceUsd: 7.99 },
          { id: 'pro', name: 'AIRA Pro', priceInr: 999, priceUsd: 19.99 }
        ]
      }));
      return;
    }

    if (pathname === '/api/billing/summary') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        plan: 'free',
        currency: 'INR',
        credits: state.credits,
        activeSubscription: null,
        subscriptions: state.subscriptions
      }));
      return;
    }

    if (pathname === '/api/billing/entitlements') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        tier: 'free',
        credits: state.credits,
        features: {}
      }));
      return;
    }

    if (pathname === '/api/billing/invoices') {
      if (state.invoiceQueryFail) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'BILLING_INVOICE_QUERY_FAILED',
          message: 'PostgreSQL database connection failed while reading invoices'
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ invoices: state.invoices }));
      return;
    }

    if (pathname === '/api/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        models: [
          { id: 'nvidia/nemotron-3-super-120b-a12b', name: 'NVIDIA Nemotron 3' }
        ]
      }));
      return;
    }

    if (pathname === '/api/conversations') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return;
    }

    // Subscription Checkout Endpoint
    if (pathname === '/api/billing/checkout/subscription') {
      state.checkoutRequestCount++;
      const idempotencyKey = (req.headers['x-idempotency-key'] as string) || parsedBody?.idempotencyKey;
      const now = Date.now();

      // Check simulated error status
      if (state.simulateErrorStatus) {
        res.writeHead(state.simulateErrorStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: state.simulateErrorMessage || 'Simulated checkout failure',
          message: state.simulateErrorMessage || 'Simulated checkout failure'
        }));
        return;
      }

      // Check Idempotency Replay
      if (idempotencyKey && state.idempotentKeysSeen.has(idempotencyKey)) {
        const cached = state.idempotentKeysSeen.get(idempotencyKey);
        // Verify payload match
        if (cached.reqPlanId !== parsedBody?.planId || cached.reqCurrency !== parsedBody?.currency) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'IDEMPOTENCY_CONFLICT',
            message: 'Idempotency key reused with different request payload parameters.'
          }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(cached.response));
        return;
      }

      // Unresolved Ambiguous Outcome Check:
      // An unresolved ambiguous timeout blocks creation of a replacement subscription until reconciled
      if (state.activePendingSession?.status === 'ambiguous_timeout') {
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'GATEWAY_AMBIGUOUS_OUTCOME',
          message: 'An unresolved checkout operation is pending reconciliation with the payment provider. Authoritative reconciliation is required before a new checkout can be initiated.'
        }));
        return;
      }

      // Check Customer Concurrency Lease
      if (state.customerLeaseActive && state.leaseExpiresAt > now) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'CONCURRENT_CHECKOUT_IN_PROGRESS',
          message: 'A subscription checkout request is currently in progress for this customer. Please wait for completion or timeout.'
        }));
        return;
      }

      // Active Pending Session Deduplication & Cross-Tier Protection (15m window)
      if (state.activePendingSession?.response && (now - state.activePendingSession.createdAt < 15 * 60 * 1000)) {
        if (state.activePendingSession.planId === parsedBody?.planId && state.activePendingSession.gateway === parsedBody?.gateway) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(state.activePendingSession.response));
          return;
        } else {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'CONCURRENT_CHECKOUT_IN_PROGRESS',
            message: `A pending subscription checkout for plan '${state.activePendingSession.planId}' is already in progress for your account. Please complete or cancel your existing session before starting a new checkout.`
          }));
          return;
        }
      }

      // Acquire 30s customer lease
      state.customerLeaseActive = true;
      state.leaseExpiresAt = now + 30000;

      // Simulated Gateway Timeout
      if (state.simulateTimeout) {
        // Lease released but durable ambiguous outcome recorded to block replacement orders
        state.customerLeaseActive = false;
        state.leaseExpiresAt = 0;
        state.activePendingSession = {
          status: 'ambiguous_timeout',
          createdAt: now,
          error: 'GATEWAY_AMBIGUOUS_OUTCOME'
        };
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'GATEWAY_AMBIGUOUS_OUTCOME',
          message: 'Subscription creation request to payment gateway timed out after 15 seconds.'
        }));
        return;
      }

      state.providerCreationCount++;
      const purchaseId = `pur_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const planTier = parsedBody?.planId || 'pro';
      const gateway = parsedBody?.gateway || 'cashfree';
      const isSandbox = true;

      let checkoutResponse: any;
      if (gateway === 'cashfree') {
        const subsSessionId = `subs_session_live_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        checkoutResponse = {
          purchaseId,
          orderId: purchaseId,
          subsSessionId,
          subscriptionSessionId: subsSessionId,
          paymentSessionId: subsSessionId,
          checkoutUrl: `https://payments-test.cashfree.com/links/${purchaseId}`,
          gateway: 'cashfree',
          amount: planTier === 'pro' ? 99900 : 39900,
          currency: 'INR',
          isSandbox
        };
      } else if (state.unknownGateway) {
        checkoutResponse = {
          purchaseId,
          orderId: `sub_unk_${Date.now()}`,
          gateway: 'unsupported_provider',
          amount: planTier === 'pro' ? 99900 : 39900,
          currency: parsedBody?.currency || 'INR',
          isSandbox
        };
      } else {
        const orderId = `sub_rzp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const rzpUrl = state.razorpayUntrustedUrl
          ? 'https://malicious.evil-phish.com/pay'
          : `https://rzp.io/i/${orderId}`;

        if (state.razorpayHostedOnly) {
          // Valid hosted URL without usable SDK parameters
          checkoutResponse = {
            purchaseId,
            checkoutUrl: rzpUrl,
            gateway: 'razorpay',
            amount: planTier === 'pro' ? 99900 : 39900,
            currency: parsedBody?.currency || 'INR',
            isSandbox
          };
        } else {
          // Standard production shape: includes keyId, orderId, AND checkoutUrl
          checkoutResponse = {
            purchaseId,
            orderId,
            keyId: 'rzp_test_fixture_key',
            checkoutUrl: rzpUrl,
            gateway: 'razorpay',
            amount: planTier === 'pro' ? 99900 : 39900,
            currency: parsedBody?.currency || 'INR',
            isSandbox
          };
        }
      }

      // Store in Idempotency Map
      if (idempotencyKey) {
        state.idempotentKeysSeen.set(idempotencyKey, {
          reqPlanId: parsedBody?.planId,
          reqCurrency: parsedBody?.currency,
          response: checkoutResponse
        });
      }

      // Store in Active Pending Deduplication
      state.activePendingSession = {
        planId: planTier,
        gateway,
        createdAt: now,
        response: checkoutResponse
      };

      // Release lease upon normal session creation response
      state.customerLeaseActive = false;
      state.leaseExpiresAt = 0;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(checkoutResponse));
      return;
    }

    // 2. STATIC ASSETS
    let filePath = path.join(distDir, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(filePath)) {
      // SPA Fallback
      filePath = path.join(distDir, 'index.html');
    }

    try {
      const ext = path.extname(filePath).toLowerCase();
      const contentType = mimeTypes[ext] || 'application/octet-stream';
      const fileData = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(fileData);
    } catch (err: any) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  });

  return new Promise<{ server: http.Server; url: string; state: TestServerState }>((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address() as any;
      const url = `http://127.0.0.1:${addr.port}`;
      resolve({ server, url, state });
    });
    server.on('error', reject);
  });
}
