import React, { useState, useEffect, useRef, useCallback } from 'react';
import { X, Check, Shield } from 'lucide-react';
import { motion } from 'framer-motion';
import { PlanTier, CurrencyCode } from '../types/commercial-types';
import { authenticatedApiFetch } from '../lib/neonAuth';

export type CheckoutState =
  | 'IDLE'
  | 'REQUESTING'
  | 'SESSION_READY'
  | 'SDK_INITIALIZING'
  | 'AUTHORIZATION_DISPATCHED'
  | 'AWAITING_CONFIRMATION'
  | 'DEFINITIVE_FAILURE'
  | 'AMBIGUOUS_OUTCOME'
  | 'RECONCILIATION_REQUIRED'
  | 'COMPLETED'
  | 'DISMISSED';

/**
 * Validates that a Cashfree redirect URL is using an official, trusted Cashfree domain over HTTPS.
 * Prevents open-redirect, domain spoofing, and environment confusion attacks.
 */
export function isTrustedCashfreeUrl(rawUrl: string, isSandbox?: boolean): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    if (parsed.port && parsed.port !== '443') return false;

    const sandboxHosts = ['sandbox.cashfree.com', 'payments-test.cashfree.com'];
    const prodHosts = ['api.cashfree.com', 'payments.cashfree.com'];

    const allowedHosts = isSandbox === true
      ? sandboxHosts
      : isSandbox === false
        ? prodHosts
        : [...sandboxHosts, ...prodHosts];

    return allowedHosts.includes(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Validates that a Razorpay redirect URL uses an official, trusted Razorpay domain over HTTPS.
 * Prevents open-redirect, domain spoofing, and protocol manipulation.
 */
export function isTrustedRazorpayUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    if (parsed.port && parsed.port !== '443') return false;

    const allowedHosts = ['api.razorpay.com', 'rzp.io', 'pages.razorpay.com'];
    return allowedHosts.includes(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export interface CheckoutDispatchDecision {
  strategy: 'cashfree_sdk' | 'cashfree_hosted' | 'razorpay_sdk' | 'razorpay_hosted' | 'unsupported_gateway' | 'failure';
  reason?: string;
}

/**
 * Evaluates gateway checkout response and determines the authoritative client dispatch strategy (TQ-01).
 * Evaluates Razorpay SDK modal path before hosted link fallback.
 */
export function determineCheckoutDispatchStrategy(data: any): CheckoutDispatchDecision {
  if (data.gateway === 'cashfree') {
    const sessionId = data.subsSessionId || data.subscriptionSessionId || data.paymentSessionId;
    if (sessionId) {
      return { strategy: 'cashfree_sdk' };
    }
    if (data.checkoutUrl && isTrustedCashfreeUrl(data.checkoutUrl, data.isSandbox)) {
      return { strategy: 'cashfree_hosted' };
    }
    return { strategy: 'failure', reason: 'Missing Cashfree session id or trusted checkout url' };
  }

  if (data.gateway === 'razorpay') {
    // Razorpay SDK precedence: keyId and orderId present selects in-page modal SDK
    if (data.keyId && data.orderId) {
      return { strategy: 'razorpay_sdk' };
    }
    if (data.checkoutUrl && isTrustedRazorpayUrl(data.checkoutUrl)) {
      return { strategy: 'razorpay_hosted' };
    }
    return { strategy: 'failure', reason: 'Missing Razorpay key/order or trusted checkout url' };
  }

  return { strategy: 'unsupported_gateway', reason: `Unsupported payment gateway: '${data.gateway || 'unknown'}'` };
}

// Module-scoped memoized script loader promises
let cashfreeScriptPromise: Promise<boolean> | null = null;
let razorpayScriptPromise: Promise<boolean> | null = null;

export function resetScriptLoadersForTesting(): void {
  cashfreeScriptPromise = null;
  razorpayScriptPromise = null;
}

/**
 * Loads the official Cashfree Web SDK v3 script dynamically.
 * Concurrency-safe with module-level promise memoization, bounded timeout, and DOM cleanup.
 */
export function loadCashfreeScript(timeoutMs: number = 5000): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if (typeof (window as any).Cashfree === 'function') return Promise.resolve(true);
  if (cashfreeScriptPromise) return cashfreeScriptPromise;

  cashfreeScriptPromise = new Promise<boolean>((resolve) => {
    try {
      const existingScript = document.querySelector('script[src*="cashfree.com"]');
      if (existingScript) {
        if (typeof (existingScript as any).remove === 'function') {
          (existingScript as any).remove();
        } else if (existingScript.parentNode) {
          existingScript.parentNode.removeChild(existingScript);
        }
      }
    } catch {}

    let settled = false;
    let timer: any = null;

    const cleanup = (el?: HTMLElement) => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (el) {
        try {
          if (typeof el.remove === 'function') el.remove();
          else if (el.parentNode) el.parentNode.removeChild(el);
        } catch {}
      }
    };

    const script = document.createElement('script');
    script.src = 'https://sdk.cashfree.com/js/v3/cashfree.js';

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup(script);
      cashfreeScriptPromise = null; // Reset so retry can attempt reload
      resolve(false);
    }, timeoutMs);

    script.onload = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      cashfreeScriptPromise = null;
      const ok = typeof (window as any).Cashfree === 'function';
      resolve(ok);
    };

    script.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup(script);
      cashfreeScriptPromise = null;
      resolve(false);
    };

    try {
      (document.body || document.head || document.documentElement).appendChild(script);
    } catch {
      if (!settled) {
        settled = true;
        cleanup();
        cashfreeScriptPromise = null;
        resolve(false);
      }
    }
  });

  return cashfreeScriptPromise;
}

/**
 * Loads the official Razorpay Checkout v1 script dynamically.
 * Concurrency-safe with module-level promise memoization, bounded timeout, and DOM cleanup.
 */
export function loadRazorpayScript(timeoutMs: number = 5000): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if (typeof (window as any).Razorpay === 'function') return Promise.resolve(true);
  if (razorpayScriptPromise) return razorpayScriptPromise;

  razorpayScriptPromise = new Promise<boolean>((resolve) => {
    try {
      const existingScript = document.querySelector('script[src*="razorpay.com"]');
      if (existingScript) {
        if (typeof (existingScript as any).remove === 'function') {
          (existingScript as any).remove();
        } else if (existingScript.parentNode) {
          existingScript.parentNode.removeChild(existingScript);
        }
      }
    } catch {}

    let settled = false;
    let timer: any = null;

    const cleanup = (el?: HTMLElement) => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (el) {
        try {
          if (typeof el.remove === 'function') el.remove();
          else if (el.parentNode) el.parentNode.removeChild(el);
        } catch {}
      }
    };

    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup(script);
      razorpayScriptPromise = null;
      resolve(false);
    }, timeoutMs);

    script.onload = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      razorpayScriptPromise = null;
      const ok = typeof (window as any).Razorpay === 'function';
      resolve(ok);
    };

    script.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup(script);
      razorpayScriptPromise = null;
      resolve(false);
    };

    try {
      (document.body || document.head || document.documentElement).appendChild(script);
    } catch {
      if (!settled) {
        settled = true;
        cleanup();
        razorpayScriptPromise = null;
        resolve(false);
      }
    }
  });

  return razorpayScriptPromise;
}

interface PendingCheckoutSummary {
  id: string;
  planId: PlanTier;
  gateway: string;
  status: string;
  gatewaySubscriptionStatus?: string | null;
  authorizationStatus?: string | null;
  nextScheduleDate?: string | null;
  lastPaymentError?: string | null;
  hasAuthorizedMandate?: boolean;
  immediateAuthChargeExpected?: boolean;
  canCancelPending?: boolean;
}

function buildFriendlyPendingNotice(p: PendingCheckoutSummary): string {
  const planLabel = p.planId === 'pro' ? 'AIRA Pro' : 'AIRA Plus';
  const gwLabel = p.gateway === 'cashfree' ? 'Cashfree' : 'Razorpay';
  const scheduleStr = p.nextScheduleDate
    ? new Date(p.nextScheduleDate).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST'
    : null;

  if (p.lastPaymentError) {
    return `Your previous ${planLabel} checkout via ${gwLabel} did not complete (${p.lastPaymentError}). Verify payment status or cancel the pending checkout to try another plan or payment method.`;
  }
  if (p.hasAuthorizedMandate || (p.gateway === 'cashfree' && (p.gatewaySubscriptionStatus === 'ACTIVE' || p.authorizationStatus === 'ACTIVE'))) {
    if (p.immediateAuthChargeExpected) {
      return `Your ${planLabel} mandate authorization on ${gwLabel} was recorded; we are verifying full first-payment settlement before unlocking paid access. Click "Verify / Reconcile Status" to check settlement or cancel this mandate.`;
    }
    return `An e-mandate for ${planLabel} via ${gwLabel} is already authorized. ${scheduleStr ? `First subscription charge is scheduled for ${scheduleStr}; paid access activates upon settlement.` : 'Awaiting first recurring charge settlement.'} You can verify its status or cancel the authorized mandate before starting another plan.`;
  }
  return `You have an unfinished ${planLabel} checkout with ${gwLabel}. Verify payment status if you completed it, or cancel the pending checkout to switch plans or payment methods.`;
}

interface ActivatedConfirmationSummary {
  planId: PlanTier;
  planName: string;
  creditsAvailable?: number;
  nextRenewalDate?: string | null;
  invoiceNumber?: string | null;
  paymentRef?: string | null;
}

interface PricingModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentPlan?: PlanTier;
  onSelectPlan?: (planId: PlanTier, currency: CurrencyCode) => void;
  onSubscriptionActivated?: (planId: PlanTier) => void;
}

export const PricingModal: React.FC<PricingModalProps> = ({
  isOpen,
  onClose,
  currentPlan = 'free',
  onSelectPlan,
  onSubscriptionActivated
}) => {
  const [currency, setCurrency] = useState<CurrencyCode>('INR');
  const [gateway, setGateway] = useState<'razorpay' | 'cashfree'>('razorpay');
  const [checkoutState, setCheckoutState] = useState<CheckoutState>('IDLE');
  const [activePlanTier, setActivePlanTier] = useState<PlanTier | null>(null);

  // In-flight active financial operation state (strictly in-progress, non-settled operations)
  const isCheckoutBusy =
    checkoutState === 'REQUESTING' ||
    checkoutState === 'SESSION_READY' ||
    checkoutState === 'SDK_INITIALIZING' ||
    checkoutState === 'AUTHORIZATION_DISPATCHED' ||
    checkoutState === 'AWAITING_CONFIRMATION';

  // Unresolved reconciliation required state (blocks replacement orders until reconciled)
  const isLockedForReconciliation =
    checkoutState === 'AMBIGUOUS_OUTCOME' ||
    checkoutState === 'RECONCILIATION_REQUIRED';

  const loadingPlan = (isCheckoutBusy || isLockedForReconciliation)
    ? (activePlanTier || ('busy' as any))
    : null;

  const setLoadingPlan = (tier: PlanTier | null) => setActivePlanTier(tier);
  const [checkoutNotice, setCheckoutNotice] = useState<string | null>(null);
  const [activatedSummary, setActivatedSummary] = useState<ActivatedConfirmationSummary | null>(null);
  const [downloadingInvoiceNum, setDownloadingInvoiceNum] = useState<string | null>(null);
  const [downloadingPdfNum, setDownloadingPdfNum] = useState<string | null>(null);
  const userTouchedCurrencyRef = useRef<boolean>(false);
  const usdEnabledRef = useRef<boolean>(false);
  const [pendingCheckout, setPendingCheckout] = useState<PendingCheckoutSummary | null>(null);
  const [activeSubSummary, setActiveSubSummary] = useState<{
    planId: PlanTier;
    cancelAtPeriodEnd: boolean;
    cancellationPending: boolean;
    currentPeriodEnd: number | null;
  } | null>(null);
  const [checkoutAvailable, setCheckoutAvailable] = useState<boolean>(false);
  const [internationalUsdEnabled, setInternationalUsdEnabled] = useState<boolean>(false);
  const [_billingStatus, setBillingStatus] = useState<string>('checkout_disabled');
  const [customerPhone, setCustomerPhone] = useState<string>('');
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [countries, setCountries] = useState<Array<{ code: string; name: string; defaultCurrency: CurrencyCode }>>([
    { code: 'US', name: 'United States', defaultCurrency: 'USD' },
    { code: 'IN', name: 'India', defaultCurrency: 'INR' },
    { code: 'GB', name: 'United Kingdom', defaultCurrency: 'USD' },
    { code: 'CA', name: 'Canada', defaultCurrency: 'USD' },
    { code: 'AU', name: 'Australia', defaultCurrency: 'USD' },
    { code: 'DE', name: 'Germany', defaultCurrency: 'USD' },
    { code: 'SG', name: 'Singapore', defaultCurrency: 'USD' },
    { code: 'AE', name: 'United Arab Emirates', defaultCurrency: 'USD' }
  ]);
  const [billingCountry, setBillingCountry] = useState<string>('IN');
  const [billingAccountType, setBillingAccountType] = useState<'individual' | 'business'>('individual');
  const [billingTaxId, setBillingTaxId] = useState<string>('');
  const [gstJurisdictions, setGstJurisdictions] = useState<Array<{ code: string; name: string }>>([
    { code: '09', name: 'Uttar Pradesh' },
    { code: '07', name: 'Delhi' },
    { code: '27', name: 'Maharashtra' },
    { code: '29', name: 'Karnataka' },
    { code: '33', name: 'Tamil Nadu' },
    { code: '36', name: 'Telangana' },
    { code: '24', name: 'Gujarat' },
    { code: '19', name: 'West Bengal' }
  ]);
  const [billingStateCode, setBillingStateCode] = useState<string>('');
  const [billingStateError, setBillingStateError] = useState<string | null>(null);
  const [showB2bGstFields, setShowB2bGstFields] = useState<boolean>(false);
  const [billingLegalName, setBillingLegalName] = useState<string>('');
  const [billingGstin, setBillingGstin] = useState<string>('');
  const [billingGstinError, setBillingGstinError] = useState<string | null>(null);
  const [billingAddress, setBillingAddress] = useState<string>('');
  const [watchdogRecoveryUrl, setWatchdogRecoveryUrl] = useState<string | null>(null);

  // Synchronous submission lock to prevent rapid same-tick double-clicks
  const isSubmittingRef = useRef<boolean>(false);
  const isMountedRef = useRef<boolean>(true);
  const isDismissedRef = useRef<boolean>(false);
  const activePendingSubIdRef = useRef<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const watchdogTimerRef = useRef<any>(null);
  const pollingTimerRef = useRef<any>(null);

  const cleanupTimers = () => {
    if (watchdogTimerRef.current) {
      clearTimeout(watchdogTimerRef.current);
      watchdogTimerRef.current = null;
    }
    if (pollingTimerRef.current) {
      clearTimeout(pollingTimerRef.current);
      pollingTimerRef.current = null;
    }
  };

  const handleModalClose = useCallback(() => {
    cleanupTimers();
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    isSubmittingRef.current = false;
    isDismissedRef.current = true;
    setActivePlanTier(null);
    setWatchdogRecoveryUrl(null);

    // Modal dismissal must NOT erase unresolved financial operation identity.
    // Preserve AMBIGUOUS_OUTCOME, RECONCILIATION_REQUIRED, or AWAITING_CONFIRMATION.
    setCheckoutState((prev) => {
      if (prev === 'AWAITING_CONFIRMATION' || prev === 'AMBIGUOUS_OUTCOME' || prev === 'RECONCILIATION_REQUIRED') {
        try {
          if (typeof sessionStorage !== 'undefined') {
            sessionStorage.setItem('aira_unresolved_checkout', JSON.stringify({
              status: prev,
              notice: checkoutNotice,
              timestamp: Date.now()
            }));
          }
        } catch {}
        return prev;
      }
      return 'DISMISSED';
    });
    onClose();
  }, [onClose, checkoutNotice]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      cleanupTimers();
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, []);

  // Modal open / reopen reconciliation
  useEffect(() => {
    if (!isOpen) return;
    isDismissedRef.current = false;

    // Check if browser refresh or prior session left an unresolved checkout in progress
    try {
      if (typeof sessionStorage !== 'undefined') {
        const stored = sessionStorage.getItem('aira_unresolved_checkout');
        if (stored) {
          const parsed = JSON.parse(stored);
          if (parsed && parsed.status && (Date.now() - (Number(parsed.timestamp) || 0) < 15 * 60 * 1000)) {
            setCheckoutState(parsed.status);
            if (parsed.notice) setCheckoutNotice(parsed.notice);
            return;
          } else {
            sessionStorage.removeItem('aira_unresolved_checkout');
          }
        }
      }
    } catch {}

    // When modal opens, allow safe recovery if previous state was definitive failure or dismissal.
    // If state is an unresolved operation, do NOT reset to IDLE.
    setCheckoutState((prev) => {
      if (prev === 'DISMISSED' || prev === 'DEFINITIVE_FAILURE') {
        return 'IDLE';
      }
      return prev;
    });
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        handleModalClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [isOpen, handleModalClose]);

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    fetch('/api/billing/plans')
      .then(r => r.json())
      .then(data => {
        if (!active) return;
        if (typeof data.checkoutAvailable === 'boolean') {
          setCheckoutAvailable(data.checkoutAvailable);
        }
        if (typeof data.internationalUsdEnabled === 'boolean') {
          usdEnabledRef.current = data.internationalUsdEnabled;
          setInternationalUsdEnabled(data.internationalUsdEnabled);
          if (!data.internationalUsdEnabled) {
            setCurrency('INR');
          } else if (!userTouchedCurrencyRef.current && billingCountry && billingCountry !== 'IN') {
            setCurrency('USD');
          }
        }
        if (Array.isArray(data.countries) && data.countries.length > 0) {
          setCountries(data.countries);
        }
        if (Array.isArray(data.gstJurisdictions) && data.gstJurisdictions.length > 0) {
          setGstJurisdictions(data.gstJurisdictions);
        }
        if (data.billingStatus) {
          setBillingStatus(data.billingStatus);
        }
      })
      .catch(() => {
        if (!active) return;
        setCheckoutAvailable(false);
        setInternationalUsdEnabled(false);
        setCurrency('INR');
      });

    authenticatedApiFetch('/api/billing/summary')
      .then(r => (r.ok ? r.json() : null))
      .then(summary => {
        if (!active) return;
        if (summary?.activeSubscription) {
          setActiveSubSummary({
            planId: summary.activeSubscription.planId,
            cancelAtPeriodEnd: Boolean(summary.activeSubscription.cancelAtPeriodEnd),
            cancellationPending: Boolean(summary.activeSubscription.cancellationPending),
            currentPeriodEnd: summary.activeSubscription.currentPeriodEnd ? Number(summary.activeSubscription.currentPeriodEnd) : null
          });
        } else {
          setActiveSubSummary(null);
        }
        if (summary?.pendingSubscription) {
          const p = summary.pendingSubscription as PendingCheckoutSummary;
          activePendingSubIdRef.current = p.id;
          setPendingCheckout(p);
          setCheckoutNotice(prev => prev || buildFriendlyPendingNotice(p));
        } else {
          activePendingSubIdRef.current = null;
          setPendingCheckout(null);
        }
        const bp = summary?.billingProfile || summary?.taxProfile;
        if (bp) {
          const resolvedCountry = String(bp.country || 'IN').toUpperCase();
          setBillingCountry(resolvedCountry);
          if (!userTouchedCurrencyRef.current) {
            if (resolvedCountry === 'IN') {
              setCurrency('INR');
            } else if (usdEnabledRef.current) {
              setCurrency('USD');
            }
          }
          setBillingAccountType(bp.accountType === 'business' || bp.customerGstin ? 'business' : 'individual');
          if (bp.stateCode) setBillingStateCode(String(bp.stateCode));
          if (bp.legalName) setBillingLegalName(String(bp.legalName));
          if (bp.taxId) setBillingTaxId(String(bp.taxId));
          if (bp.customerGstin) {
            setBillingGstin(String(bp.customerGstin));
            setShowB2bGstFields(true);
          } else if (bp.accountType === 'business') {
            setShowB2bGstFields(true);
          }
          if (bp.addressLine1) setBillingAddress(String(bp.addressLine1));
        } else {
          setBillingCountry('IN');
          setBillingAccountType('individual');
          setBillingTaxId('');
          setBillingStateCode('');
          setBillingLegalName('');
          setBillingGstin('');
          setBillingAddress('');
          setShowB2bGstFields(false);
        }
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, [isOpen]);

  const clearPendingState = () => {
    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.removeItem('aira_unresolved_checkout');
      }
    } catch {}
    activePendingSubIdRef.current = null;
    setPendingCheckout(null);
    setActivePlanTier(null);
    setCheckoutState('IDLE');
    isSubmittingRef.current = false;
  };

  const handleReconcilePendingCheckout = async (pendingSubId: string) => {
    setCheckoutState('REQUESTING');
    setCheckoutNotice('Verifying checkout status with the payment gateway…');
    try {
      const res = await authenticatedApiFetch(`/api/billing/subscriptions/${encodeURIComponent(pendingSubId)}/reconcile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await res.json().catch(() => ({} as Record<string, any>));
      if (!isMountedRef.current) return;
      if (res.ok && data?.reconciled) {
        clearPendingState();
        if (data.status === 'active') {
          try {
            const [entRes, sumRes, invRes] = await Promise.all([
              authenticatedApiFetch('/api/billing/entitlements').catch(() => null),
              authenticatedApiFetch('/api/billing/summary').catch(() => null),
              authenticatedApiFetch('/api/billing/invoices').catch(() => null)
            ]);
            const ent = entRes && entRes.ok ? await entRes.json().catch(() => null) : null;
            const sum = sumRes && sumRes.ok ? await sumRes.json().catch(() => null) : null;
            const inv = invRes && invRes.ok ? await invRes.json().catch(() => null) : null;
            const confirmedPlan: PlanTier =
              ent?.plan === 'pro' || ent?.plan === 'plus'
                ? ent.plan
                : (data.planId === 'pro' ? 'pro' : 'plus');
            const latestInv = Array.isArray(inv?.invoices) ? inv.invoices[0] : null;
            const renewalEpoch = sum?.activeSubscription?.currentPeriodEnd;
            setActivatedSummary({
              planId: confirmedPlan,
              planName: confirmedPlan === 'pro' ? 'AIRA Pro' : 'AIRA Plus',
              creditsAvailable: typeof ent?.availableCredits === 'number' ? ent.availableCredits : undefined,
              nextRenewalDate: renewalEpoch
                ? new Date(Number(renewalEpoch)).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium' })
                : null,
              invoiceNumber: data.invoiceNumber || latestInv?.invoiceNumber || null
            });
            onSubscriptionActivated?.(confirmedPlan);
          } catch {}
          setCheckoutState('COMPLETED');
        }
        setCheckoutNotice(data.message || 'Checkout status verified.');
      } else {
        setCheckoutState('RECONCILIATION_REQUIRED');
        isSubmittingRef.current = false;
        setActivePlanTier(null);
        if (pendingCheckout) {
          setPendingCheckout({
            ...pendingCheckout,
            gatewaySubscriptionStatus: data?.providerStatus || pendingCheckout.gatewaySubscriptionStatus,
            hasAuthorizedMandate: typeof data?.hasAuthorizedMandate === 'boolean' ? data.hasAuthorizedMandate : pendingCheckout.hasAuthorizedMandate,
            canCancelPending: typeof data?.canCancelPending === 'boolean' ? data.canCancelPending : true
          });
        }
        setCheckoutNotice(data?.message || data?.error || 'Payment has not completed on the gateway yet. Complete checkout or cancel it to switch plans.');
      }
    } catch (err: any) {
      if (!isMountedRef.current) return;
      setCheckoutState('IDLE');
      isSubmittingRef.current = false;
      setActivePlanTier(null);
      setCheckoutNotice(err?.message || 'Unable to reach billing server for status verification.');
    }
  };

  const handleCancelPendingCheckout = async (
    subscriptionId: string,
    options?: { reason?: string; allowCancelAuthorizedMandate?: boolean; quiet?: boolean }
  ) => {
    if (!options?.quiet) {
      setCheckoutState('REQUESTING');
      setCheckoutNotice('Cancelling unfinished checkout with the payment gateway…');
    }
    try {
      const res = await authenticatedApiFetch(`/api/billing/subscriptions/${encodeURIComponent(subscriptionId)}/cancel-pending`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: options?.reason || 'customer_cancelled_pending',
          allowCancelAuthorizedMandate: Boolean(options?.allowCancelAuthorizedMandate)
        })
      });
      const data = await res.json().catch(() => ({} as Record<string, any>));
      if (!isMountedRef.current) return;
      if (res.ok && data?.cancelled) {
        clearPendingState();
        setCheckoutNotice(
          options?.quiet
            ? 'Previous checkout was cancelled. You can choose any plan or payment method.'
            : (data.message || 'Previous unpaid checkout was cancelled cleanly. You can now select any plan or payment method.')
        );
      } else {
        isSubmittingRef.current = false;
        setActivePlanTier(null);
        if (data?.paymentSucceeded || data?.alreadyPaid) {
          clearPendingState();
          setCheckoutNotice(data.message || 'Your payment succeeded with the gateway! Refreshing your plan status.');
        } else if (data?.hasAuthorizedMandate) {
          setCheckoutState('RECONCILIATION_REQUIRED');
          setPendingCheckout(prev => prev ? { ...prev, hasAuthorizedMandate: true, canCancelPending: true } : prev);
          setCheckoutNotice(data.message || 'An e-mandate authorization is active. Verify status or explicitly cancel the authorized mandate before switching plans.');
        } else {
          setCheckoutState('RECONCILIATION_REQUIRED');
          setCheckoutNotice(data?.message || data?.error || 'Unable to confirm cancellation with the gateway right now. Please retry verification shortly.');
        }
      }
    } catch (err: any) {
      if (!isMountedRef.current) return;
      isSubmittingRef.current = false;
      setActivePlanTier(null);
      setCheckoutState('RECONCILIATION_REQUIRED');
      setCheckoutNotice(err?.message || 'Unable to reach billing server to cancel the pending checkout.');
    }
  };

  if (!isOpen) return null;

  const handleSubscribe = async (tier: PlanTier) => {
    // 1. Synchronous submission lock check (blocks rapid double-clicks, cross-tier clicks, and unresolved states)
    if (isSubmittingRef.current || isCheckoutBusy || isLockedForReconciliation || tier === 'free' || tier === currentPlan) {
      return;
    }
    isSubmittingRef.current = true;
    setCheckoutState('REQUESTING');
    setActivePlanTier(tier);
    setCheckoutNotice(null);
    setPhoneError(null);
    setWatchdogRecoveryUrl(null);
    cleanupTimers();

    const targetGateway = currency === 'USD' ? 'razorpay' : gateway;
    setBillingStateError(null);
    setBillingGstinError(null);

    if (currency === 'INR' && !onSelectPlan) {
      if (!billingStateCode) {
        const msg = 'Please select your Billing State / Union Territory for Indian GST Place of Supply determination.';
        setBillingStateError(msg);
        setCheckoutNotice(msg);
        isSubmittingRef.current = false;
        setCheckoutState('IDLE');
        setActivePlanTier(null);
        return;
      }
      if (showB2bGstFields) {
        const trimmedGstin = billingGstin.trim().toUpperCase();
        if (trimmedGstin) {
          if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(trimmedGstin) || trimmedGstin.startsWith('25')) {
            const msg = 'Enter a valid 15-character Indian GSTIN (or clear the field for B2C billing).';
            setBillingGstinError(msg);
            setCheckoutNotice(msg);
            isSubmittingRef.current = false;
            setCheckoutState('IDLE');
            setActivePlanTier(null);
            return;
          }
          if (billingStateCode && trimmedGstin.slice(0, 2) !== billingStateCode) {
            const msg = `GSTIN state prefix (${trimmedGstin.slice(0, 2)}) must match selected Billing State (${billingStateCode}).`;
            setBillingGstinError(msg);
            setCheckoutNotice(msg);
            isSubmittingRef.current = false;
            setCheckoutState('IDLE');
            setActivePlanTier(null);
            return;
          }
        }
      }
    }

    // 2. Client-side phone number validation for Cashfree e-mandate
    if (targetGateway === 'cashfree') {
      const cleaned = customerPhone.trim().replace(/[\s\-().]/g, '');
      let digits = cleaned;
      if (digits.startsWith('+91')) digits = digits.slice(3);
      else if (digits.startsWith('91') && digits.length === 12) digits = digits.slice(2);
      else if (digits.startsWith('0') && digits.length === 11) digits = digits.slice(1);

      if (!/^[6-9]\d{9}$/.test(digits)) {
        const errorMsg = 'Please enter a valid 10-digit Indian mobile number starting with 6-9 for Cashfree recurring subscription mandate.';
        setPhoneError(errorMsg);
        setCheckoutNotice(errorMsg);
        isSubmittingRef.current = false;
        setCheckoutState('IDLE');
        setActivePlanTier(null);
        return;
      }
    }

    // 3. Initiate checkout via API with client-generated idempotency key
    const clientOpId = `chk_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      if (onSelectPlan) {
        onSelectPlan(tier, currency);
        isSubmittingRef.current = false;
        setCheckoutState('IDLE');
        setActivePlanTier(null);
        return;
      }

      let res: Response;
      try {
        res = await authenticatedApiFetch('/api/billing/checkout/subscription', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-idempotency-key': clientOpId
          },
          signal: controller.signal,
          body: JSON.stringify({
            planId: tier,
            currency,
            gateway: targetGateway,
            customerPhone: currency === 'INR' ? (customerPhone.trim() || undefined) : undefined,
            billingProfile: currency === 'INR'
              ? {
                  country: 'IN',
                  accountType: showB2bGstFields ? 'business' : billingAccountType,
                  ...(billingStateCode ? { stateCode: billingStateCode } : {}),
                  ...(showB2bGstFields
                    ? {
                        legalName: billingLegalName.trim() || undefined,
                        customerGstin: billingGstin.trim().toUpperCase() || undefined,
                        addressLine1: billingAddress.trim() || undefined
                      }
                    : {})
                }
              : {
                  country: billingCountry === 'IN' ? 'US' : billingCountry,
                  accountType: showB2bGstFields ? 'business' : billingAccountType,
                  ...(billingStateCode.trim() ? { stateCode: billingStateCode.trim() } : {}),
                  ...(showB2bGstFields
                    ? {
                        legalName: billingLegalName.trim() || undefined,
                        taxId: billingTaxId.trim() || undefined,
                        addressLine1: billingAddress.trim() || undefined
                      }
                    : {})
                },
            idempotencyKey: clientOpId
          })
        });
      } catch (fetchErr: any) {
        if (fetchErr?.name === 'AbortError' || !isMountedRef.current) {
          isSubmittingRef.current = false;
          return;
        }
        setCheckoutNotice(fetchErr?.message || 'Network request failed. Please check your connection.');
        setCheckoutState('AMBIGUOUS_OUTCOME');
        isSubmittingRef.current = false;
        return;
      }

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        isSubmittingRef.current = false;
        setCheckoutState('DEFINITIVE_FAILURE');
        setLoadingPlan(null);
        setActivePlanTier(null);

        if (res.status === 400 && data.error === 'VALIDATION_ERROR') {
          const msg = data.message || 'Validation error: please check your submission details.';
          if (msg.toLowerCase().includes('gstin')) {
            setBillingGstinError(msg);
          } else if (msg.toLowerCase().includes('state') || msg.toLowerCase().includes('place of supply')) {
            setBillingStateError(msg);
          } else {
            setPhoneError(msg);
          }
          setCheckoutNotice(msg);
        } else if (res.status === 401) {
          setCheckoutNotice('Authentication required. Please sign in to upgrade.');
        } else if (res.status === 403) {
          setCheckoutNotice(data.message || 'Access restricted: only authorized test principals can initiate sandbox checkout.');
        } else if (res.status === 409) {
          if (data.error === 'PAID_PERIOD_STILL_ACTIVE') {
            setCheckoutState('DEFINITIVE_FAILURE');
            setCheckoutNotice(data.message || 'Your current paid subscription period is still active.');
          } else {
            setCheckoutState('RECONCILIATION_REQUIRED');
            if (data.pendingSubscription) {
              activePendingSubIdRef.current = data.pendingSubscription.id;
              setPendingCheckout(data.pendingSubscription);
            }
            setCheckoutNotice(
              data.customerMessage ||
              (data.pendingSubscription ? buildFriendlyPendingNotice(data.pendingSubscription) : null) ||
              'Another checkout session is already in progress for your account. Verify its status or cancel it before starting a new checkout.'
            );
          }
        } else if (res.status === 504 || data.error === 'GATEWAY_AMBIGUOUS_OUTCOME') {
          setCheckoutState('AMBIGUOUS_OUTCOME');
          setCheckoutNotice(data.message || 'Payment gateway timed out. Authoritative reconciliation is pending. Please do not reattempt.');
          try {
            if (typeof sessionStorage !== 'undefined') {
              sessionStorage.setItem('aira_unresolved_checkout', JSON.stringify({
                status: 'AMBIGUOUS_OUTCOME',
                notice: data.message || 'Payment gateway timed out. Authoritative reconciliation is pending.',
                timestamp: Date.now()
              }));
            }
          } catch {}
        } else if (res.status === 503) {
          setCheckoutNotice(data.message || 'Online checkout is currently offline.');
        } else {
          setCheckoutNotice(data.message || data.error || `Checkout failed (HTTP ${res.status}).`);
        }
        return;
      }

      // Check for component unmount
      if (!isMountedRef.current) {
        isSubmittingRef.current = false;
        return;
      }

      if (data.purchaseId) {
        activePendingSubIdRef.current = data.purchaseId;
        setPendingCheckout({
          id: data.purchaseId,
          planId: tier,
          gateway: data.gateway || targetGateway,
          status: 'pending',
          hasAuthorizedMandate: false,
          canCancelPending: true
        });
      }
      setCheckoutState('SESSION_READY');

      // 4. Cashfree Recurring Mandate Checkout Flow
      if (data.gateway === 'cashfree') {
        const sessionId = data.subsSessionId || data.subscriptionSessionId || data.paymentSessionId;
        const checkoutUrl = data.checkoutUrl;
        let sdkDispatched = false;

        // Strategy A: Cashfree Web SDK v3 invocation
        if (sessionId) {
          setCheckoutState('SDK_INITIALIZING');
          setCheckoutNotice('Initializing Cashfree secure mandate authorization...');

          let loaded = false;
          try {
            loaded = await loadCashfreeScript(5000);
          } catch {
            loaded = false;
          }

          if (!isMountedRef.current || isDismissedRef.current) {
            isSubmittingRef.current = false;
            return;
          }

          if (loaded && typeof (window as any).Cashfree === 'function') {
            const cashfree = (window as any).Cashfree({
              mode: data.isSandbox ? 'sandbox' : 'production'
            });

            if (typeof cashfree.subscriptionsCheckout === 'function') {
              sdkDispatched = true;
              setCheckoutState('AUTHORIZATION_DISPATCHED');

              // Watchdog timer: If SDK execution stalls without navigation within 10s
              watchdogTimerRef.current = setTimeout(() => {
                if (!isMountedRef.current || isDismissedRef.current) return;
                setCheckoutState('AMBIGUOUS_OUTCOME');
                isSubmittingRef.current = false;
                try {
                  if (typeof sessionStorage !== 'undefined') {
                    sessionStorage.setItem('aira_unresolved_checkout', JSON.stringify({
                      status: 'AMBIGUOUS_OUTCOME',
                      notice: 'Mandate authorization window did not open. You can open the hosted authorization page or cancel.',
                      timestamp: Date.now()
                    }));
                  }
                } catch {}
                if (checkoutUrl && isTrustedCashfreeUrl(checkoutUrl, data.isSandbox)) {
                  setWatchdogRecoveryUrl(checkoutUrl);
                  setCheckoutNotice('Mandate authorization window did not open. You can open the hosted authorization page or cancel.');
                } else {
                  setCheckoutNotice('Cashfree mandate authorization timed out. Please check your banking app or refresh to verify status.');
                }
              }, 10000);

              try {
                const result = await cashfree.subscriptionsCheckout({
                  subsSessionId: sessionId,
                  redirectTarget: '_self'
                });

                if (isDismissedRef.current) {
                  cleanupTimers();
                  return;
                }

                if (result && result.error) {
                  cleanupTimers();
                  throw new Error(result.error.message || 'Cashfree subscriptions checkout failed');
                }
                // When redirectTarget is _self, browser window will unload to Cashfree.
                return;
              } catch (sdkErr: any) {
                cleanupTimers();
                if (isDismissedRef.current) return;
                console.warn('[PricingModal] Cashfree Web SDK checkout error:', sdkErr?.message);
                // If watchdog already displayed actionable recovery link, preserve recovery container
                if (watchdogRecoveryUrl) {
                  return;
                }
                setCheckoutState('DEFINITIVE_FAILURE');
                isSubmittingRef.current = false;
                setActivePlanTier(null);
                setCheckoutNotice(sdkErr?.message || 'Cashfree subscriptions checkout failed. Please try again.');
                return;
              }
            }
          }
        }

        // Strategy B: Hosted mandate authorization link fallback (strictly ONLY if SDK was NOT dispatched)
        if (!sdkDispatched && checkoutUrl && isTrustedCashfreeUrl(checkoutUrl, data.isSandbox)) {
          if (isDismissedRef.current) return;
          cleanupTimers();
          setCheckoutState('AUTHORIZATION_DISPATCHED');
          setCheckoutNotice('Launching Cashfree Checkout...');
          window.location.assign(checkoutUrl);
          return;
        }

        // Fail-closed if SDK was not dispatched and no valid hosted URL
        if (!sdkDispatched) {
          cleanupTimers();
          isSubmittingRef.current = false;
          setCheckoutState('DEFINITIVE_FAILURE');
          setActivePlanTier(null);
          setCheckoutNotice('Unable to launch Cashfree mandate authorization. Please try again or contact support.');
          return;
        }
        return;
      }

      // 5. Razorpay Recurring Mandate Checkout Flow (SDK Precedence over Hosted Redirect)
      if (data.gateway === 'razorpay') {
        let sdkDispatched = false;

        // Strategy A: In-page Razorpay Checkout SDK Modal (evaluated first when keyId & orderId present)
        if (data.keyId && data.orderId) {
          setCheckoutState('SDK_INITIALIZING');
          setCheckoutNotice('Opening Razorpay Checkout...');

          let loaded = false;
          try {
            loaded = await loadRazorpayScript(5000);
          } catch {
            loaded = false;
          }

          if (!isMountedRef.current || isDismissedRef.current) {
            isSubmittingRef.current = false;
            return;
          }

          if (loaded && (window as any).Razorpay) {
            const isSub = typeof data.orderId === 'string' && data.orderId.startsWith('sub_');

            try {
              const rzp = new (window as any).Razorpay({
                key: data.keyId,
                subscription_id: isSub ? data.orderId : undefined,
                order_id: !isSub ? data.orderId : undefined,
                name: 'AIRA AI',
                description: `AIRA ${tier.toUpperCase()} Monthly Subscription`,
                amount: data.amount,
                currency: data.currency,
                  handler: function (response: any) {
                    const paymentRef = response.razorpay_payment_id || response.razorpay_subscription_id || data.orderId;
                    setCheckoutState('AWAITING_CONFIRMATION');
                    setCheckoutNotice(`Payment authorized (Ref: ${paymentRef}). Confirming subscription with secure ledger...`);

                    // Bounded exponential polling + active reconcile trigger for immediate Cycle 1 activation
                    let attempts = 0;
                    const pollIntervals = [750, 2000, 3500, 5500, 8000];

                    const pollEntitlements = async () => {
                      if (!isMountedRef.current) return;
                      attempts++;
                      try {
                        if (data.purchaseId) {
                          await authenticatedApiFetch(`/api/billing/subscriptions/${encodeURIComponent(data.purchaseId)}/reconcile`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({})
                          }).catch(() => null);
                        }
                        const [verifyRes, summaryRes, invoicesRes] = await Promise.all([
                          authenticatedApiFetch('/api/billing/entitlements'),
                          authenticatedApiFetch('/api/billing/summary').catch(() => null),
                          authenticatedApiFetch('/api/billing/invoices').catch(() => null)
                        ]);
                        if (verifyRes.ok) {
                          const ent = await verifyRes.json();
                          if (ent.plan === tier) {
                            const summaryData = summaryRes && summaryRes.ok ? await summaryRes.json().catch(() => null) : null;
                            const invoicesData = invoicesRes && invoicesRes.ok ? await invoicesRes.json().catch(() => null) : null;
                            const latestInv = Array.isArray(invoicesData?.invoices) ? invoicesData.invoices[0] : null;
                            const renewalEpoch = summaryData?.activeSubscription?.currentPeriodEnd;
                            const formattedRenewal = renewalEpoch
                              ? new Date(Number(renewalEpoch)).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium' })
                              : null;

                            try {
                              if (typeof sessionStorage !== 'undefined') {
                                sessionStorage.removeItem('aira_unresolved_checkout');
                              }
                            } catch {}

                            setPendingCheckout(null);
                            activePendingSubIdRef.current = null;
                            isSubmittingRef.current = false;
                            setActivePlanTier(null);
                            setActivatedSummary({
                              planId: tier,
                              planName: tier === 'pro' ? 'AIRA Pro' : 'AIRA Plus',
                              creditsAvailable: typeof ent.availableCredits === 'number' ? ent.availableCredits : undefined,
                              nextRenewalDate: formattedRenewal,
                              invoiceNumber: latestInv?.invoiceNumber || null,
                              paymentRef
                            });
                            setCheckoutState('COMPLETED');
                            setCheckoutNotice(`Subscription active: Welcome to ${tier === 'pro' ? 'AIRA Pro' : 'AIRA Plus'}! Paid features and monthly credits are now unlocked.`);
                            onSubscriptionActivated?.(tier);
                            return;
                          }
                        }
                      } catch {}

                      if (attempts < pollIntervals.length) {
                        pollingTimerRef.current = setTimeout(pollEntitlements, pollIntervals[attempts]);
                      } else {
                        // Exhausted polling window without throwing error; explain reconciliation status
                        setCheckoutState('RECONCILIATION_REQUIRED');
                        isSubmittingRef.current = false;
                        setCheckoutNotice('Payment received. Your subscription is activating in the background. Click "Verify / Reconcile Status" in a moment.');
                        try {
                          if (typeof sessionStorage !== 'undefined') {
                            sessionStorage.setItem('aira_unresolved_checkout', JSON.stringify({
                              status: 'RECONCILIATION_REQUIRED',
                              notice: 'Payment received. Your subscription is activating in the background. Please refresh in a moment.',
                              timestamp: Date.now()
                            }));
                          }
                        } catch {}
                      }
                    };

                    pollingTimerRef.current = setTimeout(pollEntitlements, pollIntervals[0]);
                  },
                modal: {
                  ondismiss: function () {
                    if (!isMountedRef.current) return;
                    let dismissedDuringAuth = false;
                    setCheckoutState((prev) => {
                      if (prev === 'AWAITING_CONFIRMATION' || prev === 'COMPLETED' || prev === 'AMBIGUOUS_OUTCOME' || prev === 'RECONCILIATION_REQUIRED') {
                        return prev;
                      }
                      dismissedDuringAuth = true;
                      isSubmittingRef.current = false;
                      setActivePlanTier(null);
                      return 'IDLE'; // Definitive safe recovery on user modal dismissal
                    });
                    if (dismissedDuringAuth && data.purchaseId) {
                      void handleCancelPendingCheckout(data.purchaseId, {
                        reason: 'modal_dismissed',
                        allowCancelAuthorizedMandate: false,
                        quiet: true
                      });
                    }
                  }
                }
              });

              if (typeof rzp.on === 'function') {
                rzp.on('payment.failed', function (failedResp: any) {
                  if (!isMountedRef.current) return;
                  isSubmittingRef.current = false;
                  setCheckoutState('DEFINITIVE_FAILURE');
                  setActivePlanTier(null);
                  setCheckoutNotice(`Payment failed: ${failedResp?.error?.description || 'Mandate authorization was declined.'}`);
                });
              }

              sdkDispatched = true;
              setCheckoutState('AUTHORIZATION_DISPATCHED');
              rzp.open();
              return;
            } catch (sdkOpenErr: any) {
              console.warn('[PricingModal] Razorpay SDK open error:', sdkOpenErr?.message);
              // Do not fallback to redirect if SDK failed after dispatch
            }
          }
        }

        // Strategy B: Hosted mandate authorization link fallback (strictly ONLY if SDK was NOT dispatched)
        if (!sdkDispatched && data.checkoutUrl) {
          if (!isTrustedRazorpayUrl(data.checkoutUrl)) {
            isSubmittingRef.current = false;
            setCheckoutState('DEFINITIVE_FAILURE');
            setActivePlanTier(null);
            setCheckoutNotice('Invalid or untrusted payment provider URL.');
            return;
          }
          if (isDismissedRef.current) return;
          setCheckoutState('AUTHORIZATION_DISPATCHED');
          setCheckoutNotice('Launching Razorpay Checkout...');
          window.location.assign(data.checkoutUrl);
          return;
        }

        // Fail-closed if neither SDK dispatched nor valid hosted URL
        isSubmittingRef.current = false;
        setCheckoutState('DEFINITIVE_FAILURE');
        setActivePlanTier(null);
        setCheckoutNotice('Unable to initialize Razorpay checkout. Please try again or contact support.');
        return;
      }

      // 6. Unknown / Unsupported Gateway Rejection (Fail Closed)
      isSubmittingRef.current = false;
      setCheckoutState('DEFINITIVE_FAILURE');
      setActivePlanTier(null);
      setCheckoutNotice(`Unsupported payment gateway: '${data.gateway || 'unknown'}'. Please contact support.`);
      return;
    } catch (err: any) {
      cleanupTimers();
      isSubmittingRef.current = false;
      setCheckoutState('DEFINITIVE_FAILURE');
      setActivePlanTier(null);
      setCheckoutNotice(err.message || 'Checkout failed');
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-md p-4 overflow-y-auto">
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="aira-pricing-title"
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="relative my-2 sm:my-8 max-h-[92dvh] w-full max-w-5xl overflow-y-auto rounded-3xl border border-claude-border-light dark:border-white/10 bg-claude-surface-light dark:bg-claude-surface-dark text-claude-text-light dark:text-white shadow-2xl"
      >
        {/* Header */}
        <div className="p-4 sm:p-6 md:p-8 border-b border-claude-border-light dark:border-white/10 flex flex-col md:flex-row md:items-center justify-between gap-3 sm:gap-4 bg-claude-surface2-light/50 dark:bg-transparent">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-claude-terracotta/10 border border-claude-terracotta/25 text-claude-accentInk dark:text-orange-400 text-xs font-semibold mb-1.5 sm:mb-2">
              <Shield className="w-3.5 h-3.5" />
              AIRA AI 2026 Commercial Plans
            </div>
            <h2 id="aira-pricing-title" className="text-xl sm:text-2xl font-bold font-serif text-claude-text-light dark:text-white">Choose Your Intelligence Tier</h2>
            <p className="text-claude-muted-light dark:text-stone-400 text-xs mt-1">Autonomous cognitive workflows, neural memory, and verifiable audit durability.</p>
          </div>

          <div className="flex items-center justify-between sm:justify-end gap-3">
            {/* Currency switcher */}
            <div className="flex items-center bg-claude-surface2-light dark:bg-stone-950/80 p-1 rounded-xl border border-claude-border-light dark:border-white/10">
              <button
                type="button"
                disabled={isCheckoutBusy}
                onClick={() => {
                  userTouchedCurrencyRef.current = true;
                  setCurrency('INR');
                  if (billingCountry !== 'IN') {
                    setBillingCountry('IN');
                    setBillingStateCode('');
                  }
                }}
                aria-pressed={currency === 'INR'}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors duration-150 ${currency === 'INR' ? 'bg-claude-terracotta text-white shadow-sm' : 'text-claude-muted-light dark:text-stone-400 hover:text-claude-text-light dark:hover:text-white'} ${isCheckoutBusy ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                ₹ INR (India)
              </button>
              {internationalUsdEnabled && (
                <button
                  type="button"
                  disabled={isCheckoutBusy}
                  onClick={() => {
                    userTouchedCurrencyRef.current = true;
                    setCurrency('USD');
                    if (billingCountry === 'IN') {
                      setBillingCountry('US');
                      setBillingStateCode('');
                    }
                  }}
                  aria-pressed={currency === 'USD'}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors duration-150 ${currency === 'USD' ? 'bg-claude-terracotta text-white shadow-sm' : 'text-claude-muted-light dark:text-stone-400 hover:text-claude-text-light dark:hover:text-white'} ${isCheckoutBusy ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  $ USD (Global)
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={handleModalClose}
              className="p-2 rounded-xl text-claude-muted-light dark:text-stone-400 hover:text-claude-text-light dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              aria-label="Close modal"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Activated Immediate Subscription Confirmation Banner */}
        {activatedSummary && checkoutState === 'COMPLETED' && (
          <div className="mx-6 md:mx-8 mt-4 p-4 rounded-xl bg-emerald-500/15 border border-emerald-500/40 text-emerald-100 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="space-y-1">
              <div className="font-bold text-sm text-white flex items-center gap-2">
                <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>{activatedSummary.planName} Activated Immediately</span>
              </div>
              <p className="text-emerald-200/90 leading-relaxed">
                {typeof activatedSummary.creditsAvailable === 'number'
                  ? `${activatedSummary.creditsAvailable.toLocaleString()} premium credits available now.`
                  : 'Monthly premium credits unlocked.'}
                {activatedSummary.nextRenewalDate ? ` Next auto-renewal: ${activatedSummary.nextRenewalDate} IST.` : ''}
                {activatedSummary.paymentRef ? ` Ref: ${activatedSummary.paymentRef}.` : ''}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {activatedSummary.invoiceNumber && (
                <>
                  <button
                    type="button"
                    disabled={downloadingPdfNum === activatedSummary.invoiceNumber}
                    onClick={async () => {
                      const invNum = activatedSummary.invoiceNumber!;
                      const safeFilename = `AIRA-Invoice-${invNum.replace(/[^a-zA-Z0-9_-]/g, '-')}.pdf`;
                      setDownloadingPdfNum(invNum);
                      try {
                        const res = await authenticatedApiFetch(`/api/billing/invoices/${encodeURIComponent(invNum)}/pdf`);
                        if (!res.ok) {
                          const errData = await res.json().catch(() => ({}));
                          alert(errData.error || 'Failed to download PDF invoice.');
                          return;
                        }
                        const blob = await res.blob();
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = safeFilename;
                        document.body.appendChild(a);
                        a.click();
                        a.remove();
                        URL.revokeObjectURL(url);
                      } catch (err: any) {
                        alert(err?.message || 'Unable to download PDF invoice.');
                      } finally {
                        setDownloadingPdfNum(null);
                      }
                    }}
                    className="px-3 py-1.5 rounded-lg bg-claude-terracotta hover:bg-claude-terracotta-hover text-white font-semibold text-[11px] whitespace-nowrap transition-colors disabled:opacity-50"
                  >
                    {downloadingPdfNum === activatedSummary.invoiceNumber ? 'Generating…' : 'Download PDF'}
                  </button>
                  <button
                    type="button"
                    disabled={downloadingInvoiceNum === activatedSummary.invoiceNumber}
                    onClick={async () => {
                      const invNum = activatedSummary.invoiceNumber!;
                      const safeFilename = `AIRA-GST-Invoice-${invNum.replace(/[^a-zA-Z0-9_-]/g, '-')}.html`;
                      setDownloadingInvoiceNum(invNum);
                      try {
                        const res = await authenticatedApiFetch(`/api/billing/invoices/${encodeURIComponent(invNum)}/download`);
                        if (!res.ok) {
                          const errData = await res.json().catch(() => ({}));
                          alert(errData.error || 'Failed to load A4 invoice.');
                          return;
                        }
                        const html = await res.text();
                        const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = safeFilename;
                        document.body.appendChild(a);
                        a.click();
                        a.remove();
                        URL.revokeObjectURL(url);
                      } catch (err: any) {
                        alert(err?.message || 'Unable to open A4 invoice.');
                      } finally {
                        setDownloadingInvoiceNum(null);
                      }
                    }}
                    className="px-3 py-1.5 rounded-lg bg-emerald-500/25 hover:bg-emerald-500/35 border border-emerald-400/40 text-white font-semibold text-[11px] whitespace-nowrap transition-colors disabled:opacity-50"
                  >
                    {downloadingInvoiceNum === activatedSummary.invoiceNumber
                      ? 'Opening…'
                      : `View / Print A4 Invoice (${activatedSummary.invoiceNumber})`}
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 rounded-lg bg-stone-800 hover:bg-stone-700 border border-white/15 text-white font-semibold text-[11px] whitespace-nowrap transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        )}

        {/* Status / Error & Pending Recovery Notice */}
        {(checkoutNotice || pendingCheckout) && !(activatedSummary && checkoutState === 'COMPLETED') && (() => {
          const targetPendingId = pendingCheckout?.id || activePendingSubIdRef.current || null;
          const hasMandate = Boolean(pendingCheckout?.hasAuthorizedMandate);
          return (
            <div data-testid="pricing-checkout-notice" className="mx-4 sm:mx-6 md:mx-8 mt-4 p-3.5 rounded-xl bg-orange-500/10 border border-orange-500/35 text-amber-950 dark:text-orange-200 text-xs flex flex-wrap items-center justify-between gap-3">
              <span className="flex-1 min-w-[220px] leading-relaxed">
                {checkoutNotice || (pendingCheckout ? buildFriendlyPendingNotice(pendingCheckout) : '')}
              </span>
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                {targetPendingId && !isCheckoutBusy && (
                  <>
                    <button
                      type="button"
                      onClick={() => void handleReconcilePendingCheckout(targetPendingId)}
                      className="px-2.5 py-1.5 rounded-lg bg-orange-500/20 hover:bg-orange-500/30 border border-orange-500/40 text-amber-950 dark:text-orange-100 font-semibold text-[11px] whitespace-nowrap transition-colors"
                    >
                      Verify / Reconcile Status
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleCancelPendingCheckout(targetPendingId, {
                        reason: hasMandate ? 'user_cancel_authorized_mandate' : 'user_cancel_pending',
                        allowCancelAuthorizedMandate: hasMandate
                      })}
                      className="px-2.5 py-1.5 rounded-lg bg-claude-surface2-light dark:bg-stone-800 hover:bg-stone-200 dark:hover:bg-stone-700 border border-claude-border-light dark:border-white/15 text-claude-text-light dark:text-stone-200 font-semibold text-[11px] whitespace-nowrap transition-colors"
                    >
                      {hasMandate ? 'Cancel Authorized Mandate' : 'Cancel Pending Checkout'}
                    </button>
                  </>
                )}
                {isCheckoutBusy && <span className="animate-pulse text-[11px] text-claude-accentInk dark:text-orange-400 font-semibold">Processing…</span>}
              </div>
            </div>
          );
        })()}

        {/* Watchdog Actionable Recovery Container */}
        {watchdogRecoveryUrl && (
          <div className="mx-4 sm:mx-6 md:mx-8 mt-4 p-4 rounded-xl bg-orange-500/10 border border-orange-500/40 flex flex-col sm:flex-row items-center justify-between gap-3 shadow-md">
            <div className="text-xs text-amber-950 dark:text-orange-200">
              Mandate authorization window did not open automatically. You can launch the official payment gateway page directly:
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <a
                href={watchdogRecoveryUrl}
                target="_self"
                className="px-3 py-1.5 rounded-lg text-xs font-bold bg-claude-terracotta text-white hover:bg-claude-terracotta-hover transition-colors shadow-sm"
              >
                Open Authorization Page
              </a>
              <button
                type="button"
                onClick={() => {
                  cleanupTimers();
                  setWatchdogRecoveryUrl(null);
                  const pendingId = activePendingSubIdRef.current || pendingCheckout?.id;
                  if (pendingId) {
                    void handleCancelPendingCheckout(pendingId, { reason: 'watchdog_dismissed', allowCancelAuthorizedMandate: false, quiet: true });
                  } else {
                    clearPendingState();
                    setCheckoutNotice(null);
                  }
                }}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-claude-surface2-light dark:bg-stone-800 text-claude-text-light dark:text-stone-300 hover:text-claude-text-light dark:hover:text-white border border-claude-border-light dark:border-white/10 transition-colors"
              >
                Cancel & Dismiss
              </button>
            </div>
          </div>
        )}

        {/* Global Country / Region Alignment */}
        <div className="px-4 sm:px-6 md:px-8 pt-3 sm:pt-4 pb-0 flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-3 text-xs">
          <div className="flex items-center gap-2">
            <label htmlFor="pricing-billing-country" className="text-claude-muted-light dark:text-stone-400 whitespace-nowrap">
              Country / Region:
            </label>
            <select
              id="pricing-billing-country"
              disabled={isCheckoutBusy}
              value={billingCountry}
              onChange={(e) => {
                userTouchedCurrencyRef.current = true;
                const nextCode = e.target.value.toUpperCase();
                if ((nextCode === 'IN') !== (billingCountry === 'IN')) {
                  setBillingStateCode('');
                }
                setBillingCountry(nextCode);
                if (nextCode === 'IN') {
                  setCurrency('INR');
                } else if (internationalUsdEnabled) {
                  setCurrency('USD');
                }
              }}
              className="bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-white/15 rounded-xl px-3 py-1.5 text-xs text-claude-text-light dark:text-white focus:outline-none focus:ring-1 focus:ring-claude-terracotta"
            >
              {countries.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name} ({c.defaultCurrency})
                </option>
              ))}
            </select>
          </div>
          <span className="text-[11px] text-claude-muted-light dark:text-stone-400">
            {currency === 'USD'
              ? 'Global Card Checkout (Visa / Mastercard / Amex) · Billed in USD'
              : 'India Domestic Billing (UPI / Card / NetBanking) · GST-inclusive pricing'}
          </span>
        </div>

        {/* Payment Method & Optional Tax Disclosure (Global USD) */}
        {currency === 'USD' && (
          <div className="px-4 sm:px-6 md:px-8 pt-3 space-y-2 text-xs">
            <div className="rounded-xl border border-claude-border-light dark:border-white/10 bg-claude-surface2-light/70 dark:bg-stone-950/60 p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="text-claude-text-light dark:text-stone-300">
                Pay securely in <strong className="text-claude-text-light dark:text-white">USD</strong> by international credit or debit card.
              </div>
              <button
                type="button"
                onClick={() => {
                  const next = !showB2bGstFields;
                  setShowB2bGstFields(next);
                  setBillingAccountType(next ? 'business' : 'individual');
                }}
                className="text-[11px] font-semibold text-claude-accentInk dark:text-orange-300 hover:underline text-left sm:text-right whitespace-nowrap"
              >
                {showB2bGstFields ? 'Hide business tax details' : 'Purchasing for a business? Add company & Tax ID (optional)'}
              </button>
            </div>
            {showB2bGstFields && (
              <div className="rounded-xl border border-claude-border-light dark:border-white/10 bg-claude-surface2-light/70 dark:bg-stone-950/60 p-3 grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <div>
                  <label htmlFor="global-b2b-name" className="block text-[11px] text-claude-muted-light dark:text-stone-400 mb-1">
                    Company / Legal Name
                  </label>
                  <input
                    id="global-b2b-name"
                    type="text"
                    disabled={isCheckoutBusy}
                    placeholder="Company LLC or Full Name"
                    value={billingLegalName}
                    onChange={(e) => setBillingLegalName(e.target.value)}
                    className="w-full bg-claude-surface-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-claude-text-light dark:text-white placeholder-stone-400 dark:placeholder-stone-500 focus:outline-none focus:ring-1 focus:ring-claude-terracotta"
                  />
                </div>
                <div>
                  <label htmlFor="global-b2b-taxid" className="block text-[11px] text-claude-muted-light dark:text-stone-400 mb-1">
                    Business Tax / VAT / EIN (Optional)
                  </label>
                  <input
                    id="global-b2b-taxid"
                    type="text"
                    maxLength={64}
                    disabled={isCheckoutBusy}
                    placeholder="e.g. EU123456789 or EIN-88-9911223"
                    value={billingTaxId}
                    onChange={(e) => setBillingTaxId(e.target.value)}
                    className="w-full bg-claude-surface-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-claude-text-light dark:text-white placeholder-stone-400 dark:placeholder-stone-500 focus:outline-none focus:ring-1 focus:ring-claude-terracotta"
                  />
                </div>
                <div>
                  <label htmlFor="global-b2b-address" className="block text-[11px] text-claude-muted-light dark:text-stone-400 mb-1">
                    Billing Address (Optional)
                  </label>
                  <input
                    id="global-b2b-address"
                    type="text"
                    disabled={isCheckoutBusy}
                    placeholder="Street, City, Postal Code"
                    value={billingAddress}
                    onChange={(e) => setBillingAddress(e.target.value)}
                    className="w-full bg-claude-surface-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-claude-text-light dark:text-white placeholder-stone-400 dark:placeholder-stone-500 focus:outline-none focus:ring-1 focus:ring-claude-terracotta"
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Payment Gateway Selector & Customer Phone for INR */}
        {currency === 'INR' && (
          <div className="px-4 sm:px-6 md:px-8 pt-3 pb-0 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 sm:gap-3 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-claude-muted-light dark:text-stone-400">Payment method:</span>
              <div className="inline-flex items-center bg-claude-surface2-light dark:bg-stone-950/80 p-0.5 rounded-lg border border-claude-border-light dark:border-white/10">
                <button
                  type="button"
                  disabled={isCheckoutBusy}
                  onClick={() => setGateway('razorpay')}
                  aria-pressed={gateway === 'razorpay'}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors ${gateway === 'razorpay' ? 'bg-claude-terracotta text-white shadow-sm' : 'text-claude-muted-light dark:text-stone-400 hover:text-claude-text-light dark:hover:text-white'} ${isCheckoutBusy ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  Razorpay
                </button>
                <button
                  type="button"
                  disabled={isCheckoutBusy}
                  onClick={() => setGateway('cashfree')}
                  aria-pressed={gateway === 'cashfree'}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors ${gateway === 'cashfree' ? 'bg-claude-terracotta text-white shadow-sm' : 'text-claude-muted-light dark:text-stone-400 hover:text-claude-text-light dark:hover:text-white'} ${isCheckoutBusy ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  Cashfree
                </button>
              </div>
            </div>

            {/* Mobile number collection required for Cashfree e-mandate */}
            <div className="flex items-center gap-2">
              <label htmlFor="cashfree-phone-input" className="text-claude-muted-light dark:text-stone-400 whitespace-nowrap">
                {gateway === 'cashfree' ? 'Mobile for Mandate *:' : 'Mobile (optional):'}
              </label>
              <input
                id="cashfree-phone-input"
                type="tel"
                disabled={isCheckoutBusy}
                placeholder="10-digit mobile"
                value={customerPhone}
                onChange={(e) => {
                  setCustomerPhone(e.target.value);
                  if (phoneError) setPhoneError(null);
                  if (checkoutState === 'DEFINITIVE_FAILURE') {
                    setCheckoutState('IDLE');
                    setCheckoutNotice(null);
                  }
                }}
                aria-label="Mobile Number for Cashfree Mandate Notifications"
                aria-invalid={!!phoneError}
                aria-describedby={phoneError ? 'cashfree-phone-error' : undefined}
                className={`w-full sm:w-44 bg-claude-surface-light dark:bg-claude-surface2-dark border rounded-xl px-3 py-1.5 sm:py-2 text-xs text-claude-text-light dark:text-white placeholder-stone-400 dark:placeholder-stone-500 focus:outline-none focus:ring-1 focus:ring-claude-terracotta ${phoneError ? 'border-red-500/60' : 'border-claude-border-light dark:border-white/15'} ${isCheckoutBusy ? 'opacity-50 cursor-not-allowed' : ''}`}
                maxLength={14}
              />
            </div>
          </div>
        )}

        {phoneError && (
          <div className="px-4 sm:px-6 md:px-8 pt-1">
            <p id="cashfree-phone-error" className="text-[11px] text-red-600 dark:text-red-400 font-medium">
              {phoneError}
            </p>
          </div>
        )}

        {/* Indian GST Place of Supply & Optional B2B GSTIN */}
        {currency === 'INR' && (
          <div className="px-4 sm:px-6 md:px-8 pt-2.5 sm:pt-3 space-y-2 text-xs">
            <div className="rounded-xl border border-claude-border-light dark:border-white/10 bg-claude-surface2-light/70 dark:bg-stone-950/60 p-2.5 sm:p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-3">
              <div className="flex flex-col sm:flex-row sm:items-center gap-2 flex-1">
                <label htmlFor="gst-billing-state" className="text-claude-text-light dark:text-stone-300 font-medium whitespace-nowrap">
                  Billing State / UT * (Place of Supply):
                </label>
                <select
                  id="gst-billing-state"
                  disabled={isCheckoutBusy}
                  value={billingStateCode}
                  onChange={(e) => {
                    setBillingStateCode(e.target.value);
                    if (billingStateError) setBillingStateError(null);
                    if (checkoutState === 'DEFINITIVE_FAILURE') {
                      setCheckoutState('IDLE');
                      setCheckoutNotice(null);
                    }
                  }}
                  aria-required="true"
                  aria-invalid={!!billingStateError}
                  aria-describedby={billingStateError ? 'gst-billing-state-error' : undefined}
                  className={`w-full sm:w-64 bg-claude-surface-light dark:bg-claude-surface2-dark border rounded-xl px-3 py-1.5 text-xs text-claude-text-light dark:text-white focus:outline-none focus:ring-1 focus:ring-claude-terracotta ${billingStateError ? 'border-red-500/60' : 'border-claude-border-light dark:border-white/15'} ${isCheckoutBusy ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <option value="">Select State / Union Territory…</option>
                  {gstJurisdictions.map((j) => (
                    <option key={j.code} value={j.code}>
                      {j.code} - {j.name}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={() => setShowB2bGstFields((v) => !v)}
                className="text-[11px] font-semibold text-claude-accentInk dark:text-orange-300 hover:underline text-left sm:text-right whitespace-nowrap"
              >
                {showB2bGstFields ? 'Hide B2B GSTIN Details' : 'Purchasing for a business? Add GSTIN (optional)'}
              </button>
            </div>

            {billingStateError && (
              <p id="gst-billing-state-error" className="text-[11px] text-red-600 dark:text-red-400 font-medium">
                {billingStateError}
              </p>
            )}

            {showB2bGstFields && (
              <div className="rounded-xl border border-claude-border-light dark:border-white/10 bg-claude-surface2-light/70 dark:bg-stone-950/60 p-3 grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <div>
                  <label htmlFor="gst-b2b-name" className="block text-[11px] text-claude-muted-light dark:text-stone-400 mb-1">
                    Business / Legal Name
                  </label>
                  <input
                    id="gst-b2b-name"
                    type="text"
                    disabled={isCheckoutBusy}
                    placeholder="Registered company or full name"
                    value={billingLegalName}
                    onChange={(e) => setBillingLegalName(e.target.value)}
                    className="w-full bg-claude-surface-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-claude-text-light dark:text-white placeholder-stone-400 dark:placeholder-stone-500 focus:outline-none focus:ring-1 focus:ring-claude-terracotta"
                  />
                </div>
                <div>
                  <label htmlFor="gst-b2b-gstin" className="block text-[11px] text-claude-muted-light dark:text-stone-400 mb-1">
                    15-Char Recipient GSTIN (Optional)
                  </label>
                  <input
                    id="gst-b2b-gstin"
                    type="text"
                    maxLength={15}
                    disabled={isCheckoutBusy}
                    placeholder="e.g. 27AABCU9603R1ZM"
                    value={billingGstin}
                    aria-invalid={!!billingGstinError}
                    aria-describedby={billingGstinError ? 'gst-b2b-gstin-error' : undefined}
                    onChange={(e) => {
                      const val = e.target.value.toUpperCase();
                      setBillingGstin(val);
                      if (billingGstinError) setBillingGstinError(null);
                      if (val.length >= 2 && /^[0-9]{2}/.test(val) && val.slice(0, 2) !== '25') {
                        const match = gstJurisdictions.find((j) => j.code === val.slice(0, 2));
                        if (match) setBillingStateCode(match.code);
                      }
                    }}
                    className={`w-full bg-claude-surface-light dark:bg-claude-surface2-dark border rounded-lg px-2.5 py-1.5 text-xs font-mono text-claude-text-light dark:text-white placeholder-stone-400 dark:placeholder-stone-500 focus:outline-none focus:ring-1 focus:ring-claude-terracotta ${billingGstinError ? 'border-red-500/60' : 'border-claude-border-light dark:border-white/15'}`}
                  />
                  {billingGstinError && (
                    <p id="gst-b2b-gstin-error" className="text-[10px] text-red-600 dark:text-red-400 mt-1">{billingGstinError}</p>
                  )}
                </div>
                <div>
                  <label htmlFor="gst-b2b-address" className="block text-[11px] text-claude-muted-light dark:text-stone-400 mb-1">
                    Billing Address (Optional)
                  </label>
                  <input
                    id="gst-b2b-address"
                    type="text"
                    disabled={isCheckoutBusy}
                    placeholder="Street, City, PIN"
                    value={billingAddress}
                    onChange={(e) => setBillingAddress(e.target.value)}
                    className="w-full bg-claude-surface-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-claude-text-light dark:text-white placeholder-stone-400 dark:placeholder-stone-500 focus:outline-none focus:ring-1 focus:ring-claude-terracotta"
                  />
                </div>
              </div>
            )}
          </div>
        )}

        <div className="px-4 sm:px-6 md:px-8 pt-2">
          {activeSubSummary?.cancelAtPeriodEnd && (currentPlan === 'plus' || currentPlan === 'pro') && (
            <div className="mb-3 rounded-xl border border-amber-500/35 bg-amber-500/10 px-4 py-3 text-xs text-amber-950 dark:text-amber-100 space-y-1">
              <div className="font-bold text-claude-text-light dark:text-white flex flex-wrap items-center gap-2">
                <span>
                  {currentPlan === 'pro' ? 'AIRA Pro' : 'AIRA Plus'} — Active until{' '}
                  {activeSubSummary.currentPeriodEnd
                    ? new Date(activeSubSummary.currentPeriodEnd).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium' })
                    : 'period end'}
                </span>
                <span className="px-2 py-0.5 rounded bg-amber-500/20 border border-amber-500/30 text-[10px] font-semibold text-amber-900 dark:text-amber-200">
                  {activeSubSummary.cancellationPending ? 'Cancellation Pending Confirmation' : 'Automatic renewal: Cancelled'}
                </span>
              </div>
              <p className="text-[11px] text-amber-900/90 dark:text-amber-200/90">
                {activeSubSummary.cancellationPending
                  ? 'Cancellation request is pending gateway confirmation. Paid plan features and credits remain active.'
                  : 'No further recurring payments will be charged for this subscription. Paid plan features and remaining credits remain active through the paid billing period.'}
              </p>
            </div>
          )}
          <div className="rounded-xl border border-claude-border-light dark:border-white/10 bg-claude-surface2-light/70 dark:bg-stone-950/60 px-3.5 py-2 text-[11px] text-claude-text-light/85 dark:text-stone-300 flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 sm:gap-2">
            <div>
              {currency === 'INR' ? (
                <>
                  <strong className="text-claude-text-light dark:text-white">Immediate Activation ({gateway === 'cashfree' ? 'Cashfree UPI AutoPay / Card' : 'Razorpay'}):</strong>{' '}
                  Full Cycle 1 payment (Plus ₹399 or Pro ₹999, GST inclusive) unlocks paid access, credits, and your invoice immediately upon confirmation.
                </>
              ) : (
                <>
                  <strong className="text-claude-text-light dark:text-white">Immediate Activation:</strong>{' '}
                  Full Cycle 1 payment ($7.99 Plus / $19.99 Pro) charges today with immediate plan & credit unlock.
                </>
              )}
            </div>
            <span className="hidden sm:inline text-claude-muted-light dark:text-stone-400 whitespace-nowrap shrink-0">
              Monthly auto-debits follow card / mandate rules · Cancel anytime
            </span>
          </div>
        </div>

        {/* Pricing Cards Grid */}
        <div className="p-4 sm:p-6 md:p-8 grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-6">
          {/* FREE */}
          <div className={`rounded-2xl p-6 border flex flex-col justify-between ${currentPlan === 'free' ? 'bg-claude-surface2-light/90 dark:bg-stone-900/60 border-claude-terracotta/50' : 'bg-claude-surface2-light/50 dark:bg-stone-900/30 border-claude-border-light dark:border-white/10'}`}>
            <div>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-bold text-claude-text-light dark:text-white">AIRA Free</h3>
                {currentPlan === 'free' && (
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-claude-surface-light dark:bg-stone-800 text-claude-text-light dark:text-stone-300 border border-claude-border-light dark:border-white/10">Current Plan</span>
                )}
              </div>
              <div className="text-3xl font-bold font-serif mb-1 text-claude-text-light dark:text-white">
                {currency === 'INR' ? '₹0' : '$0'}
                <span className="text-xs font-sans text-claude-muted-light dark:text-stone-400 font-normal"> / month</span>
              </div>
              <p className="text-xs text-claude-muted-light dark:text-stone-400 mb-6">Essential intelligence for everyday exploration</p>

              <div className="space-y-3 text-xs text-claude-text-light/85 dark:text-stone-300">
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" /><span><strong>15</strong> standard chats / day</span></div>
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" /><span><strong>150</strong> monthly standard chat units</span></div>
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" /><span><strong>100</strong> monthly premium credits</span></div>
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" /><span><strong>5</strong> complimentary Auto reasoning boosts</span></div>
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" /><span>Fast & Auto general models included</span></div>
                <div className="flex items-center gap-2 text-claude-muted-light dark:text-stone-500"><X className="w-4 h-4 shrink-0" /><span>Builder sandbox not included</span></div>
              </div>
            </div>

            <button
              type="button"
              disabled
              className="mt-8 w-full py-2.5 px-4 rounded-xl bg-stone-200 dark:bg-stone-800 text-stone-600 dark:text-stone-400 text-xs font-semibold cursor-not-allowed"
            >
              {currentPlan === 'free' ? 'Active Plan' : 'Free Tier'}
            </button>
          </div>

          {/* PLUS */}
          <div className="relative rounded-2xl p-6 border border-claude-terracotta/50 bg-gradient-to-b from-claude-terracotta/10 to-claude-surface-light dark:to-transparent flex flex-col justify-between shadow-lg">
            <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full bg-claude-terracotta text-white text-xs font-semibold shadow-sm">
              Popular value
            </div>

            <div>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-bold text-claude-text-light dark:text-white">AIRA Plus</h3>
                {currentPlan === 'plus' && (
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-claude-terracotta/15 text-claude-accentInk dark:text-orange-300 border border-claude-terracotta/30">Active</span>
                )}
              </div>
              <div className="text-3xl font-bold font-serif mb-1 text-claude-text-light dark:text-white">
                {currency === 'INR' ? '₹399' : '$7.99'}
                <span className="text-xs font-sans text-claude-muted-light dark:text-stone-400 font-normal"> / month</span>
              </div>
              <p className="text-[11px] text-claude-muted-light dark:text-stone-400 mb-6">
                {currency === 'INR' ? 'Pay ₹399 now (₹338.14 + 18% GST) · Auto-renews monthly' : 'Pay $7.99 now · Auto-renews monthly'}
              </p>

              <div className="space-y-3 text-xs text-claude-text-light/85 dark:text-stone-300">
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" /><span><strong>50</strong> standard chats / day</span></div>
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" /><span><strong>700</strong> monthly standard chat units</span></div>
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" /><span><strong>3,000</strong> monthly premium credits</span></div>
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" /><span><strong>50</strong> complimentary Auto reasoning boosts</span></div>
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" /><span>AIRA Vision (Understand, Generate, Edit)</span></div>
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" /><span><strong>3</strong> saved autonomous agents</span></div>
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" /><span>Builder sandbox limited trial</span></div>
              </div>
            </div>

            {currentPlan === 'plus' ? (
              <button
                type="button"
                disabled
                className="mt-8 w-full py-2.5 px-4 rounded-xl text-xs font-semibold bg-stone-200 dark:bg-stone-800 text-stone-600 dark:text-stone-400 cursor-not-allowed border border-claude-border-light dark:border-white/5"
              >
                Active Plan
              </button>
            ) : !checkoutAvailable ? (
              <div className="mt-8 space-y-1.5">
                <button
                  type="button"
                  disabled
                  className="w-full py-2.5 px-4 rounded-xl text-xs font-semibold bg-stone-200 dark:bg-stone-800 text-stone-600 dark:text-stone-400 cursor-not-allowed border border-claude-border-light dark:border-white/5"
                >
                  Checkout Unavailable
                </button>
                <p className="text-[10px] text-center text-claude-muted-light dark:text-stone-500">
                  Online checkout currently offline · Entitlements operational for active accounts
                </p>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => handleSubscribe('plus')}
                disabled={loadingPlan !== null}
                className="mt-8 w-full py-2.5 px-4 rounded-xl text-xs font-bold bg-claude-terracotta hover:bg-claude-terracotta-hover text-white transition-colors motion-reduce:transition-none shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-terracotta active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {activePlanTier === 'plus' && isCheckoutBusy
                  ? 'Initiating Checkout…'
                  : (currentPlan === 'pro' ? 'Downgrade to Plus' : 'Upgrade to Plus')}
              </button>
            )}
          </div>

          {/* PRO */}
          <div className="rounded-2xl p-6 border border-claude-border-light dark:border-white/10 bg-claude-surface2-light/50 dark:bg-stone-900/30 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-bold text-claude-text-light dark:text-white">AIRA Pro</h3>
                {currentPlan === 'pro' && (
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-claude-surface-light dark:bg-stone-800 text-claude-text-light dark:text-stone-300 border border-claude-border-light dark:border-white/10">Active</span>
                )}
              </div>
              <div className="text-3xl font-bold font-serif mb-1 text-claude-text-light dark:text-white">
                {currency === 'INR' ? '₹999' : '$19.99'}
                <span className="text-xs font-sans text-claude-muted-light dark:text-stone-400 font-normal"> / month</span>
              </div>
              <p className="text-[11px] text-claude-muted-light dark:text-stone-400 mb-6">
                {currency === 'INR' ? 'Pay ₹999 now (₹846.61 + 18% GST) · Auto-renews monthly' : 'Pay $19.99 now · Auto-renews monthly'}
              </p>

              <div className="space-y-3 text-xs text-claude-text-light/85 dark:text-stone-300">
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" /><span><strong>150</strong> standard chats / day</span></div>
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" /><span><strong>2,000</strong> monthly standard chat units</span></div>
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" /><span><strong>7,500</strong> monthly premium credits</span></div>
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" /><span><strong>200</strong> complimentary Auto reasoning boosts</span></div>
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" /><span>Vision Studio & Deep Research priority</span></div>
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" /><span><strong>20</strong> saved autonomous agents</span></div>
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" /><span>AIRA Builder metered access</span></div>
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" /><span><strong>2</strong> concurrent inferences</span></div>
              </div>
            </div>

            {currentPlan === 'pro' ? (
              <button
                type="button"
                disabled
                className="mt-8 w-full py-2.5 px-4 rounded-xl text-xs font-semibold bg-stone-200 dark:bg-stone-800 text-stone-600 dark:text-stone-400 cursor-not-allowed border border-claude-border-light dark:border-white/5"
              >
                Active Plan
              </button>
            ) : !checkoutAvailable ? (
              <div className="mt-8 space-y-1.5">
                <button
                  type="button"
                  disabled
                  className="w-full py-2.5 px-4 rounded-xl text-xs font-semibold bg-stone-200 dark:bg-stone-800 text-stone-600 dark:text-stone-400 cursor-not-allowed border border-claude-border-light dark:border-white/5"
                >
                  Checkout Unavailable
                </button>
                <p className="text-[10px] text-center text-claude-muted-light dark:text-stone-500">
                  Online checkout currently offline · Entitlements operational for active accounts
                </p>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => handleSubscribe('pro')}
                disabled={loadingPlan !== null}
                className="mt-8 w-full py-2.5 px-4 rounded-xl text-xs font-bold bg-claude-terracotta hover:bg-claude-terracotta-hover text-white transition-colors motion-reduce:transition-none shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-terracotta active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {activePlanTier === 'pro' && isCheckoutBusy ? 'Initiating Checkout…' : 'Upgrade to Pro'}
              </button>
            )}
          </div>
        </div>

        {/* Footer info */}
        <div className="p-4 sm:p-6 md:p-8 bg-claude-surface2-light dark:bg-stone-950/60 border-t border-claude-border-light dark:border-white/10 flex flex-col md:flex-row items-center justify-between text-xs text-claude-muted-light dark:text-stone-400 gap-3 sm:gap-4">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
            <span>Encrypted checkout · Instant credit activation · Cancel anytime in Settings</span>
          </div>
          <div className="text-[11px] text-claude-muted-light dark:text-stone-400">
            Pricing adapts automatically by billing country &amp; currency
          </div>
        </div>
      </motion.div>
    </div>
  );
};
