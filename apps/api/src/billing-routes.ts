import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { commercialBillingService } from './billing/commercial-billing-service.js';
import { paymentGatewayService, isTerminalError, validateAndNormalizeIndianPhone } from './billing/payment-gateway-service.js';
import { productionReadinessService } from './billing/production-readiness.js';
import { COMMERCIAL_PLANS } from '../../../packages/contracts/src/commercial.js';
import { isStagingSandboxRehearsalActive } from './billing/staging-sandbox-rehearsal-guard.js';

/**
 * Constant-time comparison helper for machine-to-machine worker secrets.
 */
function timingSafeSecretMatch(provided: string | string[] | undefined, expected: string): boolean {
  if (typeof provided !== 'string' || !provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isAuthorizedWorkerRequest(req: Request, expectedKey: string): boolean {
  const internalKey = req.headers['x-internal-worker-key'] || req.headers['x-worker-key'];
  const authHeader = req.headers['authorization'];
  return (
    timingSafeSecretMatch(internalKey, expectedKey) ||
    timingSafeSecretMatch(authHeader, `Bearer ${expectedKey}`)
  );
}

/**
 * External payment gateway GET/POST return bridge -> safe HTTP 303 redirect to SPA billing tab.
 * Cashfree submits an HTTP POST back to return_url which static Vercel CDN rejects with 405.
 */
export function createCashfreeReturnHandler() {
  return (req: Request, res: Response) => {
    const rawSubId =
      req.query?.sub_id ??
      req.query?.subscription_id ??
      req.query?.order_id ??
      req.body?.sub_id ??
      req.body?.subscription_id ??
      req.body?.order_id;
    const candidate = typeof rawSubId === 'string' ? rawSubId.trim() : '';
    const safeSubId = /^[a-zA-Z0-9_-]{4,80}$/.test(candidate) ? candidate : '';
    const params = new URLSearchParams({ tab: 'billing', gateway: 'cashfree' });
    if (safeSubId) {
      params.set('sub_id', safeSubId);
    }
    res.redirect(303, `/?${params.toString()}`);
  };
}

/**
 * Internal / Operator: Authoritative reconciliation for ambiguous or pending subscriptions (V-01).
 */
export function createInternalReconcileAmbiguousHandler() {
  return async (req: Request, res: Response) => {
    const expectedKey = process.env.AIRA_INTERNAL_WORKER_KEY || process.env.CRON_SECRET || '';
    const principal = req.principal;
    const isOperator =
      principal &&
      ((principal.roles || []).some(r => r === 'admin' || r === 'operator') ||
        principal.userId === 'admin');

    const isAuthorizedKey = isAuthorizedWorkerRequest(req, expectedKey);

    if (!isAuthorizedKey && !isOperator) {
      return res.status(401).json({ error: 'UNAUTHORIZED: Internal worker key or operator authorization required.' });
    }

    const { subscriptionId, manualResolution, reconciliationEvidence } = req.body || {};
    if (!subscriptionId || typeof subscriptionId !== 'string') {
      return res.status(400).json({ error: 'VALIDATION_ERROR: subscriptionId is required.' });
    }

    // Trust boundary: trustedServerVerified or raw webhookPayload cannot be supplied by an external HTTP request body
    if (
      reconciliationEvidence?.providerEvidence?.trustedServerVerified !== undefined ||
      reconciliationEvidence?.webhookPayload !== undefined
    ) {
      return res.status(400).json({
        error: 'TRUST_BOUNDARY_VIOLATION: trustedServerVerified and webhookPayload cannot be supplied by an HTTP request body or external caller. Trusted verification must be established internally through actual provider responses or authenticated webhook processing.'
      });
    }

    try {
      const result = await paymentGatewayService.reconcileAmbiguousSubscription(
        subscriptionId,
        undefined,
        manualResolution,
        reconciliationEvidence
      );
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  };
}

/**
 * Internal / Scheduled Worker: Process durable outbox queues (V-02).
 * Supports GET (Vercel Cron) and POST (programmatic trigger).
 * Authenticated via CRON_SECRET or AIRA_INTERNAL_WORKER_KEY.
 * Fails closed if configuration is missing, rejects browser navigation, enforces environment isolation.
 */
export function createWorkerOutboxHandler() {
  return async (req: Request, res: Response) => {
    const startTime = Date.now();
    const expectedKey = process.env.CRON_SECRET || process.env.AIRA_INTERNAL_WORKER_KEY || '';

    // Fail closed if server has no worker key configured
    if (!expectedKey) {
      return res.status(500).json({
        error: 'CONFIGURATION_ERROR: Worker execution credentials not configured. CRON_SECRET or AIRA_INTERNAL_WORKER_KEY required.'
      });
    }

    // Reject browser document navigation
    const secFetchDest = req.headers['sec-fetch-dest'];
    const secFetchMode = req.headers['sec-fetch-mode'];
    if (secFetchDest === 'document' || secFetchMode === 'navigate') {
      return res.status(403).json({
        error: 'FORBIDDEN_CLIENT: Browser navigation is not permitted for internal worker endpoints.'
      });
    }

    if (!isAuthorizedWorkerRequest(req, expectedKey)) {
      return res.status(401).json({
        error: 'UNAUTHORIZED: Valid worker authorization token required.'
      });
    }

    // Environment isolation check
    const requestedEnv = (req.headers['x-environment-target'] as string) || (req.query.environment as string);
    const activeEnv = (process.env.NODE_ENV === 'test' || isStagingSandboxRehearsalActive() || process.env.AIRA_ENABLE_TEST_FULFILLMENT === 'true')
      ? 'sandbox'
      : (process.env.VERCEL_ENV || process.env.NODE_ENV || 'production');

    if (requestedEnv && requestedEnv !== activeEnv && requestedEnv !== 'test' && requestedEnv !== 'sandbox') {
      return res.status(400).json({
        error: 'ENVIRONMENT_ISOLATION_ERROR',
        message: `Target environment mismatch: requested '${requestedEnv}' but running on '${activeEnv}'.`
      });
    }

    // Production safety barrier: production financial worker activation remains strictly disabled
    if (activeEnv === 'production' && process.env.AIRA_ENABLE_PRODUCTION_FINANCIAL_WORKER !== 'true') {
      return res.status(403).json({
        error: 'PRODUCTION_WORKER_DISABLED: Financial worker execution is disabled on production. Standing production financial worker activation is prohibited.'
      });
    }

    // Bounded batch processing & execution budget
    const rawBatch = (req.body && req.body.batchSize) || req.query.batchSize;
    const batchSize = Math.min(Math.max(1, Number(rawBatch) || 10), 25);
    const workerId = `wkr_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

    // Real serverless execution budget clamping
    const rawBudget = (req.body && req.body.budgetMs) || req.query.budgetMs;
    const maxBudgetMs = Math.min(Math.max(1000, Number(rawBudget) || 9000), 25000);
    const deadlineEpochMs = startTime + maxBudgetMs;

    try {
      const cancellations = await paymentGatewayService.processCancellationOutboxTasks({
        batchSize,
        workerId,
        leaseDurationMs: 30000,
        deadlineEpochMs
      });

      const invoices = await paymentGatewayService.processInvoiceReconciliationTasks({
        batchSize,
        workerId,
        leaseDurationMs: 30000,
        deadlineEpochMs
      });

      const durationMs = Date.now() - startTime;
      return res.status(200).json({
        ok: true,
        workerId,
        appliedBatchSize: batchSize,
        cancellations: {
          processed: cancellations.processed,
          succeeded: cancellations.succeeded,
          failed: cancellations.failed
        },
        invoices: {
          processed: invoices.processed,
          succeeded: invoices.succeeded,
          failed: invoices.failed
        },
        durationMs
      });
    } catch (err: any) {
      console.error('[OutboxWorkerError]', {
        workerId,
        error: err?.message
      });
      return res.status(500).json({
        ok: false,
        workerId,
        error: err?.message || 'Outbox processing failed'
      });
    }
  };
}

export function createBillingRoutes(): Router {
  const router = Router();

  /**
   * Public / Authenticated: List canonical subscription plans and prices.
   */
  router.get('/plans', (_req: Request, res: Response) => {
    const isCheckoutAvailable = process.env.AIRA_COMMERCIAL_BILLING_ENABLED === 'true';
    const isRehearsal = isStagingSandboxRehearsalActive();
    const isSandbox = isRehearsal || process.env.AIRA_ENABLE_TEST_FULFILLMENT === 'true' || process.env.NODE_ENV === 'test';
    const billingStatus = isCheckoutAvailable
      ? 'active'
      : (isRehearsal ? 'sandbox_rehearsal' : (isSandbox ? 'sandbox' : 'checkout_disabled'));

    res.json({
      plans: Object.values(COMMERCIAL_PLANS).map(plan => ({
        ...plan,
        featuresCertified: true
      })),
      topupPacks: [],
      billingStatus,
      checkoutAvailable: isCheckoutAvailable || isRehearsal,
      featuresCertified: true
    });
  });

  /**
   * Protected: Get current user's entitlement state, balance, quotas, and tier.
   */
  router.get('/entitlements', async (req: Request, res: Response) => {
    const principal = req.principal;
    if (!principal) return res.status(401).json({ error: 'Unauthorized' });

    try {
      const entitlements = await commercialBillingService.getEntitlements(principal.userId);
      const isCheckoutAvailable = process.env.AIRA_COMMERCIAL_BILLING_ENABLED === 'true';
      const isRehearsal = isStagingSandboxRehearsalActive();
      const isSandbox = isRehearsal || process.env.AIRA_ENABLE_TEST_FULFILLMENT === 'true' || process.env.NODE_ENV === 'test';
      const billingStatus = isCheckoutAvailable
        ? 'active'
        : (isRehearsal ? 'sandbox_rehearsal' : (isSandbox ? 'sandbox' : 'checkout_disabled'));

      res.json({
        ...entitlements,
        checkoutAvailable: isCheckoutAvailable || isRehearsal,
        billingStatus,
        featuresCertified: true
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to fetch entitlements.' });
    }
  });

  /**
   * Protected: Get comprehensive billing summary for user account modal.
   */
  router.get('/summary', async (req: Request, res: Response) => {
    const principal = req.principal;
    if (!principal) return res.status(401).json({ error: 'Unauthorized' });

    try {
      const entitlements = await commercialBillingService.getEntitlements(principal.userId);
      const isCheckoutAvailable = process.env.AIRA_COMMERCIAL_BILLING_ENABLED === 'true';
      const isRehearsal = isStagingSandboxRehearsalActive();
      const isSandbox = isRehearsal || process.env.AIRA_ENABLE_TEST_FULFILLMENT === 'true' || process.env.NODE_ENV === 'test';
      const billingStatus = isCheckoutAvailable
        ? 'active'
        : (isRehearsal ? 'sandbox_rehearsal' : (isSandbox ? 'sandbox' : 'checkout_disabled'));

      const lifecycle = await paymentGatewayService.getCustomerBillingLifecycleState(principal.userId);

      res.json({
        principalId: principal.userId,
        planId: entitlements.plan,
        planName: COMMERCIAL_PLANS[entitlements.plan]?.name || (entitlements.plan === 'guest' ? 'Guest' : 'AIRA Free'),
        subscriptionStatus: entitlements.subscriptionStatus,
        availableCredits: entitlements.availableCredits,
        lifetimeGranted: entitlements.creditBalance,
        lifetimeSpent: entitlements.reservedCredits,
        dailyChatsUsed: entitlements.dailyStandardChatLimit - entitlements.dailyStandardChatRemaining,
        dailyChatLimit: entitlements.dailyStandardChatLimit,
        monthlyUnitsUsed: entitlements.monthlyStandardChatUnitsLimit - entitlements.monthlyStandardChatUnitsRemaining,
        monthlyUnitLimit: entitlements.monthlyStandardChatUnitsLimit,
        reasoningBoostsUsed: entitlements.reasoningBoostsLimit - entitlements.reasoningBoostsRemaining,
        reasoningBoostLimit: entitlements.reasoningBoostsLimit,
        checkoutAvailable: isCheckoutAvailable || isRehearsal,
        billingStatus,
        featuresCertified: true,
        activeSubscription: lifecycle.activeSubscription,
        pendingSubscription: lifecycle.pendingSubscription
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to fetch billing summary.' });
    }
  });

  /**
   * Protected: Get user's invoice history with GST details.
   */
  router.get('/invoices', async (req: Request, res: Response) => {
    const principal = req.principal;
    if (!principal) return res.status(401).json({ error: 'Unauthorized' });

    try {
      const invoices = await paymentGatewayService.getInvoices(principal.userId);
      res.json({ invoices });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to fetch invoices.' });
    }
  });

  /**
   * Protected: Download a GST-compliant tax invoice HTML receipt owned by the authenticated principal.
   */
  router.get('/invoices/:invoiceNumber/download', async (req: Request, res: Response) => {
    const principal = req.principal;
    if (!principal) return res.status(401).json({ error: 'Unauthorized' });

    const requested = typeof req.params.invoiceNumber === 'string' ? req.params.invoiceNumber.trim() : '';
    if (!requested || !/^[a-zA-Z0-9_-]{3,80}$/.test(requested)) {
      return res.status(400).json({ error: 'VALIDATION_ERROR: Invalid invoice number format.' });
    }

    try {
      const invoices = await paymentGatewayService.getInvoices(principal.userId);
      const invoice = invoices.find(inv => inv.invoiceNumber === requested);
      if (!invoice) {
        return res.status(404).json({ error: 'NOT_FOUND: Invoice not found for this account.' });
      }

      const escapeHtml = (value: unknown): string =>
        String(value ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');

      const symbol = invoice.currency === 'INR' ? '₹' : '$';
      const safeFileNum = invoice.invoiceNumber.replace(/[^a-zA-Z0-9_-]/g, '');
      const taxRows =
        invoice.cgstAmount !== undefined && invoice.sgstAmount !== undefined
          ? `<tr><td>CGST (9%)</td><td class="num">${symbol}${invoice.cgstAmount.toFixed(2)}</td></tr><tr><td>SGST (9%)</td><td class="num">${symbol}${invoice.sgstAmount.toFixed(2)}</td></tr>`
          : `<tr><td>IGST (18%)</td><td class="num">${symbol}${(invoice.igstAmount ?? invoice.gstAmount).toFixed(2)}</td></tr>`;

      const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>AIRA Tax Invoice ${escapeHtml(invoice.invoiceNumber)}</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; color: #1c1917; margin: 36px; max-width: 760px; }
    .hdr { display: flex; justify-content: space-between; border-bottom: 2px solid #e7e5e4; padding-bottom: 16px; margin-bottom: 24px; }
    .badge { display: inline-block; padding: 3px 8px; border-radius: 6px; background: #ecfdf5; color: #065f46; font-weight: 600; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    th, td { border-bottom: 1px solid #e7e5e4; padding: 10px 8px; text-align: left; font-size: 14px; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .total { font-weight: 700; font-size: 16px; background: #fafaf9; }
    .meta { font-size: 13px; color: #57534e; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="hdr">
    <div>
      <h1 style="margin:0;font-size:22px;">Tax Invoice</h1>
      <div class="meta"><strong>${escapeHtml(invoice.supplierName)}</strong>${invoice.supplierGstin ? ` · GSTIN: ${escapeHtml(invoice.supplierGstin)}` : ''}</div>
      <div class="meta">SAC: ${escapeHtml(invoice.sacCode)} · Tax Compliance: ${escapeHtml(invoice.taxComplianceStatus)}</div>
    </div>
    <div style="text-align:right;">
      <div style="font-family:monospace;font-weight:700;font-size:16px;">${escapeHtml(invoice.invoiceNumber)}</div>
      <div class="meta">Date: ${escapeHtml(invoice.date)}</div>
      <span class="badge">${escapeHtml(invoice.status)}</span>
    </div>
  </div>
  <div class="meta">
    <div><strong>Customer Principal:</strong> ${escapeHtml(principal.userId)}</div>
    <div><strong>Place of Supply:</strong> ${escapeHtml(invoice.placeOfSupply)}</div>
    <div><strong>Currency:</strong> ${escapeHtml(invoice.currency)}</div>
  </div>
  <table>
    <thead><tr><th>Description</th><th class="num">Amount</th></tr></thead>
    <tbody>
      <tr><td>${escapeHtml(invoice.plan)} (Taxable Base)</td><td class="num">${symbol}${invoice.taxableBase.toFixed(2)}</td></tr>
      ${taxRows}
      <tr class="total"><td>Total Amount (${escapeHtml(invoice.currency)})</td><td class="num">${symbol}${invoice.totalAmount.toFixed(2)}</td></tr>
    </tbody>
  </table>
  <p class="meta" style="margin-top:28px;">This is a computer-generated GST-compliant invoice from ${escapeHtml(invoice.supplierName)}.</p>
</body>
</html>`;

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="AIRA-GST-Invoice-${safeFileNum}.html"`);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).send(html);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to generate invoice download.' });
    }
  });

  /**
   * Protected: Initiate subscription checkout session.
   */
  router.post('/checkout/subscription', async (req: Request, res: Response) => {
    const principal = req.principal;
    if (!principal) return res.status(401).json({ error: 'Unauthorized' });

    const { planId, currency, gateway, customerPhone, customerDetails, idempotencyKey: bodyIdempotencyKey } = req.body || {};
    if (!planId || (planId !== 'plus' && planId !== 'pro')) {
      return res.status(400).json({ error: 'Invalid planId. Must be "plus" or "pro".' });
    }

    const resolvedGateway = currency === 'USD' ? 'razorpay' : (gateway || 'razorpay');
    const rawPhone = customerPhone || customerDetails?.phone;
    const clientOpKey = (req.headers['x-idempotency-key'] as string) || bodyIdempotencyKey;

    // Security: Client-supplied email must not forge or override authenticated account email
    const principalEmail = (principal as any)?.email;
    const clientEmail = customerDetails?.email;
    if (clientEmail && principalEmail) {
      if (clientEmail.trim().toLowerCase() !== principalEmail.trim().toLowerCase()) {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'Client-supplied email does not match authenticated account email. Forged email addresses are not permitted.'
        });
      }
    }

    if (resolvedGateway === 'cashfree') {
      const phoneValidation = validateAndNormalizeIndianPhone(rawPhone);
      if (!phoneValidation.isValid) {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: phoneValidation.error || 'A valid 10-digit mobile phone number is required for Cashfree subscription e-mandate registration.'
        });
      }
    }

    try {
      const checkout = await paymentGatewayService.createSubscriptionCheckout(
        principal.userId,
        planId,
        currency === 'USD' ? 'USD' : 'INR',
        resolvedGateway,
        principal,
        {
          phone: rawPhone,
          email: principalEmail || clientEmail,
          name: (principal as any)?.name || customerDetails?.name
        },
        clientOpKey
      );
      res.json(checkout);
    } catch (err: any) {
      const isIdempotencyConflict = err?.message?.startsWith('IDEMPOTENCY_KEY_PAYLOAD_MISMATCH') || err?.message?.startsWith('IDEMPOTENCY_CONFLICT');
      const isValidationError = err?.message?.startsWith('VALIDATION_ERROR');
      const isRehearsalDenied = err?.message?.startsWith('REHEARSAL_') || err?.message?.includes('SECURITY_VIOLATION');
      const isBillingUnavailable = err?.message?.startsWith('BILLING_UNAVAILABLE');
      const isConcurrent = err?.message?.startsWith('CONCURRENT_CHECKOUT_IN_PROGRESS');
      const isAmbiguous = err?.message?.startsWith('GATEWAY_AMBIGUOUS_OUTCOME');
      const status = isIdempotencyConflict ? 409 : (isValidationError ? 400 : (isConcurrent ? 409 : (isBillingUnavailable ? 503 : (isRehearsalDenied ? 403 : (isAmbiguous ? 504 : 500)))));

      if (status === 500) {
        console.error('[BillingRoutes] Subscription checkout failed unexpectedly:', {
          principalId: principal.userId,
          planId,
          gateway: resolvedGateway,
          error: err?.message,
          stack: err?.stack
        });
      }

      const concurrentLifecycle = isConcurrent
        ? await paymentGatewayService.getCustomerBillingLifecycleState(principal.userId).catch(() => null)
        : null;
      const pendingSub = concurrentLifecycle?.pendingSubscription || null;
      const friendlyConcurrentMsg = pendingSub
        ? (pendingSub.hasAuthorizedMandate
            ? `You already have an authorized e-mandate for ${pendingSub.planId === 'pro' ? 'AIRA Pro' : 'AIRA Plus'} via ${pendingSub.gateway === 'cashfree' ? 'Cashfree' : 'Razorpay'}. Verify its status or cancel that pending mandate before starting another checkout.`
            : `You have an unfinished ${pendingSub.planId === 'pro' ? 'AIRA Pro' : 'AIRA Plus'} checkout with ${pendingSub.gateway === 'cashfree' ? 'Cashfree' : 'Razorpay'}. Verify its status or cancel the pending checkout to switch plans or payment methods.`)
        : 'Another checkout session is already open for your account. Verify or cancel it before starting a new checkout.';

      res.status(status).json({
        error: isIdempotencyConflict
          ? 'IDEMPOTENCY_CONFLICT'
          : (isValidationError
            ? 'VALIDATION_ERROR'
            : (isConcurrent
              ? 'CONCURRENT_CHECKOUT_IN_PROGRESS'
              : (isBillingUnavailable
                ? 'BILLING_UNAVAILABLE'
                : (isRehearsalDenied
                  ? 'REHEARSAL_REJECTED'
                  : (isAmbiguous ? 'GATEWAY_AMBIGUOUS_OUTCOME' : 'CHECKOUT_FAILED'))))),
        message: status === 500
          ? 'Unable to initiate subscription checkout with the payment provider. Please try again later or contact support.'
          : err.message,
        ...(isConcurrent ? { customerMessage: friendlyConcurrentMsg, pendingSubscription: pendingSub } : {})
      });
    }
  });

  /**
   * Protected: Safe checkout lease release on modal close (V-07).
   * Verifies authenticated principal ownership, prevents premature release during dispatch,
   * preserves unresolved ambiguous states, and never cancels remote provider mandates.
   */
  router.post('/checkout/release-lease', async (req: Request, res: Response) => {
    const principal = req.principal;
    if (!principal) return res.status(401).json({ error: 'Unauthorized' });

    const { operationId } = req.body || {};

    try {
      const result = await paymentGatewayService.releaseCheckoutLease(principal.userId, operationId);
      res.json(result);
    } catch (err: any) {
      const isRejected = err?.message?.startsWith('LEASE_RELEASE_REJECTED');
      const isMismatch = err?.message?.startsWith('OWNERSHIP_MISMATCH');
      const status = isMismatch ? 403 : (isRejected ? 409 : 500);
      res.status(status).json({
        error: isMismatch ? 'OWNERSHIP_MISMATCH' : (isRejected ? 'LEASE_RELEASE_REJECTED' : 'LEASE_RELEASE_FAILED'),
        message: err.message
      });
    }
  });

  /**
   * Protected: Cancel subscription at period end.
   */
  router.post('/subscription/cancel', async (req: Request, res: Response) => {
    const principal = req.principal;
    if (!principal) return res.status(401).json({ error: 'Unauthorized' });

    try {
      const result = await paymentGatewayService.cancelSubscription(principal.userId);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Subscription cancellation failed.' });
    }
  });

  /**
   * Operator / Admin: Production Payment Readiness Audit.
   */
  router.get('/readiness', (req: Request, res: Response) => {
    const principal = req.principal;
    const isOperator =
      principal &&
      ((principal.roles || []).some(r => r === 'admin' || r === 'operator') ||
        principal.userId === 'admin');

    if (!isOperator) {
      return res.status(403).json({ error: 'Operator authorization required.' });
    }

    const report = productionReadinessService.audit();
    res.json(report);
  });

  /**
   * Public Webhook: Razorpay raw body verified webhook.
   */
  router.post('/webhook/razorpay', async (req: Request, res: Response) => {
    const signature = req.headers['x-razorpay-signature'] as string;
    const rawBody = typeof (req as any).rawBody === 'string'
      ? (req as any).rawBody
      : JSON.stringify(req.body);

    try {
      const result = await paymentGatewayService.processRazorpayWebhook(rawBody, signature);
      res.status(200).json({ ok: true, ...result });
    } catch (err: any) {
      console.error('[RazorpayWebhookError]', err.message);
      const isTerminal = isTerminalError(err);
      const isForbidden = err?.message?.startsWith('FORBIDDEN_WEBHOOK');
      const isUnavailable = err?.message?.startsWith('BILLING_UNAVAILABLE');
      const statusCode = isForbidden ? 403 : isTerminal ? 400 : isUnavailable ? 503 : 500;
      res.status(statusCode).json({ error: err.message });
    }
  });

  /**
   * Public Webhook: Cashfree raw body verified webhook.
   */
  router.post('/webhook/cashfree', async (req: Request, res: Response) => {
    const signature = (req.headers['x-webhook-signature'] || req.headers['x-cashfree-signature']) as string;
    const timestamp = (req.headers['x-webhook-timestamp'] || req.headers['x-cashfree-timestamp']) as string;
    const idempotencyHeader = (
      req.headers['x-idempotency-key'] ||
      req.headers['x-idempotency-header'] ||
      req.headers['idempotency-key'] ||
      req.headers['x-webhook-event-id'] ||
      req.headers['x-event-id']
    ) as string | undefined;
    const rawBody = typeof (req as any).rawBody === 'string'
      ? (req as any).rawBody
      : JSON.stringify(req.body);

    try {
      const result = await paymentGatewayService.processCashfreeWebhook(
        rawBody,
        signature,
        timestamp,
        idempotencyHeader ? { idempotencyHeader } : undefined
      );
      res.status(200).json({ ok: true, ...result });
    } catch (err: any) {
      console.error('[CashfreeWebhookError]', err.message);
      const isTerminal = isTerminalError(err);
      const isForbidden = err?.message?.startsWith('FORBIDDEN_WEBHOOK');
      const isUnavailable = err?.message?.startsWith('BILLING_UNAVAILABLE');
      const statusCode = isForbidden ? 403 : isTerminal ? 400 : isUnavailable ? 503 : 500;
      res.status(statusCode).json({ error: err.message });
    }
  });

  const cashfreeReturnHandler = createCashfreeReturnHandler();
  router.get('/cashfree/return', cashfreeReturnHandler);
  router.post('/cashfree/return', cashfreeReturnHandler);

  /**
   * Protected: Allow owning customer to query provider status & expire abandoned unpaid pending sessions.
   */
  router.post('/subscriptions/:subscriptionId/reconcile', async (req: Request, res: Response) => {
    const principal = req.principal;
    if (!principal) return res.status(401).json({ error: 'Unauthorized' });

    const subscriptionId = typeof req.params.subscriptionId === 'string' ? req.params.subscriptionId.trim() : '';
    if (!subscriptionId) {
      return res.status(400).json({ error: 'VALIDATION_ERROR: subscriptionId is required.' });
    }

    try {
      const result = await paymentGatewayService.reconcileCustomerPendingSubscription(
        principal.userId,
        subscriptionId
      );
      res.json(result);
    } catch (err: any) {
      const status = err?.message?.startsWith('OWNERSHIP_MISMATCH')
        ? 403
        : err?.message?.startsWith('NOT_FOUND')
          ? 404
          : 400;
      res.status(status).json({ error: err.message || 'Reconciliation failed.' });
    }
  });

  /**
   * Protected: Safely cancel an abandoned/unpaid pending checkout after authoritative provider verification.
   * Distinct from cancelling an active paid subscription; preserves transaction history and aborts on payment evidence.
   */
  router.post('/subscriptions/:subscriptionId/cancel-pending', async (req: Request, res: Response) => {
    const principal = req.principal;
    if (!principal) return res.status(401).json({ error: 'Unauthorized' });

    const subscriptionId = typeof req.params.subscriptionId === 'string' ? req.params.subscriptionId.trim() : '';
    if (!subscriptionId) {
      return res.status(400).json({ error: 'VALIDATION_ERROR: subscriptionId is required.' });
    }

    const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 120) : undefined;
    const allowCancelAuthorizedMandate = req.body?.allowCancelAuthorizedMandate === true;

    try {
      const result = await paymentGatewayService.cancelPendingCheckout(
        principal.userId,
        subscriptionId,
        { reason, allowCancelAuthorizedMandate }
      );
      const status = result.cancelled ? 200 : 409;
      res.status(status).json(result);
    } catch (err: any) {
      const status = err?.message?.startsWith('OWNERSHIP_MISMATCH')
        ? 403
        : err?.message?.startsWith('NOT_FOUND')
          ? 404
          : 400;
      res.status(status).json({ error: err.message || 'Failed to cancel pending checkout.' });
    }
  });

  /**
   * Internal / Operator: Authoritative reconciliation for ambiguous or pending subscriptions (V-01).
   */
  router.post('/internal/reconcile-ambiguous', createInternalReconcileAmbiguousHandler());

  /**
   * Internal / Scheduled Worker: Process durable outbox queues (V-02).
   */
  const processOutboxHandler = createWorkerOutboxHandler();
  router.get('/worker/process-outbox', processOutboxHandler);
  router.post('/worker/process-outbox', processOutboxHandler);

  return router;
}
