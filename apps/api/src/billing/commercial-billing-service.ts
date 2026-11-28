import crypto from 'crypto';
import type { Knex } from 'knex';
import { db } from '../../../../packages/db/src/index.js';
import {
  COMMERCIAL_PLANS,
  PlanTier,
  EntitlementState,
  isModelAllowedForTier,
  isGuestPrincipal
} from '../../../../packages/contracts/src/commercial.js';
import { taxDeterminationService, validateGstin } from './tax-determination.js';

function parseJsonSafe(val: any): Record<string, any> {
  if (!val) return {};
  if (typeof val === 'object') return val;
  try {
    return JSON.parse(val);
  } catch {
    return {};
  }
}

/**
 * Determine whether a subscription row represents a paid fulfillment (vs. an unpaid/abandoned checkout).
 */
export function hasPaidSubscriptionEvidence(sub: any): boolean {
  if (!sub) return false;
  const meta = parseJsonSafe(sub.metadata);
  if (meta.refunded === true || meta.authRefunded === true || sub.status === 'refunded') {
    return false;
  }
  if (meta.hadPaidSubscription === false || meta.lifecycleStage === 'UNPAID_CHECKOUT_CANCELLED' || meta.lifecycleStage === 'UNPAID_CHECKOUT_EXPIRED') {
    return false;
  }
  if (sub.status === 'active' || sub.status === 'authenticated') {
    return true;
  }
  return Boolean(
    meta.hadPaidSubscription === true ||
    Number(meta.fulfilledCycle || 0) >= 1 ||
    meta.lifecycleStage === 'PAID_SUBSCRIPTION_CANCELLED' ||
    meta.initialPaymentId ||
    meta.lastPaymentId
  );
}

/**
 * Paid subscription period entitlement check.
 * Separates gateway recurring mandate cancellation from already-paid period-end access.
 */
export function hasPaidPeriodEntitlement(sub: any, now = Date.now()): boolean {
  if (!sub) return false;
  if (sub.plan_id !== 'plus' && sub.plan_id !== 'pro') return false;
  const periodEnd = Number(sub.current_period_end || 0);
  if (!Number.isFinite(periodEnd) || periodEnd <= now) return false;

  const status = String(sub.status || '').toLowerCase();
  if (status === 'refunded' || status === 'superseded' || status === 'pending' || status === 'initiating' || status === 'ambiguous_timeout' || status === 'expired' || status === 'failed' || status === 'halted' || status === 'created') {
    return false;
  }
  const meta = parseJsonSafe(sub.metadata);
  if (meta.refunded === true || meta.authRefunded === true) {
    return false;
  }
  if (status === 'active' || status === 'authenticated') {
    return true;
  }
  if (status === 'cancelled' || status === 'canceled') {
    return hasPaidSubscriptionEvidence(sub);
  }
  return false;
}

export class InsufficientCreditsError extends Error {
  readonly code = 'INSUFFICIENT_CREDITS';
  readonly requiredCredits: number;
  readonly availableCredits: number;

  constructor(requiredCredits: number, availableCredits: number) {
    super(`Insufficient credits: ${requiredCredits} required, but only ${availableCredits} available.`);
    this.name = 'InsufficientCreditsError';
    this.requiredCredits = requiredCredits;
    this.availableCredits = availableCredits;
  }
}

export class StandardQuotaExceededError extends Error {
  readonly code = 'STANDARD_QUOTA_EXCEEDED';
  readonly reason: 'daily' | 'monthly';

  constructor(reason: 'daily' | 'monthly') {
    super(`Standard chat quota exceeded: ${reason} limit reached.`);
    this.name = 'StandardQuotaExceededError';
    this.reason = reason;
  }
}

export class StandardChatReplayError extends Error {
  readonly code = 'CHAT_IDEMPOTENCY_REPLAY';
  constructor(readonly conflictingModel: boolean) {
    super(conflictingModel
      ? 'This idempotency key was already used with a different model.'
      : 'This chat request has already been admitted. It must not execute twice.');
    this.name = 'StandardChatReplayError';
  }
}

export class StandardChatPlanChangedError extends Error {
  readonly code = 'PLAN_MODEL_RESTRICTED';
  constructor(readonly currentTier: PlanTier) {
    super('Subscription changed before chat reservation. The requested model is no longer available.');
    this.name = 'StandardChatPlanChangedError';
  }
}

export interface StandardChatReservation {
  reservationToken: string;
  remainingDaily: number;
  remainingMonthly: number;
}

export interface SavedBusinessBillingSnapshot {
  legalName: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  stateCode: string | null;
  postalCode: string | null;
  country: string | null;
  customerGstin: string | null;
  taxId: string | null;
}

export interface BillingTaxProfile {
  accountType: 'individual' | 'business';
  legalName: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  stateCode: string | null;
  stateName: string | null;
  postalCode: string | null;
  country: string;
  customerGstin: string | null;
  taxId: string | null;
  gstinValidatedAt: number | null;
  isB2b: boolean;
  hasSavedBusinessProfile?: boolean;
  savedBusinessProfile?: SavedBusinessBillingSnapshot | null;
}

export interface BillingTaxProfileInput {
  accountType?: 'individual' | 'business';
  legalName?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  stateCode?: string;
  postalCode?: string;
  country?: string;
  customerGstin?: string;
  taxId?: string;
  clearSavedBusinessDetails?: boolean;
}

export class CommercialBillingService {
  /**
   * Get or create a billing customer and ensure credit account exists.
   */
  async getOrCreateCustomer(
    principalId: string,
    email?: string,
    name?: string,
    countryCode = 'IN'
  ): Promise<{ id: string; principalId: string; email: string | null; defaultCurrency: string }> {
    const existing = await db('billing_customers').where({ principal_id: principalId }).first();
    if (existing) {
      return {
        id: existing.id,
        principalId: existing.principal_id,
        email: existing.email,
        defaultCurrency: existing.default_currency
      };
    }

    const customerId = `cust_${crypto.randomUUID().replace(/-/g, '')}`;
    const accountId = `cacc_${crypto.randomUUID().replace(/-/g, '')}`;
    const now = Date.now();
    const currency = countryCode.toUpperCase() === 'IN' ? 'INR' : 'USD';
    const isGuest = isGuestPrincipal(principalId);
    const initialCredits = isGuest ? 0 : 100;

    let created = false;
    await db.transaction(async (trx) => {
      // Concurrent first requests for one identity must converge on one customer,
      // account and welcome grant; a plain INSERT can race and return a 503.
      const inserted = await trx('billing_customers').insert({
        id: customerId,
        principal_id: principalId,
        email: email || null,
        name: name || null,
        default_currency: currency,
        country_code: countryCode.toUpperCase(),
        tax_info: JSON.stringify({}),
        created_at: now,
        updated_at: now
      }).onConflict('principal_id').ignore().returning('id');
      if (!inserted.length) return;
      created = true;

      // Free tier initial grant: 100 promotional credits (0 credits for guests)
      await trx('credit_accounts').insert({
        id: accountId,
        customer_id: customerId,
        balance_credits: initialCredits,
        reserved_credits: 0,
        lifetime_granted_credits: initialCredits,
        lifetime_spent_credits: 0,
        created_at: now,
        updated_at: now
      });

      if (!isGuest) {
        const grantId = `grant_${crypto.randomUUID().replace(/-/g, '')}`;
        await trx('credit_grants').insert({
          id: grantId,
          account_id: accountId,
          amount_credits: 100,
          remaining_credits: 100,
          grant_type: 'promotional',
          expires_at: now + 30 * 24 * 60 * 60 * 1000,
          rollover_capped: true,
          metadata: JSON.stringify({ note: 'Free tier welcome allotment', isWelcomePromotional: true }),
          created_at: now
        });

        await trx('credit_transactions').insert({
          id: `ctx_${crypto.randomUUID().replace(/-/g, '')}`,
          account_id: accountId,
          transaction_type: 'GRANT',
          amount_credits: 100,
          balance_before: 0,
          balance_after: 100,
          idempotency_key: `init_grant_${customerId}`,
          description: 'Welcome credit grant (AIRA Free)',
          metadata: JSON.stringify({ grantId }),
          created_at: now
        });
      }
    });

    if (!created) {
      const concurrent = await db('billing_customers').where({ principal_id: principalId }).first();
      if (!concurrent) throw new Error('Concurrent billing customer creation could not be reconciled.');
      return {
        id: concurrent.id,
        principalId: concurrent.principal_id,
        email: concurrent.email,
        defaultCurrency: concurrent.default_currency
      };
    }

    return {
      id: customerId,
      principalId,
      email: email || null,
      defaultCurrency: currency
    };
  }

  /**
   * Select the highest-priority paid subscription conferring period-end entitlements
   * (either renewing active/authenticated OR cancelled mandate still inside its paid period).
   */
  async selectEntitledPaidSubscription(
    customerId: string,
    now = Date.now(),
    client: any = db,
    lockMode: 'none' | 'share' = 'none'
  ): Promise<any | null> {
    let query = client('subscriptions')
      .where({ customer_id: customerId })
      .whereIn('status', ['active', 'authenticated', 'cancelled', 'canceled'])
      .where('current_period_end', '>', now)
      .orderBy('current_period_end', 'desc');
    if (lockMode === 'share' && typeof query.forShare === 'function') {
      query = query.forShare();
    }
    const candidates = await query.select('*');
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return null;
    }
    const entitled = candidates.filter((sub: any) => hasPaidPeriodEntitlement(sub, now));
    if (entitled.length === 0) return null;
    // Prefer renewing 'active'/'authenticated' first, then cancelled with highest tier/latest period end.
    entitled.sort((a: any, b: any) => {
      const aActive = a.status === 'active' || a.status === 'authenticated' ? 1 : 0;
      const bActive = b.status === 'active' || b.status === 'authenticated' ? 1 : 0;
      if (aActive !== bActive) return bActive - aActive;
      return Number(b.current_period_end || 0) - Number(a.current_period_end || 0);
    });
    return entitled[0];
  }

  /**
   * Atomically expire stale credit grants (expires_at <= now) without disturbing
   * unexpired welcome, top-up, or held reservation credits.
   */
  private async expireStaleCreditGrants(
    accountId: string,
    now: number,
    trx: any
  ): Promise<number> {
    // Lock account first to serialize concurrent expiry/reserve/grant sweeps cleanly.
    const account = await trx('credit_accounts').where({ id: accountId }).forUpdate().first();
    if (!account) return 0;

    let grantQuery = trx('credit_grants')
      .where({ account_id: accountId })
      .where('remaining_credits', '>', 0)
      .whereNotNull('expires_at')
      .where('expires_at', '<=', now)
      .orderBy('expires_at', 'asc');
    if (typeof grantQuery.forUpdate === 'function') {
      grantQuery = grantQuery.forUpdate();
    }
    const expiredGrants = await grantQuery.select('*');

    if (!Array.isArray(expiredGrants) || expiredGrants.length === 0) {
      return 0;
    }

    let totalExpiredGrantCredits = 0;
    for (const gr of expiredGrants) {
      const rem = Number(gr.remaining_credits || 0);
      if (rem > 0) {
        totalExpiredGrantCredits += rem;
      }
    }
    if (totalExpiredGrantCredits <= 0) {
      return 0;
    }

    const currentBalance = Number(account.balance_credits || 0);
    const currentReserved = Number(account.reserved_credits || 0);
    const unreservedBalance = Math.max(0, currentBalance - currentReserved);

    // Protect expired grant credits held under active reservations from before newer non-expired
    // grants existed so settling that reservation still debits the held expired grant instead
    // of stealing from newer paid grants or double-deducting the same credits.
    let protectedByHeldReservations = 0;
    if (currentReserved > 0) {
      const heldReservations = await trx('credit_reservations')
        .where({ account_id: accountId, status: 'HELD' })
        .orderBy('created_at', 'asc')
        .select('amount_credits', 'created_at');

      if (Array.isArray(heldReservations) && heldReservations.length > 0) {
        const nonExpiredGrants = await trx('credit_grants')
          .where({ account_id: accountId })
          .where('remaining_credits', '>', 0)
          .where(function (this: any) {
            this.whereNull('expires_at').orWhere('expires_at', '>', now);
          })
          .select('remaining_credits', 'created_at');

        let cumulativeHeld = 0;
        for (const hr of heldReservations) {
          cumulativeHeld += Number(hr.amount_credits || 0);
          const holdTs = Number(hr.created_at || 0);
          const nonExpiredBeforeHold = (nonExpiredGrants || [])
            .filter((g: any) => Number(g.created_at || 0) <= holdTs)
            .reduce((s: number, g: any) => s + Number(g.remaining_credits || 0), 0);
          const neededFromExpired = Math.max(0, cumulativeHeld - nonExpiredBeforeHold);
          if (neededFromExpired > protectedByHeldReservations) {
            protectedByHeldReservations = neededFromExpired;
          }
        }
      }
    }

    const expirableGrantHeadroom = Math.max(0, totalExpiredGrantCredits - protectedByHeldReservations);
    const actualExpire = Math.min(unreservedBalance, expirableGrantHeadroom);
    if (actualExpire <= 0) {
      return 0;
    }

    // Only decrement credit_grants up to actualExpire so any portion blocked by held reservations
    // remains sweepable once the reservation settles or releases.
    let remainingToZero = actualExpire;
    const touchedIds: string[] = [];
    for (const gr of expiredGrants) {
      if (remainingToZero <= 0) break;
      const rem = Number(gr.remaining_credits || 0);
      const take = Math.min(rem, remainingToZero);
      if (take > 0) {
        await trx('credit_grants').where({ id: gr.id }).update({ remaining_credits: rem - take });
        remainingToZero -= take;
        touchedIds.push(gr.id);
      }
    }

    const newBalance = Math.max(0, currentBalance - actualExpire);
    await trx('credit_accounts')
      .where({ id: account.id })
      .update({
        balance_credits: newBalance,
        updated_at: now
      });

    const expireKeyDigest = crypto
      .createHash('sha256')
      .update(`${account.id}:${touchedIds.slice().sort().join(',')}:${now}:${newBalance}`)
      .digest('hex')
      .slice(0, 32);

    await trx('credit_transactions').insert({
      id: `ctx_${crypto.randomUUID().replace(/-/g, '')}`,
      account_id: account.id,
      transaction_type: 'EXPIRE',
      amount_credits: -actualExpire,
      balance_before: currentBalance,
      balance_after: newBalance,
      idempotency_key: `expire_${expireKeyDigest}`,
      description: `Expired ${touchedIds.length} credit grant(s)`,
      metadata: JSON.stringify({ expiredGrantIds: touchedIds, expiredGrantSum: totalExpiredGrantCredits, actualExpire }),
      created_at: now
    });

    return actualExpire;
  }

  /**
   * Get active subscription for a customer, defaulting to 'free' or 'guest'.
   */
  async getActiveSubscription(customerId: string): Promise<{
    planId: PlanTier;
    status: string;
    currentPeriodEnd: number;
    cancelAtPeriodEnd: boolean;
  }> {
    const customer = await db('billing_customers').where({ id: customerId }).first();
    if (customer && customer.principal_id && isGuestPrincipal(customer.principal_id)) {
      return {
        planId: 'guest',
        status: 'active',
        currentPeriodEnd: Date.now() + 24 * 60 * 60 * 1000,
        cancelAtPeriodEnd: false
      };
    }

    const now = Date.now();
    const activeSub = await this.selectEntitledPaidSubscription(customerId, now, db);

    if (activeSub) {
      const isCancelledMandate = activeSub.status === 'cancelled' || activeSub.status === 'canceled';
      return {
        planId: activeSub.plan_id as PlanTier,
        status: activeSub.status,
        currentPeriodEnd: Number(activeSub.current_period_end),
        cancelAtPeriodEnd: Boolean(activeSub.cancel_at_period_end) || isCancelledMandate
      };
    }

    return {
      planId: 'free',
      status: 'active',
      currentPeriodEnd: now + 30 * 24 * 60 * 60 * 1000,
      cancelAtPeriodEnd: false
    };
  }

  /**
   * Helper to resolve the billing period start date ('YYYY-MM-DD') for a customer.
   */
  private async getBillingPeriodStartDate(customerId: string, client: any = db): Promise<string> {
    const subRow = await this.selectEntitledPaidSubscription(customerId, Date.now(), client);

    if (subRow && subRow.current_period_start) {
      return new Date(Number(subRow.current_period_start)).toISOString().slice(0, 10);
    }

    // Default to start of current calendar month (e.g. '2026-11-01')
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  }

  /**
   * Helper to aggregate monthly standard chat usage across the customer's billing period.
   */
  private async getMonthlyUsageAcrossPeriod(customerId: string, today: string, client: any = db): Promise<number> {
    const periodStartDate = await this.getBillingPeriodStartDate(customerId, client);
    const sumRow = await client('entitlement_snapshots')
      .where({ customer_id: customerId })
      .where('period_date', '>=', periodStartDate)
      .where('period_date', '<=', today)
      .sum('daily_standard_chat_count as total')
      .first();

    return Number(sumRow?.total || 0);
  }

  private async getMonthlyReasoningBoostUsage(customerId: string, today: string, client: any = db): Promise<number> {
    const periodStartDate = await this.getBillingPeriodStartDate(customerId, client);
    const sumRow = await client('entitlement_snapshots')
      .where({ customer_id: customerId })
      .where('period_date', '>=', periodStartDate)
      .where('period_date', '<=', today)
      .sum('monthly_reasoning_boost_count as total')
      .first();
    return Number(sumRow?.total || 0);
  }

  /**
   * Fetch complete authoritative EntitlementState for a principal.
   */
  async getEntitlements(principalId: string): Promise<EntitlementState> {
    const customer = await this.getOrCreateCustomer(principalId);
    const isGuest = isGuestPrincipal(principalId) || isGuestPrincipal(customer.principalId);
    const sub = await this.getActiveSubscription(customer.id);
    const plan = COMMERCIAL_PLANS[sub.planId] || (isGuest ? COMMERCIAL_PLANS.guest : COMMERCIAL_PLANS.free);

    let account = await db('credit_accounts').where({ customer_id: customer.id }).first();
    if (account && !isGuest) {
      const now = Date.now();
      const staleGrant = await db('credit_grants')
        .where({ account_id: account.id })
        .where('remaining_credits', '>', 0)
        .whereNotNull('expires_at')
        .where('expires_at', '<=', now)
        .first();
      if (staleGrant) {
        await db.transaction(async (trx) => {
          await this.expireStaleCreditGrants(account.id, now, trx);
        });
        account = await db('credit_accounts').where({ customer_id: customer.id }).first();
      }
    }
    const balanceCredits = account ? Number(account.balance_credits) : 0;
    const reservedCredits = account ? Number(account.reserved_credits) : 0;
    const availableCredits = Math.max(0, balanceCredits - reservedCredits);

    const today = new Date().toISOString().slice(0, 10);
    const snapshot = await db('entitlement_snapshots')
      .where({ customer_id: customer.id, period_date: today })
      .first();

    const dailyUsed = snapshot ? Number(snapshot.daily_standard_chat_count) : 0;
    const monthlyUsed = await this.getMonthlyUsageAcrossPeriod(customer.id, today, db);
    const reasoningBoostsUsed = await this.getMonthlyReasoningBoostUsage(customer.id, today, db);

    const dailyRemaining = Math.max(0, plan.dailyStandardChatLimit - dailyUsed);
    const monthlyRemaining = Math.max(0, plan.monthlyStandardChatUnits - monthlyUsed);
    const reasoningRemaining = Math.max(0, plan.complimentaryReasoningBoosts - reasoningBoostsUsed);

    const savedAgentsCountRow = await db('agents').where({ principal_id: principalId }).count('id as count').first();
    const savedAgentsCount = Number(savedAgentsCountRow?.count || 0);

    return {
      customerId: customer.id,
      plan: isGuest ? 'guest' : sub.planId,
      subscriptionStatus: sub.status as any,
      creditBalance: isGuest ? 0 : balanceCredits,
      reservedCredits: isGuest ? 0 : reservedCredits,
      availableCredits: isGuest ? 0 : availableCredits,
      dailyStandardChatRemaining: dailyRemaining,
      dailyStandardChatLimit: plan.dailyStandardChatLimit,
      monthlyStandardChatUnitsRemaining: monthlyRemaining,
      monthlyStandardChatUnitsLimit: plan.monthlyStandardChatUnits,
      reasoningBoostsRemaining: isGuest ? 0 : reasoningRemaining,
      reasoningBoostsLimit: isGuest ? 0 : plan.complimentaryReasoningBoosts,
      savedAgentsCount,
      savedAgentsLimit: isGuest ? 0 : plan.savedAgentsLimit,
      builderAccess: isGuest ? 'none' : plan.builderAccess,
      canInitiateChat: dailyRemaining > 0 && monthlyRemaining > 0,
      canUsePremiumModels: isGuest ? false : (availableCredits >= 10 || reasoningRemaining > 0),
      canUseVision: isGuest ? false : (availableCredits >= 10),
      canUseBuilder: isGuest ? false : (plan.builderAccess !== 'none')
    };
  }

  /**
   * Refund or roll back standard chat units atomically (e.g. streaming cancellation before first token delta).
   */
  async refundStandardChat(principalId: string, computeUnits = 1): Promise<void> {
    if (!principalId || principalId === 'anonymous') return;
    const customer = await this.getOrCreateCustomer(principalId);
    const today = new Date().toISOString().slice(0, 10);
    const now = Date.now();

    await db.transaction(async (trx) => {
      const snapshot = await trx('entitlement_snapshots')
        .where({ customer_id: customer.id, period_date: today })
        .forUpdate()
        .first();

      if (snapshot) {
        const dailyUsed = Math.max(0, Number(snapshot.daily_standard_chat_count) - computeUnits);
        const monthlyUsed = Math.max(0, Number(snapshot.monthly_standard_chat_count) - computeUnits);
        await trx('entitlement_snapshots')
          .where({ customer_id: customer.id, period_date: today })
          .update({
            daily_standard_chat_count: dailyUsed,
            monthly_standard_chat_count: monthlyUsed,
            updated_at: now
          });
      }
    });
  }

  /**
   * Check and consume standard chat units atomically.
   */
  async consumeStandardChat(
    principalId: string,
    computeUnits = 1
  ): Promise<{ remainingDaily: number; remainingMonthly: number }> {
    const customer = await this.getOrCreateCustomer(principalId);
    const sub = await this.getActiveSubscription(customer.id);
    const plan = COMMERCIAL_PLANS[sub.planId] || COMMERCIAL_PLANS.free;
    const today = new Date().toISOString().slice(0, 10);
    const now = Date.now();

    return await db.transaction(async (trx) => {
      const periodStartDate = await this.getBillingPeriodStartDate(customer.id, trx);
      const priorDaysRow = await trx('entitlement_snapshots')
        .where({ customer_id: customer.id })
        .where('period_date', '>=', periodStartDate)
        .where('period_date', '<', today)
        .sum('daily_standard_chat_count as total')
        .first();
      const priorDaysUsage = Number(priorDaysRow?.total || 0);

      let snapshot = await trx('entitlement_snapshots')
        .where({ customer_id: customer.id, period_date: today })
        .forUpdate()
        .first();

      if (!snapshot) {
        const id = `snap_${crypto.randomUUID().replace(/-/g, '')}`;
        await trx('entitlement_snapshots').insert({
          id,
          customer_id: customer.id,
          period_date: today,
          daily_standard_chat_count: 0,
          monthly_standard_chat_count: priorDaysUsage,
          monthly_reasoning_boost_count: 0,
          last_reset_at: now,
          updated_at: now
        });
        snapshot = { daily_standard_chat_count: 0, monthly_standard_chat_count: priorDaysUsage };
      }

      const dailyUsed = Number(snapshot.daily_standard_chat_count);
      const monthlyUsed = priorDaysUsage + dailyUsed;

      if (dailyUsed + computeUnits > plan.dailyStandardChatLimit) {
        throw new StandardQuotaExceededError('daily');
      }
      if (monthlyUsed + computeUnits > plan.monthlyStandardChatUnits) {
        throw new StandardQuotaExceededError('monthly');
      }

      const newDaily = dailyUsed + computeUnits;
      const newMonthly = monthlyUsed + computeUnits;

      await trx('entitlement_snapshots')
        .where({ customer_id: customer.id, period_date: today })
        .update({
          daily_standard_chat_count: newDaily,
          monthly_standard_chat_count: newMonthly,
          updated_at: now
        });

      return {
        remainingDaily: plan.dailyStandardChatLimit - newDaily,
        remainingMonthly: plan.monthlyStandardChatUnits - newMonthly
      };
    });
  }

  /**
   * Atomically reserve standard chat quota units before streaming/execution.
   */
  async reserveStandardChat(
    principalId: string,
    callerTier: PlanTier,
    modelId: string,
    idempotencyKey?: string
  ): Promise<StandardChatReservation> {
    if (idempotencyKey && (idempotencyKey.length < 8 || idempotencyKey.length > 128 || !/^[\x21-\x7e]+$/.test(idempotencyKey))) {
      throw new TypeError('Invalid chat idempotency key.');
    }
    const customer = await this.getOrCreateCustomer(principalId);
    const reservationToken = `res_chat_${crypto.randomUUID().replace(/-/g, '')}`;

    return await db.transaction(async (trx) => {
      // Serialize every reservation for this customer before inspecting today's snapshot.
      // A missing snapshot has nothing to FOR UPDATE, so locking the customer is essential.
      const lockedCustomer = await trx('billing_customers')
        .where({ id: customer.id }).forUpdate().first();
      if (!lockedCustomer) throw new Error('Billing customer disappeared during quota reservation.');

      // Compute time only after locks: queued requests may cross plan expiry
      // or midnight while waiting for another account reservation.
      const now = Date.now();
      const today = new Date(now).toISOString().slice(0, 10);
      const liveSub = await this.selectEntitledPaidSubscription(customer.id, now, trx, 'share');
      const paidTier = liveSub && (liveSub.plan_id === 'plus' || liveSub.plan_id === 'pro')
        ? liveSub.plan_id as PlanTier : 'free';
      const effectiveTier: PlanTier = (isGuestPrincipal(principalId) || isGuestPrincipal(lockedCustomer.principal_id)) ? 'guest' : paidTier;
      const plan = COMMERCIAL_PLANS[effectiveTier];
      // The plan may expire between the HTTP check and the DB reservation.
      if (!isModelAllowedForTier(modelId, effectiveTier)) {
        throw new StandardChatPlanChangedError(effectiveTier);
      }

      const account = await trx('credit_accounts')
        .where({ customer_id: customer.id }).first();
      if (!account) throw new Error('Billing credit account is missing; quota cannot be reserved.');

      if (idempotencyKey) {
        // The customer row lock serializes identical keys across API instances without
        // requiring an unsafe change to an already-applied production migration.
        const prior = await trx('credit_reservations')
          .where({ account_id: account.id, task_type: 'standard_chat' })
          .whereRaw("metadata->>'idempotencyKey' = ?", [idempotencyKey])
          .first();
        if (prior) {
          // Includes HELD, SETTLED and RELEASED; none may trigger a second inference.
          throw new StandardChatReplayError(prior.reference_id !== modelId);
        }
      }

      const periodStartDate = await this.getBillingPeriodStartDate(customer.id, trx);
      const priorDaysRow = await trx('entitlement_snapshots')
        .where({ customer_id: customer.id })
        .where('period_date', '>=', periodStartDate)
        .where('period_date', '<', today)
        .sum('daily_standard_chat_count as total')
        .first();
      const priorDaysUsage = Number(priorDaysRow?.total || 0);

      let snapshot = await trx('entitlement_snapshots')
        .where({ customer_id: customer.id, period_date: today })
        .forUpdate()
        .first();

      if (!snapshot) {
        const id = `snap_${crypto.randomUUID().replace(/-/g, '')}`;
        await trx('entitlement_snapshots').insert({
          id,
          customer_id: customer.id,
          period_date: today,
          daily_standard_chat_count: 0,
          monthly_standard_chat_count: priorDaysUsage,
          monthly_reasoning_boost_count: 0,
          last_reset_at: now,
          updated_at: now
        });
        snapshot = { daily_standard_chat_count: 0, monthly_standard_chat_count: priorDaysUsage };
      }

      const dailyUsed = Number(snapshot.daily_standard_chat_count);
      const monthlyUsed = priorDaysUsage + dailyUsed;

      if (dailyUsed + 1 > plan.dailyStandardChatLimit) {
        throw new StandardQuotaExceededError('daily');
      }
      if (monthlyUsed + 1 > plan.monthlyStandardChatUnits) {
        throw new StandardQuotaExceededError('monthly');
      }

      const newDaily = dailyUsed + 1;
      const newMonthly = monthlyUsed + 1;

      await trx('entitlement_snapshots')
        .where({ customer_id: customer.id, period_date: today })
        .update({
          daily_standard_chat_count: newDaily,
          monthly_standard_chat_count: newMonthly,
          updated_at: now
        });

      await trx('credit_reservations').insert({
          id: reservationToken,
          account_id: account.id,
          amount_credits: 0,
          status: 'HELD',
          task_type: 'standard_chat',
          reference_id: modelId,
          expires_at: now + 15 * 60 * 1000,
          settled_amount_credits: 0,
          metadata: JSON.stringify({
            principalId,
            tier: effectiveTier,
            modelId,
            idempotencyKey: idempotencyKey || null,
            periodDate: today,
            units: 1
          }),
          created_at: now,
          updated_at: now
      });

      return {
        reservationToken,
        remainingDaily: plan.dailyStandardChatLimit - newDaily,
        remainingMonthly: plan.monthlyStandardChatUnits - newMonthly
      };
    });
  }

  /**
   * Settle a standard chat quota reservation upon successful inference/streaming.
   */
  async settleStandardChat(reservationToken: string): Promise<boolean> {
    if (!reservationToken) return false;
    const now = Date.now();
    const settledRows = await db('credit_reservations')
      .where({ id: reservationToken, status: 'HELD' })
      .update({
        status: 'SETTLED',
        settled_amount_credits: 0,
        updated_at: now
      });
    if (settledRows > 0) return true;
    const row = await db('credit_reservations').where({ id: reservationToken }).first();
    if (row?.status === 'SETTLED') return false; // Idempotent replay: no extra boosts.
    throw new Error('Reservation could not be settled; it was released or does not exist.');
  }

  /**
   * Release a standard chat quota reservation and refund the reserved unit.
   */
  async releaseStandardChat(reservationToken: string, reason = 'Client aborted pre-token'): Promise<void> {
    if (!reservationToken) return;
    const now = Date.now();

    await db.transaction(async (trx) => {
      const reservation = await trx('credit_reservations')
        .where({ id: reservationToken })
        .forUpdate()
        .first();

      if (!reservation || reservation.status !== 'HELD') {
        return; // Idempotent
      }

      await trx('credit_reservations')
        .where({ id: reservationToken })
        .update({
          status: 'RELEASED',
          metadata: JSON.stringify({
            ...parseJsonSafe(reservation.metadata),
            releaseReason: reason
          }),
          updated_at: now
        });

      const meta = parseJsonSafe(reservation.metadata);
      const periodDate = meta.periodDate || new Date().toISOString().slice(0, 10);
      const units = Number(meta.units) || 1;

      const account = await trx('credit_accounts').where({ id: reservation.account_id }).first();
      if (account) {
        const snapshot = await trx('entitlement_snapshots')
          .where({ customer_id: account.customer_id, period_date: periodDate })
          .forUpdate()
          .first();

        if (snapshot) {
          const dailyUsed = Math.max(0, Number(snapshot.daily_standard_chat_count) - units);
          const monthlyUsed = Math.max(0, Number(snapshot.monthly_standard_chat_count) - units);
          await trx('entitlement_snapshots')
            .where({ customer_id: account.customer_id, period_date: periodDate })
            .update({
              daily_standard_chat_count: dailyUsed,
              monthly_standard_chat_count: monthlyUsed,
              updated_at: now
            });
        }
      }
    });
  }

  /**
   * Try to consume a complimentary Auto reasoning boost.
   * Returns true if a boost was available and applied without credit deduction.
   */
  async tryConsumeReasoningBoost(principalId: string): Promise<boolean> {
    const customer = await this.getOrCreateCustomer(principalId);
    return await db.transaction(async (trx) => {
      // Serialize across dates and API workers; today's snapshot alone does not
      // enforce a monthly cap and missing snapshots cannot be row-locked.
      const lockedCustomer = await trx('billing_customers').where({ id: customer.id }).forUpdate().first();
      if (!lockedCustomer) throw new Error('Billing customer disappeared during reasoning quota consumption.');
      const now = Date.now();
      const today = new Date(now).toISOString().slice(0, 10);
      const liveSub = await this.selectEntitledPaidSubscription(customer.id, now, trx, 'share');
      const paidTier: PlanTier = liveSub && (liveSub.plan_id === 'plus' || liveSub.plan_id === 'pro')
        ? liveSub.plan_id as PlanTier : 'free';
      const tier = (isGuestPrincipal(principalId) || isGuestPrincipal(lockedCustomer.principal_id)) ? 'guest' : paidTier;
      const plan = COMMERCIAL_PLANS[tier];
      const monthlyUsed = await this.getMonthlyReasoningBoostUsage(customer.id, today, trx);

      let snapshot = await trx('entitlement_snapshots')
        .where({ customer_id: customer.id, period_date: today })
        .forUpdate()
        .first();

      if (!snapshot) {
        const id = `snap_${crypto.randomUUID().replace(/-/g, '')}`;
        await trx('entitlement_snapshots').insert({
          id,
          customer_id: customer.id,
          period_date: today,
          daily_standard_chat_count: 0,
          monthly_standard_chat_count: 0,
          monthly_reasoning_boost_count: 0,
          last_reset_at: now,
          updated_at: now
        });
        snapshot = { monthly_reasoning_boost_count: 0 };
      }

      const boostsUsedToday = Number(snapshot.monthly_reasoning_boost_count);
      if (monthlyUsed < plan.complimentaryReasoningBoosts) {
        await trx('entitlement_snapshots')
          .where({ customer_id: customer.id, period_date: today })
          .update({
            monthly_reasoning_boost_count: boostsUsedToday + 1,
            updated_at: now
          });
        return true;
      }
      return false;
    });
  }

  /**
   * Reserve credits with two-phase commit lock to prevent overdrafts.
   */
  async reserveCredits(
    principalId: string,
    amountCredits: number,
    taskType: any,
    referenceId?: string,
    metadata: Record<string, any> = {}
  ): Promise<{ reservationId: string; amountCredits: number; expiresAt: number }> {
    if (!Number.isFinite(amountCredits) || amountCredits <= 0) {
      throw new Error('Reservation amount must be positive.');
    }

    if (isGuestPrincipal(principalId)) {
      throw new InsufficientCreditsError(amountCredits, 0);
    }

    const customer = await this.getOrCreateCustomer(principalId);
    if (isGuestPrincipal(customer.principalId)) {
      throw new InsufficientCreditsError(amountCredits, 0);
    }

    const now = Date.now();
    const expiresAt = now + 15 * 60 * 1000; // 15 minute TTL
    const reservationId = `res_${crypto.randomUUID().replace(/-/g, '')}`;

    return await db.transaction(async (trx) => {
      const lockedCustomer = await trx('billing_customers')
        .where({ id: customer.id })
        .forUpdate()
        .first();

      if (!lockedCustomer || isGuestPrincipal(lockedCustomer.principal_id) || isGuestPrincipal(principalId)) {
        throw new InsufficientCreditsError(amountCredits, 0);
      }

      let account = await trx('credit_accounts')
        .where({ customer_id: customer.id })
        .forUpdate()
        .first();

      if (!account) {
        throw new Error(`Credit account not found for customer ${customer.id}`);
      }

      const expiredNow = await this.expireStaleCreditGrants(account.id, now, trx);
      if (expiredNow > 0) {
        account = await trx('credit_accounts').where({ id: account.id }).forUpdate().first();
      }

      const balance = Number(account.balance_credits);
      const reserved = Number(account.reserved_credits);
      const available = Math.max(0, balance - reserved);

      if (available < amountCredits) {
        throw new InsufficientCreditsError(amountCredits, available);
      }

      await trx('credit_accounts')
        .where({ id: account.id })
        .update({
          reserved_credits: reserved + amountCredits,
          updated_at: now
        });

      await trx('credit_reservations').insert({
        id: reservationId,
        account_id: account.id,
        amount_credits: amountCredits,
        status: 'HELD',
        task_type: taskType,
        reference_id: referenceId || null,
        expires_at: expiresAt,
        settled_amount_credits: null,
        metadata: JSON.stringify(metadata),
        created_at: now,
        updated_at: now
      });

      return {
        reservationId,
        amountCredits,
        expiresAt
      };
    });
  }

  /**
   * Settle a held reservation, debiting actual spent credits and releasing remainder.
   */
  async settleReservation(
    reservationId: string,
    actualAmountCredits: number,
    metadata: Record<string, any> = {}
  ): Promise<{ settledAmount: number; releasedAmount: number; balanceAfter: number }> {
    const now = Date.now();

    return await db.transaction(async (trx) => {
      const reservation = await trx('credit_reservations')
        .where({ id: reservationId })
        .forUpdate()
        .first();

      if (!reservation) {
        throw new Error(`Reservation ${reservationId} not found.`);
      }

      if (reservation.status !== 'HELD') {
        throw new Error(`Cannot settle reservation in status ${reservation.status}`);
      }

      const account = await trx('credit_accounts')
        .where({ id: reservation.account_id })
        .forUpdate()
        .first();

      if (!account) {
        throw new Error(`Credit account ${reservation.account_id} not found.`);
      }

      const holdAmount = Number(reservation.amount_credits);
      if (!Number.isFinite(actualAmountCredits) || actualAmountCredits < 0) {
        throw new Error('Actual settlement amount must be a finite non-negative number.');
      }
      const actualDebit = Math.min(holdAmount, Math.max(0, actualAmountCredits));
      const releaseAmount = holdAmount - actualDebit;

      const currentBalance = Number(account.balance_credits);
      const currentReserved = Number(account.reserved_credits);

      const newBalance = Math.max(0, currentBalance - actualDebit);
      const newReserved = Math.max(0, currentReserved - holdAmount);

      await trx('credit_accounts')
        .where({ id: account.id })
        .update({
          balance_credits: newBalance,
          reserved_credits: newReserved,
          lifetime_spent_credits: Number(account.lifetime_spent_credits) + actualDebit,
          updated_at: now
        });

      await trx('credit_reservations')
        .where({ id: reservationId })
        .update({
          status: 'SETTLED',
          settled_amount_credits: actualDebit,
          metadata: JSON.stringify({ ...parseJsonSafe(reservation.metadata), ...metadata }),
          updated_at: now
        });

      if (actualDebit > 0) {
        // Deduct settled debit across grants ordered soonest-expiring first, including grants that
        // expired while held by this reservation so held expired credits absorb settlement rather
        // than stealing from newer paid grants. Remaining expired balance is swept below.
        let remainingToDebit = actualDebit;
        const debitCandidateGrants = await trx('credit_grants')
          .where({ account_id: account.id })
          .where('remaining_credits', '>', 0)
          .orderByRaw('expires_at ASC NULLS LAST, created_at ASC')
          .forUpdate()
          .select('*');
        for (const gr of debitCandidateGrants || []) {
          if (remainingToDebit <= 0) break;
          const rem = Number(gr.remaining_credits || 0);
          const take = Math.min(rem, remainingToDebit);
          if (take > 0) {
            await trx('credit_grants').where({ id: gr.id }).update({ remaining_credits: rem - take });
            remainingToDebit -= take;
          }
        }

        await trx('credit_transactions').insert({
          id: `ctx_${crypto.randomUUID().replace(/-/g, '')}`,
          account_id: account.id,
          reservation_id: reservationId,
          transaction_type: 'RESERVATION_SETTLE',
          amount_credits: -actualDebit,
          balance_before: currentBalance,
          balance_after: newBalance,
          idempotency_key: `settle_${reservationId}`,
          description: `Settlement for ${reservation.task_type}`,
          metadata: JSON.stringify({ reservationId, holdAmount, actualDebit, releaseAmount, ...metadata }),
          created_at: now
        });
      }

      // Sweep any remaining expired grant credits that were held under reservation until settlement.
      const sweptAfterSettle = await this.expireStaleCreditGrants(account.id, now, trx);
      const finalBalance = sweptAfterSettle > 0
        ? Number((await trx('credit_accounts').where({ id: account.id }).first())?.balance_credits ?? newBalance)
        : newBalance;

      return {
        settledAmount: actualDebit,
        releasedAmount: releaseAmount,
        balanceAfter: finalBalance
      };
    });
  }

  /**
   * Release a reservation entirely (e.g. on error or cancellation).
   */
  async releaseReservation(reservationId: string, reason = 'Task aborted'): Promise<{ releasedAmount: number }> {
    const now = Date.now();

    return await db.transaction(async (trx) => {
      const reservation = await trx('credit_reservations')
        .where({ id: reservationId })
        .forUpdate()
        .first();

      if (!reservation) {
        throw new Error(`Reservation ${reservationId} not found.`);
      }

      if (reservation.status !== 'HELD') {
        // Idempotent: already settled or released
        return { releasedAmount: 0 };
      }

      const account = await trx('credit_accounts')
        .where({ id: reservation.account_id })
        .forUpdate()
        .first();

      if (!account) {
        throw new Error(`Credit account ${reservation.account_id} not found.`);
      }

      const holdAmount = Number(reservation.amount_credits);
      const currentReserved = Number(account.reserved_credits);
      const newReserved = Math.max(0, currentReserved - holdAmount);

      await trx('credit_accounts')
        .where({ id: account.id })
        .update({
          reserved_credits: newReserved,
          updated_at: now
        });

      await trx('credit_reservations')
        .where({ id: reservationId })
        .update({
          status: 'RELEASED',
          metadata: JSON.stringify({ ...parseJsonSafe(reservation.metadata), releaseReason: reason }),
          updated_at: now
        });

      // Now that reserved_credits decreased, sweep any expired grants held back earlier.
      await this.expireStaleCreditGrants(account.id, now, trx);

      return { releasedAmount: holdAmount };
    });
  }

  /**
   * Grant credits to a user account with capped rollover.
   */
  async grantCredits(
    principalId: string,
    amountCredits: number,
    grantType = 'subscription_monthly',
    expiresAt?: number,
    rolloverCap = 7500,
    metadata: Record<string, any> = {},
    outerTrx?: Knex.Transaction | Knex
  ): Promise<{ newBalance: number; grantId: string }> {
    if (!Number.isFinite(amountCredits) || amountCredits <= 0) {
      throw new Error('Credit grant amount must be a positive finite number.');
    }
    if (isGuestPrincipal(principalId)) {
      throw new Error('Cannot grant credits to guest principal.');
    }
    const customer = await this.getOrCreateCustomer(principalId);
    if (isGuestPrincipal(customer.principalId)) {
      throw new Error('Cannot grant credits to guest principal.');
    }
    const now = Date.now();
    const grantId = `grant_${crypto.randomUUID().replace(/-/g, '')}`;

    const execute = async (trx: any) => {
      let account = await trx('credit_accounts')
        .where({ customer_id: customer.id })
        .forUpdate()
        .first();

      if (!account) {
        throw new Error(`Account not found for customer ${customer.id}`);
      }

      const expiredNow = await this.expireStaleCreditGrants(account.id, now, trx);
      if (expiredNow > 0) {
        account = await trx('credit_accounts').where({ id: account.id }).forUpdate().first();
      }

      const currentBalance = Number(account.balance_credits);
      let allowedGrant = amountCredits;

      // Capped rollover enforcement
      if (grantType === 'subscription_monthly' && rolloverCap > 0) {
        if (currentBalance + amountCredits > rolloverCap) {
          allowedGrant = Math.max(0, rolloverCap - currentBalance);
        }
      }

      const newBalance = currentBalance + allowedGrant;

      await trx('credit_accounts')
        .where({ id: account.id })
        .update({
          balance_credits: newBalance,
          lifetime_granted_credits: Number(account.lifetime_granted_credits) + allowedGrant,
          updated_at: now
        });

      await trx('credit_grants').insert({
        id: grantId,
        account_id: account.id,
        amount_credits: allowedGrant,
        remaining_credits: allowedGrant,
        grant_type: grantType,
        expires_at: expiresAt || null,
        rollover_capped: true,
        metadata: JSON.stringify(metadata),
        created_at: now
      });

      await trx('credit_transactions').insert({
        id: `ctx_${crypto.randomUUID().replace(/-/g, '')}`,
        account_id: account.id,
        transaction_type: 'GRANT',
        amount_credits: allowedGrant,
        balance_before: currentBalance,
        balance_after: newBalance,
        idempotency_key: metadata.idempotencyKey || `grant_${grantId}`,
        description: `Credit Grant (${grantType})`,
        metadata: JSON.stringify({ grantId, requestedAmount: amountCredits, allowedGrant, ...metadata }),
        created_at: now
      });

      return { newBalance, grantId };
    };

    if (outerTrx) {
      return await execute(outerTrx);
    }
    return await db.transaction(execute);
  }

  /**
   * Record a detailed usage event for billing audit & metering.
   */
  async recordUsageEvent(params: {
    principalId: string;
    runId?: string;
    taskType: string;
    provider: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    cachedTokens?: number;
    imagesCount?: number;
    searchQueriesCount?: number;
    sandboxDurationSeconds?: number;
    chargedCredits?: number;
    estimatedDirectCostUsd?: number;
    metadata?: Record<string, any>;
  }): Promise<void> {
    const customer = await this.getOrCreateCustomer(params.principalId);
    await db('usage_events').insert({
      id: `use_${crypto.randomUUID().replace(/-/g, '')}`,
      customer_id: customer.id,
      run_id: params.runId || null,
      task_type: params.taskType,
      provider: params.provider,
      model: params.model || null,
      input_tokens: params.inputTokens || 0,
      output_tokens: params.outputTokens || 0,
      reasoning_tokens: params.reasoningTokens || 0,
      cached_tokens: params.cachedTokens || 0,
      images_count: params.imagesCount || 0,
      search_queries_count: params.searchQueriesCount || 0,
      sandbox_duration_seconds: params.sandboxDurationSeconds || 0.00,
      charged_credits: params.chargedCredits || 0,
      estimated_direct_cost_usd: params.estimatedDirectCostUsd || 0.000000,
      metadata: JSON.stringify(params.metadata || {}),
      created_at: Date.now()
    });
  }

  /**
   * Reads persisted billing/GST tax profile for a principal from billing_customers.
   */
  async getBillingTaxProfile(principalId: string): Promise<BillingTaxProfile> {
    const cust = await db('billing_customers').where({ principal_id: principalId }).first();
    if (!cust) {
      return {
        accountType: 'individual',
        legalName: null,
        addressLine1: null,
        addressLine2: null,
        city: null,
        stateCode: null,
        stateName: null,
        postalCode: null,
        country: 'IN',
        customerGstin: null,
        taxId: null,
        gstinValidatedAt: null,
        isB2b: false
      };
    }

    const taxInfo = parseJsonSafe(cust.tax_info);
    const country = (cust.billing_country || taxInfo.country || cust.country_code || 'IN').toUpperCase();
    const isIndia = country === 'IN';
    const rawState = isIndia
      ? (cust.billing_state_code || taxInfo.stateCode || null)
      : (taxInfo.stateCode || cust.billing_state_code || null);
    const stateNorm = isIndia && rawState ? taxDeterminationService.normalizePlaceOfSupply(rawState) : 'UNKNOWN';
    const resolvedStateCode = isIndia
      ? (stateNorm !== 'UNKNOWN' ? stateNorm : null)
      : (rawState ? String(rawState).trim().slice(0, 64) : null);
    const normalizeSavedBiz = (raw: any): SavedBusinessBillingSnapshot | null => {
      if (!raw || typeof raw !== 'object') return null;
      const snap: SavedBusinessBillingSnapshot = {
        legalName: typeof raw.legalName === 'string' && raw.legalName.trim() ? raw.legalName.trim() : null,
        addressLine1: typeof raw.addressLine1 === 'string' && raw.addressLine1.trim() ? raw.addressLine1.trim() : null,
        addressLine2: typeof raw.addressLine2 === 'string' && raw.addressLine2.trim() ? raw.addressLine2.trim() : null,
        city: typeof raw.city === 'string' && raw.city.trim() ? raw.city.trim() : null,
        stateCode: typeof raw.stateCode === 'string' && raw.stateCode.trim() ? raw.stateCode.trim() : null,
        postalCode: typeof raw.postalCode === 'string' && raw.postalCode.trim() ? raw.postalCode.trim() : null,
        country: typeof raw.country === 'string' && raw.country.trim() ? raw.country.trim().toUpperCase() : null,
        customerGstin: typeof raw.customerGstin === 'string' && raw.customerGstin.trim() ? raw.customerGstin.trim().toUpperCase() : null,
        taxId: typeof raw.taxId === 'string' && raw.taxId.trim() ? raw.taxId.trim() : null
      };
      return Object.values(snap).some(Boolean) ? snap : null;
    };

    const jurisdiction = isIndia && resolvedStateCode ? taxDeterminationService.getJurisdiction(resolvedStateCode) : undefined;
    const rawGstin = (cust.customer_gstin || taxInfo.gstin || null) as string | null;
    const validatedRawGstin = Boolean(rawGstin && validateGstin(rawGstin).valid);
    const rawTaxId = typeof taxInfo.taxId === 'string' && taxInfo.taxId.trim()
      ? taxInfo.taxId.trim().slice(0, 64)
      : (validatedRawGstin ? String(rawGstin).toUpperCase() : null);

    const accountType: 'individual' | 'business' =
      taxInfo.accountType === 'individual'
        ? 'individual'
        : validatedRawGstin || taxInfo.accountType === 'business' || Boolean(!isIndia && rawTaxId)
          ? 'business'
          : 'individual';

    const effectiveGstin = accountType === 'individual' ? null : (rawGstin ? String(rawGstin).toUpperCase() : null);
    const effectiveTaxId = accountType === 'individual' ? null : rawTaxId;
    const savedBusinessProfile = normalizeSavedBiz(taxInfo.savedBusiness);

    return {
      accountType,
      legalName: cust.billing_legal_name || cust.name || taxInfo.legalName || null,
      addressLine1: cust.billing_address_line1 || taxInfo.addressLine1 || null,
      addressLine2: cust.billing_address_line2 || taxInfo.addressLine2 || null,
      city: cust.billing_city || taxInfo.city || null,
      stateCode: resolvedStateCode,
      stateName: isIndia ? (jurisdiction?.name || null) : resolvedStateCode,
      postalCode: cust.billing_postal_code || taxInfo.postalCode || null,
      country,
      customerGstin: effectiveGstin,
      taxId: effectiveTaxId,
      gstinValidatedAt: accountType === 'individual' ? null : (cust.gstin_validated_at ? Number(cust.gstin_validated_at) : null),
      isB2b: accountType === 'business' && Boolean((effectiveGstin && validateGstin(effectiveGstin).valid) || !isIndia),
      hasSavedBusinessProfile: Boolean(savedBusinessProfile),
      savedBusinessProfile
    };
  }

  /**
   * Validates and persists subscriber billing profile across Indian GST & Global accounts.
   */
  async upsertBillingTaxProfile(
    principalId: string,
    input: BillingTaxProfileInput,
    outerTrx?: Knex.Transaction | Knex
  ): Promise<BillingTaxProfile> {
    const cleanCountry = (input.country || 'IN').trim().toUpperCase().slice(0, 8) || 'IN';
    const isIndia = cleanCountry === 'IN';
    const rawGstin = typeof input.customerGstin === 'string' ? input.customerGstin.trim().toUpperCase() : '';
    const rawTaxId = typeof input.taxId === 'string' ? input.taxId.trim() : '';
    const rawState = typeof input.stateCode === 'string' ? input.stateCode.trim() : '';

    let resolvedStateCode: string | null = null;
    let dbStateCodeCol: string | null = null;
    if (rawState) {
      if (isIndia) {
        const normalized = taxDeterminationService.normalizePlaceOfSupply(rawState);
        if (normalized === 'UNKNOWN') {
          throw new Error(`VALIDATION_ERROR: Unsupported Indian GST state or Union Territory code '${rawState}'.`);
        }
        resolvedStateCode = normalized;
        dbStateCodeCol = normalized;
      } else {
        resolvedStateCode = rawState.slice(0, 64);
        dbStateCodeCol = resolvedStateCode.length <= 4 ? resolvedStateCode : null;
      }
    }

    let validatedGstin: string | null = null;
    let gstinValidatedAt: number | null = null;
    if (rawGstin) {
      const check = validateGstin(rawGstin);
      if (!check.valid || !check.normalized || !check.stateCode) {
        throw new Error(`VALIDATION_ERROR: Invalid B2B GSTIN '${rawGstin}': ${check.reason || 'verification failed'}.`);
      }
      if (isIndia && resolvedStateCode && resolvedStateCode !== check.stateCode) {
        throw new Error(
          `VALIDATION_ERROR: GSTIN state prefix '${check.stateCode}' does not match selected billing state '${resolvedStateCode}'.`
        );
      }
      validatedGstin = check.normalized;
      if (isIndia) {
        resolvedStateCode = check.stateCode;
        dbStateCodeCol = check.stateCode;
      }
      gstinValidatedAt = Date.now();
    }

    if (isIndia && !resolvedStateCode) {
      throw new Error('VALIDATION_ERROR: A valid Indian State or Union Territory is required for GST billing.');
    }

    const executor = outerTrx || db;
    let custRow = await executor('billing_customers').where({ principal_id: principalId }).first();
    if (!custRow) {
      const customer = await this.getOrCreateCustomer(principalId, undefined, input.legalName, cleanCountry);
      custRow = await executor('billing_customers').where({ id: customer.id }).first() || { id: customer.id };
    }
    const prevTaxInfo = parseJsonSafe(custRow?.tax_info);
    const now = Date.now();

    const cleanOpt = (v: unknown, maxLen: number): string | null => {
      if (typeof v !== 'string') return null;
      const t = v.trim();
      return t ? t.slice(0, maxLen) : null;
    };

    const normalizeSavedBiz = (raw: any): SavedBusinessBillingSnapshot | null => {
      if (!raw || typeof raw !== 'object') return null;
      const snap: SavedBusinessBillingSnapshot = {
        legalName: cleanOpt(raw.legalName, 255),
        addressLine1: cleanOpt(raw.addressLine1, 255),
        addressLine2: cleanOpt(raw.addressLine2, 255),
        city: cleanOpt(raw.city, 120),
        stateCode: cleanOpt(raw.stateCode, 64),
        postalCode: cleanOpt(raw.postalCode, 16),
        country: typeof raw.country === 'string' && raw.country.trim() ? raw.country.trim().toUpperCase().slice(0, 8) : null,
        customerGstin: typeof raw.customerGstin === 'string' && raw.customerGstin.trim() ? raw.customerGstin.trim().toUpperCase().slice(0, 15) : null,
        taxId: cleanOpt(raw.taxId, 64)
      };
      return Object.values(snap).some(Boolean) ? snap : null;
    };

    const existingSavedBiz = normalizeSavedBiz(prevTaxInfo.savedBusiness);
    const prevGstin = typeof custRow?.customer_gstin === 'string' && custRow.customer_gstin.trim()
      ? custRow.customer_gstin.trim().toUpperCase()
      : (typeof prevTaxInfo.gstin === 'string' && prevTaxInfo.gstin.trim() ? prevTaxInfo.gstin.trim().toUpperCase() : null);
    const prevTaxId = typeof prevTaxInfo.taxId === 'string' && prevTaxInfo.taxId.trim() ? prevTaxInfo.taxId.trim() : null;
    const wasBusiness = prevTaxInfo.accountType === 'business' || Boolean(prevGstin) || Boolean(prevTaxId);

    const requestedAccountType: 'individual' | 'business' | undefined = input.accountType;
    const effectiveAccountType: 'individual' | 'business' = requestedAccountType === 'business'
      ? 'business'
      : requestedAccountType === 'individual'
        ? 'individual'
        : (validatedGstin || (prevTaxInfo.accountType === 'business' && (prevGstin || !isIndia)) ? 'business' : 'individual');

    // Non-destructively capture previous business profile before switching to Individual.
    let savedBizSnapshot: SavedBusinessBillingSnapshot | null = existingSavedBiz;
    if (!input.clearSavedBusinessDetails && effectiveAccountType === 'individual' && wasBusiness) {
      savedBizSnapshot = normalizeSavedBiz({
        legalName: prevTaxInfo.legalName ?? custRow?.billing_legal_name,
        addressLine1: prevTaxInfo.addressLine1 ?? custRow?.billing_address_line1,
        addressLine2: prevTaxInfo.addressLine2 ?? custRow?.billing_address_line2,
        city: prevTaxInfo.city ?? custRow?.billing_city,
        stateCode: prevTaxInfo.stateCode ?? custRow?.billing_state_code,
        postalCode: prevTaxInfo.postalCode ?? custRow?.billing_postal_code,
        country: prevTaxInfo.country ?? custRow?.billing_country,
        customerGstin: prevGstin,
        taxId: prevTaxId ?? prevGstin
      }) ?? existingSavedBiz;
    }

    const switchingBackToBusiness =
      effectiveAccountType === 'business' &&
      prevTaxInfo.accountType === 'individual' &&
      savedBizSnapshot !== null &&
      !input.clearSavedBusinessDetails;

    const legalName = input.legalName !== undefined
      ? cleanOpt(input.legalName, 255)
      : (switchingBackToBusiness && savedBizSnapshot?.legalName
          ? savedBizSnapshot.legalName
          : (custRow?.billing_legal_name ?? custRow?.name ?? null));
    const addressLine1 = input.addressLine1 !== undefined
      ? cleanOpt(input.addressLine1, 255)
      : (switchingBackToBusiness && savedBizSnapshot?.addressLine1
          ? savedBizSnapshot.addressLine1
          : (custRow?.billing_address_line1 ?? null));
    const addressLine2 = input.addressLine2 !== undefined
      ? cleanOpt(input.addressLine2, 255)
      : (switchingBackToBusiness && savedBizSnapshot?.addressLine2
          ? savedBizSnapshot.addressLine2
          : (custRow?.billing_address_line2 ?? null));
    const city = input.city !== undefined
      ? cleanOpt(input.city, 120)
      : (switchingBackToBusiness && savedBizSnapshot?.city
          ? savedBizSnapshot.city
          : (custRow?.billing_city ?? null));
    const postalCode = input.postalCode !== undefined
      ? cleanOpt(input.postalCode, 16)
      : (switchingBackToBusiness && savedBizSnapshot?.postalCode
          ? savedBizSnapshot.postalCode
          : (custRow?.billing_postal_code ?? null));

    let effectiveGstin: string | null = null;
    let effectiveGstinValidatedAt: number | null = null;
    let effectiveTaxId: string | null = null;

    if (effectiveAccountType === 'business') {
      effectiveGstin = validatedGstin;
      effectiveGstinValidatedAt = gstinValidatedAt;
      if (input.customerGstin === undefined) {
        const candidateGstin = prevGstin || (switchingBackToBusiness ? savedBizSnapshot?.customerGstin || null : null);
        if (isIndia && candidateGstin && resolvedStateCode && candidateGstin.slice(0, 2) !== resolvedStateCode) {
          throw new Error(
            `VALIDATION_ERROR: Saved B2B GSTIN prefix '${candidateGstin.slice(0, 2)}' does not match updated billing state '${resolvedStateCode}'. Clear or update GSTIN to switch states.`
          );
        }
        effectiveGstin = candidateGstin;
        effectiveGstinValidatedAt = candidateGstin ? (Number(custRow?.gstin_validated_at || 0) || now) : null;
      }

      effectiveTaxId = input.taxId !== undefined
        ? (rawTaxId ? rawTaxId.slice(0, 64) : null)
        : (prevTaxId || (switchingBackToBusiness ? savedBizSnapshot?.taxId || null : null) || effectiveGstin || null);

      if (!input.clearSavedBusinessDetails) {
        savedBizSnapshot = normalizeSavedBiz({
          legalName,
          addressLine1,
          addressLine2,
          city,
          stateCode: resolvedStateCode,
          postalCode,
          country: cleanCountry,
          customerGstin: effectiveGstin,
          taxId: effectiveTaxId
        });
      }
    }

    if (input.clearSavedBusinessDetails) {
      savedBizSnapshot = null;
    }

    const nextTaxInfo: Record<string, any> = {
      ...prevTaxInfo,
      accountType: effectiveAccountType,
      legalName,
      addressLine1,
      addressLine2,
      city,
      stateCode: resolvedStateCode,
      postalCode,
      country: cleanCountry,
      gstin: effectiveGstin,
      taxId: effectiveTaxId
    };
    if (savedBizSnapshot) {
      nextTaxInfo.savedBusiness = savedBizSnapshot;
    } else {
      delete nextTaxInfo.savedBusiness;
    }

    await executor('billing_customers').where({ id: custRow.id }).update({
      billing_legal_name: legalName,
      billing_address_line1: addressLine1,
      billing_address_line2: addressLine2,
      billing_city: city,
      billing_state_code: dbStateCodeCol,
      billing_postal_code: postalCode,
      billing_country: cleanCountry,
      customer_gstin: isIndia ? effectiveGstin : (effectiveGstin || null),
      gstin_validated_at: effectiveGstinValidatedAt,
      tax_info: JSON.stringify(nextTaxInfo),
      updated_at: now
    });

    const jurisdiction = isIndia && resolvedStateCode ? taxDeterminationService.getJurisdiction(resolvedStateCode) : undefined;
    return {
      accountType: effectiveAccountType,
      legalName,
      addressLine1,
      addressLine2,
      city,
      stateCode: resolvedStateCode,
      stateName: isIndia ? (jurisdiction?.name || null) : resolvedStateCode,
      postalCode,
      country: cleanCountry,
      customerGstin: effectiveGstin,
      taxId: effectiveTaxId,
      gstinValidatedAt: effectiveGstinValidatedAt,
      isB2b: Boolean(effectiveAccountType === 'business' && (effectiveGstin || !isIndia)),
      hasSavedBusinessProfile: Boolean(savedBizSnapshot),
      savedBusinessProfile: savedBizSnapshot
    };
  }
}

export const commercialBillingService = new CommercialBillingService();
