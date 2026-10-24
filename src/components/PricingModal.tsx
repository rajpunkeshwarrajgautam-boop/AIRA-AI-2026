import React, { useState } from 'react';
import { X, Check, Sparkles, Shield, Zap, CreditCard, ChevronRight, HelpCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { COMMERCIAL_PLANS, PlanTier, CurrencyCode } from '../types/commercial-types';

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
  const [loadingPlan, setLoadingPlan] = useState<PlanTier | null>(null);
  const [checkoutNotice, setCheckoutNotice] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubscribe = async (tier: PlanTier) => {
    if (tier === 'free' || tier === currentPlan) return;
    setLoadingPlan(tier);
    setCheckoutNotice(null);

    try {
      if (onSelectPlan) {
        onSelectPlan(tier, currency);
      } else {
        const res = await fetch('/api/billing/checkout/subscription', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ planId: tier, currency })
        });
        const data = await res.json();
        if (data.checkoutUrl) {
          setCheckoutNotice(`Sandbox Checkout initiated for ${tier.toUpperCase()} (${data.currency} ${data.amount / 100}). Gateway order ID: ${data.orderId}`);
        } else {
          setCheckoutNotice(data.error || 'Checkout initialization ready.');
        }
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
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="relative w-full max-w-5xl rounded-3xl bg-[#18181b] border border-white/10 text-white shadow-2xl overflow-hidden my-8"
      >
        {/* Header */}
        <div className="p-6 md:p-8 border-b border-white/10 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-orange-500/10 border border-orange-500/20 text-orange-400 text-xs font-semibold mb-2">
              <Sparkles className="w-3.5 h-3.5" />
              AIRA AI 2026 Commercial Plans
            </div>
            <h2 className="text-2xl md:text-3xl font-serif font-medium text-white">Choose the plan that fits your ambition</h2>
            <p className="text-sm text-stone-400 mt-1">Transparent compute allowances, dedicated credit wallets, and zero hidden cutoffs.</p>
          </div>

          <div className="flex items-center gap-3">
            {/* Currency Switcher */}
            <div className="flex items-center p-1 bg-stone-900 rounded-xl border border-white/10">
              <button
                type="button"
                onClick={() => setCurrency('INR')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${currency === 'INR' ? 'bg-[#cc785c] text-white shadow-sm' : 'text-stone-400 hover:text-white'}`}
              >
                ₹ INR (India)
              </button>
              <button
                type="button"
                onClick={() => setCurrency('USD')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${currency === 'USD' ? 'bg-[#cc785c] text-white shadow-sm' : 'text-stone-400 hover:text-white'}`}
              >
                $ USD (Global)
              </button>
            </div>

            <button
              onClick={onClose}
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
          <div className="relative rounded-2xl p-6 border border-orange-500/50 bg-gradient-to-b from-orange-500/5 to-transparent flex flex-col justify-between shadow-[0_0_30px_rgba(204,120,92,0.1)]">
            <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full bg-[#cc785c] text-white text-[10px] font-bold uppercase tracking-wider shadow-sm">
              Popular Value
            </div>

            <div>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-bold text-white">AIRA Plus</h3>
                {currentPlan === 'plus' && (
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-orange-500/20 text-orange-300 border border-orange-500/30">Active</span>
                )}
              </div>
              <div className="text-3xl font-bold font-serif mb-1">
                {currency === 'INR' ? '₹399' : '$7.99'}
                <span className="text-xs font-sans text-stone-400 font-normal"> / month</span>
              </div>
              <p className="text-[11px] text-stone-400 mb-6">
                {currency === 'INR' ? 'GST inclusive (₹338.14 + ₹60.86 GST)' : 'Billed monthly in USD'}
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

            <button
              onClick={() => handleSubscribe('plus')}
              disabled={loadingPlan === 'plus' || currentPlan === 'plus'}
              className={`mt-8 w-full py-2.5 px-4 rounded-xl text-xs font-semibold transition-all ${currentPlan === 'plus' ? 'bg-stone-800 text-stone-400 cursor-not-allowed' : 'bg-gradient-to-r from-orange-500 to-[#cc785c] hover:opacity-95 text-white shadow-lg active:scale-[0.98]'}`}
            >
              {loadingPlan === 'plus' ? 'Connecting Gateway...' : currentPlan === 'plus' ? 'Current Plan' : 'Upgrade to Plus'}
            </button>
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
              <div className="text-3xl font-bold font-serif mb-1">
                {currency === 'INR' ? '₹999' : '$19.99'}
                <span className="text-xs font-sans text-stone-400 font-normal"> / month</span>
              </div>
              <p className="text-[11px] text-stone-400 mb-6">
                {currency === 'INR' ? 'GST inclusive (₹846.61 + ₹152.39 GST)' : 'Billed monthly in USD'}
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

            <button
              onClick={() => handleSubscribe('pro')}
              disabled={loadingPlan === 'pro' || currentPlan === 'pro'}
              className={`mt-8 w-full py-2.5 px-4 rounded-xl text-xs font-semibold transition-all ${currentPlan === 'pro' ? 'bg-stone-800 text-stone-400 cursor-not-allowed' : 'bg-white text-stone-900 hover:bg-stone-200 shadow-md active:scale-[0.98]'}`}
            >
              {loadingPlan === 'pro' ? 'Connecting Gateway...' : currentPlan === 'pro' ? 'Current Plan' : 'Upgrade to Pro'}
            </button>
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
