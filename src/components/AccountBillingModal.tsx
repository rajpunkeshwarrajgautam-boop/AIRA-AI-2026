import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  X,
  CreditCard,
  Shield,
  Sparkles,
  RefreshCw,
  LogOut,
  Layers,
  TrendingUp
} from 'lucide-react';
import { motion } from 'framer-motion';
import { neonAuth, NeonUser } from '../lib/neonAuth';
import { CurrencyCode } from '../types/commercial-types';
import {
  BillingSummary,
  classifyServerSession,
  linkedProviderNames,
  parseBillingSummary
} from '../lib/accountBillingTruth';

interface AccountBillingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenPricing: () => void;
  initialTab?: 'overview' | 'usage' | 'topup' | 'security';
}

export const AccountBillingModal: React.FC<AccountBillingModalProps> = ({
  isOpen,
  onClose,
  onOpenPricing,
  initialTab = 'overview',
}) => {
  const [activeTab, setActiveTab] = useState<'overview' | 'usage' | 'topup' | 'security'>(initialTab);
  
  useEffect(() => {
    if (isOpen && initialTab) {
      setActiveTab(initialTab);
    }
  }, [isOpen, initialTab]);
  const [user, setUser] = useState<NeonUser | null>(() => neonAuth.getCurrentUser());
  const [loading, setLoading] = useState(false);
  const [billingSummary, setBillingSummary] = useState<BillingSummary | null>(null);
  const [billingPrincipalId, setBillingPrincipalId] = useState<string | null>(null);
  const [billingError, setBillingError] = useState<string | null>(null);
  const billingRequestId = useRef(0);
  const [sessionRefreshCount, setSessionRefreshCount] = useState(0);
  const [identity, setIdentity] = useState<{
    status: 'checking' | 'verified' | 'anonymous' | 'syncing' | 'unavailable';
    principalId: string | null;
    providers: string[] | null;
  }>({ status: 'checking', principalId: null, providers: null });
  const [topUpCurrency, setTopUpCurrency] = useState<CurrencyCode>('INR');
  const [topUpNotice, setTopUpNotice] = useState<string | null>(null);

  useEffect(() => {
    return neonAuth.onAuthStateChange((nextUser) => setUser(nextUser));
  }, []);

  const fetchBillingData = useCallback(async (signal?: AbortSignal) => {
    const requestId = ++billingRequestId.current;
    const principalId = neonAuth.getCurrentUser()?.id || null;
    const authEpoch = neonAuth.getAuthEpoch();
    setBillingSummary(null);
    setBillingPrincipalId(null);
    setBillingError(null);
    setLoading(true);
    if (!principalId) {
      setBillingError('Sign in to view your billing information.');
      setLoading(false);
      return;
    }
    try {
      const res = await fetch('/api/billing/summary', {
        headers: { Accept: 'application/json' },
        credentials: 'include',
        cache: 'no-store',
        signal
      });
      if (!res.ok) throw new Error(res.status === 401 ? 'Sign in to view billing.' : 'Billing is temporarily unavailable.');
      const data = parseBillingSummary(await res.json(), principalId);
      if (!data) throw new Error('Billing returned incomplete data. Please retry.');
      if (requestId !== billingRequestId.current || neonAuth.getCurrentUser()?.id !== principalId || neonAuth.getAuthEpoch() !== authEpoch) return;
      setBillingSummary(data);
      setBillingPrincipalId(principalId);
    } catch {
      if (requestId !== billingRequestId.current || signal?.aborted) return;
      setBillingError('Billing information could not be loaded. No balances or usage are shown until confirmed.');
    } finally {
      if (requestId === billingRequestId.current && !signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const controller = new AbortController();
    void fetchBillingData(controller.signal);
    return () => {
      controller.abort();
      ++billingRequestId.current;
    };
  }, [isOpen, user?.id, fetchBillingData]);

  useEffect(() => {
    if (!isOpen) return;
    const controller = new AbortController();
    const expectedPrincipalId = user?.id || null;
    setIdentity({ status: 'checking', principalId: null, providers: null });

    const verifyAccount = async () => {
      try {
        const res = await fetch('/api/auth/session', {
          credentials: 'include',
          headers: { Accept: 'application/json' },
          cache: 'no-store',
          signal: controller.signal
        });
        if (!res.ok) throw new Error('Session lookup failed');
        const state = classifyServerSession(await res.json(), expectedPrincipalId);
        if (controller.signal.aborted) return;

        if (state === 'anonymous') {
          setIdentity({ status: 'anonymous', principalId: null, providers: null });
          if (expectedPrincipalId && neonAuth.getCurrentUser()?.id === expectedPrincipalId) {
            neonAuth.saveSession(null); // Clear a stale cached profile, not the server cookie.
          }
          return;
        }
        if (state === 'mismatch') {
          setIdentity({ status: 'syncing', principalId: null, providers: null });
          await neonAuth.restoreSession(); // Reconcile the browser cache with the HttpOnly BFF session.
          if (!controller.signal.aborted && neonAuth.getCurrentUser()?.id === expectedPrincipalId) {
            setIdentity({ status: 'unavailable', principalId: null, providers: null });
          }
          return;
        }

        let providers: string[] | null = null;
        try {
          const linkedRes = await fetch('/api/auth/providers', {
            credentials: 'include',
            headers: { Accept: 'application/json' },
            cache: 'no-store',
            signal: controller.signal
          });
          if (linkedRes.ok) providers = linkedProviderNames(await linkedRes.json());
        } catch {
          // The session can be confirmed even if linked provider retrieval fails.
        }
        if (controller.signal.aborted || neonAuth.getCurrentUser()?.id !== expectedPrincipalId) return;
        setIdentity({ status: 'verified', principalId: expectedPrincipalId, providers });
      } catch {
        if (!controller.signal.aborted) {
          setIdentity({ status: 'unavailable', principalId: null, providers: null });
        }
      }
    };
    void verifyAccount();
    return () => controller.abort();
  }, [isOpen, user?.id, sessionRefreshCount]);

  const sessionVerified = identity.status === 'verified' && Boolean(user?.id) && identity.principalId === user?.id;
  const confirmedBilling = sessionVerified && billingPrincipalId === user?.id ? billingSummary : null;

  const handleTopUp = async (credits: number, inrPrice: number, usdPrice: number) => {
    setTopUpNotice(null);
    try {
      const res = await fetch('/api/billing/checkout/topup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          credits,
          currency: topUpCurrency,
          amountMinorUnits: topUpCurrency === 'INR' ? inrPrice * 100 : usdPrice * 100
        })
      });
      const data = await res.json();
      if (res.ok && data.checkoutUrl) {
        setTopUpNotice(`Sandbox checkout initiated: ${credits.toLocaleString()} credits. Order ID: ${data.orderId}`);
      } else {
        setTopUpNotice(data.error || 'Top-up checkout prepared.');
      }
    } catch (err: any) {
      setTopUpNotice(err.message || 'Error processing top-up');
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-md p-4 overflow-y-auto">
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96 }}
        className="relative w-full max-w-4xl rounded-3xl bg-[#161618] border border-white/10 text-white shadow-2xl overflow-hidden my-6 flex flex-col max-h-[90vh]"
      >
        {/* Header */}
        <div className="p-5 md:p-6 border-b border-white/10 flex items-center justify-between shrink-0 bg-stone-900/50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-[#3056CB] to-[#4871F7] flex items-center justify-center text-white font-bold text-sm shadow-md overflow-hidden">
              {sessionVerified && user?.image ? (
                <img src={user.image} alt={user.name || 'User'} className="w-full h-full object-cover" />
              ) : sessionVerified && user ? (
                user.name ? user.name.slice(0, 2).toUpperCase() : 'AI'
              ) : (
                'G'
              )}
            </div>
            <div>
              <h2 className="text-xl font-medium tracking-tight text-white flex items-center gap-2">
                Account & Billing Center
              </h2>
              <p className="text-xs text-stone-400">
                {sessionVerified ? (user?.email || user?.name || 'Signed-in account') : 'Guest or unconfirmed session'} · AIRA Account
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => void fetchBillingData()}
              disabled={loading}
              className="p-2 rounded-xl text-stone-400 hover:text-white hover:bg-white/10 transition-colors"
              title="Refresh Billing Data"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={onClose}
              className="p-2 rounded-xl text-stone-400 hover:text-white hover:bg-white/10 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-white/10 bg-black/20 px-6 shrink-0">
          <button
            onClick={() => setActiveTab('overview')}
            className={`flex items-center gap-2 py-3 px-4 text-xs font-semibold border-b-2 transition-all ${
              activeTab === 'overview'
                ? 'border-[#3056CB] text-white'
                : 'border-transparent text-stone-400 hover:text-white'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            Plan & Overview
          </button>
          <button
            onClick={() => setActiveTab('usage')}
            className={`flex items-center gap-2 py-3 px-4 text-xs font-semibold border-b-2 transition-all ${
              activeTab === 'usage'
                ? 'border-[#3056CB] text-white'
                : 'border-transparent text-stone-400 hover:text-white'
            }`}
          >
            <TrendingUp className="w-3.5 h-3.5" />
            Usage & Allowances
          </button>
          <button
            onClick={() => setActiveTab('topup')}
            className={`flex items-center gap-2 py-3 px-4 text-xs font-semibold border-b-2 transition-all ${
              activeTab === 'topup'
                ? 'border-[#3056CB] text-white'
                : 'border-transparent text-stone-400 hover:text-white'
            }`}
          >
            <CreditCard className="w-3.5 h-3.5" />
            Top-up Credits
          </button>
          <button
            onClick={() => setActiveTab('security')}
            className={`flex items-center gap-2 py-3 px-4 text-xs font-semibold border-b-2 transition-all ${
              activeTab === 'security'
                ? 'border-[#3056CB] text-white'
                : 'border-transparent text-stone-400 hover:text-white'
            }`}
          >
            <Shield className="w-3.5 h-3.5" />
            Account Security
          </button>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {(activeTab === 'overview' || activeTab === 'usage') && !confirmedBilling && (
            <div role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100 flex items-center justify-between gap-3">
              <span>{loading ? 'Loading your billing information…' : billingError || 'Billing information unavailable.'}</span>
              {!loading && <button onClick={() => void fetchBillingData()} className="underline underline-offset-2 shrink-0">Retry</button>}
            </div>
          )}
          {activeTab === 'overview' && confirmedBilling && (
            <div className="space-y-6">
              {/* Active Plan Card */}
              <div className="p-6 rounded-2xl bg-gradient-to-br from-stone-900 to-stone-900/60 border border-white/10 flex flex-col md:flex-row md:items-center justify-between gap-6">
                <div>
                  <div className="text-xs uppercase tracking-wider font-semibold text-[#5B82F6] mb-1">
                    Current Active Tier
                  </div>
                  <h3 className="text-2xl font-serif text-white flex items-center gap-3">
                    {confirmedBilling.planName}
                    <span className="text-xs px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 capitalize">
                      {confirmedBilling.subscriptionStatus}
                    </span>
                  </h3>
                  <p className="text-xs text-stone-400 mt-2 max-w-md">
                    Your current plan, usage and available credits are shown from the live account ledger below.
                  </p>
                </div>

                <div className="shrink-0 flex flex-col gap-2.5">
                  <button
                    onClick={() => {
                      onClose();
                      onOpenPricing();
                    }}
                    className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-[#3056CB] to-[#4871F7] text-white text-xs font-semibold shadow-md hover:brightness-110 active:scale-95 transition-all flex items-center justify-center gap-2"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    Change or Upgrade Plan
                  </button>
                </div>
              </div>

              {/* Credit Wallet Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="p-4 rounded-xl bg-stone-900/60 border border-white/10">
                  <div className="text-[11px] text-stone-400">Available Premium Credits</div>
                  <div className="text-2xl font-bold text-emerald-400 mt-1">
                    {confirmedBilling.availableCredits.toLocaleString()}
                  </div>
                  <div className="text-[10px] text-stone-500 mt-1">
                    Balance reported by your account ledger
                  </div>
                </div>

                <div className="p-4 rounded-xl bg-stone-900/60 border border-white/10">
                  <div className="text-[11px] text-stone-400">Daily Standard Allowance</div>
                  <div className="text-2xl font-bold text-white mt-1">
                    {Math.max(0, confirmedBilling.dailyChatLimit - confirmedBilling.dailyChatsUsed)} / {confirmedBilling.dailyChatLimit}
                  </div>
                  <div className="text-[10px] text-stone-500 mt-1">Resets automatically at midnight UTC</div>
                </div>

                <div className="p-4 rounded-xl bg-stone-900/60 border border-white/10">
                  <div className="text-[11px] text-stone-400">Monthly Reasoning Boosts</div>
                  <div className="text-2xl font-bold text-amber-400 mt-1">
                    {Math.max(0, confirmedBilling.reasoningBoostLimit - confirmedBilling.reasoningBoostsUsed)} / {confirmedBilling.reasoningBoostLimit}
                  </div>
                  <div className="text-[10px] text-stone-500 mt-1">Complimentary deep thinking passes</div>
                </div>
              </div>

              {/* Billing Info Notice */}
              <div className="p-4 rounded-xl bg-stone-900/40 border border-white/10 text-xs text-stone-400 space-y-2">
                <div className="font-semibold text-white flex items-center gap-2">
                  <Shield className="w-4 h-4 text-indigo-400" />
                  Financial Ledger Protection
                </div>
                <p>
                  AIRA records usage and credit reservations in your account ledger. If current balances cannot be retrieved, the values remain unavailable until your account data is confirmed.
                </p>
              </div>
            </div>
          )}

          {activeTab === 'usage' && confirmedBilling && (
            <div className="space-y-6">
              <h4 className="text-sm font-semibold text-white">Compute & Quota Breakdown</h4>
              <div className="space-y-4">
                {/* Daily Progress */}
                <div className="p-4 rounded-xl bg-stone-900/60 border border-white/10 space-y-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-stone-300">Daily Standard Chat Limit</span>
                    <span className="text-stone-400">
                      {confirmedBilling.dailyChatsUsed} / {confirmedBilling.dailyChatLimit} chats
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-stone-800 overflow-hidden">
                    <div
                      className="h-full bg-[#3056CB]"
                      style={{
                        width: `${confirmedBilling.dailyChatLimit ? Math.min(100, (confirmedBilling.dailyChatsUsed / confirmedBilling.dailyChatLimit) * 100) : 0}%`
                      }}
                    />
                  </div>
                </div>

                {/* Monthly Progress */}
                <div className="p-4 rounded-xl bg-stone-900/60 border border-white/10 space-y-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-stone-300">Monthly Standard Chat Units</span>
                    <span className="text-stone-400">
                      {confirmedBilling.monthlyUnitsUsed} / {confirmedBilling.monthlyUnitLimit} units
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-stone-800 overflow-hidden">
                    <div
                      className="h-full bg-indigo-500"
                      style={{
                        width: `${confirmedBilling.monthlyUnitLimit ? Math.min(100, (confirmedBilling.monthlyUnitsUsed / confirmedBilling.monthlyUnitLimit) * 100) : 0}%`
                      }}
                    />
                  </div>
                </div>

                {/* Reasoning Boost Progress */}
                <div className="p-4 rounded-xl bg-stone-900/60 border border-white/10 space-y-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-stone-300">Complimentary Auto Reasoning Boosts</span>
                    <span className="text-stone-400">
                      {confirmedBilling.reasoningBoostsUsed} / {confirmedBilling.reasoningBoostLimit} used
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-stone-800 overflow-hidden">
                    <div
                      className="h-full bg-amber-500"
                      style={{
                        width: `${confirmedBilling.reasoningBoostLimit ? Math.min(100, (confirmedBilling.reasoningBoostsUsed / confirmedBilling.reasoningBoostLimit) * 100) : 0}%`
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'topup' && !sessionVerified && (
            <div role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
              Verify your sign-in session to view account credit purchases.
            </div>
          )}
          {activeTab === 'topup' && sessionVerified && (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-sm font-semibold text-white">Purchase Credit Top-Up Packs</h4>
                  <p className="text-xs text-stone-400">Credits never expire and roll over indefinitely.</p>
                </div>
                <div className="flex items-center p-1 bg-stone-900 rounded-lg border border-white/10">
                  <button
                    onClick={() => setTopUpCurrency('INR')}
                    className={`px-2.5 py-1 rounded text-xs font-semibold ${topUpCurrency === 'INR' ? 'bg-[#3056CB] text-white' : 'text-stone-400'}`}
                  >
                    ₹ INR
                  </button>
                  <button
                    onClick={() => setTopUpCurrency('USD')}
                    className={`px-2.5 py-1 rounded text-xs font-semibold ${topUpCurrency === 'USD' ? 'bg-[#3056CB] text-white' : 'text-stone-400'}`}
                  >
                    $ USD
                  </button>
                </div>
              </div>

              {topUpNotice && (
                <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-xs">
                  {topUpNotice}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="p-5 rounded-2xl bg-stone-900/60 border border-white/10 flex flex-col justify-between">
                  <div>
                    <div className="text-xs font-semibold text-stone-300">Starter Top-Up</div>
                    <div className="text-2xl font-bold text-white mt-1">1,000</div>
                    <div className="text-[11px] text-stone-400">Credits</div>
                  </div>
                  <div className="mt-4 pt-4 border-t border-white/10 flex items-center justify-between">
                    <span className="text-sm font-bold text-white">
                      {topUpCurrency === 'INR' ? '₹99' : '$1.49'}
                    </span>
                    <button
                      onClick={() => handleTopUp(1000, 99, 1.49)}
                      className="px-3 py-1.5 rounded-lg bg-[#3056CB] hover:bg-[#4871F7] text-white text-xs font-semibold transition"
                    >
                      Buy Now
                    </button>
                  </div>
                </div>

                <div className="p-5 rounded-2xl bg-gradient-to-b from-[#3056CB]/10 to-stone-900/60 border border-[#3056CB]/30 flex flex-col justify-between">
                  <div>
                    <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded-full bg-[#3056CB]/20 text-[#5B82F6]">
                      Most Popular
                    </span>
                    <div className="text-xs font-semibold text-stone-300 mt-2">Power Top-Up</div>
                    <div className="text-2xl font-bold text-white mt-1">5,000</div>
                    <div className="text-[11px] text-stone-400">Credits</div>
                  </div>
                  <div className="mt-4 pt-4 border-t border-white/10 flex items-center justify-between">
                    <span className="text-sm font-bold text-white">
                      {topUpCurrency === 'INR' ? '₹399' : '$5.99'}
                    </span>
                    <button
                      onClick={() => handleTopUp(5000, 399, 5.99)}
                      className="px-3 py-1.5 rounded-lg bg-[#3056CB] hover:bg-[#4871F7] text-white text-xs font-semibold transition"
                    >
                      Buy Now
                    </button>
                  </div>
                </div>

                <div className="p-5 rounded-2xl bg-stone-900/60 border border-white/10 flex flex-col justify-between">
                  <div>
                    <div className="text-xs font-semibold text-stone-300">Studio Top-Up</div>
                    <div className="text-2xl font-bold text-white mt-1">15,000</div>
                    <div className="text-[11px] text-stone-400">Credits</div>
                  </div>
                  <div className="mt-4 pt-4 border-t border-white/10 flex items-center justify-between">
                    <span className="text-sm font-bold text-white">
                      {topUpCurrency === 'INR' ? '₹999' : '$14.99'}
                    </span>
                    <button
                      onClick={() => handleTopUp(15000, 999, 14.99)}
                      className="px-3 py-1.5 rounded-lg bg-[#3056CB] hover:bg-[#4871F7] text-white text-xs font-semibold transition"
                    >
                      Buy Now
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'security' && (
            <div className="space-y-6">
              <h4 className="text-sm font-semibold text-white">Session & Identity Integrity</h4>
              {!sessionVerified && identity.status !== 'checking' && identity.status !== 'syncing' && (
                <button type="button" onClick={() => setSessionRefreshCount((count) => count + 1)} className="text-xs text-blue-300 underline underline-offset-2">
                  Recheck session with AIRA
                </button>
              )}
              <div className="p-4 rounded-xl bg-stone-900/60 border border-white/10 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs font-semibold text-white">Authenticated Principal ID</div>
                    <div className="text-xs text-stone-400 font-mono mt-0.5">{sessionVerified ? user?.id : 'Not confirmed'}</div>
                  </div>
                  <span className={`text-[11px] px-2 py-0.5 rounded-md font-medium ${sessionVerified ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'}`}>
                    {sessionVerified ? 'Session verified' : identity.status === 'checking' || identity.status === 'syncing' ? 'Checking session' : 'Not verified'}
                  </span>
                </div>

                <div className="pt-3 border-t border-white/10 flex items-center justify-between">
                  <div>
                    <div className="text-xs font-semibold text-white">Account Email</div>
                    <div className="text-xs text-stone-400">{sessionVerified ? (user?.email || 'No email on account') : 'Not confirmed'}</div>
                  </div>
                  <span className="text-[10px] text-stone-400 text-right">{sessionVerified ? identity.providers === null ? 'Sign-in providers unavailable' : identity.providers.length ? `Linked: ${identity.providers.join(', ')}` : 'No linked OAuth providers' : 'Provider not confirmed'}</span>
                </div>
              </div>

              {sessionVerified && (
                <div className="pt-2">
                  <button
                    onClick={async () => {
                      await neonAuth.signOut();
                      window.location.reload();
                    }}
                    className="px-4 py-2 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 text-xs font-semibold border border-rose-500/20 transition flex items-center gap-2"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    Sign Out & Invalidate Session
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
};
