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
    INR: { id: 'price_pro_inr', amountMinorUnits: 99900, currency: 'INR' },
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

export class TerminalRejectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalRejectionError';
  }
}

export function isTerminalError(err: any): boolean {
  return (
    err instanceof TerminalRejectionError ||
    err?.name === 'TerminalRejectionError' ||
    err?.message?.startsWith('FRAUD_CHECK_FAILED') ||
    err?.message?.startsWith('BILLING_RECONCILIATION_FAILED') ||
    err?.message?.startsWith('FORBIDDEN_WEBHOOK') ||
    err?.message?.startsWith('INVALID_STATE_TRANSITION')
  );
}

export const PAID_FULFILLMENT_EVENTS = new Set([
  // Razorpay
  'subscription.charged',
  'subscription.activated',
  'subscription.renewed',
  'order.paid',
  'payment.captured',
  'invoice.paid',
  // Cashfree
  'ORDER_PAID',
  'PAYMENT_SUCCESS_WEBHOOK',
  'PAYMENT_SUCCESS',
  'SUBSCRIPTION_PAYMENT_SUCCESS',
  'SUBSCRIPTION_ACTIVATED',
  'SUBSCRIPTION_CHARGED',
  'SUBSCRIPTION_STATUS_CHANGE'
]);

export const SAFE_RECONCILIATION_EVENTS = new Set([
  // Razorpay
  'subscription.cancelled',
  'subscription.halted',
  'subscription.pending',
  'subscription.paused',
  'payment.failed',
  'refund.processed',
  'refund.created',
  'refund.speed_processed',
  // Cashfree
  'SUBSCRIPTION_CANCELLED',
  'SUBSCRIPTION_HALTED',
  'PAYMENT_FAILED_WEBHOOK',
  'REFUND_SUCCESS'
]);

export function assertCommercialFulfillmentAllowed(eventType: string, gateway: string, payload: any): void {
  // 1. Safe reconciliation (cancellations, halts, refunds) is always permitted
  if (SAFE_RECONCILIATION_EVENTS.has(eventType)) {
    return;
  }

  // 2. Paid fulfillment requires strict kill switch enforcement
  const isPaidFulfillment = PAID_FULFILLMENT_EVENTS.has(eventType);
  if (!isPaidFulfillment) {
    // Unrecognized / unsupported event attempting activation: fail-closed
    throw new TerminalRejectionError(`BILLING_RECONCILIATION_FAILED: Unsupported or unverified webhook event class '${eventType}'. Refusing fulfillment.`);
  }

  // 3. Centralized fail-closed check
  const isProduction = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
  const isStaging = process.env.VERCEL_ENV === 'preview' || process.env.AIRA_ENVIRONMENT === 'staging';
  const isIsolatedTest = (process.env.NODE_ENV === 'test' || process.env.AIRA_ENABLE_TEST_FULFILLMENT === 'true') && !isProduction && !isStaging;

  if (isProduction || isStaging) {
    if (process.env.AIRA_COMMERCIAL_BILLING_ENABLED !== 'true') {
      const envName = isProduction ? 'production' : 'staging';
      throw new Error(`BILLING_UNAVAILABLE: Commercial billing fulfillment is currently disabled in ${envName}. Paid entitlements cannot be granted.`);
    }
  } else {
    if (!isIsolatedTest && process.env.AIRA_COMMERCIAL_BILLING_ENABLED !== 'true') {
      throw new Error('BILLING_UNAVAILABLE: Paid fulfillment requires verified commercial billing activation or isolated test harness.');
    }
  }
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
   * Process Razorpay Webhook Event idempotently with durable lifecycle and atomic state transitions.
   */
  async processRazorpayWebhook(rawBody: string, signature: string): Promise<{ status: string; eventId: string; duplicate?: boolean }> {
    const verification = this.verifyRazorpayWebhook(rawBody, signature);
    if (!verification.valid) {
      throw new Error(`FORBIDDEN_WEBHOOK: ${verification.error}`);
    }

    const payload = JSON.parse(rawBody);
    const eventId = payload.event_id || payload.id || `evt_${crypto.randomUUID().replace(/-/g, '')}`;
    const eventType = payload.event;

    return await this.executeWebhookTransaction('razorpay', eventId, eventType, rawBody, payload);
  }

  /**
   * Process Cashfree Webhook Event idempotently with durable lifecycle and atomic state transitions.
   */
  async processCashfreeWebhook(rawBody: string, signature: string, timestamp: string): Promise<{ status: string; eventId: string; duplicate?: boolean }> {
    const verification = this.verifyCashfreeWebhook(rawBody, signature, timestamp);
    if (!verification.valid) {
      throw new Error(`FORBIDDEN_WEBHOOK: ${verification.error}`);
    }

    const payload = JSON.parse(rawBody);
    const eventId = payload.event_id || payload.data?.order?.order_id || payload.data?.payment?.cf_payment_id || payload.id || `evt_cf_${crypto.randomUUID().replace(/-/g, '')}`;
    const eventType = payload.type || payload.event || 'cashfree.webhook';

    return await this.executeWebhookTransaction('cashfree', eventId, eventType, rawBody, payload);
  }

  /**
   * Centralized webhook transaction engine with durable lifecycle states:
   * RECEIVED -> PROCESSING -> PROCESSED | RETRYABLE_FAILURE | TERMINAL_FAILURE
   *
   * Crucial durability invariant: State machine persistence on `payment_gateway_events`
   * must survive failed fulfillment transactions without committing partial business entitlements.
   */
  private async executeWebhookTransaction(
    gateway: 'razorpay' | 'cashfree',
    eventId: string,
    eventType: string,
    _rawBody: string,
    payload: any
  ): Promise<{ status: string; eventId: string; duplicate?: boolean }> {
    // 1. Centralized fail-closed commercial fulfillment kill switch
    assertCommercialFulfillmentAllowed(eventType, gateway, payload);

    const now = Date.now();
    const database = this.getDb();
    const hasTransaction = typeof (database as any).transaction === 'function';

    if (!hasTransaction) {
      return await this.executeWebhookWithMockDb(gateway, eventId, eventType, payload);
    }

    const knex = database as Knex;
    const eventRowId = `pge_${crypto.randomUUID().replace(/-/g, '')}`;

    // 1. Durable event registration outside business fulfillment transaction
    await knex('payment_gateway_events')
      .insert({
        id: eventRowId,
        gateway,
        event_id: eventId,
        event_type: eventType,
        signature_valid: true,
        processed: false,
        error: 'PROCESSING',
        payload: JSON.stringify({
          ...payload,
          _lifecycle: { state: 'PROCESSING', attempts: 1, lastAttemptAt: now }
        }),
        created_at: now
      })
      .onConflict('event_id')
      .ignore();

    // 2. Fetch existing record to inspect durable state
    const record = await knex('payment_gateway_events')
      .where({ event_id: eventId })
      .first();

    if (!record) {
      throw new Error(`Failed to acquire event lock for ${eventId}`);
    }

    // If already successfully processed, return idempotent response
    if (record.processed) {
      return { status: 'ALREADY_PROCESSED', eventId, duplicate: true };
    }

    let lifecycle: any = {};
    try {
      const parsed = typeof record.payload === 'string' ? JSON.parse(record.payload) : record.payload;
      lifecycle = parsed?._lifecycle || {};
    } catch {}

    // Reject retry immediately if event terminally failed (e.g. fraud, tampered amount)
    if (lifecycle.state === 'TERMINAL_FAILURE' || record.error?.startsWith('TERMINAL_FAILURE')) {
      throw new TerminalRejectionError(`TERMINAL_FAILURE: Webhook event ${eventId} was terminally rejected: ${record.error}`);
    }

    // Check concurrent worker lock lease (30 second timeout)
    if (
      record.error === 'PROCESSING' &&
      record.id !== eventRowId &&
      (now - (lifecycle.lastAttemptAt || 0)) < 30000
    ) {
      return { status: 'CONCURRENTLY_PROCESSING', eventId, duplicate: true };
    }

    const attempts = (lifecycle.attempts || 0) + 1;
    const currentPayload = typeof record.payload === 'string' ? JSON.parse(record.payload) : (record.payload || {});
    currentPayload._lifecycle = { state: 'PROCESSING', attempts, lastAttemptAt: now };

    await knex('payment_gateway_events')
      .where({ event_id: eventId })
      .update({
        error: 'PROCESSING',
        payload: JSON.stringify(currentPayload)
      });

    // 3. Execute business fulfillment inside an isolated transaction
    // Atomically commit business mutations AND payment_gateway_events.processed inside trx
    let fulfillmentError: any = null;
    try {
      await knex.transaction(async (trx) => {
        await this.handleGatewayEvent(gateway, eventType, payload, trx);

        currentPayload._lifecycle.state = 'PROCESSED';
        currentPayload._lifecycle.processedAt = Date.now();
        await trx('payment_gateway_events')
          .where({ event_id: eventId })
          .update({
            processed: true,
            error: null,
            payload: JSON.stringify(currentPayload)
          });
      });
    } catch (err: any) {
      fulfillmentError = err;
    }

    // 4. Update durable lifecycle state OUTSIDE the rolled-back business transaction
    if (fulfillmentError) {
      const isTerminal = isTerminalError(fulfillmentError);
      currentPayload._lifecycle.state = isTerminal ? 'TERMINAL_FAILURE' : 'RETRYABLE_FAILURE';
      currentPayload._lifecycle.terminalReason = isTerminal ? fulfillmentError.message : undefined;
      currentPayload._lifecycle.lastError = fulfillmentError.message;

      await knex('payment_gateway_events')
        .where({ event_id: eventId })
        .update({
          processed: false,
          error: `${isTerminal ? 'TERMINAL_FAILURE' : 'RETRYABLE_FAILURE'}: ${fulfillmentError.message}`,
          payload: JSON.stringify(currentPayload)
        });

      throw fulfillmentError;
    }

    return { status: 'PROCESSED', eventId, duplicate: false };
  }

  /**
   * Fallback execution path for mock database client harnesses.
   */
  private async executeWebhookWithMockDb(
    gateway: 'razorpay' | 'cashfree',
    eventId: string,
    eventType: string,
    payload: any
  ): Promise<{ status: string; eventId: string; duplicate?: boolean }> {
    const now = Date.now();
    const dbClient = this.getDb();
    const existing = await dbClient('payment_gateway_events').where({ event_id: eventId }).first();
    if (existing && (existing as any).processed) {
      return { status: 'ALREADY_PROCESSED', eventId, duplicate: true };
    }

    let lifecycle: any = {};
    try {
      const parsed = typeof (existing as any)?.payload === 'string' ? JSON.parse((existing as any).payload) : (existing as any)?.payload;
      lifecycle = parsed?._lifecycle || {};
    } catch {}

    if (existing && ((existing as any).error?.startsWith('TERMINAL_FAILURE') || lifecycle.state === 'TERMINAL_FAILURE')) {
      throw new TerminalRejectionError(`TERMINAL_FAILURE: Webhook event ${eventId} was terminally rejected: ${(existing as any).error}`);
    }

    if (existing && (existing as any).error === 'PROCESSING' && (now - (lifecycle.lastAttemptAt || 0)) < 30000) {
      return { status: 'CONCURRENTLY_PROCESSING', eventId, duplicate: true };
    }

    const attempts = (lifecycle.attempts || 0) + 1;
    const currentPayload = typeof (existing as any)?.payload === 'string' ? JSON.parse((existing as any).payload) : ((existing as any)?.payload || payload);
    currentPayload._lifecycle = { state: 'PROCESSING', attempts, lastAttemptAt: now };

    if (!existing) {
      await dbClient('payment_gateway_events').insert({
        id: `pge_${crypto.randomUUID().replace(/-/g, '')}`,
        gateway,
        event_id: eventId,
        event_type: eventType,
        signature_valid: true,
        processed: false,
        error: 'PROCESSING',
        payload: JSON.stringify(currentPayload),
        created_at: now
      });
    } else {
      await dbClient('payment_gateway_events').where({ event_id: eventId }).update({
        error: 'PROCESSING',
        payload: JSON.stringify(currentPayload)
      });
    }

    try {
      await this.handleGatewayEvent(gateway, eventType, payload, dbClient);
      currentPayload._lifecycle.state = 'PROCESSED';
      currentPayload._lifecycle.processedAt = Date.now();
      await dbClient('payment_gateway_events').where({ event_id: eventId }).update({
        processed: true,
        error: null,
        payload: JSON.stringify(currentPayload)
      });
      return { status: 'PROCESSED', eventId, duplicate: false };
    } catch (err: any) {
      const isTerminal = isTerminalError(err);
      currentPayload._lifecycle.state = isTerminal ? 'TERMINAL_FAILURE' : 'RETRYABLE_FAILURE';
      currentPayload._lifecycle.terminalReason = isTerminal ? err.message : undefined;
      currentPayload._lifecycle.lastError = err.message;
      await dbClient('payment_gateway_events').where({ event_id: eventId }).update({
        processed: false,
        error: `${isTerminal ? 'TERMINAL_FAILURE' : 'RETRYABLE_FAILURE'}: ${err.message}`,
        payload: JSON.stringify(currentPayload)
      });
      throw err;
    }
  }

  /**
   * Internal gateway event handler for subscriptions, renewals, cancellations, top-ups.
   * Operates strictly within the provided database transaction for atomicity.
   */
  private async handleGatewayEvent(gateway: string, eventType: string, payload: any, trx: any): Promise<void> {
    const now = Date.now();

    // Re-verify commercial fulfillment policy within handler
    assertCommercialFulfillmentAllowed(eventType, gateway, payload);

    if (
      eventType === 'subscription.charged' ||
      eventType === 'subscription.activated' ||
      eventType === 'subscription.renewed' ||
      eventType === 'order.paid' ||
      eventType === 'invoice.paid' ||
      eventType === 'ORDER_PAID' ||
      eventType === 'PAYMENT_SUCCESS_WEBHOOK' ||
      eventType === 'PAYMENT_SUCCESS' ||
      eventType === 'SUBSCRIPTION_PAYMENT_SUCCESS' ||
      eventType === 'SUBSCRIPTION_ACTIVATED' ||
      eventType === 'SUBSCRIPTION_CHARGED' ||
      (eventType === 'SUBSCRIPTION_STATUS_CHANGE' && (payload.data?.subscription?.subscription_status === 'ACTIVE' || payload.data?.subscription?.status === 'ACTIVE')) ||
      (eventType === 'payment.captured' && payload.payload?.payment?.entity?.notes?.type !== 'credit_topup')
    ) {
      const subEntity = payload.payload?.subscription?.entity || payload.payload?.invoice?.entity || payload.subscription || payload.data?.subscription || {};
      const invoiceEntity = payload.payload?.invoice?.entity || payload.invoice || {};
      const paymentEntity = payload.payload?.payment?.entity || payload.payment || payload.data?.payment || {};
      const orderEntity = payload.payload?.order?.entity || payload.order || payload.data?.order || {};

      const actualPaymentId = paymentEntity.id ||
        paymentEntity.cf_payment_id ||
        payload.data?.payment?.cf_payment_id ||
        payload.data?.payment?.payment_id ||
        invoiceEntity.payment_id;

      const cycleNumber = subEntity.paid_count !== undefined ? Number(subEntity.paid_count)
        : subEntity.current_cycle !== undefined ? Number(subEntity.current_cycle)
        : payload.data?.subscription?.current_cycle !== undefined ? Number(payload.data?.subscription?.current_cycle)
        : undefined;

      const explicitPeriodStart = subEntity.current_start ? Number(subEntity.current_start) * 1000
        : (invoiceEntity.billing_start ? Number(invoiceEntity.billing_start) * 1000 : undefined);
      const explicitPeriodEnd = subEntity.current_end ? Number(subEntity.current_end) * 1000
        : (invoiceEntity.billing_end ? Number(invoiceEntity.billing_end) * 1000 : undefined);

      const gatewayOrderId = subEntity.id ||
        subEntity.subscription_id ||
        payload.data?.subscription?.subscription_id ||
        invoiceEntity.subscription_id ||
        invoiceEntity.order_id ||
        invoiceEntity.id ||
        paymentEntity.order_id ||
        orderEntity.id ||
        orderEntity.order_id ||
        paymentEntity.subscription_id ||
        subEntity.notes?.purchase_id ||
        paymentEntity.notes?.purchase_id ||
        subEntity.notes?.order_id ||
        paymentEntity.notes?.order_id;

      if (!gatewayOrderId) {
        throw new TerminalRejectionError('BILLING_RECONCILIATION_FAILED: Missing gateway order/subscription identifier in webhook payload.');
      }

      // Query authoritative pre-existing purchase record with row-level lock
      let purchaseQuery = trx('subscriptions').where({ gateway_subscription_id: gatewayOrderId });
      if (typeof purchaseQuery.forUpdate === 'function') {
        purchaseQuery = purchaseQuery.forUpdate();
      }
      let purchaseRecord = await purchaseQuery.first();

      if (!purchaseRecord) {
        let fallbackQuery = trx('subscriptions').where({ id: gatewayOrderId });
        if (typeof fallbackQuery.forUpdate === 'function') {
          fallbackQuery = fallbackQuery.forUpdate();
        }
        purchaseRecord = await fallbackQuery.first();
      }

      if (!purchaseRecord) {
        const isProduction = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
        const isStaging = process.env.VERCEL_ENV === 'preview' || process.env.AIRA_ENVIRONMENT === 'staging';
        if (!isProduction && !isStaging && (gatewayOrderId.startsWith('ord_test_') || gatewayOrderId.startsWith('test_'))) {
          return; // Acknowledged test webhook event in isolated test environment without entitlement mutation
        }
        throw new TerminalRejectionError(`BILLING_RECONCILIATION_FAILED: No authoritative purchase record found for transaction ${gatewayOrderId}. Refusing fulfillment.`);
      }

      // Validate state transition: never reactivate a cancelled subscription without a new checkout order
      if (purchaseRecord.status === 'cancelled') {
        throw new TerminalRejectionError(`INVALID_STATE_TRANSITION: Cannot activate or renew cancelled subscription ${purchaseRecord.id}.`);
      }

      // Validate payment state
      if (paymentEntity.status && paymentEntity.status !== 'captured' && paymentEntity.status !== 'paid') {
        throw new TerminalRejectionError(`BILLING_RECONCILIATION_FAILED: Razorpay payment status is '${paymentEntity.status}', expected 'captured' or 'paid'.`);
      }
      if (invoiceEntity.status && invoiceEntity.status !== 'paid') {
        throw new TerminalRejectionError(`BILLING_RECONCILIATION_FAILED: Razorpay invoice status is '${invoiceEntity.status}', expected 'paid'.`);
      }
      if (paymentEntity.payment_status && paymentEntity.payment_status !== 'SUCCESS') {
        throw new TerminalRejectionError(`BILLING_RECONCILIATION_FAILED: Cashfree payment status is '${paymentEntity.payment_status}', expected 'SUCCESS'.`);
      }

      // 1. Currency verification (strict uppercase match)
      const receivedCurrency = (subEntity.currency || invoiceEntity.currency || paymentEntity.currency || orderEntity.currency || '').toUpperCase();
      if (!receivedCurrency || receivedCurrency !== purchaseRecord.currency.toUpperCase()) {
        throw new TerminalRejectionError(`FRAUD_CHECK_FAILED: Currency mismatch. Expected ${purchaseRecord.currency}, received ${receivedCurrency}`);
      }

      // 2. Exact minor-unit amount verification (no zero or missing fallbacks)
      const receivedAmount = subEntity.amount !== undefined ? Number(subEntity.amount)
        : invoiceEntity.amount_paid !== undefined ? Number(invoiceEntity.amount_paid)
        : invoiceEntity.amount !== undefined ? Number(invoiceEntity.amount)
        : paymentEntity.amount !== undefined ? Number(paymentEntity.amount)
        : orderEntity.amount !== undefined ? Number(orderEntity.amount)
        : (orderEntity.order_amount !== undefined ? Math.round(Number(orderEntity.order_amount) * 100) : null);

      if (receivedAmount === null || receivedAmount <= 0 || !Number.isInteger(receivedAmount)) {
        throw new TerminalRejectionError(`FRAUD_CHECK_FAILED: Received invalid or non-integer minor-unit payment amount: ${receivedAmount}`);
      }

      const expectedAmount = Number(purchaseRecord.amount_minor_units);
      if (expectedAmount <= 0 || receivedAmount !== expectedAmount) {
        throw new TerminalRejectionError(`FRAUD_CHECK_FAILED: Amount mismatch. Expected ${expectedAmount}, received ${receivedAmount}`);
      }

      let meta: any = {};
      try {
        meta = typeof purchaseRecord.metadata === 'string' ? JSON.parse(purchaseRecord.metadata) : (purchaseRecord.metadata || {});
      } catch {}

      const principalId = meta.principalId;
      const planTier: PlanTier = (purchaseRecord.plan_id as PlanTier) || 'plus';
      const customerId = purchaseRecord.customer_id;

      if (!principalId) {
        throw new TerminalRejectionError(`BILLING_RECONCILIATION_FAILED: Purchase record ${purchaseRecord.id} lacks verified principalId.`);
      }

      const plan = COMMERCIAL_PLANS[planTier] || COMMERCIAL_PLANS.plus;

      // Deterministic fulfillment operation ID based on immutable gateway evidence
      const fulfillmentOpId = actualPaymentId
        ? `${gateway}:sub:${purchaseRecord.id}:pay:${actualPaymentId}`
        : cycleNumber !== undefined
        ? `${gateway}:sub:${purchaseRecord.id}:cycle:${cycleNumber}`
        : explicitPeriodEnd !== undefined
        ? `${gateway}:sub:${purchaseRecord.id}:period:${explicitPeriodEnd}`
        : `${gateway}:sub:${purchaseRecord.id}:act:${gatewayOrderId}`;

      // Check durable idempotency table before any state modification
      try {
        const existingOp = await trx('idempotent_operations')
          .where({ principal_id: principalId, operation_id: fulfillmentOpId })
          .first();
        if (existingOp && existingOp.status === 'COMPLETED') {
          return;
        }
      } catch {}

      // 3. Idempotent fulfillment vs Renewal logic
      if (purchaseRecord.status === 'active') {
        // Fast duplicate check against previously recorded payment ID
        if (actualPaymentId && (actualPaymentId === meta.lastPaymentId || actualPaymentId === meta.initialPaymentId)) {
          return;
        }

        // Fast duplicate check against previously fulfilled cycle number
        if (cycleNumber !== undefined && cycleNumber <= (meta.fulfilledCycle || 1)) {
          return;
        }

        // Fast duplicate check against previously recorded billing period end
        if (explicitPeriodEnd !== undefined && explicitPeriodEnd <= Number(purchaseRecord.current_period_end)) {
          return;
        }

        // Authoritative renewal evidence verification
        const hasRenewalEvidence = Boolean(
          (explicitPeriodEnd && explicitPeriodEnd > Number(purchaseRecord.current_period_end)) ||
          (cycleNumber !== undefined && cycleNumber > (meta.fulfilledCycle || 1)) ||
          (actualPaymentId && actualPaymentId !== meta.lastPaymentId && actualPaymentId !== meta.initialPaymentId)
        );

        const isClaimedRenewalEvent = Boolean(
          eventType === 'subscription.renewed' ||
          eventType === 'subscription.charged' ||
          eventType === 'SUBSCRIPTION_CHARGED' ||
          eventType === 'SUBSCRIPTION_PAYMENT_SUCCESS'
        );

        if (!hasRenewalEvidence) {
          if (isClaimedRenewalEvent) {
            throw new TerminalRejectionError('BILLING_RECONCILIATION_FAILED: Subscription renewal event lacks authoritative cycle or payment evidence.');
          }
          // Generic webhook event (e.g. redelivered order.paid) on already active subscription: idempotent no-op
          return;
        }

        // Legitimate Renewal: anchor period strictly to previous current_period_end (never Date.now() + 30 days)
        const periodStart = explicitPeriodStart || Number(purchaseRecord.current_period_end);
        const periodEnd = explicitPeriodEnd || (Number(purchaseRecord.current_period_end) + 30 * 24 * 60 * 60 * 1000);

        const newFulfilledCycle = cycleNumber !== undefined ? cycleNumber : ((meta.fulfilledCycle || 1) + 1);
        meta.fulfilledCycle = newFulfilledCycle;
        if (actualPaymentId) {
          meta.lastPaymentId = actualPaymentId;
        }

        await trx('subscriptions').where({ id: purchaseRecord.id }).update({
          current_period_start: periodStart,
          current_period_end: periodEnd,
          cancel_at_period_end: false,
          metadata: JSON.stringify(meta),
          updated_at: now
        });

        const renewalGrantId = `grant_${fulfillmentOpId}`;
        if (!this.customDbClient) {
          await commercialBillingService.grantCredits(
            principalId,
            plan.monthlyPremiumCredits,
            'subscription_monthly',
            periodEnd,
            plan.monthlyPremiumCredits * 2,
            {
              gatewayOrderId,
              eventType,
              purchaseId: purchaseRecord.id,
              isRenewal: true,
              cycleNumber: newFulfilledCycle,
              actualPaymentId,
              idempotencyKey: renewalGrantId
            },
            trx
          );
        }

        try {
          let ins = trx('idempotent_operations').insert({
            key: `${principalId}:${fulfillmentOpId}`,
            principal_id: principalId,
            operation_id: fulfillmentOpId,
            operation_type: 'subscription_renewal',
            payload_hash: '',
            status: 'COMPLETED',
            response_status: 200,
            response_body: JSON.stringify({ status: 'FULFILLED', purchaseId: purchaseRecord.id, cycle: newFulfilledCycle }),
            locked_until: 0,
            created_at: now,
            updated_at: now
          });
          if (ins && typeof ins.onConflict === 'function') {
            ins = ins.onConflict(['principal_id', 'operation_id']).ignore();
          }
          await ins;
        } catch {}

        await trx('billing_audit_events').insert({
          id: `bae_${crypto.randomUUID().replace(/-/g, '')}`,
          customer_id: customerId,
          event_type: 'SUBSCRIPTION_RENEWED',
          actor_type: 'gateway_webhook',
          actor_id: gatewayOrderId,
          payload: JSON.stringify({
            purchaseId: purchaseRecord.id,
            principalId,
            planTier,
            periodStart,
            periodEnd,
            amount: expectedAmount,
            cycleNumber: newFulfilledCycle,
            actualPaymentId
          }),
          created_at: now
        });

        return;
      }

      // Initial Activation (transition from pending -> active)
      const initialPeriodStart = explicitPeriodStart || now;
      const initialPeriodEnd = explicitPeriodEnd || (initialPeriodStart + 30 * 24 * 60 * 60 * 1000);

      meta.fulfilledCycle = cycleNumber || 1;
      if (actualPaymentId) {
        meta.initialPaymentId = actualPaymentId;
        meta.lastPaymentId = actualPaymentId;
      }

      await trx('subscriptions').where({ id: purchaseRecord.id }).update({
        status: 'active',
        current_period_start: initialPeriodStart,
        current_period_end: initialPeriodEnd,
        cancel_at_period_end: false,
        metadata: JSON.stringify(meta),
        updated_at: now
      });

      const initialGrantId = `grant_${fulfillmentOpId}`;
      if (!this.customDbClient) {
        await commercialBillingService.grantCredits(
          principalId,
          plan.monthlyPremiumCredits,
          'subscription_monthly',
          initialPeriodEnd,
          plan.monthlyPremiumCredits * 2,
          {
            gatewayOrderId,
            eventType,
            purchaseId: purchaseRecord.id,
            actualPaymentId,
            cycleNumber: meta.fulfilledCycle,
            idempotencyKey: initialGrantId
          },
          trx
        );
      }

      try {
        let ins = trx('idempotent_operations').insert({
          key: `${principalId}:${fulfillmentOpId}`,
          principal_id: principalId,
          operation_id: fulfillmentOpId,
          operation_type: 'subscription_activation',
          payload_hash: '',
          status: 'COMPLETED',
          response_status: 200,
          response_body: JSON.stringify({ status: 'FULFILLED', purchaseId: purchaseRecord.id, cycle: meta.fulfilledCycle }),
          locked_until: 0,
          created_at: now,
          updated_at: now
        });
        if (ins && typeof ins.onConflict === 'function') {
          ins = ins.onConflict(['principal_id', 'operation_id']).ignore();
        }
        await ins;
      } catch {}

      await trx('billing_audit_events').insert({
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
          periodStart: initialPeriodStart,
          periodEnd: initialPeriodEnd,
          actualPaymentId
        }),
        created_at: now
      });
      return;
    }

    if (
      eventType === 'subscription.cancelled' ||
      eventType === 'subscription.halted' ||
      eventType === 'SUBSCRIPTION_CANCELLED' ||
      eventType === 'SUBSCRIPTION_HALTED' ||
      (eventType === 'SUBSCRIPTION_STATUS_CHANGE' && (payload.data?.subscription?.subscription_status === 'CANCELLED' || payload.data?.subscription?.subscription_status === 'HALTED' || payload.data?.subscription?.status === 'CANCELLED' || payload.data?.subscription?.status === 'HALTED'))
    ) {
      const subEntity = payload.payload?.subscription?.entity || payload.subscription || payload.data?.subscription || {};
      const gatewaySubId = subEntity.id || payload.data?.subscription?.subscription_id;
      if (gatewaySubId) {
        await trx('subscriptions').where({ gateway_subscription_id: gatewaySubId }).update({
          status: 'cancelled',
          cancelled_at: now,
          cancel_at_period_end: false,
          updated_at: now
        });
      }
      return;
    }

    if (
      (eventType === 'payment.captured' && payload.payload?.payment?.entity?.notes?.type === 'credit_topup') ||
      (eventType === 'ORDER_PAID' && (payload.data?.order?.order_tags?.type === 'credit_topup' || payload.data?.payment?.payment_notes?.type === 'credit_topup')) ||
      (eventType === 'PAYMENT_SUCCESS' && (payload.data?.order?.order_tags?.type === 'credit_topup' || payload.data?.payment?.payment_notes?.type === 'credit_topup')) ||
      (eventType === 'PAYMENT_SUCCESS_WEBHOOK' && (payload.data?.order?.order_tags?.type === 'credit_topup' || payload.data?.payment?.payment_notes?.type === 'credit_topup'))
    ) {
      const paymentEntity = payload.payload?.payment?.entity || payload.payment || payload.data?.payment || {};
      const orderEntity = payload.payload?.order?.entity || payload.order || payload.data?.order || {};
      const gatewayOrderId = paymentEntity.order_id || orderEntity.id || paymentEntity.id;

      if (!gatewayOrderId) {
        throw new TerminalRejectionError('BILLING_RECONCILIATION_FAILED: Missing order identifier for credit top-up.');
      }

      let purchaseQuery = trx('subscriptions').where({ gateway_subscription_id: gatewayOrderId });
      if (typeof purchaseQuery.forUpdate === 'function') {
        purchaseQuery = purchaseQuery.forUpdate();
      }
      let purchaseRecord = await purchaseQuery.first();

      if (!purchaseRecord) {
        let fallbackQuery = trx('subscriptions').where({ id: gatewayOrderId });
        if (typeof fallbackQuery.forUpdate === 'function') {
          fallbackQuery = fallbackQuery.forUpdate();
        }
        purchaseRecord = await fallbackQuery.first();
      }

      if (!purchaseRecord) {
        throw new TerminalRejectionError(`BILLING_RECONCILIATION_FAILED: No pre-existing verified purchase record found for credit top-up ${gatewayOrderId}. Refusing fulfillment.`);
      }

      if (paymentEntity.status && paymentEntity.status !== 'captured' && paymentEntity.status !== 'paid') {
        throw new TerminalRejectionError(`BILLING_RECONCILIATION_FAILED: Top-up payment status is '${paymentEntity.status}', expected 'captured'.`);
      }

      const receivedCurrency = (paymentEntity.currency || orderEntity.currency || '').toUpperCase();
      if (!receivedCurrency || receivedCurrency !== purchaseRecord.currency.toUpperCase()) {
        throw new TerminalRejectionError(`FRAUD_CHECK_FAILED: Currency mismatch for top-up. Expected ${purchaseRecord.currency}, received ${receivedCurrency}`);
      }

      const receivedAmount = Number(paymentEntity.amount || orderEntity.amount || 0);
      const expectedAmount = Number(purchaseRecord.amount_minor_units);
      if (receivedAmount <= 0 || receivedAmount !== expectedAmount) {
        throw new TerminalRejectionError(`FRAUD_CHECK_FAILED: Amount mismatch for top-up. Expected ${expectedAmount}, received ${receivedAmount}`);
      }

      let meta: any = {};
      try {
        meta = typeof purchaseRecord.metadata === 'string' ? JSON.parse(purchaseRecord.metadata) : (purchaseRecord.metadata || {});
      } catch {}

      const principalId = meta.principalId;
      const packId = meta.packId || paymentEntity.notes?.pack_id;
      const pack = TOPUP_PACKS[packId];

      if (!principalId || !pack) {
        throw new TerminalRejectionError(`BILLING_RECONCILIATION_FAILED: Invalid top-up metadata or unapproved packId: ${packId}`);
      }

      const actualPaymentId = paymentEntity.id || paymentEntity.cf_payment_id || payload.data?.payment?.cf_payment_id || payload.data?.payment?.payment_id;
      const topupFulfillmentOpId = actualPaymentId ? `${gateway}:topup:pay:${actualPaymentId}` : `${gateway}:topup:${purchaseRecord.id}`;

      try {
        const existingTopupOp = await trx('idempotent_operations')
          .where({ principal_id: principalId, operation_id: topupFulfillmentOpId })
          .first();
        if (existingTopupOp && existingTopupOp.status === 'COMPLETED') {
          return;
        }
      } catch {}

      if (purchaseRecord.status === 'active') {
        return; // Prevent duplicate top-up credit grants
      }

      await trx('subscriptions').where({ id: purchaseRecord.id }).update({
        status: 'active',
        updated_at: now
      });

      const topupGrantId = `grant_${topupFulfillmentOpId}`;
      if (!this.customDbClient) {
        await commercialBillingService.grantCredits(
          principalId,
          pack.credits,
          'purchased_topup',
          undefined,
          0,
          { paymentId: gatewayOrderId, packId: pack.id, purchaseId: purchaseRecord.id, actualPaymentId, idempotencyKey: topupGrantId },
          trx
        );
      }

      try {
        let ins = trx('idempotent_operations').insert({
          key: `${principalId}:${topupFulfillmentOpId}`,
          principal_id: principalId,
          operation_id: topupFulfillmentOpId,
          operation_type: 'credit_topup',
          payload_hash: '',
          status: 'COMPLETED',
          response_status: 200,
          response_body: JSON.stringify({ status: 'FULFILLED', packId: pack.id, credits: pack.credits }),
          locked_until: 0,
          created_at: now,
          updated_at: now
        });
        if (ins && typeof ins.onConflict === 'function') {
          ins = ins.onConflict(['principal_id', 'operation_id']).ignore();
        }
        await ins;
      } catch {}

      await trx('billing_audit_events').insert({
        id: `bae_${crypto.randomUUID().replace(/-/g, '')}`,
        customer_id: purchaseRecord.customer_id,
        event_type: 'CREDIT_TOPUP_FULFILLED',
        actor_type: 'gateway_webhook',
        actor_id: gatewayOrderId,
        payload: JSON.stringify({
          purchaseId: purchaseRecord.id,
          principalId,
          packId: pack.id,
          credits: pack.credits,
          amount: receivedAmount,
          currency: receivedCurrency
        }),
        created_at: now
      });
      return;
    }

    if (SAFE_RECONCILIATION_EVENTS.has(eventType)) {
      return; // Safe non-mutating events (payment.failed, refunds, pauses) acknowledged without state mutation
    }

    // Fail-closed fallback: Any recognized paid event that did not match an explicit handler must be terminally rejected
    throw new TerminalRejectionError(`BILLING_RECONCILIATION_FAILED: Unhandled paid event type '${eventType}' in fulfillment engine.`);
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
