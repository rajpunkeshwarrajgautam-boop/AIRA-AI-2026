import React, { useState, useEffect } from 'react';
import { X, Check, Shield, Zap, CreditCard, ChevronRight, HelpCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { COMMERCIAL_PLANS, PlanTier, CurrencyCode } from '../types/commercial-types';
import { authenticatedApiFetch } from '../lib/neonAuth';

/**
 * Validates that a Cashfree redirect URL is using an official, trusted Cashfree domain over HTTPS.
 * Prevents open-redirect, domain spoofing, and environment confusion attacks.
 */
export function isTrustedCashfreeUrl(rawUrl: string, isSandbox?: boolean): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return false;

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
 * Loads the official Cashfree Web SDK v3 script dynamically.
 */
export function loadCashfreeScript(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (typeof window === 'undefined') return resolve(false);
    if ((window as any).Cashfree) return resolve(true);
    const existingScript = document.querySelector('script[src*="cashfree.com"]');
    if (existingScript) {
      existingScript.addEventListener('load', () => resolve(true));
      existingScript.addEventListener('error', () => resolve(false));
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://sdk.cashfree.com/js/v3/cashfree.js';
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

interface PricingModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentPlan?: PlanTier;
  onSelectPlan?: (planId: PlanTier, currency: CurrencyCode) => void;
}

export const PricingModal: React.FC<PricingModalProps> = ({
  isOpen,
  onClose,
  currentPlan = 'free',
  onSelectPlan
}) => {
  const [currency, setCurrency] = useState<CurrencyCode>('INR');
  const [gateway, setGateway] = useState<'razorpay' | 'cashfree'>('razorpay');
  const [loadingPlan, setLoadingPlan] = useState<PlanTier | null>(null);
  const [checkoutNotice, setCheckoutNotice] = useState<string | null>(null);
  const [checkoutAvailable, setCheckoutAvailable] = useState<boolean>(false);
  const [billingStatus, setBillingStatus] = useState<string>('checkout_disabled');
  const [customerPhone, setCustomerPhone] = useState<string>('');
  const [phoneError, setPhoneError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    fetch('/api/billing/plans')
      .then(r => r.json())
      .then(data => {
        if (typeof data.checkoutAvailable === 'boolean') {
          setCheckoutAvailable(data.checkoutAvailable);
        }
        if (data.billingStatus) {
          setBillingStatus(data.billingStatus);
        }
      })
      .catch(() => {
        setCheckoutAvailable(false);
      });
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubscribe = async (tier: PlanTier) => {
    if (loadingPlan !== null || tier === 'free' || tier === currentPlan) return;
    setLoadingPlan(tier);
    setCheckoutNotice(null);
    setPhoneError(null);

    const targetGateway = currency === 'USD' ? 'razorpay' : gateway;

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
        setLoadingPlan(null);
        return;
      }
    }

    try {
      if (onSelectPlan) {
        onSelectPlan(tier, currency);
      } else {
        const res = await authenticatedApiFetch('/api/billing/checkout/subscription', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            planId: tier,
            currency,
            gateway: targetGateway,
            customerPhone: customerPhone.trim() || undefined
          })
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (res.status === 400 && data.error === 'VALIDATION_ERROR') {
            setPhoneError(data.message || 'A valid 10-digit mobile number is required.');
            setCheckoutNotice(data.message || 'Validation error: please check your mobile phone number.');
          } else if (res.status === 401) {
            setCheckoutNotice('Authentication required. Please sign in to upgrade.');
          } else if (res.status === 403) {
            setCheckoutNotice(data.message || 'Access restricted: only authorized test principals can initiate sandbox checkout.');
          } else if (res.status === 503) {
            setCheckoutNotice(data.message || 'Online checkout is currently offline.');
          } else {
            setCheckoutNotice(data.message || data.error || `Checkout failed (HTTP ${res.status}).`);
          }
          return;
        }

        // Cashfree Recurring Mandate Checkout Flow (Strategy A: Web SDK v3; Strategy B: Hosted Link Fallback)
        if (data.gateway === 'cashfree') {
          const sessionId = data.paymentSessionId || data.subscriptionSessionId;
          const checkoutUrl = data.checkoutUrl;

          // Strategy A: Cashfree Web SDK v3 invocation when session ID is available
          if (sessionId) {
            setCheckoutNotice('Initializing Cashfree secure mandate authorization...');
            try {
              const loaded = await loadCashfreeScript();
              if (loaded && (window as any).Cashfree) {
                const cashfree = (window as any).Cashfree({
                  mode: data.isSandbox ? 'sandbox' : 'production'
                });
                cashfree.checkout({
                  paymentSessionId: sessionId,
                  redirectTarget: '_self'
                });
                return;
              }
            } catch (sdkErr: any) {
              console.warn('[PricingModal] Cashfree Web SDK checkout error, falling back to hosted checkout URL:', sdkErr?.message);
            }
          }

          // Strategy B: Hosted mandate authorization link fallback (only if genuine provider auth_link exists and is trusted)
          if (checkoutUrl && isTrustedCashfreeUrl(checkoutUrl, data.isSandbox)) {
            setCheckoutNotice('Launching Cashfree Checkout...');
            window.location.assign(checkoutUrl);
            return;
          }

          // Fail-closed: No valid session ID and no trusted checkout URL
          setCheckoutNotice('Unable to launch Cashfree mandate authorization. Please try again or contact support.');
          setLoadingPlan(null);
          return;
        }

        if (data.gateway !== 'cashfree' && data.checkoutUrl) {
          setCheckoutNotice('Launching Checkout...');
          window.location.assign(data.checkoutUrl);
          return;
        }

        if (data.gateway === 'razorpay' && data.keyId && data.orderId) {
          setCheckoutNotice('Opening Razorpay Checkout...');
          const loadRazorpayScript = () => new Promise<boolean>((resolve) => {
            if ((window as any).Razorpay) return resolve(true);
            const script = document.createElement('script');
            script.src = 'https://checkout.razorpay.com/v1/checkout.js';
            script.onload = () => resolve(true);
            script.onerror = () => resolve(false);
            document.body.appendChild(script);
          });

          const loaded = await loadRazorpayScript();
          if (loaded && (window as any).Razorpay) {
            const isSub = typeof data.orderId === 'string' && data.orderId.startsWith('sub_');
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
                setCheckoutNotice(`Payment authorized (Ref: ${paymentRef}). Awaiting authoritative webhook confirmation...`);
                setTimeout(async () => {
                  try {
                    const verifyRes = await authenticatedApiFetch('/api/billing/entitlements');
                    if (verifyRes.ok) {
                      const ent = await verifyRes.json();
                      if (ent.plan === tier) {
                        setCheckoutNotice(`Subscription active: Welcome to AIRA ${tier.toUpperCase()}!`);
                        setTimeout(() => { window.location.reload(); }, 1200);
                        return;
                      }
                    }
                  } catch {
                    // fall through
                  }
                  window.location.reload();
                }, 2000);
              },
              modal: {
                ondismiss: function () {
                  setLoadingPlan(null);
                }
              }
            });
            rzp.open();
            return;
          }
        }

        setCheckoutNotice('Unable to initialize payment gateway. Please try again or contact support.');
      }
    } catch (err: any) {
      setCheckoutNotice(err.message || 'Checkout failed');
    } finally {
      setLoadingPlan(null);
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
        className="relative my-2 sm:my-8 max-h-[92dvh] w-full max-w-5xl overflow-y-auto rounded-3xl border border-white/10 bg-stone-900 text-white shadow-lg"
      >
        {/* Header */}
        <div className="p-6 md:p-8 border-b border-white/10 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-orange-500/10 border border-orange-500/20 text-orange-400 text-xs font-semibold mb-2">
              <Shield className="w-3.5 h-3.5" />
              AIRA AI 2026 Commercial Plans
            </div>
            <h2 id="aira-pricing-title" className="text-2xl md:text-3xl font-serif font-medium text-white">Choose the plan that fits your ambition</h2>
            <p className="text-sm text-stone-400 mt-1">Transparent compute allowances, dedicated credit wallets, and zero hidden cutoffs.</p>
          </div>

          <div className="flex items-center gap-3">
            {/* Gateway Switcher */}
            {currency === 'INR' && (
              <div className="flex items-center p-1 bg-stone-900 rounded-xl border border-white/10" title="Select payment gateway">
                <button
                  type="button"
                  onClick={() => setGateway('razorpay')}
                  aria-pressed={gateway === 'razorpay'}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors duration-150 ${gateway === 'razorpay' ? 'bg-claude-terracotta text-white shadow-sm' : 'text-stone-400 hover:text-white'}`}
                >
                  Razorpay
                </button>
                <button
                  type="button"
                  onClick={() => setGateway('cashfree')}
                  aria-pressed={gateway === 'cashfree'}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors duration-150 ${gateway === 'cashfree' ? 'bg-claude-terracotta text-white shadow-sm' : 'text-stone-400 hover:text-white'}`}
                >
                  Cashfree
                </button>
              </div>
            )}

            {/* Currency Switcher */}
            <div className="flex items-center p-1 bg-stone-900 rounded-xl border border-white/10">
              <button
                type="button"
                onClick={() => setCurrency('INR')}
                aria-pressed={currency === 'INR'}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors duration-150 ${currency === 'INR' ? 'bg-claude-terracotta text-white shadow-sm' : 'text-stone-400 hover:text-white'}`}
              >
                ₹ INR (India)
              </button>
              <button
                type="button"
                onClick={() => setCurrency('USD')}
                aria-pressed={currency === 'USD'}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors duration-150 ${currency === 'USD' ? 'bg-claude-terracotta text-white shadow-sm' : 'text-stone-400 hover:text-white'}`}
              >
                $ USD (Global)
              </button>
            </div>

            <button
              onClick={onClose}
              aria-label="Close pricing"
              className="p-2 rounded-xl text-stone-400 hover:text-white hover:bg-white/10 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {checkoutNotice && (
          <div className="mx-6 md:mx-8 mt-6 p-4 rounded-xl bg-orange-500/10 border border-orange-500/20 text-orange-300 text-xs flex items-center justify-between">
            <span>{checkoutNotice}</span>
            <button onClick={() => setCheckoutNotice(null)} className="underline font-semibold ml-4">Dismiss</button>
          </div>
        )}

        {/* Cashfree Contact Details Mandate Input */}
        {currency === 'INR' && gateway === 'cashfree' && (
          <div className="mx-6 md:mx-8 mt-4 p-4 rounded-2xl bg-stone-950/70 border border-orange-500/30">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <label htmlFor="cashfree-phone-input" className="block text-xs font-semibold text-stone-200">
                  Mobile Number for Mandate Notifications (RBI Mandated)
                </label>
                <p className="text-[11px] text-stone-400 mt-0.5">
                  Required by Reserve Bank of India regulations for pre-debit notifications on recurring e-mandates.
                </p>
              </div>
              <div className="flex items-center gap-2 w-full sm:w-auto">
                <span className="text-xs font-mono font-medium text-stone-300 bg-stone-800 px-2.5 py-2 rounded-xl border border-white/10">
                  +91
                </span>
                <input
                  id="cashfree-phone-input"
                  type="tel"
                  placeholder="9876543210"
                  value={customerPhone}
                  onChange={(e) => {
                    setCustomerPhone(e.target.value);
                    if (phoneError) setPhoneError(null);
                  }}
                  aria-label="Mobile Number for Cashfree Mandate Notifications"
                  aria-invalid={!!phoneError}
                  aria-describedby={phoneError ? 'cashfree-phone-error' : undefined}
                  className="w-full sm:w-44 bg-stone-900 border border-white/15 rounded-xl px-3 py-2 text-xs text-white placeholder-stone-500 focus:outline-none focus:ring-1 focus:ring-claude-terracotta"
                  maxLength={14}
                />
              </div>
            </div>
            {phoneError && (
              <p id="cashfree-phone-error" className="text-[11px] text-red-400 mt-2 font-medium">
                {phoneError}
              </p>
            )}
          </div>
        )}

        {/* Pricing Cards Grid */}
        <div className="p-6 md:p-8 grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* FREE */}
          <div className={`rounded-2xl p-6 border flex flex-col justify-between ${currentPlan === 'free' ? 'bg-stone-900/60 border-orange-500/40' : 'bg-stone-900/30 border-white/10'}`}>
            <div>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-bold text-white">AIRA Free</h3>
                {currentPlan === 'free' && (
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-stone-800 text-stone-300 border border-white/10">Current Plan</span>
                )}
              </div>
              <div className="text-3xl font-bold font-serif mb-1">
                {currency === 'INR' ? '₹0' : '$0'}
                <span className="text-xs font-sans text-stone-400 font-normal"> / month</span>
              </div>
              <p className="text-xs text-stone-400 mb-6">Essential intelligence for everyday exploration</p>

              <div className="space-y-3 text-xs text-stone-300">
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-400 shrink-0" /><span><strong>15</strong> standard chats / day</span></div>
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-400 shrink-0" /><span><strong>150</strong> monthly standard chat units</span></div>
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-400 shrink-0" /><span><strong>100</strong> monthly premium credits</span></div>
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-400 shrink-0" /><span><strong>5</strong> complimentary Auto reasoning boosts</span></div>
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-400 shrink-0" /><span>Fast & Auto general models included</span></div>
                <div className="flex items-center gap-2 text-stone-500"><X className="w-4 h-4 shrink-0" /><span>Builder sandbox not included</span></div>
              </div>
            </div>

            <button
              disabled
              className="mt-8 w-full py-2.5 px-4 rounded-xl bg-stone-800 text-stone-400 text-xs font-semibold cursor-not-allowed"
            >
              {currentPlan === 'free' ? 'Active Plan' : 'Free Tier'}
            </button>
          </div>

          {/* PLUS */}
          <div className="relative rounded-2xl p-6 border border-orange-500/50 bg-gradient-to-b from-orange-500/5 to-transparent flex flex-col justify-between shadow-lg">
            <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full bg-claude-terracotta text-white text-xs font-semibold shadow-sm">
              Popular value
            </div>

            <div>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-bold text-white">AIRA Plus</h3>
                {currentPlan === 'plus' && (
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-orange-500/20 text-orange-300 border border-orange-500/30">Active</span>
                )}
              </div>
              <div className="text-3xl font-bold font-serif mb-1 text-white">
                {currency === 'INR' ? '₹399' : '$7.99'}
                <span className="text-xs font-sans text-stone-400 font-normal"> / month</span>
              </div>
              <p className="text-[11px] text-stone-400 mb-6">
                {currency === 'INR' ? '₹338.14 + 18% GST · Tax compliant' : '$7.99 / month · Global billing'}
              </p>

              <div className="space-y-3 text-xs text-stone-300">
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-400 shrink-0" /><span><strong>50</strong> standard chats / day</span></div>
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-400 shrink-0" /><span><strong>700</strong> monthly standard chat units</span></div>
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-400 shrink-0" /><span><strong>3,000</strong> monthly premium credits ($3 value)</span></div>
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-400 shrink-0" /><span><strong>50</strong> complimentary Auto reasoning boosts</span></div>
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-400 shrink-0" /><span>AIRA Vision (Understand, Generate, Edit)</span></div>
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-400 shrink-0" /><span><strong>3</strong> saved autonomous agents</span></div>
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-400 shrink-0" /><span>Builder sandbox limited trial</span></div>
              </div>
            </div>

            {currentPlan === 'plus' ? (
              <button
                disabled
                className="mt-8 w-full py-2.5 px-4 rounded-xl text-xs font-semibold bg-stone-800 text-stone-400 cursor-not-allowed border border-white/5"
              >
                Active Plan
              </button>
            ) : !checkoutAvailable ? (
              <div className="mt-8 space-y-1.5">
                <button
                  disabled
                  className="w-full py-2.5 px-4 rounded-xl text-xs font-semibold bg-stone-800 text-stone-400 cursor-not-allowed border border-white/5"
                >
                  Checkout Unavailable
                </button>
                <p className="text-[10px] text-center text-stone-500">
                  Online checkout currently offline · Entitlements operational for active accounts
                </p>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => handleSubscribe('plus')}
                disabled={loadingPlan === 'plus'}
                className="mt-8 w-full py-2.5 px-4 rounded-xl text-xs font-bold bg-claude-terracotta hover:bg-claude-terracotta-hover text-white transition-colors motion-reduce:transition-none shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-terracotta active:scale-[0.99]"
              >
                {loadingPlan === 'plus' ? 'Initiating Checkout…' : 'Upgrade to Plus'}
              </button>
            )}
          </div>

          {/* PRO */}
          <div className="rounded-2xl p-6 border border-white/10 bg-stone-900/30 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-bold text-white">AIRA Pro</h3>
                {currentPlan === 'pro' && (
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-stone-800 text-stone-300 border border-white/10">Active</span>
                )}
              </div>
              <div className="text-3xl font-bold font-serif mb-1 text-white">
                {currency === 'INR' ? '₹999' : '$19.99'}
                <span className="text-xs font-sans text-stone-400 font-normal"> / month</span>
              </div>
              <p className="text-[11px] text-stone-400 mb-6">
                {currency === 'INR' ? '₹846.61 + 18% GST · Tax compliant' : '$19.99 / month · Global billing'}
              </p>

              <div className="space-y-3 text-xs text-stone-300">
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-400 shrink-0" /><span><strong>150</strong> standard chats / day</span></div>
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-400 shrink-0" /><span><strong>2,000</strong> monthly standard chat units</span></div>
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-400 shrink-0" /><span><strong>7,500</strong> monthly premium credits ($7.50 value)</span></div>
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-400 shrink-0" /><span><strong>200</strong> complimentary Auto reasoning boosts</span></div>
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-400 shrink-0" /><span>Vision Studio & Deep Research priority</span></div>
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-400 shrink-0" /><span><strong>20</strong> saved autonomous agents</span></div>
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-400 shrink-0" /><span>AIRA Builder metered access</span></div>
                <div className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-400 shrink-0" /><span><strong>2</strong> concurrent inferences</span></div>
              </div>
            </div>

            {currentPlan === 'pro' ? (
              <button
                disabled
                className="mt-8 w-full py-2.5 px-4 rounded-xl text-xs font-semibold bg-stone-800 text-stone-400 cursor-not-allowed border border-white/5"
              >
                Active Plan
              </button>
            ) : !checkoutAvailable ? (
              <div className="mt-8 space-y-1.5">
                <button
                  disabled
                  className="w-full py-2.5 px-4 rounded-xl text-xs font-semibold bg-stone-800 text-stone-400 cursor-not-allowed border border-white/5"
                >
                  Checkout Unavailable
                </button>
                <p className="text-[10px] text-center text-stone-500">
                  Online checkout currently offline · Entitlements operational for active accounts
                </p>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => handleSubscribe('pro')}
                disabled={loadingPlan === 'pro'}
                className="mt-8 w-full py-2.5 px-4 rounded-xl text-xs font-bold bg-claude-terracotta hover:bg-claude-terracotta-hover text-white transition-colors motion-reduce:transition-none shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-terracotta active:scale-[0.99]"
              >
                {loadingPlan === 'pro' ? 'Initiating Checkout…' : 'Upgrade to Pro'}
              </button>
            )}
          </div>
        </div>

        {/* Footer info */}
        <div className="p-6 md:p-8 bg-stone-950/60 border-t border-white/10 flex flex-col md:flex-row items-center justify-between text-xs text-stone-400 gap-4">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-emerald-400" />
            <span>Secure payment gateway encryption. Cancel anytime at period end with zero penalty.</span>
          </div>
          <div>Virexa AI Ventures Private Limited · SAC 998431 Tax Compliant</div>
        </div>
      </motion.div>
    </div>
  );
};
