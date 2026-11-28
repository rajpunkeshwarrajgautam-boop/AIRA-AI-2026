import React, { useEffect, useRef, useState, useCallback, useMemo, useSyncExternalStore } from 'react';
import { 
  Settings, 
  X, 
  Check, 
  Download, 
  Upload, 
  Brain, 
  User, 
  Sliders, 
  ShieldCheck,
  Palette,
  FileCode2,
  Database,
  CreditCard,
  Keyboard,
  Eye,
  Lock,
  Layers,
  Zap,
  Clock,
  ArrowRight,
  AlertTriangle,
  ChevronRight,
  Info,
  CheckCircle2,
  TrendingUp,
  Shield,
  Lightbulb,
  Globe,
  FileText,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import type { AppSettings, Conversation, Project } from '../types';
import { AVAILABLE_MODELS } from '../utils/constants';
import { neonAuth, authenticatedApiFetch } from '../lib/neonAuth';
import { COMMERCIAL_PLANS, PlanTier, PaymentMethodSummary, GlobalBillingProfile } from '../types/commercial-types';
import { resetDismissedAnnouncements } from '../utils/announcements';
import { agentMemory } from '../utils/agentMemoryEngine';
import { createWorkspaceBackup, validateAndParseBackup } from '../utils/workspaceBackup';

export interface PresetTheme {
  id: NonNullable<AppSettings['aestheticPreset']>;
  name: string;
  badge: string;
  feature: string;
  swatches: [string, string, string];
}

export const PRESET_THEMES: PresetTheme[] = [
  {
    id: 'linear-precision',
    name: 'Aira Atelier',
    badge: 'Default',
    feature: 'Warm cream canvas, coral accents & editorial serif typography',
    swatches: ['#FAF9F5', '#181715', '#CC785C'],
  },
  {
    id: 'warm-parchment',
    name: 'Warm Parchment',
    badge: 'Antiquarian',
    feature: 'Antique book sepia & burnt copper halo',
    swatches: ['#F5EFEB', '#2C2016', '#BA582F'],
  },
  {
    id: 'liquid-glass',
    name: 'Liquid Glass',
    badge: 'VisionOS Specular',
    feature: 'Frosted crystal refractions & cobalt cyan',
    swatches: ['#EDF3F8', '#0A1629', '#0284C7'],
  },
  {
    id: 'industrial-brutalist',
    name: 'Industrial Brutalist',
    badge: 'Bauhaus Grid',
    feature: 'Architectural matte concrete & safety orange',
    swatches: ['#EDEDEA', '#0F0F0E', '#FF4D00'],
  },
  {
    id: 'nordic-moss',
    name: 'Nordic Earth',
    badge: 'Biophilic Sanctuary',
    feature: 'Scandinavian lichen & aurora emerald pulse',
    swatches: ['#F1F4EE', '#18261B', '#2E7D52'],
  },
  {
    id: 'solar-gold',
    name: 'Solaris Gold',
    badge: 'Haute Horlogerie',
    feature: '24K molten gold flare & champagne shimmer',
    swatches: ['#F7F5EE', '#0D0C09', '#E5B94E'],
  },
  {
    id: 'tokyo-neon',
    name: 'Tokyo Cyber',
    badge: 'Shibuya Night',
    feature: 'Laser scanline glow & dual-tone neon pulse',
    swatches: ['#090611', '#120D22', '#EC4899'],
  },
  {
    id: 'vanguard-monolith',
    name: 'Vanguard Monolith',
    badge: 'High Fashion',
    feature: 'Mirror platinum reflection & magnetic contrast',
    swatches: ['#F4F4F4', '#050505', '#FFFFFF'],
  },
];

export type SettingsTab = 'general' | 'plan' | 'reasoning' | 'memory' | 'instructions' | 'artifacts' | 'data';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSaveSettings: (settings: AppSettings) => void;
  conversations: Conversation[];
  projects: Project[];
  onImportData: (data: { conversations: Conversation[]; projects: Project[]; settings?: Partial<AppSettings> }) => void;
  onClearAll: () => void;
  onOpenMemoryVault?: () => void;
  initialTab?: string;
  onOpenBilling?: () => void;
  onOpenPricing?: () => void;
  onOpenShortcuts?: () => void;
  userTier?: PlanTier;
  onEntitlementsUpdated?: (planId: PlanTier) => void;
  onTriggerUpgrade?: (trigger: string) => void;
  onRestartOnboarding?: () => void;
  onResetAnnouncements?: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  onSaveSettings,
  conversations,
  projects,
  onImportData,
  onClearAll,
  onOpenMemoryVault,
  initialTab = 'general',
  onOpenBilling,
  onOpenPricing,
  onOpenShortcuts,
  userTier = 'guest',
  onEntitlementsUpdated,
  onTriggerUpgrade,
  onRestartOnboarding,
  onResetAnnouncements,
}) => {
  const resolveTab = (tab?: string): SettingsTab => {
    if (tab === 'appearance' || tab === 'accessibility') return 'general';
    if (tab === 'plan' || tab === 'billing' || tab === 'subscription' || tab === 'usage') return 'plan';
    if (tab === 'instructions' || tab === 'personalization') return 'instructions';
    if (tab === 'account' || tab === 'privacy' || tab === 'shortcuts') return 'data';
    if (tab === 'reasoning' || tab === 'memory' || tab === 'artifacts' || tab === 'data') return tab;
    return 'general';
  };

  const [activeTab, setActiveTab] = useState<SettingsTab>(() => resolveTab(initialTab));
  const [form, setForm] = useState<AppSettings>({ ...settings });
  const [saved, setSaved] = useState(false);
  const [announcementsReset, setAnnouncementsReset] = useState(false);
  const [currentUser, setCurrentUser] = useState(() => neonAuth.getCurrentUser());
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const closeHandler = useRef(onClose);

  useEffect(() => {
    if (isOpen) {
      setActiveTab(resolveTab(initialTab));
    }
  }, [isOpen, initialTab]);

  useEffect(() => {
    closeHandler.current = onClose;
  }, [onClose]);

  const [viewport, setViewport] = useState(() => ({
    top: 0, 
    left: 0,
    width: typeof window === 'undefined' ? 1024 : window.innerWidth,
    height: typeof window === 'undefined' ? 768 : window.innerHeight,
  }));
  const compactHeight = viewport.height < 430;

  const wasOpenRef = useRef(false);

  useEffect(() => {
    const unsubscribe = neonAuth.onAuthStateChange((user) => {
      setCurrentUser(user);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      setForm({ ...settings });
      setCurrentUser(neonAuth.getCurrentUser());
    }
    wasOpenRef.current = isOpen;
  }, [isOpen, settings]);

  interface ActiveSubscriptionSummary {
    id: string;
    planId: PlanTier;
    gateway: string;
    status?: string;
    cancelAtPeriodEnd: boolean;
    autoRenewalStatus?: 'active' | 'cancelled';
    cancellationStatus?: string | null;
    cancellationPending?: boolean;
    cancellationFailed?: boolean;
    lastCancellationError?: string | null;
    currentPeriodStart: number | null;
    currentPeriodEnd: number | null;
  }

  interface SubscriptionLifecycleSummary {
    state:
      | 'ACTIVE_RENEWING'
      | 'ACTIVE_CANCEL_SCHEDULED'
      | 'CANCELLATION_PENDING'
      | 'CANCELLATION_FAILED'
      | 'EXPIRED'
      | 'PAYMENT_PENDING'
      | 'REFUNDED'
      | 'FREE';
    planId: PlanTier | null;
    planName: string | null;
    gateway: string | null;
    currentPeriodEnd: number | null;
    cancelledAt: number | null;
    refundedAt: number | null;
    refundAmount: number | null;
    creditNoteNumber: string | null;
    lastError: string | null;
  }

  interface PendingSubscriptionSummary {
    id: string;
    planId: PlanTier;
    gateway: string;
    status: string;
    amountMinorUnits: number;
    currency: string;
    gatewaySubscriptionStatus: string | null;
    authorizationStatus: string | null;
    nextScheduleDate: string | null;
    lastPaymentError: string | null;
    hasAuthorizedMandate?: boolean;
    immediateAuthChargeExpected?: boolean;
    canCancelPending?: boolean;
    createdAt: number;
  }

  interface UsageData {
    planId: PlanTier;
    planName: string;
    dailyChatsUsed: number;
    dailyChatsLimit: number;
    remainingDailyChats: number;
    monthlyCreditsRemaining: number;
    reasoningBoostsRemaining: number;
    resetAt: string;
    paymentCollectionDisabled: boolean;
    checkoutAvailable: boolean;
    billingStatus: string;
    activeSubscription: ActiveSubscriptionSummary | null;
    pendingSubscription: PendingSubscriptionSummary | null;
    subscriptionLifecycle: SubscriptionLifecycleSummary | null;
    paymentMethods?: PaymentMethodSummary[];
    billingProfile?: GlobalBillingProfile | null;
    supplierIdentity?: {
      legalName?: string;
      tradeName?: string;
      stateCode?: string;
      stateName?: string;
      supportEmail?: string;
    };
  }

  const isGuestUser = userTier === 'guest' || !currentUser;
  const [usageData, setUsageData] = useState<UsageData | null>(null);
  const [isUsageLoading, setIsUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState(false);
  const [summaryUnavailable, setSummaryUnavailable] = useState(false);

  const fetchUsage = useCallback(async () => {
    setIsUsageLoading((prev) => (usageData ? prev : true));
    setUsageError(false);
    setSummaryUnavailable(false);
    try {
      const [res, summaryRes] = await Promise.all([
        authenticatedApiFetch('/api/billing/entitlements'),
        authenticatedApiFetch('/api/billing/summary').catch(() => null)
      ]);
      if (!res.ok) throw new Error('Unable to verify current entitlements.');
      const entitlements = await res.json();
      let summary: any = null;
      if (summaryRes && summaryRes.ok) {
        summary = await summaryRes.json().catch(() => null);
      } else if (!isGuestUser && (entitlements.plan === 'plus' || entitlements.plan === 'pro')) {
        setSummaryUnavailable(true);
      }
      const planId = entitlements.plan as PlanTier;
      if (!Object.prototype.hasOwnProperty.call(COMMERCIAL_PLANS, planId) ||
          !Number.isFinite(entitlements.dailyStandardChatRemaining) ||
          !Number.isFinite(entitlements.dailyStandardChatLimit) ||
          !Number.isFinite(entitlements.availableCredits) ||
          !Number.isFinite(entitlements.reasoningBoostsRemaining)) {
        throw new Error('Invalid entitlement response.');
      }

      // Authoritative consistency check:
      // If client session is unauthenticated / guest, server MUST classify plan as 'guest'.
      // If server returned a paid or free subscriber plan for an unauthenticated visitor, fail visibly!
      if (isGuestUser && planId !== 'guest') {
        throw new Error('Inconsistent entitlement response: unauthenticated session returned non-guest plan.');
      }
      if (!isGuestUser && planId === 'guest') {
        // Reconcile: If client state had cached user, but authoritative server returned guest plan,
        // invalidate stale client session and adopt guest state gracefully instead of permanently crashing.
        neonAuth.saveSession(null);
        setCurrentUser(null);
      } else if (planId !== userTier) {
        onEntitlementsUpdated?.(planId);
      }

      const now = new Date();
      const tomorrowUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
      const dailyChatsLimit = entitlements.dailyStandardChatLimit;
      const remainingDailyChats = Math.min(dailyChatsLimit, Math.max(0, entitlements.dailyStandardChatRemaining));
      const dailyChatsUsed = Math.max(0, dailyChatsLimit - remainingDailyChats);
      const checkoutAvailable = Boolean(entitlements.checkoutAvailable);
      const serverBillingStatus = entitlements.billingStatus || (planId === 'guest' ? 'Guest Trial Session' : (checkoutAvailable ? 'Active' : 'Sandbox billing — checkout is unavailable'));
      setUsageData({
        planId,
        planName: COMMERCIAL_PLANS[planId].name,
        dailyChatsUsed,
        dailyChatsLimit,
        remainingDailyChats,
        monthlyCreditsRemaining: entitlements.availableCredits,
        reasoningBoostsRemaining: entitlements.reasoningBoostsRemaining,
        resetAt: tomorrowUtc.toISOString(),
        paymentCollectionDisabled: !checkoutAvailable,
        checkoutAvailable,
        billingStatus: serverBillingStatus,
        activeSubscription: summary?.activeSubscription || null,
        pendingSubscription: summary?.pendingSubscription || null,
        subscriptionLifecycle: summary?.subscriptionLifecycle || null,
        paymentMethods: Array.isArray(summary?.paymentMethods) ? summary.paymentMethods : [],
        billingProfile: summary?.billingProfile || null,
        supplierIdentity: summary?.supplierIdentity
      });
    } catch (err) {
      console.warn('[SettingsModal] fetchUsage error:', err);
      // Never fabricate an active plan or quota figures when the API is offline or inconsistent.
      setUsageError(true);
    } finally {
      setIsUsageLoading(false);
    }
  }, [isGuestUser, onEntitlementsUpdated, userTier]);

  const [invoices, setInvoices] = useState<any[]>([]);
  const [creditNotes, setCreditNotes] = useState<any[]>([]);
  const [isLoadingInvoices, setIsLoadingInvoices] = useState(false);
  const [invoicesError, setInvoicesError] = useState<string | null>(null);
  const [isCancellingSub, setIsCancellingSub] = useState(false);
  const [cancelMessage, setCancelMessage] = useState<string | null>(null);
  const [isReconcilingPending, setIsReconcilingPending] = useState(false);
  const [isCancellingPending, setIsCancellingPending] = useState(false);
  const [reconcileMessage, setReconcileMessage] = useState<string | null>(null);
  const [downloadingInvoiceNum, setDownloadingInvoiceNum] = useState<string | null>(null);
  const [downloadingPdfNum, setDownloadingPdfNum] = useState<string | null>(null);
  const [downloadingCnNum, setDownloadingCnNum] = useState<string | null>(null);
  const [countriesList, setCountriesList] = useState<Array<{ code: string; name: string; defaultCurrency: string }>>([
    { code: 'US', name: 'United States', defaultCurrency: 'USD' },
    { code: 'IN', name: 'India', defaultCurrency: 'INR' },
    { code: 'GB', name: 'United Kingdom', defaultCurrency: 'USD' },
    { code: 'CA', name: 'Canada', defaultCurrency: 'USD' },
    { code: 'AU', name: 'Australia', defaultCurrency: 'USD' },
    { code: 'DE', name: 'Germany', defaultCurrency: 'USD' },
    { code: 'SG', name: 'Singapore', defaultCurrency: 'USD' }
  ]);
  const [taxCountry, setTaxCountry] = useState<string>('IN');
  const [taxAccountType, setTaxAccountType] = useState<'individual' | 'business'>('individual');
  const [taxJurisdictions, setTaxJurisdictions] = useState<Array<{ code: string; name: string }>>([]);
  const [taxStateCode, setTaxStateCode] = useState<string>('');
  const [taxLegalName, setTaxLegalName] = useState<string>('');
  const [taxGstin, setTaxGstin] = useState<string>('');
  const [taxIdValue, setTaxIdValue] = useState<string>('');
  const [taxAddress, setTaxAddress] = useState<string>('');
  const [taxProfileSaving, setTaxProfileSaving] = useState<boolean>(false);
  const [taxProfileMsg, setTaxProfileMsg] = useState<string | null>(null);
  const [taxProfileError, setTaxProfileError] = useState<string | null>(null);
  const returnReconciledSubRef = useRef<string | null>(null);

  const fetchInvoices = useCallback(async () => {
    if (isGuestUser) return;
    setIsLoadingInvoices(true);
    setInvoicesError(null);
    try {
      const [invRes, cnRes] = await Promise.all([
        authenticatedApiFetch('/api/billing/invoices'),
        authenticatedApiFetch('/api/billing/credit-notes').catch(() => null)
      ]);
      if (!invRes.ok) {
        const errData = await invRes.json().catch(() => ({} as Record<string, any>));
        throw new Error(errData?.error || 'Unable to load billing history right now.');
      }
      const invData = await invRes.json();
      setInvoices(Array.isArray(invData?.invoices) ? invData.invoices : []);
      if (cnRes && cnRes.ok) {
        const cnData = await cnRes.json().catch(() => ({} as Record<string, any>));
        setCreditNotes(Array.isArray(cnData?.creditNotes) ? cnData.creditNotes : []);
      }
    } catch (err: any) {
      setInvoices([]);
      setInvoicesError(err?.message || 'Unable to load billing history right now.');
    } finally {
      setIsLoadingInvoices(false);
    }
  }, [isGuestUser]);

  const fetchTaxProfile = useCallback(async () => {
    if (isGuestUser) {
      setTaxCountry('IN');
      setTaxAccountType('individual');
      setTaxStateCode('');
      setTaxLegalName('');
      setTaxGstin('');
      setTaxIdValue('');
      setTaxAddress('');
      return;
    }
    try {
      let res = await authenticatedApiFetch('/api/billing/profile');
      if (!res.ok) {
        res = await authenticatedApiFetch('/api/billing/tax-profile');
      }
      if (!res.ok) {
        setTaxStateCode('');
        setTaxLegalName('');
        setTaxGstin('');
        setTaxIdValue('');
        setTaxAddress('');
        return;
      }
      const data = await res.json().catch(() => ({} as Record<string, any>));
      if (Array.isArray(data?.countries) && data.countries.length > 0) {
        setCountriesList(data.countries);
      }
      if (Array.isArray(data?.jurisdictions)) {
        setTaxJurisdictions(data.jurisdictions);
      }
      if (data?.profile) {
        setTaxCountry(String(data.profile.country || 'IN').toUpperCase());
        setTaxAccountType(data.profile.accountType === 'business' || data.profile.customerGstin ? 'business' : 'individual');
        setTaxStateCode(String(data.profile.stateCode || ''));
        setTaxLegalName(String(data.profile.legalName || ''));
        setTaxGstin(String(data.profile.customerGstin || ''));
        setTaxIdValue(String(data.profile.taxId || ''));
        setTaxAddress(String(data.profile.addressLine1 || ''));
      } else {
        setTaxStateCode('');
        setTaxLegalName('');
        setTaxGstin('');
        setTaxIdValue('');
        setTaxAddress('');
      }
    } catch {
      setTaxStateCode('');
      setTaxLegalName('');
      setTaxGstin('');
      setTaxIdValue('');
      setTaxAddress('');
    }
  }, [isGuestUser]);

  const handleSaveTaxProfile = async () => {
    setTaxProfileSaving(true);
    setTaxProfileMsg(null);
    setTaxProfileError(null);

    const isIndia = taxCountry === 'IN';
    const trimmedGstin = isIndia && taxAccountType === 'business' ? taxGstin.trim().toUpperCase() : '';
    if (trimmedGstin) {
      if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(trimmedGstin) || trimmedGstin.startsWith('25')) {
        setTaxProfileError('Enter a valid 15-character Indian GSTIN (or clear the field).');
        setTaxProfileSaving(false);
        return;
      }
      if (taxStateCode && trimmedGstin.slice(0, 2) !== taxStateCode) {
        setTaxProfileError(`GSTIN state prefix (${trimmedGstin.slice(0, 2)}) must match selected State (${taxStateCode}).`);
        setTaxProfileSaving(false);
        return;
      }
    }

    try {
      const res = await authenticatedApiFetch('/api/billing/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          country: taxCountry,
          accountType: taxAccountType,
          stateCode: taxStateCode || undefined,
          legalName: taxLegalName.trim() || undefined,
          customerGstin: isIndia ? (trimmedGstin || '') : '',
          taxId: !isIndia && taxAccountType === 'business' ? (taxIdValue.trim() || '') : '',
          addressLine1: taxAddress.trim() || undefined
        })
      });
      const data = await res.json().catch(() => ({} as Record<string, any>));
      if (!res.ok) {
        setTaxProfileError(data?.message || data?.error || 'Failed to save billing information.');
        return;
      }
      if (data?.profile?.country) setTaxCountry(String(data.profile.country).toUpperCase());
      if (data?.profile?.stateCode !== undefined) setTaxStateCode(String(data.profile.stateCode || ''));
      if (data?.profile?.customerGstin !== undefined) setTaxGstin(String(data.profile.customerGstin || ''));
      if (data?.profile?.taxId !== undefined) setTaxIdValue(String(data.profile.taxId || ''));
      setTaxProfileMsg('Billing information saved.');
    } catch (err: any) {
      setTaxProfileError(err?.message || 'Unable to save billing information.');
    } finally {
      setTaxProfileSaving(false);
    }
  };

  const handleReconcilePending = useCallback(async (subscriptionId: string) => {
    setIsReconcilingPending(true);
    setReconcileMessage(null);
    try {
      const res = await authenticatedApiFetch(`/api/billing/subscriptions/${encodeURIComponent(subscriptionId)}/reconcile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await res.json().catch(() => ({} as Record<string, any>));
      setReconcileMessage(data?.message || data?.error || 'Reconciliation check finished.');
      await fetchUsage();
      await fetchInvoices();
    } catch (err: any) {
      setReconcileMessage(err?.message || 'Unable to contact billing reconciliation service.');
    } finally {
      setIsReconcilingPending(false);
    }
  }, [fetchUsage, fetchInvoices]);

  const handleCancelPending = async (subscriptionId: string, allowCancelAuthorizedMandate = false) => {
    setIsCancellingPending(true);
    setReconcileMessage(null);
    try {
      const res = await authenticatedApiFetch(`/api/billing/subscriptions/${encodeURIComponent(subscriptionId)}/cancel-pending`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: allowCancelAuthorizedMandate ? 'user_cancel_authorized_mandate' : 'user_cancel_pending',
          allowCancelAuthorizedMandate
        })
      });
      const data = await res.json().catch(() => ({} as Record<string, any>));
      setReconcileMessage(data?.message || data?.error || 'Pending checkout updated.');
      await fetchUsage();
      await fetchInvoices();
    } catch (err: any) {
      setReconcileMessage(err?.message || 'Unable to cancel pending checkout right now.');
    } finally {
      setIsCancellingPending(false);
    }
  };

  const downloadBillingDocument = async (params: {
    endpoint: string;
    filename: string;
    mimeType: string;
    errorLabel: string;
    setBusy: (busy: boolean) => void;
  }) => {
    params.setBusy(true);
    try {
      const res = await authenticatedApiFetch(params.endpoint);
      if (!res.ok) {
        const errData = await res.json().catch(() => ({} as any));
        alert(errData.error || params.errorLabel);
        return;
      }
      const blob = params.mimeType.includes('pdf')
        ? await res.blob()
        : new Blob([await res.text()], { type: params.mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = params.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      alert(err?.message || params.errorLabel);
    } finally {
      params.setBusy(false);
    }
  };

  const handleDownloadInvoice = (invoiceNumber: string) =>
    downloadBillingDocument({
      endpoint: `/api/billing/invoices/${encodeURIComponent(invoiceNumber)}/download`,
      filename: `AIRA-GST-Invoice-${invoiceNumber.replace(/[^a-zA-Z0-9_-]/g, '-')}.html`,
      mimeType: 'text/html;charset=utf-8',
      errorLabel: 'Failed to load A4 invoice.',
      setBusy: (busy) => setDownloadingInvoiceNum(busy ? invoiceNumber : null)
    });

  const handleDownloadInvoicePdf = (invoiceNumber: string) =>
    downloadBillingDocument({
      endpoint: `/api/billing/invoices/${encodeURIComponent(invoiceNumber)}/pdf`,
      filename: `AIRA-Invoice-${invoiceNumber.replace(/[^a-zA-Z0-9_-]/g, '-')}.pdf`,
      mimeType: 'application/pdf',
      errorLabel: 'Failed to download PDF invoice.',
      setBusy: (busy) => setDownloadingPdfNum(busy ? invoiceNumber : null)
    });

  const handleDownloadCreditNotePdf = (creditNoteNumber: string) =>
    downloadBillingDocument({
      endpoint: `/api/billing/credit-notes/${encodeURIComponent(creditNoteNumber)}/pdf`,
      filename: `AIRA-Credit-Note-${creditNoteNumber.replace(/[^a-zA-Z0-9_-]/g, '-')}.pdf`,
      mimeType: 'application/pdf',
      errorLabel: 'Failed to download PDF credit note.',
      setBusy: (busy) => setDownloadingPdfNum(busy ? creditNoteNumber : null)
    });

  const handleDownloadCreditNote = (creditNoteNumber: string) =>
    downloadBillingDocument({
      endpoint: `/api/billing/credit-notes/${encodeURIComponent(creditNoteNumber)}/download`,
      filename: `AIRA-GST-Credit-Note-${creditNoteNumber.replace(/[^a-zA-Z0-9_-]/g, '-')}.html`,
      mimeType: 'text/html;charset=utf-8',
      errorLabel: 'Failed to load A4 credit note.',
      setBusy: (busy) => setDownloadingCnNum(busy ? creditNoteNumber : null)
    });

  const handleCancelSubscription = async () => {
    if (!window.confirm('Are you sure you want to cancel your recurring subscription? Your entitlements will remain active until the end of the current billing cycle.')) {
      return;
    }
    setIsCancellingSub(true);
    try {
      const res = await authenticatedApiFetch('/api/billing/subscription/cancel', {
        method: 'POST'
      });
      const data = await res.json().catch(() => ({} as Record<string, any>));
      if (res.ok && data.success) {
        setCancelMessage(data.message || 'Subscription cancellation scheduled at period end.');
        await fetchUsage();
        await fetchInvoices();
      } else {
        await fetchUsage();
        alert(data.error || data.message || 'Failed to cancel subscription.');
      }
    } catch (err: any) {
      await fetchUsage().catch(() => {});
      alert(err.message || 'Error communicating with billing server.');
    } finally {
      setIsCancellingSub(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      void fetchUsage();
      void fetchInvoices();
      void fetchTaxProfile();
      if (!isGuestUser) {
        try {
          if (typeof sessionStorage !== 'undefined') {
            const rawReturn = sessionStorage.getItem('aira_cashfree_return_sub');
            if (rawReturn) {
              const parsed = JSON.parse(rawReturn);
              sessionStorage.removeItem('aira_cashfree_return_sub');
              if (parsed?.subId && returnReconciledSubRef.current !== parsed.subId) {
                returnReconciledSubRef.current = parsed.subId;
                void handleReconcilePending(String(parsed.subId));
              }
            }
          }
        } catch {}
      }
    }
  }, [isOpen, isGuestUser, userTier, fetchUsage, fetchInvoices, handleReconcilePending]);

  const activePlanId: PlanTier = usageData ? usageData.planId : (isGuestUser ? 'guest' : (userTier || 'free'));
  const activePlanDef = COMMERCIAL_PLANS[activePlanId] || COMMERCIAL_PLANS.free;
  const projectLimit = activePlanDef.maxProjects;
  const memoryLimit = activePlanDef.maxMemoryRecords;
  const isProjectsExceeded = projectLimit !== -1 && projects.length > projectLimit;
  const memorySnapshot = useSyncExternalStore(agentMemory.subscribe, agentMemory.getSnapshot, () => []);
  const memoryCount = memorySnapshot.length;
  const isMemoryExceeded = memoryLimit !== -1 && memoryCount > memoryLimit;

  const dailyChatsLimit = usageData?.dailyChatsLimit ?? activePlanDef.dailyStandardChatLimit;
  const dailyChatsUsed = usageData?.dailyChatsUsed ?? 0;
  const remainingDailyChats = usageData?.remainingDailyChats ?? Math.max(0, dailyChatsLimit - dailyChatsUsed);
  const dailyChatsPct = dailyChatsLimit > 0 ? Math.min(100, Math.round((dailyChatsUsed / dailyChatsLimit) * 100)) : 0;
  const creditsRemaining = usageData?.monthlyCreditsRemaining ?? activePlanDef.monthlyPremiumCredits;
  const creditsLimit = activePlanDef.monthlyPremiumCredits;
  const reasoningBoostsRemaining = usageData?.reasoningBoostsRemaining ?? activePlanDef.complimentaryReasoningBoosts;
  const reasoningBoostsLimit = activePlanDef.complimentaryReasoningBoosts;

  useEffect(() => {
    if (!isOpen) return;
    const visual = window.visualViewport;
    const measure = () => setViewport({
      top: visual?.offsetTop ?? 0,
      left: visual?.offsetLeft ?? 0,
      width: visual?.width ?? window.innerWidth,
      height: visual?.height ?? window.innerHeight,
    });
    measure();
    window.addEventListener('resize', measure);
    visual?.addEventListener('resize', measure);
    visual?.addEventListener('scroll', measure);
    requestAnimationFrame(() => closeButtonRef.current?.focus({ preventScroll: true }));

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeHandler.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const tabbable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href]'
      ) || []).filter(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
      if (!tabbable.length) return;
      const first = tabbable[0], last = tabbable[tabbable.length - 1];
      if (!dialogRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('resize', measure);
      visual?.removeEventListener('resize', measure);
      visual?.removeEventListener('scroll', measure);
      document.removeEventListener('keydown', handleKey);
    };
  }, [isOpen]);

  const save = () => {
    onSaveSettings(form);
    setSaved(true);
    setTimeout(() => {
      setSaved(false);
      onClose();
    }, 500);
  };

  const exportData = () => {
    const backupJson = createWorkspaceBackup(conversations, projects, form, currentUser?.id || 'guest');
    const blob = new Blob([backupJson], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; 
    a.download = `aira-workspace-${new Date().toISOString().slice(0, 10)}.json`; 
    a.click();
    URL.revokeObjectURL(url);
  };

  const importData = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; 
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const text = String(ev.target?.result || '');
        const parseResult = validateAndParseBackup(text, conversations, projects);
        if (!parseResult.valid || !parseResult.data) {
          alert(`Import failed: ${parseResult.error || 'Invalid Aira backup format.'}`);
          return;
        }

        onImportData({
          conversations: parseResult.data.conversations,
          projects: parseResult.data.projects,
          settings: parseResult.data.preferences as any,
        });

        if (parseResult.data.preferences) {
          setForm(prev => ({ ...prev, ...parseResult.data!.preferences }));
        }

        alert(`Successfully imported ${parseResult.data.conversations.length} conversation(s) and ${parseResult.data.projects.length} project(s).`);
      } catch (err: any) { 
        alert(`Failed to import backup: ${err.message || 'Invalid JSON format'}`); 
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleResetAnnouncements = () => {
    resetDismissedAnnouncements(currentUser?.id);
    onResetAnnouncements?.();
    setAnnouncementsReset(true);
    setTimeout(() => setAnnouncementsReset(false), 2000);
  };

  const handleRestartOnboarding = () => {
    onClose();
    onRestartOnboarding?.();
  };

  const tabs: Array<{ id: SettingsTab; label: string; icon: React.ReactNode }> = [
    { id: 'general', label: 'General & Appearance', icon: <Palette className="w-4 h-4" /> },
    { id: 'plan', label: 'My Plan & Usage', icon: <CreditCard className="w-4 h-4 text-claude-accentInk" /> },
    { id: 'reasoning', label: 'Model & Reasoning', icon: <Brain className="w-4 h-4" /> },
    { id: 'memory', label: 'Agent Memory', icon: <Database className="w-4 h-4" /> },
    { id: 'instructions', label: 'Personalization', icon: <Sliders className="w-4 h-4" /> },
    { id: 'artifacts', label: 'Artifact Studio', icon: <FileCode2 className="w-4 h-4" /> },
    { id: 'data', label: 'Account & Privacy', icon: <ShieldCheck className="w-4 h-4" /> },
  ];

  return (
    <AnimatePresence>
      {isOpen && (
        <div 
          data-testid="settings-viewport"
          className="fixed z-[70] flex items-center justify-center p-2 sm:p-6 select-none"
          style={{ top: viewport.top, left: viewport.left, width: viewport.width, height: viewport.height }}
        >
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="absolute inset-0 bg-stone-900/40 dark:bg-black/60 backdrop-blur-md"
            onClick={onClose}
          />
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="aira-settings-title"
            tabIndex={-1}
            data-testid="settings-dialog"
            initial={{ opacity: 0, scale: 0.96, y: 15 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 10 }}
            transition={{ type: "spring", stiffness: 350, damping: 28 }}
            style={{ maxHeight: Math.max(0, viewport.height - (viewport.width >= 640 ? 48 : 16)) }}
            className={`aira-settings-dialog w-full min-w-0 max-w-3xl h-full max-h-full sm:h-auto sm:max-h-[min(90dvh,900px)] rounded-2xl sm:rounded-[1.75rem] border border-claude-border-light dark:border-claude-border-dark bg-claude-surface-light dark:bg-claude-surface-dark shadow-2xl dark:shadow-lg flex flex-col relative z-10 ${compactHeight ? 'overflow-y-auto overscroll-contain' : 'overflow-hidden'}`}
          >
            {/* Header */}
            <header 
              data-testid="settings-header" 
              className="shrink-0 px-3 sm:px-7 py-3 sm:py-4 border-b border-claude-border-light dark:border-claude-border-dark flex items-start justify-between gap-2 bg-claude-surface2-light dark:bg-claude-surface2-dark"
            >
              <div className="flex min-w-0 items-start gap-2 sm:gap-3">
                <div className="shrink-0 p-2 rounded-xl bg-claude-terracotta/10 text-claude-accentInk">
                  <Settings className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <h2 id="aira-settings-title" className="font-bold text-base sm:text-lg tracking-tight leading-snug text-claude-text-light dark:text-white">
                    Workspace Settings
                  </h2>
                  <p className="text-[11px] font-medium text-claude-muted-light dark:text-claude-muted-dark">
                    Preferences, intelligence, accessibility, and account management
                  </p>
                </div>
              </div>
              <motion.button
                ref={closeButtonRef}
                type="button"
                aria-label="Close settings"
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={onClose}
                className="shrink-0 min-h-10 min-w-10 flex items-center justify-center p-2 rounded-xl hover:bg-claude-surface-light dark:hover:bg-claude-surface-dark text-claude-muted-light dark:text-claude-muted-dark transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-terracotta active:scale-[0.99]"
              >
                <X className="w-5 h-5" />
              </motion.button>
            </header>

            {/* Mobile section dropdown (strict 6 options for responsive tests) */}
            <div data-testid="settings-mobile-navigation" className="shrink-0 px-3 py-2 border-b border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light/60 dark:bg-claude-surface2-dark/60 sm:hidden">
              <label htmlFor="aira-settings-section" className="block mb-1 text-[11px] font-semibold text-claude-muted-light dark:text-claude-muted-dark">Settings section</label>
              <select
                id="aira-settings-section"
                aria-label="Settings section"
                value={activeTab}
                onChange={event => setActiveTab(event.target.value as SettingsTab)}
                className="w-full min-w-0 rounded-xl border border-claude-border-light dark:border-claude-border-dark bg-claude-surface-light dark:bg-claude-surface-dark text-claude-text-light dark:text-white px-3 py-2.5 text-sm font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-claude-terracotta"
              >
                {tabs.map(tab => <option key={tab.id} value={tab.id}>{tab.label}</option>)}
              </select>
            </div>

            {/* Desktop Tab Strip (all tabs wrap cleanly with zero horizontal scrollbar) */}
            <div role="tablist" aria-label="Settings categories" data-testid="settings-desktop-tabs" className="hidden sm:flex flex-wrap shrink-0 border-b border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light/60 dark:bg-claude-surface2-dark/60 px-4 sm:px-6 gap-1 pt-2 pb-1">
              {tabs.map(tab => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  id={`aira-settings-tab-${tab.id}`} data-testid={`settings-tab-${tab.id}`}
                  aria-controls="aira-settings-panel"
                  className={`shrink-0 flex items-center gap-1.5 px-2.5 py-2 text-xs font-semibold rounded-t-xl transition-colors motion-reduce:transition-none border-b-2 whitespace-nowrap ${
                    activeTab === tab.id
                      ? 'border-claude-terracotta text-claude-accentInk bg-claude-surface-light dark:bg-claude-surface-dark shadow-sm'
                      : 'border-transparent text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light dark:hover:text-white'
                  }`}
                >
                  {tab.icon}
                  <span>{tab.label}</span>
                </button>
              ))}
            </div>

            {/* Tab Body */}
            <div id="aira-settings-panel" data-testid="settings-content" className={`min-w-0 p-3 sm:p-7 space-y-6 bg-transparent ${compactHeight ? 'shrink-0' : 'min-h-0 flex-1 overflow-y-auto overscroll-contain'}`}>
              
              {/* TAB 1: GENERAL & APPEARANCE */}
              {activeTab === 'general' && (
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
                  <div>
                    <label htmlFor="aira-settings-name" className="text-xs font-semibold text-claude-muted-light dark:text-claude-muted-dark block mb-2">Display Name</label>
                    <input 
                      id="aira-settings-name"
                      value={form.userName} 
                      onChange={e => setForm({ ...form, userName: e.target.value })} 
                      placeholder="Enter your name (e.g. Punkeshwar)" 
                      className="w-full px-4 py-3 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark text-[13px] font-medium outline-none focus:border-claude-terracotta focus:ring-2 focus:ring-claude-terracotta/20 transition-colors motion-reduce:transition-none placeholder:text-claude-muted-light/50" 
                    />
                    <p className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark mt-1">Used to personalize dynamic greetings and conversation synthesis.</p>
                  </div>

                  <div>
                    <label htmlFor="aira-settings-email" className="text-xs font-semibold text-claude-muted-light dark:text-claude-muted-dark block mb-2">Account Email</label>
                    <div className="relative">
                      <input 
                        id="aira-settings-email"
                        value={currentUser?.email || 'Not signed in (Guest Workspace)'} 
                        readOnly
                        disabled
                        aria-readonly="true"
                        title="Account email is bound to your verified authentication identity."
                        className="w-full px-4 py-3 rounded-xl bg-claude-surface2-light/60 dark:bg-claude-surface2-dark/60 border border-claude-border-light dark:border-claude-border-dark text-[13px] font-medium text-claude-muted-light dark:text-claude-muted-dark outline-none cursor-not-allowed select-none" 
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-bold px-2 py-0.5 rounded-full bg-claude-surface2-light dark:bg-white/10 text-claude-muted-light border border-claude-border-light/60 dark:border-white/10">
                        {currentUser ? 'Verified OAuth' : 'Guest'}
                      </span>
                    </div>
                    <p className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark mt-1">
                      {currentUser 
                        ? 'Email is managed through your verified sign-in provider.' 
                        : 'Sign in with Google or GitHub to link your email and sync workspace history.'}
                    </p>
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-claude-muted-light dark:text-claude-muted-dark block mb-2">Theme Mode</label>
                    <div className="grid grid-cols-3 gap-2.5">
                      {(['light','dark','system'] as const).map(theme => (
                        <button 
                          type="button"
                          key={theme} 
                          onClick={() => {
                            setForm({ ...form, theme });
                            onSaveSettings({ ...settings, ...form, theme });
                          }} 
                          className={`py-2.5 rounded-xl border text-[13px] font-bold capitalize transition-colors motion-reduce:transition-none ${
                            form.theme === theme 
                              ? 'border-claude-terracotta bg-claude-terracotta-hover text-claude-onAccent shadow-sm'
                              : 'border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light dark:bg-claude-surface2-dark text-claude-muted-light dark:text-claude-muted-dark hover:border-claude-terracotta/40'
                          }`}
                        >
                          {theme}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 8 Aesthetic Presets */}
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <label className="text-xs font-semibold text-claude-muted-light dark:text-claude-muted-dark block">
                        Aesthetic Preset & Visual System
                      </label>
                      <span className="text-[10px] font-semibold text-claude-accentInk bg-claude-terracotta/10 px-2 py-0.5 rounded-full">
                        8 Curated Systems
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      {PRESET_THEMES.map(preset => {
                        const isSelected = (form.aestheticPreset || 'linear-precision') === preset.id;
                        return (
                          <motion.button
                            key={preset.id}
                            type="button"
                            whileHover={{ scale: 1.01 }}
                            whileTap={{ scale: 0.99 }}
                            onClick={() => {
                              setForm({ ...form, aestheticPreset: preset.id });
                              onSaveSettings({ ...settings, ...form, aestheticPreset: preset.id });
                            }}
                            className={`p-3 rounded-2xl border text-left transition-colors motion-reduce:transition-none relative overflow-hidden flex flex-col justify-between ${
                              isSelected
                                ? 'border-claude-terracotta bg-claude-terracotta/5 dark:bg-claude-terracotta/10 shadow-sm ring-1 ring-claude-terracotta'
                                : 'border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light dark:bg-claude-surface2-dark/60 hover:border-claude-terracotta/40'
                            }`}
                          >
                            <div className="flex items-start justify-between gap-2 mb-2">
                              <div>
                                <div className="text-[13px] font-bold text-claude-text-light dark:text-white flex items-center gap-1.5">
                                  <span>{preset.name}</span>
                                  {isSelected && <Check className="w-3.5 h-3.5 text-claude-terracotta" />}
                                </div>
                                <span className="text-[11px] font-semibold text-claude-accentInk">
                                  {preset.badge}
                                </span>
                              </div>
                              <div className="flex items-center -space-x-1.5 shrink-0 p-1 rounded-lg bg-black/5 dark:bg-white/5 border border-black/5 dark:border-white/5">
                                {preset.swatches.map((color, idx) => (
                                  <span
                                    key={idx}
                                    className="w-3.5 h-3.5 rounded-full border border-white/60 dark:border-black/60 shadow-xs"
                                    style={{ backgroundColor: color }}
                                  />
                                ))}
                              </div>
                            </div>
                            <p className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark leading-snug">
                              {preset.feature}
                            </p>
                          </motion.button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Accessibility Section within General */}
                  <div className="p-4 rounded-xl border border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light/40 dark:bg-claude-surface2-dark/40 space-y-4">
                    <div className="flex items-center gap-2">
                      <Eye className="w-4 h-4 text-claude-accentInk" />
                      <span className="text-xs font-semibold text-claude-text-light dark:text-white">
                        Accessibility & Motion
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs font-medium text-claude-muted-light block mb-1">Reduced Motion</label>
                        <select
                          aria-label="Reduced Motion" value={form.reducedMotion || 'system'}
                          onChange={e => setForm({ ...form, reducedMotion: e.target.value as any })}
                          className="w-full px-3 py-2 rounded-lg bg-claude-surface-light dark:bg-black/20 border border-claude-border-light dark:border-claude-border-dark text-xs font-medium"
                        >
                          <option value="system">Follow System</option>
                          <option value="always">Reduce Motion</option>
                          <option value="never">Full Animations</option>
                        </select>
                      </div>

                      <div>
                        <label className="text-xs font-medium text-claude-muted-light block mb-1">Font Scale</label>
                        <select
                          aria-label="Font Scale" value={form.fontSize || 'base'}
                          onChange={e => setForm({ ...form, fontSize: e.target.value as any })}
                          className="w-full px-3 py-2 rounded-lg bg-claude-surface-light dark:bg-black/20 border border-claude-border-light dark:border-claude-border-dark text-xs font-medium"
                        >
                          <option value="sm">Compact (13px)</option>
                          <option value="base">Standard (14px)</option>
                          <option value="lg">Large (16px)</option>
                        </select>
                      </div>
                    </div>

                    <div className="flex items-center justify-between pt-2 border-t border-claude-border-light/60 dark:border-claude-border-dark/60">
                      <div>
                        <div className="text-xs font-bold text-claude-text-light dark:text-white">High Contrast Outlines</div>
                        <div className="text-[10px] text-claude-muted-light">Enhance contrast ratios for borders and focus indicators.</div>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          checked={form.highContrast === true}
                          onChange={e => setForm({ ...form, highContrast: e.target.checked })}
                          className="sr-only peer"
                        />
                        <div className="w-9 h-5 bg-claude-surface2-light dark:bg-white/20 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-transform motion-reduce:after:transition-none peer-checked:bg-claude-terracotta"></div>
                      </label>
                    </div>
                  </div>
                </motion.div>
              )}

              {/* TAB: MY PLAN & USAGE */}
              {activeTab === 'plan' && (
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
                  {!usageData && (
                    <div role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-claude-text-light dark:text-white">
                      {isUsageLoading ? 'Verifying your plan and usage…' : usageError ? 'Plan and usage are unavailable. No subscription or quota has been verified.' : 'Loading plan information…'}
                      {!isUsageLoading && usageError && (
                        <button type="button" className="ml-3 inline-flex items-center justify-center min-h-[32px] px-2.5 py-1 rounded-md font-semibold underline hover:bg-amber-500/20 transition-colors" onClick={() => void fetchUsage()}>Retry</button>
                      )}
                    </div>
                  )}
                  {usageData && (<>
                  {/* Active Plan Overview Card */}
                  <div className="p-4 sm:p-5 rounded-2xl border border-claude-border-light dark:border-claude-border-dark bg-gradient-to-br from-claude-terracotta/10 via-claude-surface2-light/50 dark:via-white/[0.03] to-transparent space-y-4">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div className={`w-10 h-10 rounded-xl flex items-center justify-center font-bold text-white shadow-sm shrink-0 ${activePlanId === "pro" ? "bg-aira-blue" : activePlanId === "plus" ? "bg-claude-terracotta" : activePlanId === "free" ? "bg-emerald-600" : "bg-stone-600"}`}>
                          {activePlanId === 'pro' ? <Zap className="w-5 h-5" /> : activePlanId === 'plus' ? <Layers className="w-5 h-5" /> : <ShieldCheck className="w-5 h-5" />}
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="text-base font-bold text-claude-text-light dark:text-white">
                              {usageData?.activeSubscription?.cancelAtPeriodEnd && !usageData.activeSubscription.cancellationPending && usageData.activeSubscription.currentPeriodEnd
                                ? `${activePlanDef.name} — Active until ${new Date(usageData.activeSubscription.currentPeriodEnd).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium' })}`
                                : activePlanDef.name}
                            </h3>
                            <span className={`px-2 py-0.5 rounded-md text-xs font-medium ${
                              activePlanId === 'guest'
                                ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/20'
                                : usageData?.activeSubscription?.cancellationPending
                                  ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/20'
                                  : usageData?.activeSubscription?.cancelAtPeriodEnd
                                    ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/20'
                                    : summaryUnavailable
                                      ? 'bg-stone-500/15 text-stone-600 dark:text-stone-300 border border-stone-500/20'
                                      : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20'
                            }`}>
                              {activePlanId === 'guest'
                                ? 'Trial Session'
                                : usageData?.activeSubscription?.cancellationPending
                                  ? 'Cancellation Pending'
                                  : usageData?.activeSubscription?.cancelAtPeriodEnd
                                    ? 'Automatic renewal: Cancelled'
                                    : summaryUnavailable
                                      ? 'Renewal Status Unverified'
                                      : 'Active Plan'}
                            </span>
                          </div>
                          <p className="text-xs text-claude-muted-light dark:text-claude-muted-dark mt-0.5">
                            {activePlanDef.description}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {activePlanId === 'guest' ? (
                          <button
                            type="button"
                            onClick={() => {
                              onClose();
                              onTriggerUpgrade?.('guest_limit');
                            }}
                            className="px-3.5 py-2 rounded-xl bg-aira-blue text-white text-xs font-bold hover:bg-aira-blue/90 transition-colors motion-reduce:transition-none shadow-sm flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-terracotta active:scale-[0.99]"
                          >
                            <User className="w-3.5 h-3.5" />
                            <span>Sign in or Create Account</span>
                          </button>
                        ) : activePlanId !== 'pro' ? (
                          <button
                            type="button"
                            onClick={() => {
                              if (onOpenPricing) {
                                onClose();
                                onOpenPricing();
                              } else if (onTriggerUpgrade) {
                                onTriggerUpgrade(activePlanId === 'free' ? 'free_to_plus_model' : 'plus_to_pro_tool');
                              }
                            }}
                            className="px-3.5 py-2 rounded-xl bg-claude-terracotta hover:bg-claude-terracotta-hover text-white text-xs font-bold transition-colors motion-reduce:transition-none shadow-sm flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-terracotta active:scale-[0.99]"
                          >
                            <Zap className="w-3.5 h-3.5" />
                            <span>Upgrade Tier</span>
                          </button>
                        ) : (
                          <span className="px-3 py-1.5 rounded-xl bg-purple-500/10 border border-purple-500/20 text-purple-600 dark:text-purple-300 text-xs font-bold">
                            Maximum Tier
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Reset Countdown & Disabled Notice */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-3 border-t border-claude-border-light/60 dark:border-white/10 text-xs">
                      <div className="flex items-center gap-2 text-claude-muted-light dark:text-claude-muted-dark">
                        <Clock className="w-4 h-4 text-claude-accentInk shrink-0" />
                        <span>Daily quota resets at: <strong className="text-claude-text-light dark:text-white font-mono">00:00 UTC</strong></span>
                      </div>
                      <div className="flex items-center gap-2 text-claude-muted-light dark:text-claude-muted-dark sm:justify-end">
                        <Shield className="w-4 h-4 text-emerald-500 shrink-0" />
                        <span>
                          Billing: <span className="text-claude-text-light dark:text-white font-medium">
                            {activePlanId === 'guest'
                              ? 'Guest Trial (No Billing Active)'
                              : (!usageData?.billingStatus || usageData.billingStatus === 'sandbox_rehearsal' || usageData.billingStatus === 'sandbox')
                                ? 'Sandbox Mode (Isolated)'
                                : (usageData.billingStatus === 'checkout_disabled')
                                  ? 'Checkout Unavailable'
                                  : (usageData.billingStatus === 'active' || usageData.billingStatus === 'live')
                                    ? 'Live Billing Active'
                                    : usageData.billingStatus.replace(/^Billing:\s*/i, '')}
                          </span>
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Pending Subscription & Abandoned Checkout Recovery Banner */}
                  {(usageData?.pendingSubscription || reconcileMessage) && (
                    <div className="p-4 rounded-xl border border-amber-500/30 bg-amber-500/10 space-y-2.5 text-xs">
                      {usageData?.pendingSubscription && (() => {
                        const pending = usageData.pendingSubscription;
                        const hasMandate = Boolean(
                          pending.hasAuthorizedMandate ||
                          (pending.gateway === 'cashfree' && (pending.gatewaySubscriptionStatus === 'ACTIVE' || pending.authorizationStatus === 'ACTIVE'))
                        );
                        const planLabel = pending.planId === 'pro' ? 'AIRA Pro' : 'AIRA Plus';
                        const gwLabel = pending.gateway === 'cashfree' ? 'Cashfree' : 'Razorpay';
                        return (
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                            <div className="space-y-1 min-w-0">
                              <div className="flex flex-wrap items-center gap-2 font-bold text-claude-text-light dark:text-white">
                                <Clock className="w-4 h-4 text-amber-500 shrink-0" />
                                <span>
                                  {hasMandate
                                    ? `Authorized Mandate Pending Settlement (${planLabel} via ${gwLabel})`
                                    : `Pending Checkout (${planLabel} via ${gwLabel})`}
                                </span>
                              </div>
                              <p className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark leading-relaxed">
                                {pending.lastPaymentError ? (
                                  <>Last gateway notice: <span className="text-red-500 font-medium">{pending.lastPaymentError}</span>. Verify status or cancel this pending checkout to retry.</>
                                ) : hasMandate ? (
                                  pending.immediateAuthChargeExpected ? (
                                    <>
                                      Mandate authorized; verifying full Cycle 1 settlement with {gwLabel} before activating paid features.
                                      {pending.nextScheduleDate ? (
                                        <> Next scheduled auto-renewal: <strong className="text-claude-text-light dark:text-white">{new Date(pending.nextScheduleDate).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST</strong>.</>
                                      ) : null}
                                    </>
                                  ) : (
                                    <>
                                      Mandate authorized (₹1 verification). Paid tier activates only after Cycle 1 settlement
                                      {pending.nextScheduleDate ? (
                                        <> — first scheduled debit: <strong className="text-claude-text-light dark:text-white">{new Date(pending.nextScheduleDate).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST</strong>.</>
                                      ) : '.'}
                                    </>
                                  )
                                ) : (
                                  <>No completed payment is recorded for this {gwLabel} checkout yet. Verify payment status if you completed it, or cancel it to choose another plan or gateway.</>
                                )}
                              </p>
                            </div>
                            <div className="flex flex-wrap items-center gap-2 shrink-0">
                              <button
                                type="button"
                                onClick={() => void handleReconcilePending(pending.id)}
                                disabled={isReconcilingPending || isCancellingPending}
                                className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-800 dark:text-amber-200 font-semibold text-xs whitespace-nowrap transition-colors disabled:opacity-50"
                              >
                                {isReconcilingPending ? 'Checking...' : 'Verify / Reconcile Status'}
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleCancelPending(pending.id, hasMandate)}
                                disabled={isReconcilingPending || isCancellingPending}
                                className="px-3 py-1.5 rounded-lg bg-claude-surface-light dark:bg-white/10 hover:bg-red-500/10 border border-claude-border-light dark:border-white/20 text-claude-text-light dark:text-white font-semibold text-xs whitespace-nowrap transition-colors disabled:opacity-50"
                              >
                                {isCancellingPending ? 'Cancelling...' : (hasMandate ? 'Cancel Authorized Mandate' : 'Cancel Pending Checkout')}
                              </button>
                            </div>
                          </div>
                        );
                      })()}
                      {reconcileMessage && (
                        <div className="p-2 rounded-lg bg-black/5 dark:bg-white/5 text-[11px] text-claude-text-light dark:text-white">
                          {reconcileMessage}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Quota Meters & Usage Gauges */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-semibold text-claude-muted-light dark:text-claude-muted-dark">
                        Allowance Meters & Gauges
                      </h4>
                      <span className="text-[10px] text-claude-muted-light dark:text-claude-muted-dark">
                        Real-time atomic tracking
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {/* Daily Chats Meter */}
                      <div className="p-4 rounded-xl border border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light/40 dark:bg-claude-surface2-dark/40 space-y-2">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-bold text-claude-text-light dark:text-white">Daily Standard Chats</span>
                          <span className="font-bold text-claude-accentInk">
                            <span className="num font-mono">{remainingDailyChats}</span> / <span className="num font-mono">{dailyChatsLimit}</span> remaining
                          </span>
                        </div>
                        <div className="w-full h-2 rounded-full bg-claude-surface-light dark:bg-white/10 overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-colors motion-reduce:transition-none duration-500 ${
                              dailyChatsPct >= 90 ? 'bg-red-500' : dailyChatsPct >= 70 ? 'bg-amber-500' : 'bg-emerald-500'
                            }`}
                            style={{ width: `${dailyChatsPct}%` }}
                          />
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-claude-muted-light dark:text-claude-muted-dark">
                          <span>{dailyChatsUsed} used today</span>
                          <span>{100 - dailyChatsPct}% capacity free</span>
                        </div>
                      </div>

                      {/* Monthly Credits Meter */}
                      <div className="p-4 rounded-xl border border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light/40 dark:bg-claude-surface2-dark/40 space-y-2">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-bold text-claude-text-light dark:text-white">Available Premium Credits</span>
                          <span className="font-mono font-bold text-claude-accentInk">
                            {creditsRemaining.toLocaleString()}
                          </span>
                        </div>
                        <div className="w-full h-2 rounded-full bg-claude-surface-light dark:bg-white/10 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-aira-blue transition-colors motion-reduce:transition-none duration-500"
                            style={{ width: `${creditsLimit > 0 ? Math.min(100, Math.round((creditsRemaining / creditsLimit) * 100)) : 0}%` }}
                          />
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-claude-muted-light dark:text-claude-muted-dark">
                          <span>Dedicated credit wallet</span>
                          <span>For vision & advanced compute</span>
                        </div>
                      </div>

                      {/* Reasoning Boosts Meter */}
                      <div className="p-4 rounded-xl border border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light/40 dark:bg-claude-surface2-dark/40 space-y-2">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-bold text-claude-text-light dark:text-white">Reasoning Boosts</span>
                          <span className="font-bold text-claude-accentInk">
                            <span className="num font-mono">{reasoningBoostsRemaining}</span> / <span className="num font-mono">{reasoningBoostsLimit}</span> boosts
                          </span>
                        </div>
                        <div className="w-full h-2 rounded-full bg-claude-surface-light dark:bg-white/10 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-purple-500 transition-colors motion-reduce:transition-none duration-500"
                            style={{ width: `${reasoningBoostsLimit > 0 ? Math.min(100, Math.round((reasoningBoostsRemaining / reasoningBoostsLimit) * 100)) : 0}%` }}
                          />
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-claude-muted-light dark:text-claude-muted-dark">
                          <span>Deep architectural thinking</span>
                          <span>Monthly allocation</span>
                        </div>
                      </div>

                      {/* Projects & Workspaces Quota */}
                      <div className="p-4 rounded-xl border border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light/40 dark:bg-claude-surface2-dark/40 space-y-2">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-bold text-claude-text-light dark:text-white">Projects & Knowledge</span>
                          <span className="font-mono font-bold text-claude-accentInk">
                            {projects.length} / {projectLimit === -1 ? 'Unlimited' : projectLimit}
                          </span>
                        </div>
                        <div className="w-full h-2 rounded-full bg-claude-surface-light dark:bg-white/10 overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-colors motion-reduce:transition-none duration-500 ${
                              isProjectsExceeded ? 'bg-amber-500' : 'bg-teal-500'
                            }`}
                            style={{ width: `${projectLimit === -1 ? 100 : Math.min(100, Math.round((projects.length / (projectLimit || 1)) * 100))}%` }}
                          />
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-claude-muted-light dark:text-claude-muted-dark">
                          <span>{isProjectsExceeded ? `${projects.length - projectLimit} in read-only mode` : 'Persistent document contexts'}</span>
                          <span>{projectLimit === -1 ? 'Pro unlimited' : `${projectLimit} slots`}</span>
                        </div>
                      </div>
                    </div>

                    {/* Safe Downgrade Retention Warning Banner (Feature 18) */}
                    {isProjectsExceeded && (
                      <div data-testid="retention-banner-projects" className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-800 dark:text-amber-200 space-y-1.5">
                        <div className="flex items-center gap-2 font-bold">
                          <Lock className="w-4 h-4 text-amber-500 shrink-0" />
                          <span>Safe Downgrade Retention Active</span>
                        </div>
                        <p className="text-[11px] leading-relaxed">
                          You have {projects.length} projects. Your current plan includes {projectLimit}. Excess projects are saved in read-only mode.
                        </p>
                        <div className="pt-1 flex items-center justify-between">
                          <span className="text-[10px] text-amber-700/80 dark:text-amber-300/80">Data is never deleted upon downgrade. Export is always enabled.</span>
                          <button
                            type="button"
                            onClick={() => onTriggerUpgrade ? onTriggerUpgrade('pro_tools_agent') : onOpenPricing?.()}
                            className="text-claude-accentInk font-bold hover:underline inline-flex items-center gap-1 text-[11px]"
                          >
                            <span>Upgrade to Pro to edit all</span>
                            <ArrowRight className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Plan Comparison Cards (Side-by-Side) */}
                  <div className="space-y-3 pt-2">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-semibold text-claude-muted-light dark:text-claude-muted-dark">
                        Plan Comparison Matrix
                      </h4>
                      {onOpenPricing && (
                        <button
                          type="button"
                          onClick={onOpenPricing}
                          className="text-xs font-semibold text-claude-accentInk hover:underline"
                        >
                          Full Pricing Table
                        </button>
                      )}
                    </div>

                    {usageData && !usageData.checkoutAvailable && (
                      <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/20 text-[11px] text-amber-700 dark:text-amber-300">
                        <Shield className="w-3.5 h-3.5 shrink-0 text-amber-500" />
                        <span>Commercial checkout is currently offline · Plan features, quotas and entitlements are fully operational for entitled accounts.</span>
                      </div>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                      {(['guest', 'free', 'plus', 'pro'] as const).map(tierKey => {
                        const plan = COMMERCIAL_PLANS[tierKey];
                        const isCurrent = activePlanId === tierKey;
                        return (
                          <div
                            key={tierKey}
                            className={`p-3.5 rounded-xl border flex flex-col justify-between transition-colors motion-reduce:transition-none ${
                              isCurrent
                                ? 'border-claude-terracotta bg-claude-terracotta/[0.04] shadow-sm'
                                : 'border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light/40 dark:bg-claude-surface2-dark/40 hover:border-claude-terracotta/40'
                            }`}
                          >
                            <div className="space-y-2.5">
                              <div className="flex items-center justify-between">
                                <span className="font-bold text-xs text-claude-text-light dark:text-white">{plan.name}</span>
                                {isCurrent && (
                                  <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded bg-claude-terracotta/20 text-claude-accentInk">
                                    Current
                                  </span>
                                )}
                              </div>
                              <div className="text-base font-bold font-serif text-claude-text-light dark:text-white">
                                {tierKey === 'guest' || tierKey === 'free'
                                  ? 'Free'
                                  : `₹${plan.pricing?.INR || (tierKey === 'plus' ? 399 : 999)}`}
                                <span className="text-[10px] font-sans font-normal text-claude-muted-light">
                                  {tierKey === 'guest' || tierKey === 'free'
                                    ? ' /mo'
                                    : ' /mo (incl. GST)'}
                                </span>
                              </div>
                              <div className="space-y-1.5 text-[11px] text-claude-muted-light dark:text-claude-muted-dark border-t border-claude-border-light/60 dark:border-white/5 pt-2">
                                <div className="flex items-center gap-1.5"><Check className="w-3 h-3 text-emerald-500 shrink-0" /><span><strong>{plan.dailyStandardChatLimit}</strong> chats/day</span></div>
                                <div className="flex items-center gap-1.5"><Check className="w-3 h-3 text-emerald-500 shrink-0" /><span><strong>{plan.monthlyPremiumCredits}</strong> credits/mo</span></div>
                                <div className="flex items-center gap-1.5"><Check className="w-3 h-3 text-emerald-500 shrink-0" /><span><strong>{plan.complimentaryReasoningBoosts}</strong> reasoning boosts</span></div>
                                <div className="flex items-center gap-1.5"><Check className="w-3 h-3 text-emerald-500 shrink-0" /><span>{plan.maxProjects === -1 ? 'Unlimited' : `${plan.maxProjects} project slots`}</span></div>
                                <div className="flex items-center gap-1.5">
                                  {plan.allowAutonomous ? <Check className="w-3 h-3 text-emerald-500 shrink-0" /> : <X className="w-3 h-3 text-stone-400 shrink-0" />}
                                  <span>Agent Mode</span>
                                </div>
                                <div className="flex items-center gap-1.5">
                                  {plan.allowPythonSandbox ? <Check className="w-3 h-3 text-emerald-500 shrink-0" /> : <X className="w-3 h-3 text-stone-400 shrink-0" />}
                                  <span>Python & Browser</span>
                                </div>
                              </div>
                            </div>

                            <div className="pt-3 mt-2 border-t border-claude-border-light/40 dark:border-white/5">
                              {isCurrent ? (
                                <button disabled className="w-full py-1.5 rounded-lg bg-claude-surface2-light dark:bg-white/5 text-[11px] font-bold text-claude-muted-light cursor-default">
                                  Current Plan
                                </button>
                              ) : tierKey === 'guest' ? (
                                <button disabled className="w-full py-1.5 rounded-lg bg-claude-surface2-light dark:bg-white/5 text-[11px] font-medium text-claude-muted-light cursor-default">
                                  Trial Tier
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (onOpenPricing) {
                                      onClose();
                                      onOpenPricing();
                                    } else if (onTriggerUpgrade) {
                                      onTriggerUpgrade(tierKey === 'pro' ? 'plus_to_pro_tool' : 'free_to_plus_model');
                                    }
                                  }}
                                  className="w-full px-2.5 py-1.5 rounded-lg bg-claude-terracotta hover:bg-claude-terracotta-hover text-white text-[11px] font-bold text-center leading-tight transition-colors motion-reduce:transition-none shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-terracotta active:scale-[0.99]"
                                >
                                  {tierKey === 'free'
                                    ? 'Get Started'
                                    : (usageData?.checkoutAvailable
                                      ? `${activePlanId === 'pro' && tierKey === 'plus' ? 'Downgrade' : 'Upgrade'} to ${tierKey === 'pro' ? 'Pro' : 'Plus'}`
                                      : 'View Plan Details')}
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Active Subscription Management & Cancellation */}
                  {(activePlanId === 'plus' || activePlanId === 'pro') && summaryUnavailable && (
                    <div className="p-4 rounded-xl border border-amber-500/30 bg-amber-500/10 text-xs flex items-center justify-between gap-3">
                      <span className="text-amber-800 dark:text-amber-200">
                        Unable to verify subscription renewal status right now. Retry before managing cancellation.
                      </span>
                      <button
                        type="button"
                        onClick={() => void fetchUsage()}
                        className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-800 dark:text-amber-200 font-semibold whitespace-nowrap"
                      >
                        Retry Status Check
                      </button>
                    </div>
                  )}
                  {(activePlanId === 'plus' || activePlanId === 'pro') && !summaryUnavailable && (() => {
                    const activeSub = usageData?.activeSubscription;
                    const lifecycleState = usageData?.subscriptionLifecycle?.state;
                    const endDateText = activeSub?.currentPeriodEnd
                      ? `${new Date(activeSub.currentPeriodEnd).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium' })}`
                      : 'end of current period';
                    const isCancellationFailed = Boolean(activeSub?.cancellationFailed || lifecycleState === 'CANCELLATION_FAILED');
                    const isCancellationPending = Boolean(activeSub?.cancellationPending || lifecycleState === 'CANCELLATION_PENDING');
                    const isRenewalCancelled = Boolean(activeSub?.cancelAtPeriodEnd || lifecycleState === 'ACTIVE_CANCEL_SCHEDULED');
                    return (
                      <div className="p-4 rounded-xl border border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light/40 dark:bg-claude-surface2-dark/40 space-y-3">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                          <div className="space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <h4 className="text-xs font-bold text-claude-text-light dark:text-white">
                                {isRenewalCancelled && !isCancellationPending
                                  ? `${activePlanDef.name} — Active until ${endDateText}`
                                  : isCancellationPending
                                    ? `${activePlanDef.name} — Cancellation Pending`
                                    : `${activePlanDef.name} — Active and renewing`}
                              </h4>
                              {isRenewalCancelled && !isCancellationPending && (
                                <span className="px-2 py-0.5 rounded-md bg-amber-500/15 border border-amber-500/30 text-amber-700 dark:text-amber-300 text-[10px] font-semibold">
                                  Automatic renewal: Cancelled
                                </span>
                              )}
                              {!isRenewalCancelled && !isCancellationFailed && (
                                <span className="px-2 py-0.5 rounded-md bg-emerald-500/15 border border-emerald-500/30 text-emerald-700 dark:text-emerald-300 text-[10px] font-semibold">
                                  Active and renewing
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark leading-relaxed">
                              {isCancellationFailed ? (
                                <>
                                  Cancellation could not be confirmed with the payment provider ({activeSub?.lastCancellationError || 'Gateway error'}). Automatic renewal remains active — please retry cancellation.
                                </>
                              ) : isCancellationPending ? (
                                <>
                                  Cancellation requested with the payment gateway. Your paid entitlements remain active until {endDateText} IST while confirmation settles.
                                </>
                              ) : isRenewalCancelled ? (
                                <>
                                  Automatic renewal: Cancelled · No further recurring payments will be charged for this subscription. Paid plan features and remaining credits stay active until {endDateText} IST.
                                </>
                              ) : activeSub?.currentPeriodEnd ? (
                                <>Next automatic renewal: {endDateText} IST. Cancel anytime before renewal without losing your current paid cycle.</>
                              ) : (
                                <>Recurring plan renewal via e-mandate. Cancellation stops renewal at the end of your billing cycle.</>
                              )}
                            </p>
                          </div>
                          {isCancellationPending ? (
                            <span className="px-3 py-1.5 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-700 dark:text-amber-300 text-xs font-semibold whitespace-nowrap self-start sm:self-center">
                              Cancellation Pending
                            </span>
                          ) : isRenewalCancelled ? (
                            <span className="px-3 py-1.5 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-700 dark:text-amber-300 text-xs font-semibold whitespace-nowrap self-start sm:self-center">
                              Automatic renewal: Cancelled
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={handleCancelSubscription}
                              disabled={isCancellingSub}
                              className="px-3 py-1.5 rounded-lg border border-red-500/30 hover:bg-red-500/10 text-red-600 dark:text-red-400 text-xs font-semibold transition-colors disabled:opacity-50 whitespace-nowrap self-start sm:self-center"
                            >
                              {isCancellingSub ? 'Processing...' : (isCancellationFailed ? 'Retry Cancellation' : 'Cancel Subscription')}
                            </button>
                          )}
                        </div>
                        {cancelMessage && (
                          <div className="p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-700 dark:text-emerald-300 text-xs">
                            {cancelMessage}
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* Historical Expired / Refunded Subscription Notice (when on Free) */}
                  {activePlanId === 'free' && (usageData?.subscriptionLifecycle?.state === 'EXPIRED' || usageData?.subscriptionLifecycle?.state === 'REFUNDED') && (() => {
                    const lc = usageData.subscriptionLifecycle!;
                    const endDateText = lc.currentPeriodEnd
                      ? new Date(lc.currentPeriodEnd).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium' })
                      : null;
                    return (
                      <div className="p-4 rounded-xl border border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light/40 dark:bg-claude-surface2-dark/40 text-xs space-y-1">
                        <div className="font-bold text-claude-text-light dark:text-white flex items-center gap-2">
                          <span>
                            {lc.state === 'REFUNDED'
                              ? `${lc.planName || 'Subscription'} — Refunded`
                              : `${lc.planName || 'Subscription'} — Expired`}
                          </span>
                          <span className="px-2 py-0.5 rounded-md bg-stone-500/15 border border-stone-500/30 text-stone-600 dark:text-stone-300 text-[10px] font-semibold">
                            {lc.state === 'REFUNDED' ? 'Refunded' : 'Expired'}
                          </span>
                        </div>
                        <p className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark leading-relaxed">
                          {lc.state === 'REFUNDED'
                            ? `Your ${lc.planName || 'paid'} subscription payment was refunded${lc.creditNoteNumber ? ` (Credit Note ${lc.creditNoteNumber})` : ''}. Paid plan benefits have ended and your historical GST invoices remain preserved below.`
                            : `Your ${lc.planName || 'paid'} billing period ended${endDateText ? ` on ${endDateText} IST` : ''} with automatic renewal cancelled. No further recurring charges will occur; upgrade anytime to resume paid benefits.`}
                        </p>
                      </div>
                    );
                  })()}

                  {/* Payment Methods */}
                  {!isGuestUser && (
                    <div className="p-4 rounded-xl border border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light/30 dark:bg-claude-surface2-dark/20 space-y-2.5 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <CreditCard className="w-4 h-4 text-claude-accentInk shrink-0" />
                          <h4 className="font-semibold text-claude-text-light dark:text-white">Payment methods</h4>
                        </div>
                        {onOpenPricing && (
                          <button
                            type="button"
                            onClick={onOpenPricing}
                            className="text-[11px] font-semibold text-claude-accentInk hover:underline"
                          >
                            {activePlanId === 'free' ? 'Add via Plan Checkout' : 'Change Plan'}
                          </button>
                        )}
                      </div>
                      {Array.isArray(usageData?.paymentMethods) && usageData.paymentMethods.length > 0 ? (
                        <div className="space-y-2">
                          {usageData.paymentMethods.map((pm) => (
                            <div
                              key={pm.id}
                              className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border border-claude-border-light dark:border-white/10 bg-claude-surface-light dark:bg-claude-surface2-dark"
                            >
                              <div className="space-y-0.5">
                                <div className="font-semibold text-claude-text-light dark:text-white">{pm.displayLabel}</div>
                                <div className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark capitalize">
                                  {pm.methodType} · Status: {pm.mandateStatus || 'active'}
                                </div>
                              </div>
                              {pm.isDefault && (
                                <span className="px-2 py-0.5 rounded-md bg-emerald-500/15 border border-emerald-500/30 text-emerald-700 dark:text-emerald-300 text-[10px] font-semibold">
                                  Default
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark">
                          No saved payment method on file yet. Verified card or mandate details appear automatically after subscription checkout.
                        </p>
                      )}
                    </div>
                  )}

                  {/* Billing Information (Global Country, Account Type & Tax ID / GSTIN) */}
                  {!isGuestUser && (
                    <div className="p-4 rounded-xl border border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light/30 dark:bg-claude-surface2-dark/20 space-y-3 text-xs">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                        <div className="flex items-start gap-2">
                          <Globe className="w-4 h-4 text-claude-accentInk shrink-0 mt-0.5" />
                          <div>
                            <h4 className="font-semibold text-claude-text-light dark:text-white">
                              Billing information
                            </h4>
                            <p className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark">
                              Controls your default checkout currency, invoices, and optional business tax identification.
                            </p>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleSaveTaxProfile()}
                          disabled={taxProfileSaving}
                          className="px-3 py-1.5 rounded-lg bg-claude-terracotta hover:bg-claude-terracotta-hover text-white text-[11px] font-semibold transition-colors disabled:opacity-50 shrink-0 self-start sm:self-center"
                        >
                          {taxProfileSaving ? 'Saving…' : 'Save Billing Info'}
                        </button>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                        <div>
                          <label htmlFor="settings-billing-country" className="block text-[11px] text-claude-muted-light dark:text-claude-muted-dark mb-1">
                            Country / Region
                          </label>
                          <select
                            id="settings-billing-country"
                            value={taxCountry}
                            onChange={(e) => {
                              const next = e.target.value.toUpperCase();
                              setTaxCountry(next);
                              if (next !== 'IN') setTaxStateCode('');
                              setTaxProfileError(null);
                              setTaxProfileMsg(null);
                            }}
                            className="w-full px-3 py-2 rounded-lg bg-claude-surface-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark text-xs text-claude-text-light dark:text-white"
                          >
                            {countriesList.map((c) => (
                              <option key={c.code} value={c.code}>
                                {c.name} ({c.defaultCurrency})
                              </option>
                            ))}
                          </select>
                        </div>

                        <div>
                          <span className="block text-[11px] text-claude-muted-light dark:text-claude-muted-dark mb-1">
                            Account Type
                          </span>
                          <div className="grid grid-cols-2 gap-1.5 bg-claude-surface-light dark:bg-claude-surface2-dark p-1 rounded-lg border border-claude-border-light dark:border-claude-border-dark">
                            <button
                              type="button"
                              aria-pressed={taxAccountType === 'individual'}
                              onClick={() => setTaxAccountType('individual')}
                              className={`py-1 rounded-md text-[11px] font-semibold transition-colors ${taxAccountType === 'individual' ? 'bg-claude-terracotta text-white' : 'text-claude-muted-light dark:text-claude-muted-dark'}`}
                            >
                              Individual
                            </button>
                            <button
                              type="button"
                              aria-pressed={taxAccountType === 'business'}
                              onClick={() => setTaxAccountType('business')}
                              className={`py-1 rounded-md text-[11px] font-semibold transition-colors ${taxAccountType === 'business' ? 'bg-claude-terracotta text-white' : 'text-claude-muted-light dark:text-claude-muted-dark'}`}
                            >
                              Business
                            </button>
                          </div>
                        </div>

                        {taxCountry === 'IN' ? (
                          <div>
                            <label htmlFor="settings-gst-state" className="block text-[11px] text-claude-muted-light dark:text-claude-muted-dark mb-1">
                              State / Union Territory *
                            </label>
                            <select
                              id="settings-gst-state"
                              value={taxStateCode}
                              onChange={(e) => {
                                setTaxStateCode(e.target.value);
                                setTaxProfileError(null);
                                setTaxProfileMsg(null);
                              }}
                              className="w-full px-3 py-2 rounded-lg bg-claude-surface-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark text-xs text-claude-text-light dark:text-white"
                            >
                              <option value="">Select State / UT…</option>
                              {taxJurisdictions.map((j) => (
                                <option key={j.code} value={j.code}>
                                  {j.code} - {j.name}
                                </option>
                              ))}
                            </select>
                          </div>
                        ) : (
                          <div>
                            <label htmlFor="settings-global-region" className="block text-[11px] text-claude-muted-light dark:text-claude-muted-dark mb-1">
                              State / Province / Region (Optional)
                            </label>
                            <input
                              id="settings-global-region"
                              type="text"
                              placeholder="e.g. California, London, ON"
                              value={taxStateCode}
                              onChange={(e) => setTaxStateCode(e.target.value)}
                              className="w-full px-3 py-2 rounded-lg bg-claude-surface-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark text-xs text-claude-text-light dark:text-white"
                            />
                          </div>
                        )}

                        {taxAccountType === 'business' && (
                          taxCountry === 'IN' ? (
                            <div>
                              <label htmlFor="settings-gst-gstin" className="block text-[11px] text-claude-muted-light dark:text-claude-muted-dark mb-1">
                                B2B Recipient GSTIN (Optional)
                              </label>
                              <input
                                id="settings-gst-gstin"
                                type="text"
                                maxLength={15}
                                placeholder="e.g. 09AAMCV4678C1ZV"
                                value={taxGstin}
                                onChange={(e) => {
                                  const val = e.target.value.toUpperCase();
                                  setTaxGstin(val);
                                  setTaxProfileError(null);
                                  setTaxProfileMsg(null);
                                  if (val.length >= 2 && /^[0-9]{2}/.test(val) && val.slice(0, 2) !== '25') {
                                    const match = taxJurisdictions.find((j) => j.code === val.slice(0, 2));
                                    if (match) setTaxStateCode(match.code);
                                  }
                                }}
                                className="w-full px-3 py-2 rounded-lg bg-claude-surface-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark text-xs font-mono text-claude-text-light dark:text-white"
                              />
                            </div>
                          ) : (
                            <div>
                              <label htmlFor="settings-global-taxid" className="block text-[11px] text-claude-muted-light dark:text-claude-muted-dark mb-1">
                                Business Tax / VAT / EIN ID (Optional)
                              </label>
                              <input
                                id="settings-global-taxid"
                                type="text"
                                maxLength={64}
                                placeholder="e.g. EIN-88-9911223 or GB123456789"
                                value={taxIdValue}
                                onChange={(e) => setTaxIdValue(e.target.value)}
                                className="w-full px-3 py-2 rounded-lg bg-claude-surface-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark text-xs text-claude-text-light dark:text-white"
                              />
                            </div>
                          )
                        )}

                        <div>
                          <label htmlFor="settings-gst-legal-name" className="block text-[11px] text-claude-muted-light dark:text-claude-muted-dark mb-1">
                            {taxAccountType === 'business' ? 'Registered Business Name' : 'Full Name on Invoices (Optional)'}
                          </label>
                          <input
                            id="settings-gst-legal-name"
                            type="text"
                            placeholder={taxAccountType === 'business' ? 'Registered company name' : 'Your full name'}
                            value={taxLegalName}
                            onChange={(e) => setTaxLegalName(e.target.value)}
                            className="w-full px-3 py-2 rounded-lg bg-claude-surface-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark text-xs text-claude-text-light dark:text-white"
                          />
                        </div>
                        <div>
                          <label htmlFor="settings-gst-address" className="block text-[11px] text-claude-muted-light dark:text-claude-muted-dark mb-1">
                            Billing Address (Optional)
                          </label>
                          <input
                            id="settings-gst-address"
                            type="text"
                            placeholder="Street, City, Postal Code"
                            value={taxAddress}
                            onChange={(e) => setTaxAddress(e.target.value)}
                            className="w-full px-3 py-2 rounded-lg bg-claude-surface-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark text-xs text-claude-text-light dark:text-white"
                          />
                        </div>
                      </div>
                      {taxProfileError && (
                        <p className="text-[11px] text-red-600 dark:text-red-400 font-medium">{taxProfileError}</p>
                      )}
                      {taxProfileMsg && (
                        <p className="text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">{taxProfileMsg}</p>
                      )}
                    </div>
                  )}

                  {/* Billing History (PDF & Printable A4 Documents) */}
                  {!isGuestUser && (
                    <div className="space-y-3 pt-2">
                      <div className="flex items-center justify-between">
                        <h4 className="text-xs font-semibold text-claude-text-light dark:text-white">
                          Billing history
                        </h4>
                        <span className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark">
                          PDF &amp; A4 receipts
                        </span>
                      </div>

                      {isLoadingInvoices ? (
                        <div className="p-4 rounded-xl border border-claude-border-light dark:border-claude-border-dark text-xs text-claude-muted-light dark:text-claude-muted-dark text-center">
                          Loading invoices...
                        </div>
                      ) : invoicesError ? (
                        <div className="p-4 rounded-xl border border-red-500/30 bg-red-500/5 text-xs text-red-700 dark:text-red-300 text-center space-y-2">
                          <p className="font-medium">Unable to load billing history right now.</p>
                          <p className="text-[11px] opacity-80">{invoicesError}</p>
                          <button
                            type="button"
                            onClick={() => void fetchInvoices()}
                            className="px-3 py-1 rounded-lg border border-red-500/30 hover:bg-red-500/10 text-[11px] font-semibold transition-colors"
                          >
                            Retry
                          </button>
                        </div>
                      ) : (invoices.length === 0 && creditNotes.length === 0) ? (
                        <div className="p-4 rounded-xl border border-dashed border-claude-border-light dark:border-claude-border-dark text-xs text-claude-muted-light dark:text-claude-muted-dark text-center space-y-1">
                          <p className="font-medium">No billing history or invoices yet.</p>
                          <p className="text-[10px]">When you activate a subscription, downloadable PDF and A4 receipts will appear here.</p>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {invoices.map((inv: any, idx: number) => (
                            <div
                              key={inv.invoiceNumber || idx}
                              className="p-3 rounded-xl border border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light/30 dark:bg-claude-surface2-dark/30 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
                            >
                              <div className="space-y-0.5 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="font-mono font-bold text-claude-text-light dark:text-white">{inv.invoiceNumber}</span>
                                  <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-medium">
                                    {inv.status}
                                  </span>
                                  {inv.isSandbox && (
                                    <span className="text-[10px] px-1.5 py-0.2 rounded bg-amber-500/15 text-amber-700 dark:text-amber-300 font-medium">
                                      Sandbox
                                    </span>
                                  )}
                                </div>
                                <div className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark">
                                  {inv.plan} · {inv.date}{inv.paymentMethod ? ` · ${inv.paymentMethod}` : ''}
                                </div>
                              </div>
                              <div className="flex flex-wrap items-center gap-2 shrink-0">
                                <div className="text-right mr-1">
                                  <div className="font-mono font-bold text-claude-text-light dark:text-white">
                                    {inv.currency === 'INR' ? '₹' : '$'}{inv.totalAmount.toFixed(2)}
                                  </div>
                                  {Number(inv.gstAmount || 0) > 0 && (
                                    <div className="text-[10px] text-claude-muted-light dark:text-claude-muted-dark">
                                      Incl. {inv.currency === 'INR' ? '₹' : '$'}{inv.gstAmount.toFixed(2)} GST
                                    </div>
                                  )}
                                </div>
                                {inv.invoiceNumber && inv.invoiceNumber !== 'INV-PENDING-RECONCILIATION' && (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => void handleDownloadInvoicePdf(inv.invoiceNumber)}
                                      disabled={downloadingPdfNum === inv.invoiceNumber}
                                      aria-label={`Download PDF Invoice ${inv.invoiceNumber}`}
                                      className="px-2.5 py-1.5 rounded-lg bg-claude-terracotta hover:bg-claude-terracotta-hover text-white text-[11px] font-semibold inline-flex items-center gap-1 transition-colors disabled:opacity-50"
                                    >
                                      <FileText className="w-3.5 h-3.5" />
                                      <span>{downloadingPdfNum === inv.invoiceNumber ? 'Generating…' : 'Download PDF'}</span>
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => void handleDownloadInvoice(inv.invoiceNumber)}
                                      disabled={downloadingInvoiceNum === inv.invoiceNumber}
                                      aria-label={`View or Print A4 Invoice ${inv.invoiceNumber}`}
                                      className="px-2.5 py-1.5 rounded-lg border border-claude-border-light dark:border-white/15 hover:bg-black/5 dark:hover:bg-white/10 text-[11px] font-semibold text-claude-text-light dark:text-white inline-flex items-center gap-1 transition-colors disabled:opacity-50"
                                    >
                                      <Download className="w-3.5 h-3.5" />
                                      <span>{downloadingInvoiceNum === inv.invoiceNumber ? 'Opening…' : 'View / Print A4'}</span>
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>
                          ))}

                          {creditNotes.map((cn: any, idx: number) => (
                            <div
                              key={cn.creditNoteNumber || idx}
                              className="p-3 rounded-xl border border-amber-500/25 bg-amber-500/5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
                            >
                              <div className="space-y-0.5 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="font-mono font-bold text-claude-text-light dark:text-white">{cn.creditNoteNumber}</span>
                                  <span className="text-[10px] px-1.5 py-0.2 rounded bg-amber-500/15 text-amber-700 dark:text-amber-300 font-medium">
                                    Credit Note · {cn.status}
                                  </span>
                                </div>
                                <div className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark">
                                  Against {cn.originalInvoiceNumber} · {cn.date}
                                </div>
                              </div>
                              <div className="flex flex-wrap items-center gap-2 shrink-0">
                                <div className="text-right font-mono font-bold text-claude-text-light dark:text-white mr-1">
                                  -{cn.currency === 'INR' ? '₹' : '$'}{Number(cn.refundAmount || 0).toFixed(2)}
                                </div>
                                <button
                                  type="button"
                                  onClick={() => void handleDownloadCreditNotePdf(cn.creditNoteNumber)}
                                  disabled={downloadingPdfNum === cn.creditNoteNumber}
                                  aria-label={`Download PDF Credit Note ${cn.creditNoteNumber}`}
                                  className="px-2.5 py-1.5 rounded-lg bg-claude-terracotta hover:bg-claude-terracotta-hover text-white text-[11px] font-semibold inline-flex items-center gap-1 transition-colors disabled:opacity-50"
                                >
                                  <FileText className="w-3.5 h-3.5" />
                                  <span>{downloadingPdfNum === cn.creditNoteNumber ? 'Generating…' : 'Download PDF'}</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void handleDownloadCreditNote(cn.creditNoteNumber)}
                                  disabled={downloadingCnNum === cn.creditNoteNumber}
                                  aria-label={`View or Print A4 Credit Note ${cn.creditNoteNumber}`}
                                  className="px-2.5 py-1.5 rounded-lg border border-claude-border-light dark:border-white/15 hover:bg-black/5 dark:hover:bg-white/10 text-[11px] font-semibold text-claude-text-light dark:text-white inline-flex items-center gap-1 transition-colors disabled:opacity-50"
                                >
                                  <Download className="w-3.5 h-3.5" />
                                  <span>{downloadingCnNum === cn.creditNoteNumber ? 'Opening…' : 'View / Print A4'}</span>
                                </button>
                              </div>
                            </div>
                          ))}

                          <div className="pt-2 border-t border-claude-border-light/40 dark:border-white/5 flex flex-col sm:flex-row sm:items-center justify-between text-[10px] text-claude-muted-light dark:text-claude-muted-dark gap-1">
                            <span>
                              All paid receipts include complete tax &amp; payment snapshot records.
                            </span>
                            <span>
                              Billing support: {usageData?.supplierIdentity?.supportEmail || 'virexaiventures@gmail.com'}
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  </>)}
                </motion.div>
              )}

              {/* TAB 2: MODEL & REASONING */}
              {activeTab === 'reasoning' && (
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-5">
                  <div>
                    <label htmlFor="aira-settings-default-model" className="text-xs font-semibold text-claude-muted-light dark:text-claude-muted-dark block mb-2">Default Model</label>
                    <select
                      id="aira-settings-default-model"
                      value={form.activeModel}
                      onChange={e => setForm({ ...form, activeModel: e.target.value as any })}
                      className="w-full px-4 py-3 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark text-[13px] font-semibold text-claude-text-light dark:text-white outline-none focus:border-claude-terracotta transition-colors motion-reduce:transition-none"
                    >
                      {AVAILABLE_MODELS.map(m => (
                        <option key={m.id} value={m.id}>
                          {m.name} ({m.badge}) - {m.description}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="p-4 rounded-xl border border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light/40 dark:bg-claude-surface2-dark/40 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-xs font-bold text-claude-text-light dark:text-white">Extended Thinking / Deep Output Budget</div>
                        <div className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark mt-0.5">Caps generation ceiling (1,024–8,192 tokens) on AIRA Deep. Native thinking tokens emit only when the active upstream provider supports them (NVIDIA Nemotron 70B applies output max_tokens cap).</div>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          checked={form.extendedThinking}
                          onChange={e => setForm({ ...form, extendedThinking: e.target.checked })}
                          className="sr-only peer"
                        />
                        <div className="w-11 h-6 bg-claude-surface2-light dark:bg-white/20 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-transform motion-reduce:after:transition-none peer-checked:bg-claude-terracotta"></div>
                      </label>
                    </div>

                    {form.extendedThinking && (
                      <div className="pt-2 border-t border-claude-border-light/60 dark:border-claude-border-dark/60">
                        <div className="flex justify-between text-xs font-bold mb-1">
                          <span className="text-claude-muted-light dark:text-claude-muted-dark">Output / Reasoning Token Ceiling</span>
                          <span className="text-claude-accentInk font-semibold"><span className="num font-mono">{form.thinkingBudget.toLocaleString()}</span> tokens</span>
                        </div>
                        <input
                          type="range"
                          min={1024}
                          max={8192}
                          step={1024}
                          value={Math.min(form.thinkingBudget, 8192)}
                          onChange={e => setForm({ ...form, thinkingBudget: Number(e.target.value) })}
                          className="w-full accent-claude-terracotta cursor-pointer"
                        />
                        <div className="flex justify-between text-[10px] text-claude-muted-light dark:text-claude-muted-dark mt-1">
                          <span>1,024 min</span>
                          <span>Runtime cap (max_tokens / effort where supported)</span>
                          <span>8,192 max</span>
                        </div>
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-claude-muted-light dark:text-claude-muted-dark block mb-2">Response Style</label>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {[
                        { id: 'normal', label: 'Balanced & Adaptive' },
                        { id: 'concise', label: 'Concise & Direct' },
                        { id: 'explanatory', label: 'Detailed & Pedagogical' },
                        { id: 'academic', label: 'Academic & Rigorous' },
                        { id: 'code-first', label: 'Code-First & Dense' },
                      ].map(style => (
                        <button
                          key={style.id}
                          type="button"
                          onClick={() => setForm({ ...form, responseStyle: style.id as any })}
                          className={`p-2.5 rounded-xl border text-xs font-semibold text-left transition-colors motion-reduce:transition-none ${
                            form.responseStyle === style.id
                              ? 'border-claude-terracotta bg-claude-terracotta/10 text-claude-accentInk'
                              : 'border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light dark:bg-claude-surface2-dark text-claude-muted-light hover:border-claude-terracotta/40'
                          }`}
                        >
                          {style.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {form.tipsEnabled !== false && (
                    <div data-testid="tip-reasoning" className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-800 dark:text-amber-300 flex items-start gap-2.5">
                      <Lightbulb className="w-4 h-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
                      <div>
                        <div className="font-bold">Pro Tip: Extended Reasoning Tokens</div>
                        <p className="mt-0.5 text-[11px] leading-relaxed opacity-90">
                          Allocate up to 8,192 thinking tokens on supported models for deep multi-step architecture design, verification proofs, and complex debugging chains.
                        </p>
                      </div>
                    </div>
                  )}
                </motion.div>
              )}

              {/* TAB 3: AGENT MEMORY */}
              {activeTab === 'memory' && (
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-5">
                  <div className="p-4 rounded-xl border border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light/40 dark:bg-claude-surface2-dark/40 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-xs font-bold text-claude-text-light dark:text-white">Cross-Conversation Memory</div>
                        <div className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark mt-0.5">Retain architectural decisions and preferences across separate sessions.</div>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          checked={form.persistentMemoryEnabled !== false}
                          onChange={e => setForm({ ...form, persistentMemoryEnabled: e.target.checked })}
                          className="sr-only peer"
                        />
                        <div className="w-11 h-6 bg-claude-surface2-light dark:bg-white/20 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-transform motion-reduce:after:transition-none peer-checked:bg-claude-terracotta"></div>
                      </label>
                    </div>

                    <div className="flex items-center justify-between pt-2 border-t border-claude-border-light/60 dark:border-claude-border-dark/60">
                      <div>
                        <div className="text-xs font-bold text-claude-text-light dark:text-white flex items-center gap-1.5">
                          <span>Automatic Privacy Scrubbing</span>
                          <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-200/50 dark:border-emerald-500/20">
                            Enforced Safeguard
                          </span>
                        </div>
                        <div className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark mt-0.5">
                          API keys, tokens, and credentials are automatically redacted before persisting memories.
                        </div>
                      </div>
                      <div className="flex items-center gap-1 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                        <ShieldCheck className="w-4 h-4" />
                        <span>Active</span>
                      </div>
                    </div>

                    {onOpenMemoryVault && (
                      <div className="pt-2 border-t border-claude-border-light/60 dark:border-claude-border-dark/60 flex items-center justify-between">
                        <span className="text-[11px] text-claude-muted-light">Inspect, search, and edit saved memory items:</span>
                        <button
                          type="button"
                          onClick={() => {
                            onClose();
                            onOpenMemoryVault();
                          }}
                          className="px-3 py-1.5 rounded-lg bg-claude-terracotta/10 hover:bg-claude-terracotta/20 text-claude-accentInk font-bold text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-terracotta active:scale-[0.99]"
                        >
                          Open Memory Vault
                        </button>
                      </div>
                    )}

                    {/* Safe Memory Retention Warning Banner */}
                    {isMemoryExceeded && (
                      <div data-testid="retention-banner-memory" className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-800 dark:text-amber-200 space-y-1">
                        <div className="flex items-center gap-2 font-bold">
                          <Lock className="w-4 h-4 text-amber-500 shrink-0" />
                          <span>Safe Memory Retention Active</span>
                        </div>
                        <p className="text-[11px] leading-relaxed">
                          You have {memoryCount} memories. Your current plan includes {memoryLimit}. Excess memories are preserved in read-only mode without deletion.
                        </p>
                      </div>
                    )}

                    {form.tipsEnabled !== false && (
                      <div data-testid="tip-memory" className="p-3.5 rounded-xl bg-blue-500/10 border border-blue-500/20 text-xs text-blue-800 dark:text-blue-300 flex items-start gap-2.5">
                        <Database className="w-4 h-4 shrink-0 mt-0.5 text-blue-600 dark:text-blue-400" />
                        <div>
                          <div className="font-bold">Pro Tip: Safe Cross-Conversation Memory</div>
                          <p className="mt-0.5 text-[11px] leading-relaxed opacity-90">
                            AIRA automatically consolidates important facts across sessions while scrubbing authorization tokens and passwords to maintain continuous, private context.
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                </motion.div>
              )}

              {/* TAB 4: PERSONALIZATION & INSTRUCTIONS */}
              {activeTab === 'instructions' && (
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-5">
                  <div>
                    <label htmlFor="aira-settings-instructions" className="text-xs font-semibold text-claude-muted-light dark:text-claude-muted-dark block mb-2">Custom System Directives</label>
                    <textarea 
                      id="aira-settings-instructions"
                      rows={5}
                      value={form.customInstructions} 
                      onChange={e => setForm({ ...form, customInstructions: e.target.value })} 
                      placeholder="Directives injected into the top of every conversation context (e.g., prefer functional TypeScript, provide mathematical proof where applicable)..." 
                      className="w-full px-4 py-3 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark text-[13px] font-mono outline-none focus:border-claude-terracotta transition-colors motion-reduce:transition-none resize-none" 
                    />
                  </div>

                  <div>
                    <label htmlFor="aira-settings-bio" className="text-xs font-semibold text-claude-muted-light dark:text-claude-muted-dark block mb-2">User Context & Bio</label>
                    <textarea 
                      id="aira-settings-bio"
                      rows={3}
                      value={form.userBio || ''} 
                      onChange={e => setForm({ ...form, userBio: e.target.value })} 
                      placeholder="e.g. Senior Principal Architect specializing in distributed systems and React 19."
                      className="w-full px-4 py-3 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark text-[13px] font-medium outline-none focus:border-claude-terracotta transition-colors motion-reduce:transition-none resize-none" 
                    />
                  </div>

                  {form.tipsEnabled !== false && (
                    <div data-testid="tip-personalization" className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-800 dark:text-emerald-300 flex items-start gap-2.5">
                      <Sliders className="w-4 h-4 shrink-0 mt-0.5 text-emerald-600 dark:text-emerald-400" />
                      <div>
                        <div className="font-bold">Pro Tip: Custom Personality & Coding Style</div>
                        <p className="mt-0.5 text-[11px] leading-relaxed opacity-90">
                          Custom directives steer AIRA&apos;s output style across every chat. User context bio lets AIRA tailor explanations to your seniority and tech stack.
                        </p>
                      </div>
                    </div>
                  )}
                </motion.div>
              )}

              {/* TAB 5: ARTIFACT STUDIO */}
              {activeTab === 'artifacts' && (
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-5">
                  <div className="p-4 rounded-xl border border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light/40 dark:bg-claude-surface2-dark/40 flex items-center justify-between">
                    <div>
                      <div className="text-xs font-bold text-claude-text-light dark:text-white">Auto-Open Artifact Studio</div>
                      <div className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark mt-0.5">Automatically open the side canvas when an interactive code artifact or diagram is generated.</div>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={form.autoOpenArtifacts !== false}
                        onChange={e => setForm({ ...form, autoOpenArtifacts: e.target.checked })}
                        className="sr-only peer"
                      />
                      <div className="w-11 h-6 bg-claude-surface2-light dark:bg-white/20 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-transform motion-reduce:after:transition-none peer-checked:bg-claude-terracotta"></div>
                    </label>
                  </div>

                  <div className="p-4 rounded-xl border border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light/40 dark:bg-claude-surface2-dark/40 flex items-center justify-between">
                    <div>
                      <div className="text-xs font-bold text-claude-text-light dark:text-white">
                        {activePlanDef.allowPythonSandbox ? 'Interactive Python & Web Sandbox' : 'Interactive Web Sandbox Preview'}
                      </div>
                      <div className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark mt-0.5">
                        {activePlanDef.allowPythonSandbox 
                          ? 'Execute Python scripts, HTML, SVG, and React components with full isolation.' 
                          : 'Live execute HTML, SVG, and Tailwind previews inside a secure isolated iframe.'}
                      </div>
                    </div>
                    <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10 px-2.5 py-1 rounded-md border border-emerald-200/50 dark:border-emerald-500/20">
                      {activePlanDef.allowPythonSandbox ? 'Pro Sandbox Active' : 'Web Sandbox Active'}
                    </span>
                  </div>

                  {form.tipsEnabled !== false && (
                    <div data-testid="tip-artifacts" className="p-3.5 rounded-xl bg-purple-500/10 border border-purple-500/20 text-xs text-purple-800 dark:text-purple-300 flex items-start gap-2.5">
                      <FileCode2 className="w-4 h-4 shrink-0 mt-0.5 text-purple-600 dark:text-purple-400" />
                      <div>
                        <div className="font-bold">Pro Tip: Dual-Pane Artifact Studio</div>
                        <p className="mt-0.5 text-[11px] leading-relaxed opacity-90">
                          When &apos;Auto-Open Artifact Studio&apos; is enabled, code, SVG diagrams, and HTML mockups open automatically side-by-side with your chat.
                        </p>
                      </div>
                    </div>
                  )}
                </motion.div>
              )}

              {/* TAB 7: ACCOUNT & PRIVACY DATA */}
              {activeTab === 'data' && (
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-5">
                  {/* Account / Subscription Banner */}
                  <div className="p-4 rounded-2xl border border-claude-terracotta/20 bg-claude-terracotta/5 dark:bg-claude-terracotta/10 flex items-center justify-between">
                    <div>
                      <div className="text-xs font-semibold text-claude-accentInk">
                        {currentUser ? 'Authenticated Profile' : 'Guest Workspace'}
                      </div>
                      <div className="text-sm font-bold text-claude-text-light dark:text-white mt-0.5">
                        {currentUser ? `${currentUser.name || 'User'} (${activePlanDef.name} Workspace)` : `${activePlanDef.name} (Guest Session)`}
                      </div>
                      <div className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark mt-0.5">
                        {currentUser ? currentUser.email : 'Unauthenticated trial session. Sign in to sync across devices.'}
                      </div>
                    </div>
                    <span className={`text-xs font-bold px-3 py-1 rounded-full ${currentUser ? 'bg-claude-terracotta text-claude-onAccent' : 'bg-claude-surface2-light dark:bg-claude-surface2-dark text-claude-muted-light border border-claude-border-light dark:border-claude-border-dark'}`}>
                      {currentUser ? 'Active' : 'Guest'}
                    </span>
                  </div>

                  {/* Actions for Plan, Billing & Pricing */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    <button
                      type="button"
                      data-testid="settings-goto-plan"
                      onClick={() => setActiveTab('plan')}
                      className="p-3 rounded-xl border border-claude-border-light dark:border-white/10 bg-claude-surface2-light dark:bg-white/5 hover:border-claude-terracotta/50 text-left transition-colors flex items-center gap-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-terracotta active:scale-[0.99]"
                    >
                      <CreditCard className="w-4 h-4 text-claude-accentInk shrink-0" />
                      <div>
                        <div className="text-xs font-bold text-claude-text-light dark:text-white">My Plan & Usage</div>
                        <div className="text-[10px] text-claude-muted-light">Active tier, meters & quotas</div>
                      </div>
                    </button>

                    {onOpenBilling && (
                      <button
                        type="button"
                        onClick={() => {
                          onClose();
                          onOpenBilling();
                        }}
                        className="p-3 rounded-xl border border-claude-border-light dark:border-white/10 bg-claude-surface2-light dark:bg-white/5 hover:border-claude-terracotta/50 text-left transition-colors flex items-center gap-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-terracotta active:scale-[0.99]"
                      >
                        <CreditCard className="w-4 h-4 text-claude-accentInk shrink-0" />
                        <div>
                          <div className="text-xs font-bold text-claude-text-light dark:text-white">Account & Billing</div>
                          <div className="text-[10px] text-claude-muted-light">Usage, quotas & top-ups</div>
                        </div>
                      </button>
                    )}

                    {onOpenPricing && (
                      <button
                        type="button"
                        onClick={() => {
                          onClose();
                          onOpenPricing();
                        }}
                        className="p-3 rounded-xl border border-claude-border-light dark:border-white/10 bg-claude-surface2-light dark:bg-white/5 hover:border-claude-terracotta/50 text-left transition-colors flex items-center gap-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-terracotta active:scale-[0.99]"
                      >
                        <Zap className="w-4 h-4 text-claude-accentInk shrink-0" />
                        <div>
                          <div className="text-xs font-bold text-claude-text-light dark:text-white">Upgrade Plan</div>
                          <div className="text-[10px] text-claude-muted-light">Compare Free, Plus & Pro</div>
                        </div>
                      </button>
                    )}
                  </div>

                  {/* Safe Downgrade Retention Warning Banner */}
                  {isProjectsExceeded && (
                    <div data-testid="retention-banner-projects-data" className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-800 dark:text-amber-200 space-y-1">
                      <div className="flex items-center gap-2 font-bold">
                        <Lock className="w-4 h-4 text-amber-500 shrink-0" />
                        <span>Safe Downgrade Retention Active</span>
                      </div>
                      <p className="text-[11px] leading-relaxed">
                        You have {projects.length} projects. Your current plan includes {projectLimit}. Excess projects are saved in read-only mode. All data remains fully exportable below.
                      </p>
                    </div>
                  )}

                  {/* Privacy Controls */}
                  <div className="p-4 rounded-xl border border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light/40 dark:bg-claude-surface2-dark/40 flex items-center justify-between">
                    <div>
                      <div className="text-xs font-bold text-claude-text-light dark:text-white">Telemetry Opt-Out</div>
                      <div className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark mt-0.5">Disable all anonymous client diagnostic telemetry.</div>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={form.telemetryOptOut === true}
                        onChange={e => setForm({ ...form, telemetryOptOut: e.target.checked })}
                        className="sr-only peer"
                      />
                      <div className="w-9 h-5 bg-claude-surface2-light dark:bg-white/20 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-transform motion-reduce:after:transition-none peer-checked:bg-claude-terracotta"></div>
                    </label>
                  </div>

                  {/* Notification Preferences */}
                  <div data-testid="settings-notifications-section" className="p-4 rounded-xl border border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light/40 dark:bg-claude-surface2-dark/40 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-xs font-bold text-claude-text-light dark:text-white">Notification Preferences</div>
                        <div className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark mt-0.5">Control product update popups, announcements, and contextual tips.</div>
                      </div>
                    </div>

                    <div className="space-y-2 pt-2 border-t border-claude-border-light/60 dark:border-white/10">
                      {/* Product Announcements & What’s New */}
                      <div className="flex items-center justify-between py-1">
                        <div>
                          <div className="text-xs font-medium text-claude-text-light dark:text-white">Product Announcements & What’s New</div>
                          <div className="text-[10px] text-claude-muted-light">Show popups for major feature releases and platform updates</div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            data-testid="settings-toggle-announcements"
                            checked={form.announcementsEnabled !== false}
                            onChange={e => setForm({ ...form, announcementsEnabled: e.target.checked })}
                            className="sr-only peer"
                          />
                          <div className="w-9 h-5 bg-claude-surface2-light dark:bg-white/20 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-transform motion-reduce:after:transition-none peer-checked:bg-claude-terracotta"></div>
                        </label>
                      </div>

                      {/* Product & Model Updates */}
                      <div className="flex items-center justify-between py-1">
                        <div>
                          <div className="text-xs font-medium text-claude-text-light dark:text-white">Product & Model Updates</div>
                          <div className="text-[10px] text-claude-muted-light">Notifications about new models, thinking budgets, and tool capabilities</div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            data-testid="settings-toggle-product-updates"
                            checked={form.productUpdatesEnabled !== false}
                            onChange={e => setForm({ ...form, productUpdatesEnabled: e.target.checked })}
                            className="sr-only peer"
                          />
                          <div className="w-9 h-5 bg-claude-surface2-light dark:bg-white/20 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-transform motion-reduce:after:transition-none peer-checked:bg-claude-terracotta"></div>
                        </label>
                      </div>

                      {/* Tips & Feature Guidance */}
                      <div className="flex items-center justify-between py-1">
                        <div>
                          <div className="text-xs font-medium text-claude-text-light dark:text-white">Tips & Feature Guidance</div>
                          <div className="text-[10px] text-claude-muted-light">Contextual discovery cards when enabling new plan features</div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            data-testid="settings-toggle-tips"
                            checked={form.tipsEnabled !== false}
                            onChange={e => setForm({ ...form, tipsEnabled: e.target.checked })}
                            className="sr-only peer"
                          />
                          <div className="w-9 h-5 bg-claude-surface2-light dark:bg-white/20 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-transform motion-reduce:after:transition-none peer-checked:bg-claude-terracotta"></div>
                        </label>
                      </div>

                      {/* Reset Dismissed Announcements */}
                      <div className="pt-2 flex items-center justify-between border-t border-claude-border-light/40 dark:border-white/5">
                        <span className="text-[11px] text-claude-muted-light">Reset all dismissed release announcements to review again</span>
                        <button
                          type="button"
                          data-testid="settings-reset-announcements"
                          onClick={handleResetAnnouncements}
                          className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-stone-200/60 dark:bg-white/10 hover:bg-stone-300 dark:hover:bg-white/20 text-claude-text-light dark:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-terracotta active:scale-[0.99]"
                        >
                          {announcementsReset ? 'Announcements Reset!' : 'Reset Announcements'}
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Interactive Tutorial / Walkthrough Restart */}
                  <div className="p-4 rounded-xl border border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light/40 dark:bg-claude-surface2-dark/40 flex items-center justify-between">
                    <div>
                      <div className="text-xs font-bold text-claude-text-light dark:text-white">AIRA Interactive Walkthrough</div>
                      <div className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark mt-0.5">Restart the 5-stage onboarding tour covering Chat, Reasoning, Agent Mode, and Artifacts.</div>
                    </div>
                    <button
                      type="button"
                      data-testid="settings-restart-onboarding"
                      onClick={handleRestartOnboarding}
                      className="px-3 py-1.5 text-xs font-bold rounded-lg bg-aira-blue text-white hover:bg-aira-blue/90 shadow-sm transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-terracotta active:scale-[0.99]"
                    >
                      Restart Tour
                    </button>
                  </div>

                  {/* Backup & Portability */}
                  <div className="pt-2">
                    <div className="text-xs font-semibold text-claude-muted-light dark:text-claude-muted-dark mb-3">Workspace Backup & Portability</div>
                    <div className="flex gap-3">
                      <motion.button 
                        whileHover={{ scale: 1.02 }} 
                        whileTap={{ scale: 0.98 }} 
                        onClick={exportData} 
                        className="flex-1 p-3 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark text-[13px] font-bold text-claude-text-light dark:text-white flex items-center justify-center gap-2 hover:border-claude-terracotta/50 transition-colors shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-terracotta active:scale-[0.99]"
                      >
                        <Download className="w-4 h-4 text-claude-accentInk" />
                        <span>Export Data (JSON)</span>
                      </motion.button>
                      <motion.label 
                        whileHover={{ scale: 1.02 }} 
                        whileTap={{ scale: 0.98 }} 
                        className="flex-1 p-3 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark text-[13px] font-bold text-claude-text-light dark:text-white flex items-center justify-center gap-2 cursor-pointer hover:border-claude-terracotta/50 transition-colors shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-terracotta active:scale-[0.99]"
                      >
                        <Upload className="w-4 h-4 text-claude-accentInk" />
                        <span>Import Backup</span>
                        <input type="file" accept=".json" onChange={importData} className="hidden" aria-label="Import workspace settings JSON file" />
                      </motion.label>
                    </div>
                  </div>

                  {/* Quick Shortcuts Trigger */}
                  {onOpenShortcuts && (
                    <div className="p-3 rounded-xl border border-claude-border-light/60 dark:border-claude-border-dark/60 bg-claude-surface2-light/20 dark:bg-white/[0.01] flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <Keyboard className="w-4 h-4 text-claude-accentInk" />
                        <span className="font-medium text-claude-text-light dark:text-white">Keyboard Shortcuts Map</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          onClose();
                          onOpenShortcuts();
                        }}
                        className="text-claude-accentInk font-bold hover:underline"
                      >
                        View Table
                      </button>
                    </div>
                  )}

                  <div className="pt-4 border-t border-claude-border-light dark:border-claude-border-dark">
                    <button 
                      onClick={() => { if (confirm('Reset all Aira local data, conversations, and projects from this browser? (Local device data only; does not affect server-side accounts)')) onClearAll(); }} 
                      className="text-xs font-bold text-red-500 hover:text-red-600 transition-colors flex items-center justify-center w-full min-h-[40px] px-3 py-2.5 rounded-xl hover:bg-red-50 dark:hover:bg-red-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-terracotta active:scale-[0.99]"
                    >
                      Reset all local workspace data (This device only)
                    </button>
                  </div>
                </motion.div>
              )}
            </div>

            {/* Footer */}
            <footer 
              data-testid="settings-footer" 
              className="shrink-0 px-3 sm:px-7 py-2.5 sm:py-3.5 border-t border-claude-border-light dark:border-claude-border-dark flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3 bg-claude-surface2-light dark:bg-claude-surface2-dark" 
              style={{ paddingBottom: 'max(0.625rem, env(safe-area-inset-bottom, 0px))' }}
            >
              <span className="block text-center sm:text-left text-[11px] font-medium tracking-tight text-claude-muted-light dark:text-claude-muted-dark">
                Product of Virexa AI Ventures
              </span>
              <div className="grid grid-cols-2 sm:flex sm:items-center gap-2 min-w-0">
                <button 
                  type="button" 
                  onClick={onClose} 
                  className="min-w-0 px-3 py-2.5 rounded-xl text-[13px] font-medium text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light dark:hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-terracotta active:scale-[0.99]"
                >
                  Cancel
                </button>
                <motion.button 
                  whileHover={{ scale: 1.02 }} 
                  whileTap={{ scale: 0.98 }} 
                  onClick={save}
                  data-testid="settings-save"
                  className="min-w-0 justify-center px-3 sm:px-5 py-2.5 rounded-xl bg-claude-terracotta-hover text-claude-onAccent text-[13px] font-bold hover:brightness-90 transition-colors flex items-center gap-1.5 shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-terracotta active:scale-[0.99]"
                >
                  {saved && <Check className="w-4 h-4" />}
                  {saved ? 'Preferences Saved' : 'Save Changes'}
                </motion.button>
              </div>
            </footer>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
