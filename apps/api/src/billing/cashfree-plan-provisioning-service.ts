import { PlanTier } from '../../../../packages/contracts/src/commercial.js';

export interface CashfreeCredentials {
  appId: string;
  secretKey: string;
  env: 'TEST' | 'PROD';
}

export interface CashfreePlanSpecification {
  planId: string;
  planName: string;
  planTier: 'plus' | 'pro';
  currency: 'INR';
  recurringAmount: number;
  maxAmount?: number;
  intervalType: 'MONTH';
  intervals: number;
  maxCycles?: number;
  planNote: string;
}

export interface PlanLookupResult {
  exists: boolean;
  plan?: any;
  error?: string;
}

export interface PlanVerificationResult {
  isValid: boolean;
  mismatches?: string[];
  existingPlan?: any;
}

export interface ProvisionPlanResult {
  status: 'ALREADY_EXISTS_AND_MATCHED' | 'CREATED';
  planId: string;
  plan: any;
}

export function getAuthoritativeCashfreeSpec(tier: 'plus' | 'pro'): CashfreePlanSpecification {
  if (tier === 'plus') {
    return {
      planId: process.env.CASHFREE_PLAN_ID_PLUS_INR || 'plan_cf_plus_inr_monthly',
      planName: 'AIRA Plus Monthly',
      planTier: 'plus',
      currency: 'INR',
      recurringAmount: 399,
      maxAmount: 399,
      intervalType: 'MONTH',
      intervals: 1,
      // Max cycles is optional for ongoing SaaS subscriptions. When undefined, it runs until cancelled.
      maxCycles: process.env.CASHFREE_PLAN_MAX_CYCLES ? parseInt(process.env.CASHFREE_PLAN_MAX_CYCLES, 10) : undefined,
      planNote: 'AIRA Plus Monthly Subscription (GST Inclusive)'
    };
  }
  return {
    planId: process.env.CASHFREE_PLAN_ID_PRO_INR || 'plan_cf_pro_inr_monthly',
    planName: 'AIRA Pro Monthly',
    planTier: 'pro',
    currency: 'INR',
    recurringAmount: 999,
    maxAmount: 999,
    intervalType: 'MONTH',
    intervals: 1,
    maxCycles: process.env.CASHFREE_PLAN_MAX_CYCLES ? parseInt(process.env.CASHFREE_PLAN_MAX_CYCLES, 10) : undefined,
    planNote: 'AIRA Pro Monthly Subscription (GST Inclusive)'
  };
}

export const AUTHORITATIVE_CASHFREE_SPECS: Record<'plus' | 'pro', CashfreePlanSpecification> = {
  get plus() {
    return getAuthoritativeCashfreeSpec('plus');
  },
  get pro() {
    return getAuthoritativeCashfreeSpec('pro');
  }
};

export class CashfreePlanProvisioningService {
  private inFlightLocks = new Map<string, Promise<ProvisionPlanResult>>();
  private customFetch?: typeof fetch;

  constructor(customFetch?: typeof fetch) {
    this.customFetch = customFetch;
  }

  public setCustomFetch(fn?: typeof fetch): void {
    this.customFetch = fn;
  }

  private getFetch(): typeof fetch {
    return this.customFetch || fetch;
  }

  public resolveCredentials(overrides?: Partial<CashfreeCredentials>): CashfreeCredentials {
    const appId = overrides?.appId || process.env.CASHFREE_APP_ID || '';
    const secretKey = overrides?.secretKey || process.env.CASHFREE_SECRET_KEY || '';
    const rawEnv = overrides?.env || process.env.CASHFREE_ENV || (appId.startsWith('TEST') ? 'TEST' : 'PROD');
    const env: 'TEST' | 'PROD' = rawEnv.toUpperCase() === 'TEST' ? 'TEST' : 'PROD';

    if (!appId || !secretKey) {
      throw new Error('CASHFREE_CREDENTIALS_MISSING: CASHFREE_APP_ID and CASHFREE_SECRET_KEY must be configured.');
    }

    // Strict environment-credential consistency validation: prevents cross-environment pollution
    if (env === 'TEST' && !appId.startsWith('TEST')) {
      throw new Error('ENVIRONMENT_CREDENTIAL_MISMATCH: Target environment is TEST but CASHFREE_APP_ID does not begin with TEST. Refusing cross-environment operation.');
    }
    if (env === 'PROD' && appId.startsWith('TEST')) {
      throw new Error('ENVIRONMENT_CREDENTIAL_MISMATCH: Target environment is PROD but CASHFREE_APP_ID is a TEST sandbox credential. Refusing production mutation with test credentials.');
    }

    return { appId, secretKey, env };
  }

  public getBaseUrl(env: 'TEST' | 'PROD'): string {
    return env === 'TEST'
      ? 'https://sandbox.cashfree.com/pg'
      : 'https://api.cashfree.com/pg';
  }

  /**
   * Safe read-only lookup of a recurring plan in Cashfree.
   * Fails closed on network/gateway errors.
   */
  public async fetchPlan(planId: string, credentials?: CashfreeCredentials): Promise<PlanLookupResult> {
    if (!planId || typeof planId !== 'string') {
      throw new Error('VALIDATION_ERROR: planId is required for Cashfree plan lookup.');
    }

    const creds = credentials || this.resolveCredentials();
    const url = `${this.getBaseUrl(creds.env)}/plans/${encodeURIComponent(planId)}`;
    const fetchFn = this.getFetch();

    try {
      const res = await fetchFn(url, {
        method: 'GET',
        headers: {
          'x-client-id': creds.appId,
          'x-client-secret': creds.secretKey,
          'x-api-version': '2023-08-01'
        }
      });

      if (res.status === 200) {
        const planData = await res.json();
        return { exists: true, plan: planData };
      }

      if (res.status === 404 || res.status === 400) {
        const text = await res.text();
        if (text.includes('plan_not_found') || text.includes('does not exist') || res.status === 404) {
          return { exists: false };
        }
        throw new Error(`CASHFREE_LOOKUP_FAILED: Unexpected error during plan lookup (HTTP ${res.status}): ${text}`);
      }

      const errText = await res.text();
      throw new Error(`CASHFREE_GATEWAY_ERROR: Upstream provider returned HTTP ${res.status} during plan lookup: ${errText}`);
    } catch (err: any) {
      if (err.message?.startsWith('CASHFREE_')) {
        throw err;
      }
      throw new Error(`CASHFREE_GATEWAY_ERROR: Failed to connect to Cashfree plan lookup API: ${err.message || err}`);
    }
  }

  /**
   * Compares existing provider plan terms against the expected AIRA plan specification.
   */
  public verifyPlanTerms(existingPlan: any, expected: CashfreePlanSpecification): PlanVerificationResult {
    const mismatches: string[] = [];

    const planAmount = Number(existingPlan.plan_recurring_amount ?? existingPlan.plan_amount);
    if (isNaN(planAmount) || planAmount !== expected.recurringAmount) {
      mismatches.push(`Amount mismatch: expected ₹${expected.recurringAmount}, got ₹${planAmount}`);
    }

    const currency = (existingPlan.plan_currency || '').toUpperCase();
    if (currency !== expected.currency) {
      mismatches.push(`Currency mismatch: expected ${expected.currency}, got ${currency}`);
    }

    const planType = (existingPlan.plan_type || '').toUpperCase();
    if (planType !== 'PERIODIC') {
      mismatches.push(`Plan type mismatch: expected PERIODIC, got ${planType}`);
    }

    const intervalType = (existingPlan.plan_interval_type || '').toUpperCase();
    if (intervalType !== expected.intervalType) {
      mismatches.push(`Interval type mismatch: expected ${expected.intervalType}, got ${intervalType}`);
    }

    const intervals = Number(existingPlan.plan_intervals);
    if (intervals !== expected.intervals) {
      mismatches.push(`Intervals count mismatch: expected ${expected.intervals}, got ${intervals}`);
    }

    return {
      isValid: mismatches.length === 0,
      mismatches,
      existingPlan
    };
  }

  /**
   * Controlled, idempotent provisioning of a Cashfree recurring plan.
   *
   * Hard Invariants:
   * 1. Requires explicit operator authorization (`options.operatorAuthorized === true`).
   * 2. Checks if plan already exists. If yes and terms match, returns existing without mutation.
   * 3. If plan exists but terms mismatch, strictly rejects (fails closed).
   * 4. Concurrency lock serializes provisioning per planId.
   * 5. Never called during customer checkout.
   */
  public async provisionPlan(
    spec: CashfreePlanSpecification,
    options: {
      operatorAuthorized: boolean;
      credentials?: CashfreeCredentials;
    }
  ): Promise<ProvisionPlanResult> {
    if (!options?.operatorAuthorized) {
      throw new Error('OPERATOR_AUTHORIZATION_REQUIRED: Explicit operator authorization is required before provider-side plan mutation.');
    }

    const creds = options.credentials || this.resolveCredentials();

    // In-process lock to prevent concurrent duplicate provisioning attempts
    const lockKey = `${creds.env}:${spec.planId}`;
    if (this.inFlightLocks.has(lockKey)) {
      return this.inFlightLocks.get(lockKey)!;
    }

    const executionPromise = (async (): Promise<ProvisionPlanResult> => {
      // Step 1: Pre-flight existence check
      const lookup = await this.fetchPlan(spec.planId, creds);

      if (lookup.exists && lookup.plan) {
        // Step 2: Verify existing terms
        const verification = this.verifyPlanTerms(lookup.plan, spec);
        if (!verification.isValid) {
          throw new Error(
            `PLAN_TERMS_MISMATCH: Existing Cashfree plan "${spec.planId}" exists but has conflicting terms: ${verification.mismatches?.join('; ')}. ` +
            `Refusing to mutate or overwrite existing plan.`
          );
        }
        return {
          status: 'ALREADY_EXISTS_AND_MATCHED',
          planId: spec.planId,
          plan: lookup.plan
        };
      }

      // Step 3: Plan does not exist. Perform explicit mutation via POST /pg/plans
      const url = `${this.getBaseUrl(creds.env)}/plans`;
      const fetchFn = this.getFetch();

      const payload: Record<string, any> = {
        plan_id: spec.planId,
        plan_name: spec.planName,
        plan_type: 'PERIODIC',
        plan_currency: spec.currency,
        plan_recurring_amount: spec.recurringAmount,
        plan_max_amount: spec.maxAmount ?? spec.recurringAmount,
        plan_intervals: spec.intervals,
        plan_interval_type: spec.intervalType,
        plan_note: spec.planNote
      };

      if (typeof spec.maxCycles === 'number' && spec.maxCycles > 0) {
        payload.plan_max_cycles = spec.maxCycles;
      }

      let res: Response;
      try {
        res = await fetchFn(url, {
          method: 'POST',
          headers: {
            'x-client-id': creds.appId,
            'x-client-secret': creds.secretKey,
            'x-api-version': '2023-08-01',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });
      } catch (networkErr: any) {
        throw new Error(`PROVISIONING_AMBIGUOUS_ERROR: Network failure while communicating with Cashfree Create Plan API: ${networkErr.message}. Verify provider state before retry.`);
      }

      if (res.status === 200 || res.status === 201) {
        const createdData = await res.json();
        return {
          status: 'CREATED',
          planId: spec.planId,
          plan: createdData
        };
      }

      const errText = await res.text();

      // Handle race condition where another operator provisioned the plan concurrently
      if (errText.includes('plan_already_exists') || errText.includes('already exists') || res.status === 409) {
        const doubleCheck = await this.fetchPlan(spec.planId, creds);
        if (doubleCheck.exists && doubleCheck.plan) {
          const verification = this.verifyPlanTerms(doubleCheck.plan, spec);
          if (!verification.isValid) {
            throw new Error(`PLAN_TERMS_MISMATCH: Concurrent plan creation detected for "${spec.planId}", but terms mismatch: ${verification.mismatches?.join('; ')}`);
          }
          return {
            status: 'ALREADY_EXISTS_AND_MATCHED',
            planId: spec.planId,
            plan: doubleCheck.plan
          };
        }
      }

      throw new Error(`CASHFREE_PROVISION_FAILED: Failed to create recurring plan "${spec.planId}" on Cashfree (HTTP ${res.status}): ${errText}`);
    })();

    this.inFlightLocks.set(lockKey, executionPromise);
    try {
      return await executionPromise;
    } finally {
      this.inFlightLocks.delete(lockKey);
    }
  }
}

export const cashfreePlanProvisioningService = new CashfreePlanProvisioningService();
