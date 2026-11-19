import crypto from 'crypto';
import type { Knex } from 'knex';
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

export interface SubscriptionRow {
  id: string;
  customer_id: string;
  plan_id: string;
  price_id: string;
  status: string;
  gateway: string;
  gateway_subscription_id?: string | null;
  currency: string;
  amount_minor_units: number | string;
  current_period_start: number | string;
  current_period_end: number | string;
  cancel_at_period_end: boolean;
  cancelled_at?: number | string | null;
  metadata?: string | Record<string, unknown>;
  created_at: number | string;
  updated_at: number | string;
}

export interface InvoiceRecord {
  invoiceNumber: string;
  date: string;
  plan: string;
  currency: string;
  totalAmount: number;
  taxableBase: number;
  gstAmount: number;
  sacCode: string;
  supplierName: string;
  status: string;
}

export interface PaymentDbQueryBuilder {
  first: () => Promise<SubscriptionRow | Record<string, unknown> | null>;
  update: (patch: Record<string, unknown>) => Promise<unknown>;
  delete?: () => Promise<unknown>;
  orderBy?: (column: string, direction?: string) => Promise<SubscriptionRow[]>;
}

export type PaymentDbClient = {
  (tableName: string): {
    where: (query: Record<string, unknown>) => PaymentDbQueryBuilder;
    insert: (record: Record<string, unknown>) => Promise<unknown>;
    orderBy?: (column: string, direction?: string) => Promise<SubscriptionRow[]>;
  };
};

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

export interface CheckoutSessionResult {
  purchaseId: string;
  orderId: string;
  keyId: string;
  amount: number;
  currency: CurrencyCode;
  gateway: 'razorpay' | 'cashfree' | 'sandbox';
  isSandbox: boolean;
  checkoutUrl?: string; // ONLY populated if the gateway itself returned a hosted payment link (e.g. short_url)
}

export type GatewayOrderTransport = (params: {
  gateway: 'razorpay' | 'cashfree';
  orderId: string;
  amountMinorUnits: number;
  currency: CurrencyCode;
  principalId: string;
  customerId: string;
  planTier: PlanTier;
}) => Promise<{ gatewayOrderId: string; shortUrl?: string }>;

/**
 * AIRA AI 2026 — Candidate Pricing Matrix.
 * 
 * IMPORTANT: In published contracts (packages/contracts/src/commercial.ts), Plus and Pro prices
 * remain empty arrays `[]` pending formal owner commercial sign-off and pricing approval.
 * In production mode, live checkout strictly refuses any plan tier without documented owner approval.
 * CANDIDATE_PRICE_CATALOG is used exclusively in authorized sandbox/test mode.
 */
export const CANDIDATE_PRICE_CATALOG: Record<PlanTier, Record<CurrencyCode, { id: string; amountMinorUnits: number; currency: CurrencyCode } | undefined>> = {
  guest: {
    INR: { id: 'price_guest_inr', amountMinorUnits: 0, currency: 'INR' },
    USD: { id: 'price_guest_usd', amountMinorUnits: 0, currency: 'USD' }
  },
  free: {
    INR: { id: 'price_free_inr', amountMinorUnits: 0, currency: 'INR' },
    USD: { id: 'price_free_usd', amountMinorUnits: 0, currency: 'USD' }
  },
  plus: {
    INR: { id: 'price_plus_inr', amountMinorUnits: 39900, currency: 'INR' },
    USD: { id: 'price_plus_usd', amountMinorUnits: 799, currency: 'USD' }
  },
  pro: {
    INR: { id: 'price_pro_inr', amountMinorUnits: 149900, currency: 'INR' },
    USD: { id: 'price_pro_usd', amountMinorUnits: 1999, currency: 'USD' }
  }
};

export function isPriceApprovedForProduction(tier: PlanTier, currency: CurrencyCode): boolean {
  const plan = COMMERCIAL_PLANS[tier];
  if (!plan || !plan.prices || plan.prices.length === 0) {
    return false;
  }
  return plan.prices.some(p => p.currency === currency && p.amountMinorUnits > 0);
}

function isDisabledCommercialFulfillment(eventType: string, payload: any): boolean {
  if (process.env.AIRA_ENABLE_TEST_FULFILLMENT === 'true' || process.env.AIRA_COMMERCIAL_BILLING_ENABLED === 'true') {
    return false;
  }
  return eventType === 'subscription.charged' || eventType === 'subscription.activated' ||
    (eventType === 'payment.captured' && payload.payload?.payment?.entity?.notes?.type === 'credit_topup');
}

export class PaymentGatewayService {
  private razorpaySecret: string;
  private cashfreeSecret: string;
  private customDbClient: Knex | PaymentDbClient | null = null;
  private customGatewayTransport: GatewayOrderTransport | null = null;

  constructor() {
    this.razorpaySecret = process.env.RAZORPAY_WEBHOOK_SECRET || '';
    this.cashfreeSecret = process.env.CASHFREE_WEBHOOK_SECRET || '';
  }

  setDbClient(client: Knex | PaymentDbClient | null): void {
    this.customDbClient = client;
  }

  setGatewayTransport(transport: GatewayOrderTransport | null): void {
    this.customGatewayTransport = transport;
  }

  setRazorpaySecret(secret: string): void {
    this.razorpaySecret = secret;
  }

  setCashfreeSecret(secret: string): void {
    this.cashfreeSecret = secret;
  }

  private getDb(): Knex | PaymentDbClient {
    return this.customDbClient || db;
  }

  /**
   * Cryptographically verify Razorpay Webhook HMAC-SHA256 signature using raw body.
   */
  verifyRazorpayWebhook(rawBody: string, signature: string, secretOverride?: string): WebhookVerificationResult {
    const secret = secretOverride || this.razorpaySecret || process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret || !signature || !rawBody) {
      return { valid: false, error: 'Missing webhook secret, signature or body payload.' };
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
    const secret = secretOverride || this.cashfreeSecret || process.env.CASHFREE_WEBHOOK_SECRET;
    if (!secret || !signature || !rawBody || !timestamp) {
      return { valid: false, error: 'Missing webhook secret, signature, body, or timestamp.' };
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

    // A disabled paid event must not be recorded as PROCESSED on retry.
    // Decline it before inserting a deduplication row.
    if (isDisabledCommercialFulfillment(eventType, payload)) {
      throw new Error('BILLING_UNAVAILABLE: Paid fulfillment requires verified payment reconciliation.');
    }

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

    if (isDisabledCommercialFulfillment(eventType, payload)) {
      throw new Error('BILLING_UNAVAILABLE: Paid fulfillment requires verified payment reconciliation.');
    }

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

    // Commercial activation is intentionally disabled until a verified gateway
    // order, approved price and paid amount/currency can be reconciled atomically.
    // Signed merchant notes alone are not proof of a purchased subscription.
    if (isDisabledCommercialFulfillment(eventType, payload)) {
      throw new Error('BILLING_UNAVAILABLE: Paid fulfillment awaits approved pricing and verified payment reconciliation.');
    }

    if (eventType === 'subscription.charged' || eventType === 'subscription.activated' || eventType === 'order.paid' || (eventType === 'payment.captured' && payload.payload?.payment?.entity?.notes?.type !== 'credit_topup')) {
      const subEntity = payload.payload?.subscription?.entity || payload.subscription || {};
      const paymentEntity = payload.payload?.payment?.entity || payload.payment || payload.data?.payment || {};
      const orderEntity = payload.payload?.order?.entity || payload.order || payload.data?.order || {};

      const gatewayOrderId = subEntity.id ||
        paymentEntity.order_id ||
        orderEntity.id ||
        paymentEntity.subscription_id ||
        subEntity.notes?.purchase_id ||
        paymentEntity.notes?.purchase_id ||
        subEntity.notes?.order_id ||
        paymentEntity.notes?.order_id;

      if (!gatewayOrderId) {
        throw new Error('BILLING_RECONCILIATION_FAILED: Missing gateway order/subscription identifier in webhook payload.');
      }

      // Query authoritative pre-existing purchase record from database
      const purchaseRecord = await this.getDb()('subscriptions')
        .where({ gateway_subscription_id: gatewayOrderId })
        .first() || await this.getDb()('subscriptions').where({ id: gatewayOrderId }).first();

      if (!purchaseRecord) {
        throw new Error(`BILLING_RECONCILIATION_FAILED: No authoritative purchase record found for transaction ${gatewayOrderId}. Refusing fulfillment.`);
      }

      // Webhook payload validation against pre-existing purchase record:
      // 1. Currency verification
      const receivedCurrency = (subEntity.currency || paymentEntity.currency || orderEntity.currency || purchaseRecord.currency).toUpperCase();
      if (receivedCurrency !== purchaseRecord.currency) {
        throw new Error(`FRAUD_CHECK_FAILED: Currency mismatch. Expected ${purchaseRecord.currency}, received ${receivedCurrency}`);
      }

      // 2. Amount verification
      const receivedAmount = Number(subEntity.amount || paymentEntity.amount || orderEntity.amount || 0);
      if (receivedAmount > 0 && Number(purchaseRecord.amount_minor_units) > 0 && receivedAmount !== Number(purchaseRecord.amount_minor_units)) {
        throw new Error(`FRAUD_CHECK_FAILED: Amount mismatch. Expected ${purchaseRecord.amount_minor_units}, received ${receivedAmount}`);
      }

      // 3. Deduplication / Idempotent state transition
      if (purchaseRecord.status === 'active') {
        // Already fulfilled and active, do not grant duplicate credits
        return;
      }

      // 4. Derive customer and principal strictly from verified purchase record
      let meta: any = {};
      try {
        meta = typeof purchaseRecord.metadata === 'string' ? JSON.parse(purchaseRecord.metadata) : (purchaseRecord.metadata || {});
      } catch {}

      const principalId = meta.principalId;
      const planTier: PlanTier = (purchaseRecord.plan_id as PlanTier) || 'plus';
      const customerId = purchaseRecord.customer_id;

      if (!principalId) {
        throw new Error(`BILLING_RECONCILIATION_FAILED: Purchase record ${purchaseRecord.id} lacks verified principalId.`);
      }

      const plan = COMMERCIAL_PLANS[planTier] || COMMERCIAL_PLANS.plus;
      const periodStart = subEntity.current_start ? subEntity.current_start * 1000 : now;
      const periodEnd = subEntity.current_end ? subEntity.current_end * 1000 : now + 30 * 24 * 60 * 60 * 1000;

      // Update purchase record to active
      await this.getDb()('subscriptions').where({ id: purchaseRecord.id }).update({
        status: 'active',
        current_period_start: periodStart,
        current_period_end: periodEnd,
        cancel_at_period_end: false,
        updated_at: now
      });

      // Grant monthly plan credits with capped rollover to verified principal
      if (!this.customDbClient) {
        await commercialBillingService.grantCredits(
          principalId,
          plan.monthlyPremiumCredits,
          'subscription_monthly',
          periodEnd,
          plan.monthlyPremiumCredits * 2, // Maximum 2x monthly rollover cap
          { gatewayOrderId, eventType, purchaseId: purchaseRecord.id }
        );
      }

      // Audit event
      await this.getDb()('billing_audit_events').insert({
        id: `bae_${crypto.randomUUID().replace(/-/g, '')}`,
        customer_id: customerId,
        event_type: 'SUBSCRIPTION_ACTIVATED',
        actor_type: 'gateway_webhook',
        actor_id: gatewayOrderId,
        payload: JSON.stringify({
          purchaseId: purchaseRecord.id,
          principalId,
          planTier,
          currency: purchaseRecord.currency,
          amount: purchaseRecord.amount_minor_units,
          periodStart,
          periodEnd
        }),
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
   * Create a legitimate, gateway-backed subscription checkout order.
   * Fails closed when live billing is not explicitly enabled or gateway credentials are missing.
   * When enabled, creates an authoritative purchase record binding principal, plan, price, amount, and currency.
   */
  async createSubscriptionCheckout(
    principalId: string,
    planTier: PlanTier,
    currency: CurrencyCode = 'INR'
  ): Promise<CheckoutSessionResult> {
    const plan = COMMERCIAL_PLANS[planTier];
    if (!plan || planTier === 'free' || planTier === 'guest') {
      throw new Error(`Invalid plan tier for subscription checkout: ${planTier}`);
    }

    if (process.env.AIRA_COMMERCIAL_BILLING_ENABLED !== 'true') {
      throw new Error('BILLING_UNAVAILABLE: Live checkout has not been approved or integrated.');
    }

    const isSandbox = process.env.AIRA_ENABLE_TEST_FULFILLMENT === 'true' || process.env.NODE_ENV === 'test';
    let price: { id: string; amountMinorUnits: number; currency: CurrencyCode } | undefined;

    if (!isSandbox) {
      if (!isPriceApprovedForProduction(planTier, currency)) {
        throw new Error(`BILLING_UNAVAILABLE: Production plan pricing for ${planTier} (${currency}) has not received documented owner approval.`);
      }
      price = plan.prices.find(p => p.currency === currency);
    } else {
      price = CANDIDATE_PRICE_CATALOG[planTier]?.[currency];
    }

    if (!price || price.amountMinorUnits <= 0) {
      throw new Error(`BILLING_UNAVAILABLE: No valid price configured for plan ${planTier} in ${currency}.`);
    }

    const keyId = process.env.RAZORPAY_KEY_ID || process.env.CASHFREE_APP_ID || (isSandbox ? process.env.AIRA_TEST_GATEWAY_KEY_ID : undefined);
    if (!keyId) {
      throw new Error('BILLING_UNAVAILABLE: Gateway credentials not configured.');
    }

    let customerId: string;
    if (this.customDbClient) {
      const existingCust = await this.getDb()('billing_customers').where({ principal_id: principalId }).first();
      if (existingCust) {
        customerId = (existingCust as any).id;
      } else {
        customerId = `cust_${crypto.randomUUID().replace(/-/g, '')}`;
        await this.getDb()('billing_customers').insert({
          id: customerId,
          principal_id: principalId,
          created_at: Date.now(),
          updated_at: Date.now()
        });
      }
    } else {
      const customer = await commercialBillingService.getOrCreateCustomer(principalId);
      customerId = customer.id;
    }

    const gateway: 'razorpay' | 'cashfree' = process.env.RAZORPAY_KEY_ID || process.env.RAZORPAY_WEBHOOK_SECRET ? 'razorpay' : 'cashfree';
    const purchaseId = `pur_${crypto.randomUUID().replace(/-/g, '')}`;

    let gatewayOrderId: string;
    let gatewayCheckoutUrl: string | undefined;

    if (this.customGatewayTransport) {
      const res = await this.customGatewayTransport({
        gateway,
        orderId: purchaseId,
        amountMinorUnits: price.amountMinorUnits,
        currency,
        principalId,
        customerId,
        planTier
      });
      gatewayOrderId = res.gatewayOrderId;
      gatewayCheckoutUrl = res.shortUrl;
    } else if (process.env.RAZORPAY_KEY_SECRET && process.env.RAZORPAY_KEY_ID && !process.env.RAZORPAY_KEY_ID.startsWith('rzp_test_mock')) {
      const authHeader = 'Basic ' + Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
      const rzpRes = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          amount: price.amountMinorUnits,
          currency,
          receipt: purchaseId,
          notes: {
            principal_id: principalId,
            customer_id: customerId,
            plan_tier: planTier,
            purchase_id: purchaseId
          }
        })
      });
      if (!rzpRes.ok) {
        const errText = await rzpRes.text();
        throw new Error(`GATEWAY_ORDER_FAILED: Gateway order creation returned status ${rzpRes.status}: ${errText}`);
      }
      const rzpData: any = await rzpRes.json();
      gatewayOrderId = rzpData.id;
    } else if (isSandbox) {
      gatewayOrderId = `order_sandbox_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
    } else {
      throw new Error('BILLING_UNAVAILABLE: Live gateway secret keys not configured for order creation.');
    }

    const now = Date.now();

    // Authoritative purchase record binding in database:
    // Binds authenticated principal, customer ID, gateway order, plan, price, amount, and currency
    await this.getDb()('subscriptions').insert({
      id: purchaseId,
      customer_id: customerId,
      plan_id: planTier,
      price_id: price.id,
      status: 'pending',
      gateway,
      gateway_subscription_id: gatewayOrderId,
      currency,
      amount_minor_units: price.amountMinorUnits,
      current_period_start: now,
      current_period_end: now,
      cancel_at_period_end: false,
      metadata: JSON.stringify({
        principalId,
        customerId,
        orderId: gatewayOrderId,
        purchaseId,
        planTier,
        currency,
        amount: price.amountMinorUnits,
        priceId: price.id,
        reconciliationStatus: 'AWAITING_PAYMENT',
        isSandbox,
        createdAt: now
      }),
      created_at: now,
      updated_at: now
    });

    await this.getDb()('billing_audit_events').insert({
      id: `bae_${crypto.randomUUID().replace(/-/g, '')}`,
      customer_id: customerId,
      event_type: 'CHECKOUT_ORDER_CREATED',
      actor_type: 'principal',
      actor_id: principalId,
      payload: JSON.stringify({
        purchaseId,
        orderId: gatewayOrderId,
        principalId,
        planTier,
        currency,
        amount: price.amountMinorUnits,
        priceId: price.id,
        gateway,
        status: 'PENDING_PAYMENT'
      }),
      created_at: now
    });

    return {
      purchaseId,
      orderId: gatewayOrderId,
      keyId,
      amount: price.amountMinorUnits,
      currency,
      gateway,
      isSandbox,
      checkoutUrl: gatewayCheckoutUrl
    };
  }

  /**
   * Cancel an active subscription.
   */
  async cancelSubscription(principalId: string): Promise<{ success: boolean; message: string }> {
    let customerId: string;
    if (this.customDbClient) {
      const existingCust = await this.getDb()('billing_customers').where({ principal_id: principalId }).first();
      customerId = existingCust ? (existingCust as any).id : '';
    } else {
      const customer = await commercialBillingService.getOrCreateCustomer(principalId);
      customerId = customer.id;
    }

    const sub = await this.getDb()('subscriptions')
      .where({ customer_id: customerId, status: 'active' })
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
   * Invoice history is unavailable until real, reconciled gateway invoice
   * records exist. Subscription rows alone are not proof of a paid invoice.
   */
  async getInvoices(_principalId: string): Promise<InvoiceRecord[]> {
    return [];
  }
}

export const paymentGatewayService = new PaymentGatewayService();
