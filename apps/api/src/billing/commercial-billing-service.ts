import crypto from 'crypto';
import { db } from '../../../../packages/db/src/index.js';
import {
  COMMERCIAL_PLANS,
  PlanTier,
  EntitlementState,
  calculateVisionTariff,
  isModelAllowedForTier
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
    const isGuest = principalId.startsWith('guest_');
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
   * Get active subscription for a customer, defaulting to 'free' or 'guest'.
   */
  async getActiveSubscription(customerId: string): Promise<{
    planId: PlanTier;
    status: string;
    currentPeriodEnd: number;
    cancelAtPeriodEnd: boolean;
  }> {
    const customer = await db('billing_customers').where({ id: customerId }).first();
    if (customer && customer.principal_id && customer.principal_id.startsWith('guest_')) {
      return {
        planId: 'guest',
        status: 'active',
        currentPeriodEnd: Date.now() + 24 * 60 * 60 * 1000,
        cancelAtPeriodEnd: false
      };
    }

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
   * Helper to resolve the billing period start date ('YYYY-MM-DD') for a customer.
   */
  private async getBillingPeriodStartDate(customerId: string, client: any = db): Promise<string> {
    const subRow = await client('subscriptions')
      .where({ customer_id: customerId })
      .whereIn('status', ['active', 'authenticated'])
      .orderBy('current_period_end', 'desc')
      .first();

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

  /**
   * Fetch complete authoritative EntitlementState for a principal.
   */
  async getEntitlements(principalId: string): Promise<EntitlementState> {
    const isGuest = principalId.startsWith('guest_');
    const customer = await this.getOrCreateCustomer(principalId);
    const sub = await this.getActiveSubscription(customer.id);
    const plan = COMMERCIAL_PLANS[sub.planId] || (isGuest ? COMMERCIAL_PLANS.guest : COMMERCIAL_PLANS.free);

    const account = await db('credit_accounts').where({ customer_id: customer.id }).first();
    const balanceCredits = account ? Number(account.balance_credits) : 0;
    const reservedCredits = account ? Number(account.reserved_credits) : 0;
    const availableCredits = Math.max(0, balanceCredits - reservedCredits);

    const today = new Date().toISOString().slice(0, 10);
    const snapshot = await db('entitlement_snapshots')
      .where({ customer_id: customer.id, period_date: today })
      .first();

    const dailyUsed = snapshot ? Number(snapshot.daily_standard_chat_count) : 0;
    const monthlyUsed = await this.getMonthlyUsageAcrossPeriod(customer.id, today, db);
    const reasoningBoostsUsed = snapshot ? Number(snapshot.monthly_reasoning_boost_count) : 0;

    const dailyRemaining = Math.max(0, plan.dailyStandardChatLimit - dailyUsed);
    const monthlyRemaining = Math.max(0, plan.monthlyStandardChatUnits - monthlyUsed);
    const reasoningRemaining = Math.max(0, plan.complimentaryReasoningBoosts - reasoningBoostsUsed);

    const savedAgentsCountRow = await db('agents').where({ principal_id: principalId }).count('id as count').first();
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

      const liveSub = await trx('subscriptions')
        .where({ customer_id: customer.id })
        .whereIn('status', ['active', 'authenticated'])
        .orderBy('current_period_end', 'desc')
        .forShare().first();
      // Compute time only after locks: queued requests may cross plan expiry
      // or midnight while waiting for another account reservation.
      const now = Date.now();
      const today = new Date(now).toISOString().slice(0, 10);
      const paidTier = liveSub && Number(liveSub.current_period_end) > now &&
        (liveSub.plan_id === 'plus' || liveSub.plan_id === 'pro')
        ? liveSub.plan_id as PlanTier : 'free';
      const effectiveTier: PlanTier = principalId.startsWith('guest_') ? 'guest' : paidTier;
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
