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

    const { planId, currency, gateway, customerPhone, customerDetails } = req.body || {};
    if (!planId || (planId !== 'plus' && planId !== 'pro')) {
      return res.status(400).json({ error: 'Invalid planId. Must be "plus" or "pro".' });
    }

    const resolvedGateway = currency === 'USD' ? 'razorpay' : (gateway || 'razorpay');
    const rawPhone = customerPhone || customerDetails?.phone;

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
        gateway,
        principal,
        {
          phone: rawPhone,
          email: principalEmail || clientEmail,
          name: (principal as any)?.name || customerDetails?.name
        }
      );
      res.json(checkout);
    } catch (err: any) {
      const isValidationError = err?.message?.startsWith('VALIDATION_ERROR');
      const isRehearsalDenied = err?.message?.startsWith('REHEARSAL_') || err?.message?.includes('SECURITY_VIOLATION');
      const status = isValidationError ? 400 : (err?.message?.startsWith('BILLING_UNAVAILABLE') ? 503 : (isRehearsalDenied ? 403 : 500));
      res.status(status).json({
        error: isValidationError
          ? 'VALIDATION_ERROR'
          : (err?.message?.startsWith('BILLING_UNAVAILABLE') ? 'BILLING_UNAVAILABLE' : (isRehearsalDenied ? 'REHEARSAL_REJECTED' : 'CHECKOUT_FAILED')),
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

  return router;
}
