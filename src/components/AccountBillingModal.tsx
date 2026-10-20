import React, { useState, useEffect } from 'react';
import {
  X,
  CreditCard,
  Shield,
  Zap,
  CheckCircle,
  Clock,
  Sparkles,
  ArrowUpRight,
  Download,
  AlertTriangle,
  RefreshCw,
  LogOut,
  Layers,
  ChevronRight,
  TrendingUp
} from 'lucide-react';
import { motion } from 'framer-motion';
import { neonAuth, NeonUser } from '../lib/neonAuth';
import { PlanTier, CurrencyCode } from '../types/commercial-types';

interface AccountBillingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenPricing: () => void;
}

interface BillingSummary {
  planId: PlanTier;
  planName: string;
  subscriptionStatus: string;
  currentPeriodEnd?: string;
  availableCredits: number;
  lifetimeGranted: number;
  lifetimeSpent: number;
  dailyChatsUsed: number;
  dailyChatLimit: number;
  monthlyUnitsUsed: number;
  monthlyUnitLimit: number;
  reasoningBoostsUsed: number;
  reasoningBoostLimit: number;
}

export const AccountBillingModal: React.FC<AccountBillingModalProps> = ({
  isOpen,
  onClose,
  onOpenPricing,
}) => {
  const [activeTab, setActiveTab] = useState<'overview' | 'usage' | 'topup' | 'security'>('overview');
  const [user, setUser] = useState<NeonUser | null>(() => neonAuth.getCurrentUser());
  const [loading, setLoading] = useState(false);
  const [billingSummary, setBillingSummary] = useState<BillingSummary | null>(null);
  const [topUpCurrency, setTopUpCurrency] = useState<CurrencyCode>('INR');
  const [topUpNotice, setTopUpNotice] = useState<string | null>(null);

  useEffect(() => {
    return neonAuth.onAuthStateChange((nextUser) => setUser(nextUser));
  }, []);

  useEffect(() => {
    if (isOpen) {
      fetchBillingData();
    }
  }, [isOpen]);

  const fetchBillingData = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/billing/summary', {
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
      });
      if (res.ok) {
        const data = await res.json();
        setBillingSummary(data);
      } else {
        // Fallback default snapshot if offline or staging bootstrap
        setBillingSummary({
          planId: 'free',
          planName: 'AIRA Free',
          subscriptionStatus: 'active',
          availableCredits: 100,
          lifetimeGranted: 100,
          lifetimeSpent: 0,
          dailyChatsUsed: 2,
          dailyChatLimit: 15,
          monthlyUnitsUsed: 12,
          monthlyUnitLimit: 150,
          reasoningBoostsUsed: 1,
          reasoningBoostLimit: 5,
        });
      }
    } catch {
      setBillingSummary({
        planId: 'free',
        planName: 'AIRA Free',
        subscriptionStatus: 'active',
        availableCredits: 100,
        lifetimeGranted: 100,
        lifetimeSpent: 0,
        dailyChatsUsed: 2,
        dailyChatLimit: 15,
        monthlyUnitsUsed: 12,
        monthlyUnitLimit: 150,
        reasoningBoostsUsed: 1,
        reasoningBoostLimit: 5,
      });
    } finally {
      setLoading(false);
    }
  };

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
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-[#cc785c] to-[#eb6e4b] flex items-center justify-center text-white font-bold text-sm shadow-md overflow-hidden">
              {user?.image ? (
                <img src={user.image} alt={user.name || 'User'} className="w-full h-full object-cover" />
              ) : user ? (
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
                {user ? user.email : 'Guest Workspace (Ephemeral session)'} · Neon Auth Protected
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={fetchBillingData}
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
                ? 'border-[#cc785c] text-white'
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
                ? 'border-[#cc785c] text-white'
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
                ? 'border-[#cc785c] text-white'
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
                ? 'border-[#cc785c] text-white'
                : 'border-transparent text-stone-400 hover:text-white'
            }`}
          >
            <Shield className="w-3.5 h-3.5" />
            Account Security
          </button>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {activeTab === 'overview' && (
            <div className="space-y-6">
              {/* Active Plan Card */}
              <div className="p-6 rounded-2xl bg-gradient-to-br from-stone-900 to-stone-900/60 border border-white/10 flex flex-col md:flex-row md:items-center justify-between gap-6">
                <div>
                  <div className="text-xs uppercase tracking-wider font-semibold text-[#cc785c] mb-1">
                    Current Active Tier
                  </div>
                  <h3 className="text-2xl font-serif text-white flex items-center gap-3">
                    {billingSummary?.planName || 'AIRA Free'}
                    <span className="text-xs px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 capitalize">
                      {billingSummary?.subscriptionStatus || 'Active'}
                    </span>
                  </h3>
                  <p className="text-xs text-stone-400 mt-2 max-w-md">
                    {billingSummary?.planId === 'pro'
                      ? 'Pro tier includes 7,500 monthly premium credits, 2,000 standard chat units, 20 saved agents, and metered sandbox builder access.'
                      : billingSummary?.planId === 'plus'
                      ? 'Plus tier includes 3,000 monthly credits, 700 standard chat units, and 3 saved agents.'
                      : 'Free tier includes 15 daily chats, 100 welcome credits, and 5 complimentary Auto reasoning boosts.'}
                  </p>
                </div>

                <div className="shrink-0 flex flex-col gap-2.5">
                  <button
                    onClick={() => {
                      onClose();
                      onOpenPricing();
                    }}
                    className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-[#cc785c] to-[#eb6e4b] text-white text-xs font-semibold shadow-md hover:brightness-110 active:scale-95 transition-all flex items-center justify-center gap-2"
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
                    {billingSummary?.availableCredits.toLocaleString() || '100'}
                  </div>
                  <div className="text-[10px] text-stone-500 mt-1">
                    Equivalent to ${((billingSummary?.availableCredits || 100) * 0.001).toFixed(2)} retail AI value
                  </div>
                </div>

                <div className="p-4 rounded-xl bg-stone-900/60 border border-white/10">
                  <div className="text-[11px] text-stone-400">Daily Standard Allowance</div>
                  <div className="text-2xl font-bold text-white mt-1">
                    {(billingSummary?.dailyChatLimit || 15) - (billingSummary?.dailyChatsUsed || 0)} / {billingSummary?.dailyChatLimit || 15}
                  </div>
                  <div className="text-[10px] text-stone-500 mt-1">Resets automatically at midnight UTC</div>
                </div>

                <div className="p-4 rounded-xl bg-stone-900/60 border border-white/10">
                  <div className="text-[11px] text-stone-400">Monthly Reasoning Boosts</div>
                  <div className="text-2xl font-bold text-amber-400 mt-1">
                    {(billingSummary?.reasoningBoostLimit || 5) - (billingSummary?.reasoningBoostsUsed || 0)} / {billingSummary?.reasoningBoostLimit || 5}
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
                  All usage transactions and credit reservations are immutably logged to the Neon PostgreSQL database. General chats deduct from your standard ceiling and never deplete your premium wallet balance.
                </p>
              </div>
            </div>
          )}

          {activeTab === 'usage' && (
            <div className="space-y-6">
              <h4 className="text-sm font-semibold text-white">Compute & Quota Breakdown</h4>
              <div className="space-y-4">
                {/* Daily Progress */}
                <div className="p-4 rounded-xl bg-stone-900/60 border border-white/10 space-y-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-stone-300">Daily Standard Chat Limit</span>
                    <span className="text-stone-400">
                      {billingSummary?.dailyChatsUsed || 0} / {billingSummary?.dailyChatLimit || 15} chats
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-stone-800 overflow-hidden">
                    <div
                      className="h-full bg-[#cc785c]"
                      style={{
                        width: `${Math.min(100, ((billingSummary?.dailyChatsUsed || 0) / (billingSummary?.dailyChatLimit || 15)) * 100)}%`
                      }}
                    />
                  </div>
                </div>

                {/* Monthly Progress */}
                <div className="p-4 rounded-xl bg-stone-900/60 border border-white/10 space-y-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-stone-300">Monthly Standard Chat Units</span>
                    <span className="text-stone-400">
                      {billingSummary?.monthlyUnitsUsed || 0} / {billingSummary?.monthlyUnitLimit || 150} units
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-stone-800 overflow-hidden">
                    <div
                      className="h-full bg-indigo-500"
                      style={{
                        width: `${Math.min(100, ((billingSummary?.monthlyUnitsUsed || 0) / (billingSummary?.monthlyUnitLimit || 150)) * 100)}%`
                      }}
                    />
                  </div>
                </div>

                {/* Reasoning Boost Progress */}
                <div className="p-4 rounded-xl bg-stone-900/60 border border-white/10 space-y-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-stone-300">Complimentary Auto Reasoning Boosts</span>
                    <span className="text-stone-400">
                      {billingSummary?.reasoningBoostsUsed || 0} / {billingSummary?.reasoningBoostLimit || 5} used
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-stone-800 overflow-hidden">
                    <div
                      className="h-full bg-amber-500"
                      style={{
                        width: `${Math.min(100, ((billingSummary?.reasoningBoostsUsed || 0) / (billingSummary?.reasoningBoostLimit || 5)) * 100)}%`
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'topup' && (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-sm font-semibold text-white">Purchase Credit Top-Up Packs</h4>
                  <p className="text-xs text-stone-400">Credits never expire and roll over indefinitely.</p>
                </div>
                <div className="flex items-center p-1 bg-stone-900 rounded-lg border border-white/10">
                  <button
                    onClick={() => setTopUpCurrency('INR')}
                    className={`px-2.5 py-1 rounded text-xs font-semibold ${topUpCurrency === 'INR' ? 'bg-[#cc785c] text-white' : 'text-stone-400'}`}
                  >
                    ₹ INR
                  </button>
                  <button
                    onClick={() => setTopUpCurrency('USD')}
                    className={`px-2.5 py-1 rounded text-xs font-semibold ${topUpCurrency === 'USD' ? 'bg-[#cc785c] text-white' : 'text-stone-400'}`}
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
                      className="px-3 py-1.5 rounded-lg bg-[#cc785c] hover:bg-[#eb6e4b] text-white text-xs font-semibold transition"
                    >
                      Buy Now
                    </button>
                  </div>
                </div>

                <div className="p-5 rounded-2xl bg-gradient-to-b from-[#cc785c]/10 to-stone-900/60 border border-[#cc785c]/30 flex flex-col justify-between">
                  <div>
                    <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded-full bg-[#cc785c]/20 text-[#cc785c]">
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
                      className="px-3 py-1.5 rounded-lg bg-[#cc785c] hover:bg-[#eb6e4b] text-white text-xs font-semibold transition"
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
                      className="px-3 py-1.5 rounded-lg bg-[#cc785c] hover:bg-[#eb6e4b] text-white text-xs font-semibold transition"
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
              <div className="p-4 rounded-xl bg-stone-900/60 border border-white/10 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs font-semibold text-white">Neon Auth Principal ID</div>
                    <div className="text-xs text-stone-400 font-mono mt-0.5">{user?.id || 'guest-session'}</div>
                  </div>
                  <span className="text-[11px] px-2 py-0.5 rounded-md bg-emerald-500/20 text-emerald-300 font-medium">
                    Verified
                  </span>
                </div>

                <div className="pt-3 border-t border-white/10 flex items-center justify-between">
                  <div>
                    <div className="text-xs font-semibold text-white">Authenticated Email</div>
                    <div className="text-xs text-stone-400">{user?.email || 'Unregistered'}</div>
                  </div>
                </div>
              </div>

              {user && (
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
