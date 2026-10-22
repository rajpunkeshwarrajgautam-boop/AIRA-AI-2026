import crypto from 'crypto';
import { db } from '../../../../packages/db/src/index.js';
import {
  COMMERCIAL_PLANS,
  PlanTier,
  EntitlementState,
  calculateVisionTariff
} from '../../../../packages/contracts/src/commercial.js';

function parseJsonSafe(val: any): Record<string, any> {
  if (!val) return {};
  if (typeof val === 'object') return val;
  try {
    return JSON.parse(val);
  } catch {
    return {};
  }
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

    await db.transaction(async (trx) => {
      await trx('billing_customers').insert({
        id: customerId,
        principal_id: principalId,
        email: email || null,
        name: name || null,
        default_currency: currency,
        country_code: countryCode.toUpperCase(),
        tax_info: JSON.stringify({}),
        created_at: now,
        updated_at: now
      });

      // Free tier initial grant: 100 promotional credits
      await trx('credit_accounts').insert({
        id: accountId,
        customer_id: customerId,
        balance_credits: 100,
        reserved_credits: 0,
        lifetime_granted_credits: 100,
        lifetime_spent_credits: 0,
        created_at: now,
        updated_at: now
      });

      const grantId = `grant_${crypto.randomUUID().replace(/-/g, '')}`;
      await trx('credit_grants').insert({
        id: grantId,
        account_id: accountId,
        amount_credits: 100,
        remaining_credits: 100,
        grant_type: 'subscription_monthly',
        expires_at: now + 30 * 24 * 60 * 60 * 1000,
        rollover_capped: true,
        metadata: JSON.stringify({ note: 'Free tier welcome allotment' }),
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
    });

    return {
      id: customerId,
      principalId,
      email: email || null,
      defaultCurrency: currency
    };
  }

  /**
   * Get active subscription for a customer, defaulting to 'free'.
   */
  async getActiveSubscription(customerId: string): Promise<{
    planId: PlanTier;
    status: string;
    currentPeriodEnd: number;
    cancelAtPeriodEnd: boolean;
  }> {
    const activeSub = await db('subscriptions')
      .where({ customer_id: customerId })
      .whereIn('status', ['active', 'authenticated'])
      .orderBy('current_period_end', 'desc')
      .first();

    if (activeSub && activeSub.current_period_end > Date.now()) {
      return {
        planId: activeSub.plan_id as PlanTier,
        status: activeSub.status,
        currentPeriodEnd: Number(activeSub.current_period_end),
        cancelAtPeriodEnd: Boolean(activeSub.cancel_at_period_end)
      };
    }

    return {
      planId: 'free',
      status: 'active',
      currentPeriodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000,
      cancelAtPeriodEnd: false
    };
  }

  /**
   * Fetch complete authoritative EntitlementState for a principal.
   */
  async getEntitlements(principalId: string): Promise<EntitlementState> {
    const customer = await this.getOrCreateCustomer(principalId);
    const sub = await this.getActiveSubscription(customer.id);
    const plan = COMMERCIAL_PLANS[sub.planId] || COMMERCIAL_PLANS.free;

    const account = await db('credit_accounts').where({ customer_id: customer.id }).first();
    const balanceCredits = account ? Number(account.balance_credits) : 0;
    const reservedCredits = account ? Number(account.reserved_credits) : 0;
    const availableCredits = Math.max(0, balanceCredits - reservedCredits);

    const today = new Date().toISOString().slice(0, 10);
    const snapshot = await db('entitlement_snapshots')
      .where({ customer_id: customer.id, period_date: today })
      .first();

    const dailyUsed = snapshot ? Number(snapshot.daily_standard_chat_count) : 0;
    const monthlyUsed = snapshot ? Number(snapshot.monthly_standard_chat_count) : 0;
    const reasoningBoostsUsed = snapshot ? Number(snapshot.monthly_reasoning_boost_count) : 0;

    const dailyRemaining = Math.max(0, plan.dailyStandardChatLimit - dailyUsed);
    const monthlyRemaining = Math.max(0, plan.monthlyStandardChatUnits - monthlyUsed);
    const reasoningRemaining = Math.max(0, plan.complimentaryReasoningBoosts - reasoningBoostsUsed);

    const savedAgentsCountRow = await db('agents').where({ principal_id: principalId }).count('id as count').first().catch(() => ({ count: 0 }));
    const savedAgentsCount = Number(savedAgentsCountRow?.count || 0);

    return {
      customerId: customer.id,
      plan: sub.planId,
      subscriptionStatus: sub.status as any,
      creditBalance: balanceCredits,
      reservedCredits,
      availableCredits,
      dailyStandardChatRemaining: dailyRemaining,
      dailyStandardChatLimit: plan.dailyStandardChatLimit,
      monthlyStandardChatUnitsRemaining: monthlyRemaining,
      monthlyStandardChatUnitsLimit: plan.monthlyStandardChatUnits,
      reasoningBoostsRemaining: reasoningRemaining,
      reasoningBoostsLimit: plan.complimentaryReasoningBoosts,
      savedAgentsCount,
      savedAgentsLimit: plan.savedAgentsLimit,
      builderAccess: plan.builderAccess,
      canInitiateChat: dailyRemaining > 0 && monthlyRemaining > 0,
      canUsePremiumModels: availableCredits >= 10 || reasoningRemaining > 0,
      canUseVision: availableCredits >= 10,
      canUseBuilder: plan.builderAccess !== 'none'
    };
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
        snapshot = { daily_standard_chat_count: 0, monthly_standard_chat_count: 0 };
      }

      const dailyUsed = Number(snapshot.daily_standard_chat_count);
      const monthlyUsed = Number(snapshot.monthly_standard_chat_count);

      if (dailyUsed + computeUnits > plan.dailyStandardChatLimit) {
        throw new StandardQuotaExceededError('daily');
      }
      if (monthlyUsed + computeUnits > plan.monthlyStandardChatUnits) {
        throw new StandardQuotaExceededError('monthly');
      }

      await trx('entitlement_snapshots')
        .where({ customer_id: customer.id, period_date: today })
        .update({
          daily_standard_chat_count: dailyUsed + computeUnits,
          monthly_standard_chat_count: monthlyUsed + computeUnits,
          updated_at: now
        });

      return {
        remainingDaily: plan.dailyStandardChatLimit - (dailyUsed + computeUnits),
        remainingMonthly: plan.monthlyStandardChatUnits - (monthlyUsed + computeUnits)
      };
    });
  }

  /**
   * Try to consume a complimentary Auto reasoning boost.
   * Returns true if a boost was available and applied without credit deduction.
   */
  async tryConsumeReasoningBoost(principalId: string): Promise<boolean> {
    const customer = await this.getOrCreateCustomer(principalId);
    const sub = await this.getActiveSubscription(customer.id);
    const plan = COMMERCIAL_PLANS[sub.planId] || COMMERCIAL_PLANS.free;
    const today = new Date().toISOString().slice(0, 10);
    const now = Date.now();

    return await db.transaction(async (trx) => {
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

      const boostsUsed = Number(snapshot.monthly_reasoning_boost_count);
      if (boostsUsed < plan.complimentaryReasoningBoosts) {
        await trx('entitlement_snapshots')
          .where({ customer_id: customer.id, period_date: today })
          .update({
            monthly_reasoning_boost_count: boostsUsed + 1,
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
    if (amountCredits <= 0) {
      throw new Error('Reservation amount must be positive.');
    }

    const customer = await this.getOrCreateCustomer(principalId);
    const now = Date.now();
    const expiresAt = now + 15 * 60 * 1000; // 15 minute TTL
    const reservationId = `res_${crypto.randomUUID().replace(/-/g, '')}`;

    return await db.transaction(async (trx) => {
      const account = await trx('credit_accounts')
        .where({ customer_id: customer.id })
        .forUpdate()
        .first();

      if (!account) {
        throw new Error(`Credit account not found for customer ${customer.id}`);
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

      return {
        settledAmount: actualDebit,
        releasedAmount: releaseAmount,
        balanceAfter: newBalance
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
    metadata: Record<string, any> = {}
  ): Promise<{ newBalance: number; grantId: string }> {
    const customer = await this.getOrCreateCustomer(principalId);
    const now = Date.now();
    const grantId = `grant_${crypto.randomUUID().replace(/-/g, '')}`;

    return await db.transaction(async (trx) => {
      const account = await trx('credit_accounts')
        .where({ customer_id: customer.id })
        .forUpdate()
        .first();

      if (!account) {
        throw new Error(`Account not found for customer ${customer.id}`);
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
        idempotency_key: `grant_${grantId}`,
        description: `Credit Grant (${grantType})`,
        metadata: JSON.stringify({ grantId, requestedAmount: amountCredits, allowedGrant, ...metadata }),
        created_at: now
      });

      return { newBalance, grantId };
    });
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
}

export const commercialBillingService = new CommercialBillingService();
