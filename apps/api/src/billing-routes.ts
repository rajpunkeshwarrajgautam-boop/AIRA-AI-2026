import { Router, Request, Response } from 'express';
import { commercialBillingService } from './billing/commercial-billing-service.js';
import { paymentGatewayService, isTerminalError, validateAndNormalizeIndianPhone } from './billing/payment-gateway-service.js';
import { productionReadinessService } from './billing/production-readiness.js';
import { COMMERCIAL_PLANS } from '../../../packages/contracts/src/commercial.js';
import { isStagingSandboxRehearsalActive } from './billing/staging-sandbox-rehearsal-guard.js';

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
        featuresCertified: true
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
          : err.message
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

  /**
   * Internal / Operator: Authoritative reconciliation for ambiguous subscriptions (V-01).
   * Strictly requires server-side internal worker key or operator authorization.
   */
  router.post('/internal/reconcile-ambiguous', async (req: Request, res: Response) => {
    const internalKey = req.headers['x-internal-worker-key'] || req.headers['x-worker-key'];
    const authHeader = req.headers['authorization'];
    const expectedKey = process.env.AIRA_INTERNAL_WORKER_KEY || process.env.CRON_SECRET;

    const principal = req.principal;
    const isOperator =
      principal &&
      ((principal.roles || []).some(r => r === 'admin' || r === 'operator') ||
        principal.userId === 'admin');

    const isAuthorizedKey = Boolean(
      expectedKey &&
      (internalKey === expectedKey || authHeader === `Bearer ${expectedKey}`)
    );

    if (!isAuthorizedKey && !isOperator) {
      return res.status(401).json({ error: 'UNAUTHORIZED: Internal worker key or operator authorization required.' });
    }

    const { subscriptionId, manualResolution, reconciliationEvidence } = req.body || {};
    if (!subscriptionId) {
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
  });

  /**
   * Internal / Scheduled Worker: Process durable outbox queues (V-02).
   * Supports GET (Vercel Cron) and POST (programmatic trigger).
   * Authenticated via CRON_SECRET or AIRA_INTERNAL_WORKER_KEY.
   * Fails closed if configuration is missing, rejects browser navigation, enforces environment isolation.
   */
  const processOutboxHandler = async (req: Request, res: Response) => {
    const startTime = Date.now();
    const expectedKey = process.env.CRON_SECRET || process.env.AIRA_INTERNAL_WORKER_KEY;

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

    // Authenticate credentials
    const internalKey = req.headers['x-internal-worker-key'] || req.headers['x-worker-key'];
    const authHeader = req.headers['authorization'];
    const isAuthorized = Boolean(
      (internalKey && internalKey === expectedKey) ||
      (authHeader && authHeader === `Bearer ${expectedKey}`)
    );

    if (!isAuthorized) {
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

  router.get('/worker/process-outbox', processOutboxHandler);
  router.post('/worker/process-outbox', processOutboxHandler);

  return router;
}
