import { Router, Request, Response } from 'express';
import { commercialBillingService } from './billing/commercial-billing-service.js';
import { paymentGatewayService, TOPUP_PACKS } from './billing/payment-gateway-service.js';
import { productionReadinessService } from './billing/production-readiness.js';
import { COMMERCIAL_PLANS } from '../../../packages/contracts/src/commercial.js';

export function createBillingRoutes(): Router {
  const router = Router();

  /**
   * Public / Authenticated: List canonical subscription plans and prices.
   */
  router.get('/plans', (_req: Request, res: Response) => {
    res.json({
      plans: Object.values(COMMERCIAL_PLANS),
      topupPacks: Object.values(TOPUP_PACKS)
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
      res.json(entitlements);
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
      res.json({
        planId: entitlements.plan,
        planName: entitlements.plan === 'pro' ? 'AIRA Pro' : entitlements.plan === 'plus' ? 'AIRA Plus' : 'AIRA Free',
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

    const { planId, currency } = req.body || {};
    if (!planId || (planId !== 'plus' && planId !== 'pro')) {
      return res.status(400).json({ error: 'Invalid planId. Must be "plus" or "pro".' });
    }

    try {
      const checkout = await paymentGatewayService.createSubscriptionCheckout(
        principal.userId,
        planId,
        currency === 'USD' ? 'USD' : 'INR'
      );
      res.json(checkout);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Subscription checkout creation failed.' });
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
      res.status(200).json({ status: 'ok', ...result });
    } catch (err: any) {
      console.error('[RazorpayWebhookError]', err.message);
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}
