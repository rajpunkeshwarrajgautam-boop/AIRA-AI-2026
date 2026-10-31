import crypto from 'crypto';
import { db } from '../../../../packages/db/src/index.js';
import {
  COMMERCIAL_PLANS,
  PlanTier,
  CurrencyCode
} from '../../../../packages/contracts/src/commercial.js';
import { commercialBillingService } from './commercial-billing-service.js';

export interface WebhookVerificationResult {
  valid: boolean;
  error?: string;
}

export interface CreditTopupPack {
  id: string;
  name: string;
  credits: number;
  inrPrice: number; // ₹ GST-inclusive
  usdPrice: number; // $ USD
}

export const TOPUP_PACKS: Record<string, CreditTopupPack> = {
  pack_1k: {
    id: 'pack_1k',
    name: '1,000 Credits',
    credits: 1000,
    inrPrice: 99.00,
    usdPrice: 1.99
  },
  pack_5k: {
    id: 'pack_5k',
    name: '5,000 Credits',
    credits: 5000,
    inrPrice: 399.00,
    usdPrice: 7.99
  },
  pack_15k: {
    id: 'pack_15k',
    name: '15,000 Credits',
    credits: 15000,
    inrPrice: 999.00,
    usdPrice: 19.99
  }
};

export class PaymentGatewayService {
  private razorpaySecret: string;
  private cashfreeSecret: string;
  private customDbClient: any = null;

  constructor() {
    this.razorpaySecret = process.env.RAZORPAY_WEBHOOK_SECRET || 'test_webhook_secret_razorpay_2026';
    this.cashfreeSecret = process.env.CASHFREE_WEBHOOK_SECRET || 'test_webhook_secret_cashfree_2026';
  }

  setDbClient(client: any) {
    this.customDbClient = client;
  }

  private getDb() {
    return this.customDbClient || db;
  }

  /**
   * Cryptographically verify Razorpay Webhook HMAC-SHA256 signature using raw body.
   */
  verifyRazorpayWebhook(rawBody: string, signature: string, secretOverride?: string): WebhookVerificationResult {
    const secret = secretOverride || this.razorpaySecret;
    if (!signature || !rawBody) {
      return { valid: false, error: 'Missing signature or body payload.' };
    }

    try {
      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest('hex');

      const sigBuffer = Buffer.from(signature, 'utf8');
      const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

      if (sigBuffer.length !== expectedBuffer.length) {
        return { valid: false, error: 'Signature length mismatch.' };
      }

      const match = crypto.timingSafeEqual(sigBuffer, expectedBuffer);
      return { valid: match, error: match ? undefined : 'Signature verification failed.' };
    } catch (err: any) {
      return { valid: false, error: err.message || 'Signature calculation error.' };
    }
  }

  /**
   * Cryptographically verify Cashfree Webhook HMAC-SHA256 signature using raw body and timestamp.
   */
  verifyCashfreeWebhook(rawBody: string, signature: string, timestamp: string, secretOverride?: string): WebhookVerificationResult {
    const secret = secretOverride || this.cashfreeSecret;
    if (!signature || !rawBody || !timestamp) {
      return { valid: false, error: 'Missing signature, body, or timestamp.' };
    }

    try {
      const dataToSign = `${timestamp}${rawBody}`;
      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(dataToSign)
        .digest('base64');

      const sigBuffer = Buffer.from(signature, 'utf8');
      const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

      if (sigBuffer.length !== expectedBuffer.length) {
        return { valid: false, error: 'Signature length mismatch.' };
      }

      const match = crypto.timingSafeEqual(sigBuffer, expectedBuffer);
      return { valid: match, error: match ? undefined : 'Signature verification failed.' };
    } catch (err: any) {
      return { valid: false, error: err.message || 'Signature calculation error.' };
    }
  }

  /**
   * Process Razorpay Webhook Event idempotently.
   */
  async processRazorpayWebhook(rawBody: string, signature: string): Promise<{ status: string; eventId: string; duplicate?: boolean }> {
    const verification = this.verifyRazorpayWebhook(rawBody, signature);
    if (!verification.valid) {
      throw new Error(`FORBIDDEN_WEBHOOK: ${verification.error}`);
    }

    const payload = JSON.parse(rawBody);
    const eventId = payload.event_id || payload.id || `evt_${crypto.randomUUID().replace(/-/g, '')}`;
    const eventType = payload.event;
    const now = Date.now();

    // Deduplication check in payment_gateway_events
    const existing = await this.getDb()('payment_gateway_events').where({ event_id: eventId }).first();
    if (existing) {
      return { status: 'ALREADY_PROCESSED', eventId, duplicate: true };
    }

    await this.getDb()('payment_gateway_events').insert({
      id: `pge_${crypto.randomUUID().replace(/-/g, '')}`,
      gateway: 'razorpay',
      event_id: eventId,
      event_type: eventType,
      signature_valid: true,
      processed: false,
      payload: JSON.stringify(payload),
      created_at: now
    });

    try {
      await this.handleGatewayEvent('razorpay', eventType, payload);
      await this.getDb()('payment_gateway_events').where({ event_id: eventId }).update({ processed: true });
      return { status: 'PROCESSED', eventId, duplicate: false };
    } catch (err: any) {
      await this.getDb()('payment_gateway_events').where({ event_id: eventId }).update({ error: err.message });
      throw err;
    }
  }

  /**
   * Process Cashfree Webhook Event idempotently.
   */
  async processCashfreeWebhook(rawBody: string, signature: string, timestamp: string): Promise<{ status: string; eventId: string; duplicate?: boolean }> {
    const verification = this.verifyCashfreeWebhook(rawBody, signature, timestamp);
    if (!verification.valid) {
      throw new Error(`FORBIDDEN_WEBHOOK: ${verification.error}`);
    }

    const payload = JSON.parse(rawBody);
    const eventId = payload.event_id || payload.data?.order?.order_id || payload.data?.payment?.cf_payment_id || payload.id || `evt_cf_${crypto.randomUUID().replace(/-/g, '')}`;
    const eventType = payload.type || payload.event || 'cashfree.webhook';
    const now = Date.now();

    // Deduplication check in payment_gateway_events
    const existing = await this.getDb()('payment_gateway_events').where({ event_id: eventId }).first();
    if (existing) {
      return { status: 'ALREADY_PROCESSED', eventId, duplicate: true };
    }

    await this.getDb()('payment_gateway_events').insert({
      id: `pge_${crypto.randomUUID().replace(/-/g, '')}`,
      gateway: 'cashfree',
      event_id: eventId,
      event_type: eventType,
      signature_valid: true,
      processed: false,
      payload: JSON.stringify(payload),
      created_at: now
    });

    try {
      await this.handleGatewayEvent('cashfree', eventType, payload);
      await this.getDb()('payment_gateway_events').where({ event_id: eventId }).update({ processed: true });
      return { status: 'PROCESSED', eventId, duplicate: false };
    } catch (err: any) {
      await this.getDb()('payment_gateway_events').where({ event_id: eventId }).update({ error: err.message });
      throw err;
    }
  }

  /**
   * Internal gateway event handler for subscriptions, renewals, cancellations, top-ups.
   */
  private async handleGatewayEvent(gateway: string, eventType: string, payload: any): Promise<void> {
    const now = Date.now();

    if (eventType === 'subscription.charged' || eventType === 'subscription.activated') {
      const subEntity = payload.payload?.subscription?.entity || payload.subscription || {};
      const customerEmail = subEntity.notes?.customer_email || payload.payload?.payment?.entity?.email;
      const principalId = subEntity.notes?.principal_id;
      const planTier: PlanTier = (subEntity.notes?.plan_tier as PlanTier) || 'plus';
      const gatewaySubId = subEntity.id || `sub_${Date.now()}`;
      const currency = (subEntity.currency || 'INR').toUpperCase() as CurrencyCode;

      if (!principalId) {
        console.warn(`[GatewayWebhook] Missing principal_id in subscription notes. Skipping grant.`);
        return;
      }

      const customer = await commercialBillingService.getOrCreateCustomer(principalId, customerEmail);
      const plan = COMMERCIAL_PLANS[planTier] || COMMERCIAL_PLANS.plus;
      const periodStart = subEntity.current_start ? subEntity.current_start * 1000 : now;
      const periodEnd = subEntity.current_end ? subEntity.current_end * 1000 : now + 30 * 24 * 60 * 60 * 1000;

      // Update or create Subscription record
      const existingSub = await this.getDb()('subscriptions').where({ customer_id: customer.id }).first();
      const subId = existingSub ? existingSub.id : `sub_${crypto.randomUUID().replace(/-/g, '')}`;

      const price = plan.prices.find(p => p.currency === currency) || plan.prices[0];

      if (existingSub) {
        await this.getDb()('subscriptions').where({ id: subId }).update({
          plan_id: planTier,
          price_id: price.id,
          status: 'active',
          gateway,
          gateway_subscription_id: gatewaySubId,
          currency,
          amount_minor_units: price.amountMinorUnits,
          current_period_start: periodStart,
          current_period_end: periodEnd,
          cancel_at_period_end: false,
          updated_at: now
        });
      } else {
        await this.getDb()('subscriptions').insert({
          id: subId,
          customer_id: customer.id,
          plan_id: planTier,
          price_id: price.id,
          status: 'active',
          gateway,
          gateway_subscription_id: gatewaySubId,
          currency,
          amount_minor_units: price.amountMinorUnits,
          current_period_start: periodStart,
          current_period_end: periodEnd,
          cancel_at_period_end: false,
          metadata: JSON.stringify(subEntity),
          created_at: now,
          updated_at: now
        });
      }

      // Grant monthly plan credits with capped rollover
      await commercialBillingService.grantCredits(
        principalId,
        plan.monthlyPremiumCredits,
        'subscription_monthly',
        periodEnd,
        plan.monthlyPremiumCredits * 2, // Maximum 2x monthly rollover cap
        { gatewaySubId, eventType }
      );

      // Audit event
      await this.getDb()('billing_audit_events').insert({
        id: `bae_${crypto.randomUUID().replace(/-/g, '')}`,
        customer_id: customer.id,
        event_type: 'SUBSCRIPTION_ACTIVATED',
        actor_type: 'gateway_webhook',
        actor_id: gatewaySubId,
        payload: JSON.stringify({ planTier, currency, periodStart, periodEnd }),
        created_at: now
      });
    }

    if (eventType === 'subscription.cancelled' || eventType === 'subscription.halted') {
      const subEntity = payload.payload?.subscription?.entity || payload.subscription || {};
      const gatewaySubId = subEntity.id;
      if (gatewaySubId) {
        await this.getDb()('subscriptions').where({ gateway_subscription_id: gatewaySubId }).update({
          status: 'cancelled',
          cancelled_at: now,
          cancel_at_period_end: false,
          updated_at: now
        });
      }
    }

    if (eventType === 'payment.captured' && payload.payload?.payment?.entity?.notes?.type === 'credit_topup') {
      const paymentEntity = payload.payload.payment.entity;
      const principalId = paymentEntity.notes.principal_id;
      const packId = paymentEntity.notes.pack_id;
      const pack = TOPUP_PACKS[packId];

      if (principalId && pack) {
        await commercialBillingService.grantCredits(
          principalId,
          pack.credits,
          'purchased_topup',
          undefined, // Purchased top-ups do not expire monthly!
          0, // No rollover cap for purchased top-ups
          { paymentId: paymentEntity.id, packId: pack.id }
        );
      }
    }
  }

  /**
   * Create a subscription checkout session for frontend redirection.
   */
  async createSubscriptionCheckout(
    principalId: string,
    planTier: PlanTier,
    currency: CurrencyCode = 'INR'
  ): Promise<{ checkoutUrl?: string; orderId: string; keyId: string; amount: number; currency: string }> {
    const plan = COMMERCIAL_PLANS[planTier];
    if (!plan || planTier === 'free') {
      throw new Error(`Invalid plan tier for subscription checkout: ${planTier}`);
    }

    const price = plan.prices.find(p => p.currency === currency) || plan.prices[0];
    const customer = await commercialBillingService.getOrCreateCustomer(principalId);
    const mockOrderId = `order_${crypto.randomUUID().replace(/-/g, '')}`;

    return {
      orderId: mockOrderId,
      keyId: process.env.RAZORPAY_KEY_ID || 'rzp_test_mock_key_2026',
      amount: price.amountMinorUnits,
      currency: price.currency,
      checkoutUrl: `https://checkout.razorpay.com/v1/checkout.js`
    };
  }

  /**
   * Cancel an active subscription.
   */
  async cancelSubscription(principalId: string): Promise<{ success: boolean; message: string }> {
    const customer = await commercialBillingService.getOrCreateCustomer(principalId);
    const sub = await this.getDb()('subscriptions')
      .where({ customer_id: customer.id, status: 'active' })
      .first();

    if (!sub) {
      return { success: false, message: 'No active subscription found.' };
    }

    await this.getDb()('subscriptions').where({ id: sub.id }).update({
      cancel_at_period_end: true,
      updated_at: Date.now()
    });

    return {
      success: true,
      message: 'Subscription marked to cancel at the end of the current billing period. Entitlements remain active until then.'
    };
  }

  /**
   * Fetch invoice history for customer with GST calculation.
   */
  async getInvoices(principalId: string): Promise<any[]> {
    const customer = await commercialBillingService.getOrCreateCustomer(principalId);
    const subs = await this.getDb()('subscriptions').where({ customer_id: customer.id }).orderBy('created_at', 'desc');

    return (subs as any[]).map((sub: any, idx: number) => {
      const amountPaise = Number(sub.amount_minor_units);
      const isTaxInclusive = true;
      const rateFactor = 1.18;
      const taxableBasePaise = Math.round(amountPaise / rateFactor);
      const gstPaise = amountPaise - taxableBasePaise;

      return {
        invoiceNumber: `INV-2026-${String(idx + 1).padStart(4, '0')}`,
        date: new Date(Number(sub.current_period_start)).toISOString().slice(0, 10),
        plan: sub.plan_id,
        currency: sub.currency,
        totalAmount: Number((amountPaise / 100).toFixed(2)),
        taxableBase: Number((taxableBasePaise / 100).toFixed(2)),
        gstAmount: Number((gstPaise / 100).toFixed(2)),
        sacCode: '998431',
        supplierName: 'Virexa AI Ventures Private Limited',
        status: 'PAID'
      };
    });
  }
}

export const paymentGatewayService = new PaymentGatewayService();
