import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { 
  User, 
  Settings, 
  HelpCircle, 
  LogOut, 
  Sparkles, 
  ChevronRight, 
  ShieldCheck, 
  Sliders, 
  FileText, 
  Keyboard, 
  Download, 
  Bug, 
  Lock, 
  ChevronLeft, 
  CreditCard, 
  History, 
  CheckCircle2,
  Compass,
  Film
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import type { NeonUser } from '../lib/neonAuth';
import { neonAuth } from '../lib/neonAuth';
import { parseBillingSummary } from '../lib/accountBillingTruth';
import type { AppSettings } from '../types';

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

interface AccountMenuDropdownProps {
  isOpen: boolean;
  onClose: () => void;
  neonUser: NeonUser | null;
  settings: AppSettings;
  anchorRef?: React.RefObject<HTMLElement | null>;
  onOpenSettings: (initialTab?: string) => void;
  onOpenBilling: () => void;
  onOpenPricing: () => void;
  onOpenAuth: () => void;
  onOpenHelpCenter: () => void;
  onOpenPrivacyCenter: () => void;
  onOpenReleaseNotes: () => void;
  onOpenDownloadApps: () => void;
  onOpenShortcuts: () => void;
  onOpenLegalViewer: (doc: 'terms' | 'privacy') => void;
  onOpenReportBug: () => void;
  onSignOutSuccess?: () => void;
  onOpenWhatsNew?: () => void;
  onRestartOnboarding?: () => void;
  onOpenMotionStudio?: () => void;
  unreadAnnouncementsCount?: number;
}

export const AccountMenuDropdown: React.FC<AccountMenuDropdownProps> = ({
  isOpen,
  onClose,
  neonUser,
  settings: _settings,
  anchorRef,
  onOpenSettings,
  onOpenBilling,
  onOpenPricing,
  onOpenAuth,
  onOpenHelpCenter,
  onOpenPrivacyCenter,
  onOpenReleaseNotes,
  onOpenDownloadApps,
  onOpenShortcuts,
  onOpenLegalViewer,
  onOpenReportBug,
  onSignOutSuccess,
  onOpenWhatsNew,
  onRestartOnboarding,
  onOpenMotionStudio,
  unreadAnnouncementsCount,
}) => {
  const [activeSubmenu, setActiveSubmenu] = useState<'main' | 'help'>('main');
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [billingPlanName, setBillingPlanName] = useState<string | null>(null);
  const [isBillingLoading, setIsBillingLoading] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{
    left: number;
    bottom?: number;
    top?: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Position calculation relative to anchor button and viewport boundaries
  const updatePosition = useCallback(() => {
    const anchor = anchorRef?.current?.getBoundingClientRect();
    if (!anchor || typeof window === 'undefined') return;

    const viewport = window.visualViewport;
    const viewportWidth = viewport?.width || window.innerWidth;
    const viewportHeight = viewport?.height || window.innerHeight;
    const viewportOffsetLeft = viewport?.offsetLeft || 0;
    const viewportOffsetTop = viewport?.offsetTop || 0;

    const GUTTER = 12;
    const width = Math.min(320, viewportWidth - GUTTER * 2);

    const minLeft = viewportOffsetLeft + GUTTER;
    const maxLeft = viewportOffsetLeft + viewportWidth - width - GUTTER;
    const left = Math.max(minLeft, Math.min(anchor.left, maxLeft));

    const spaceAbove = anchor.top - viewportOffsetTop - GUTTER;
    const spaceBelow = (viewportOffsetTop + viewportHeight) - anchor.bottom - GUTTER;

    const placeAbove = spaceAbove >= 220 || spaceAbove >= spaceBelow;

    if (placeAbove) {
      const bottom = Math.max(GUTTER, window.innerHeight - anchor.top + 8);
      const maxHeight = Math.min(540, Math.max(160, spaceAbove - 8));
      setMenuPosition({ left, bottom, width, maxHeight });
    } else {
      const top = Math.max(GUTTER, anchor.bottom + 8);
      const maxHeight = Math.min(540, Math.max(160, spaceBelow - 8));
      setMenuPosition({ left, top, width, maxHeight });
    }
  }, [anchorRef]);

  useIsomorphicLayoutEffect(() => {
    if (!isOpen) {
      setMenuPosition(null);
      return;
    }

    updatePosition();

    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', updatePosition);
      window.visualViewport.addEventListener('scroll', updatePosition);
    }

    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', updatePosition);
        window.visualViewport.removeEventListener('scroll', updatePosition);
      }
    };
  }, [isOpen, updatePosition]);

  // Reset to main view whenever opened
  useEffect(() => {
    if (isOpen) {
      setActiveSubmenu('main');
    }
  }, [isOpen]);

  // Fetch verified billing tier from server-side summary endpoint
  useEffect(() => {
    if (!isOpen || !neonUser?.id) {
      setBillingPlanName(null);
      setIsBillingLoading(false);
      return;
    }

    let cancelled = false;
    setIsBillingLoading(true);

    fetch('/api/billing/summary', {
      headers: { Accept: 'application/json' },
      credentials: 'include',
      cache: 'no-store'
    })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (cancelled) return;
        const summary = parseBillingSummary(data, neonUser.id);
        if (summary) {
          setBillingPlanName(summary.planName || (summary.planId === 'pro' ? 'Pro Plan' : summary.planId === 'plus' ? 'Plus Plan' : 'Free Plan'));
        } else {
          setBillingPlanName('Standard Workspace');
        }
      })
      .catch(() => {
        if (!cancelled) setBillingPlanName('Standard Workspace');
      })
      .finally(() => {
        if (!cancelled) setIsBillingLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, neonUser?.id]);

  // Click outside listener using pointerdown
  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        menuRef.current && 
        !menuRef.current.contains(target) &&
        (!anchorRef?.current || !anchorRef.current.contains(target))
      ) {
        onClose();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [isOpen, onClose, anchorRef]);

  // Keyboard navigation, ARIA arrow cycling & escape listener
  useEffect(() => {
    if (!isOpen) return;

    const timer = setTimeout(() => {
      if (menuRef.current) {
        const firstFocusable = menuRef.current.querySelector<HTMLElement>(
          'button:not([disabled]), [tabindex="0"]'
        );
        if (firstFocusable) {
          firstFocusable.focus();
        } else {
          menuRef.current.focus();
        }
      }
    }, 50);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (activeSubmenu === 'help') {
          setActiveSubmenu('main');
        } else {
          onClose();
          anchorRef?.current?.focus();
        }
        return;
      }

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!menuRef.current) return;
        const items = Array.from(
          menuRef.current.querySelectorAll<HTMLButtonElement>(
            'button[role="menuitem"]:not([disabled])'
          )
        );
        if (items.length === 0) return;

        e.preventDefault();
        const activeIdx = items.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === 'ArrowDown') {
          const nextIdx = activeIdx < items.length - 1 ? activeIdx + 1 : 0;
          items[nextIdx].focus();
        } else {
          const prevIdx = activeIdx > 0 ? activeIdx - 1 : items.length - 1;
          items[prevIdx].focus();
        }
        return;
      }

      if (e.key === 'Tab') {
        setTimeout(() => {
          if (menuRef.current && !menuRef.current.contains(document.activeElement)) {
            onClose();
          }
        }, 0);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, activeSubmenu, onClose, anchorRef]);

  const handleLogout = async () => {
    const startEpoch = neonAuth.getAuthEpoch();
    try {
      setIsLoggingOut(true);
      onClose();
      await neonAuth.signOut();
      if (neonAuth.getAuthEpoch() === startEpoch + 1 && !neonAuth.getCurrentUser()) {
        onSignOutSuccess?.();
      }
    } catch (e) {
      console.error('Logout error', e);
    } finally {
      setIsLoggingOut(false);
    }
  };

  const getInitials = (name?: string, email?: string) => {
    if (name && name.trim()) {
      const parts = name.trim().split(/\s+/);
      if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
      return name.slice(0, 2).toUpperCase();
    }
    if (email && email.includes('@')) {
      return email.slice(0, 2).toUpperCase();
    }
    return 'AI';
  };

  if (!isOpen) return null;

  const menuContent = (
    <div
      ref={menuRef}
      role="menu"
      tabIndex={-1}
      aria-orientation="vertical"
      aria-label="Account and user settings menu"
      className="fixed rounded-2xl bg-claude-surface-light dark:bg-stone-900 border border-claude-border-light dark:border-white/10 shadow-2xl overflow-hidden z-[100] text-claude-text-light dark:text-white backdrop-blur-xl outline-none"
      style={{
        left: menuPosition?.left ?? 12,
        bottom: menuPosition?.bottom,
        top: menuPosition?.top,
        width: menuPosition?.width ?? 320,
        maxHeight: menuPosition?.maxHeight ?? 'calc(100vh - 80px)',
        opacity: menuPosition ? 1 : 0,
        pointerEvents: menuPosition ? 'auto' : 'none',
      }}
    >
      <AnimatePresence mode="wait">
        {activeSubmenu === 'main' ? (
          <motion.div
            key="main-menu"
            initial={{ opacity: 0, x: -12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -12 }}
            transition={{ duration: 0.15 }}
            className="flex flex-col max-h-[inherit]"
          >
            {/* Header: User Profile Details */}
            {neonUser ? (
              <div className="p-4 border-b border-claude-border-light dark:border-white/10 bg-claude-surface2-light/40 dark:bg-white/[0.02]">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-claude-terracotta to-aira-blue text-white font-bold text-sm flex items-center justify-center shrink-0 shadow-sm overflow-hidden">
                    {neonUser.image ? (
                      <img src={neonUser.image} alt={neonUser.name || 'User'} className="w-full h-full object-cover" />
                    ) : (
                      <span>{getInitials(neonUser.name, neonUser.email)}</span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-bold truncate text-claude-text-light dark:text-white">
                        {neonUser.name || 'Authenticated User'}
                      </span>
                      {neonUser.emailVerified && (
                        <span title="Verified Account" className="inline-flex items-center shrink-0"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" /></span>
                      )}
                    </div>
                    <div className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark truncate">
                      {neonUser.email}
                    </div>
                  </div>
                </div>

                {/* Plan Badge & Quick Upgrade Action */}
                <div className="mt-3 flex items-center justify-between gap-2 p-2 rounded-xl bg-claude-surface-light dark:bg-white/5 border border-claude-border-light/60 dark:border-white/10">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0"></span>
                    <span className="text-xs font-semibold text-claude-text-light dark:text-white truncate">
                      {isBillingLoading ? 'Loading plan...' : (billingPlanName || 'Standard Workspace')}
                    </span>
                  </div>
                  <button
                    data-testid="account-menu-manage-plan"
                    onClick={() => {
                      onClose();
                      onOpenSettings('plan');
                    }}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-aira-blue/10 hover:bg-aira-blue/20 text-aira-blue dark:text-aira-cyan text-[11px] font-bold transition-colors shrink-0"
                  >
                    <Sparkles className="w-3 h-3" />
                    <span>Manage Plan</span>
                  </button>
                </div>
              </div>
            ) : (
              /* Unauthenticated / Guest Header */
              <div className="p-4 border-b border-claude-border-light dark:border-white/10 bg-claude-surface2-light/40 dark:bg-white/[0.02]">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-claude-surface2-light dark:bg-white/10 border border-claude-border-light dark:border-white/10 flex items-center justify-center text-claude-muted-light shrink-0">
                    <ShieldCheck className="w-5 h-5 text-amber-500" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-bold text-claude-text-light dark:text-white">
                      Guest Workspace
                    </div>
                    <div className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark">
                      Local sandbox session
                    </div>
                  </div>
                </div>

                <div className="mt-3 flex flex-col gap-1.5">
                  <button
                    data-testid="account-menu-signin"
                    onClick={() => {
                      onClose();
                      onOpenAuth();
                    }}
                    className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-aira-blue hover:bg-aira-blue/90 text-white font-bold text-xs transition-colors shadow-sm"
                  >
                    <User className="w-3.5 h-3.5" />
                    <span>Sign in or Create Account</span>
                  </button>
                  <button
                    data-testid="account-menu-guest-plan"
                    onClick={() => {
                      onClose();
                      onOpenSettings('plan');
                    }}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-xl border border-claude-border-light dark:border-white/10 text-claude-text-light dark:text-white font-semibold text-[11px] hover:bg-claude-surface2-light dark:hover:bg-white/5 transition-colors"
                  >
                    <Sparkles className="w-3 h-3 text-claude-accentInk" />
                    <span>View Plan & Limits</span>
                  </button>
                </div>
              </div>
            )}

            {/* Menu Items List */}
            <div className="p-2 space-y-0.5 text-xs overflow-y-auto">
              {/* My Plan & Usage */}
              <button
                role="menuitem"
                data-testid="account-menu-plan-tab"
                onClick={() => {
                  onClose();
                  onOpenSettings('plan');
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left hover:bg-claude-surface2-light dark:hover:bg-white/5 transition-colors group"
              >
                <Sparkles className="w-4 h-4 text-claude-muted-light group-hover:text-claude-accentInk transition-colors" />
                <span className="flex-1 font-medium">My Plan & Usage</span>
                <span className="text-[10px] text-claude-muted-light">Meters</span>
              </button>

              {/* Account Management */}
              {neonUser && (
                <button
                  role="menuitem"
                  onClick={() => {
                    onClose();
                    onOpenBilling();
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left hover:bg-claude-surface2-light dark:hover:bg-white/5 transition-colors group"
                >
                  <CreditCard className="w-4 h-4 text-claude-muted-light group-hover:text-aira-blue transition-colors" />
                  <span className="flex-1 font-medium">Account & Billing</span>
                </button>
              )}

              {/* Personalization (Direct to Instructions Tab) */}
              <button
                role="menuitem"
                onClick={() => {
                  onClose();
                  onOpenSettings('instructions');
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left hover:bg-claude-surface2-light dark:hover:bg-white/5 transition-colors group"
              >
                <Sliders className="w-4 h-4 text-claude-muted-light group-hover:text-aira-blue transition-colors" />
                <span className="flex-1 font-medium">Personalization</span>
                <span className="text-[10px] text-claude-muted-light">Directives</span>
              </button>

              {/* Settings (Direct to General Tab) */}
              <button
                role="menuitem"
                onClick={() => {
                  onClose();
                  onOpenSettings('general');
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left hover:bg-claude-surface2-light dark:hover:bg-white/5 transition-colors group"
              >
                <Settings className="w-4 h-4 text-claude-muted-light group-hover:text-aira-blue transition-colors" />
                <span className="flex-1 font-medium">Settings</span>
                <kbd className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-claude-surface2-light dark:bg-white/10 text-claude-muted-light">⌘,</kbd>
              </button>

              {/* Help & Support Submenu Trigger */}
              <button
                role="menuitem"
                aria-haspopup="true"
                aria-expanded={false}
                onClick={() => setActiveSubmenu('help')}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left hover:bg-claude-surface2-light dark:hover:bg-white/5 transition-colors group"
              >
                <HelpCircle className="w-4 h-4 text-claude-muted-light group-hover:text-aira-blue transition-colors" />
                <span className="flex-1 font-medium">Help & Resources</span>
                <ChevronRight className="w-3.5 h-3.5 text-claude-muted-light group-hover:translate-x-0.5 transition-transform" />
              </button>

              <div className="my-1 border-t border-claude-border-light/60 dark:border-white/10" />

              {/* Sign out or Sign in */}
              {neonUser ? (
                <button
                  role="menuitem"
                  data-testid="account-menu-logout"
                  onClick={handleLogout}
                  disabled={isLoggingOut}
                  className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 transition-colors font-medium"
                >
                  <LogOut className="w-4 h-4" />
                  <span>{isLoggingOut ? 'Signing out...' : 'Log out'}</span>
                </button>
              ) : (
                <button
                  role="menuitem"
                  onClick={() => {
                    onClose();
                    onOpenPricing();
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left text-aira-blue hover:bg-aira-blue/10 transition-colors font-medium"
                >
                  <Sparkles className="w-4 h-4" />
                  <span>View Subscription Plans</span>
                </button>
              )}
            </div>
          </motion.div>
        ) : (
          /* Submenu: Help & Resources */
          <motion.div
            key="help-submenu"
            initial={{ opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 12 }}
            transition={{ duration: 0.15 }}
            className="flex flex-col max-h-[inherit]"
          >
            {/* Submenu Header */}
            <div className="flex items-center gap-2 px-3 py-2.5 border-b border-claude-border-light dark:border-white/10 bg-claude-surface2-light/40 dark:bg-white/[0.02]">
              <button
                onClick={() => setActiveSubmenu('main')}
                className="p-1 rounded-lg text-claude-muted-light hover:text-claude-text-light hover:bg-claude-surface2-light dark:hover:bg-white/10 transition-colors"
                aria-label="Back to main account menu"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-xs font-bold text-claude-text-light dark:text-white">
                Help & Resources
              </span>
            </div>

            {/* Submenu Items */}
            <div className="p-2 space-y-0.5 text-xs max-h-80 overflow-y-auto">
              <button
                role="menuitem"
                data-testid="account-menu-whats-new"
                onClick={() => {
                  onClose();
                  onOpenWhatsNew?.();
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left hover:bg-claude-surface2-light dark:hover:bg-white/5 transition-colors group"
              >
                <Sparkles className="w-4 h-4 text-amber-500 shrink-0" />
                <span className="flex-1 font-medium">What's New</span>
                {typeof unreadAnnouncementsCount === 'number' && unreadAnnouncementsCount > 0 && (
                  <span
                    data-testid="account-menu-whats-new-badge"
                    className="px-1.5 py-0.2 text-[10px] font-bold rounded-full bg-aira-blue text-white"
                  >
                    {unreadAnnouncementsCount}
                  </span>
                )}
              </button>

              <button
                role="menuitem"
                data-testid="account-menu-restart-onboarding"
                onClick={() => {
                  onClose();
                  onRestartOnboarding?.();
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left hover:bg-claude-surface2-light dark:hover:bg-white/5 transition-colors group"
              >
                <Compass className="w-4 h-4 text-aira-blue shrink-0" />
                <span className="flex-1 font-medium">Interactive Tour</span>
                <span className="text-[10px] text-claude-muted-light">Tutorial</span>
              </button>

              <button
                role="menuitem"
                data-testid="account-menu-motion-studio"
                onClick={() => {
                  onClose();
                  onOpenMotionStudio?.();
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left hover:bg-claude-surface2-light dark:hover:bg-white/5 transition-colors group"
              >
                <Film className="w-4 h-4 text-cyan-500 shrink-0" />
                <span className="flex-1 font-medium">Motion Showcase</span>
                <span className="text-[10px] text-claude-muted-light">Video Studio</span>
              </button>

              <button
                role="menuitem"
                onClick={() => {
                  onClose();
                  onOpenHelpCenter();
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left hover:bg-claude-surface2-light dark:hover:bg-white/5 transition-colors group"
              >
                <HelpCircle className="w-4 h-4 text-aira-blue shrink-0" />
                <span className="flex-1 font-medium">Help Center</span>
              </button>

              <button
                role="menuitem"
                onClick={() => {
                  onClose();
                  onOpenPrivacyCenter();
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left hover:bg-claude-surface2-light dark:hover:bg-white/5 transition-colors group"
              >
                <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0" />
                <span className="flex-1 font-medium">Privacy Center</span>
              </button>

              <button
                role="menuitem"
                onClick={() => {
                  onClose();
                  onOpenReleaseNotes();
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left hover:bg-claude-surface2-light dark:hover:bg-white/5 transition-colors group"
              >
                <History className="w-4 h-4 text-indigo-500 shrink-0" />
                <span className="flex-1 font-medium">Release Notes</span>
                <span className="text-[10px] font-bold text-emerald-500">v2.4</span>
              </button>

              <button
                role="menuitem"
                onClick={() => {
                  onClose();
                  onOpenDownloadApps();
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left hover:bg-claude-surface2-light dark:hover:bg-white/5 transition-colors group"
              >
                <Download className="w-4 h-4 text-cyan-500 shrink-0" />
                <span className="flex-1 font-medium">Download Apps</span>
              </button>

              <button
                role="menuitem"
                onClick={() => {
                  onClose();
                  onOpenShortcuts();
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left hover:bg-claude-surface2-light dark:hover:bg-white/5 transition-colors group"
              >
                <Keyboard className="w-4 h-4 text-amber-500 shrink-0" />
                <span className="flex-1 font-medium">Keyboard Shortcuts</span>
                <kbd className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-claude-surface2-light dark:bg-white/10 text-claude-muted-light">?</kbd>
              </button>

              <div className="my-1 border-t border-claude-border-light/60 dark:border-white/10" />

              <button
                role="menuitem"
                onClick={() => {
                  onClose();
                  onOpenLegalViewer('terms');
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left hover:bg-claude-surface2-light dark:hover:bg-white/5 transition-colors group"
              >
                <FileText className="w-4 h-4 text-slate-500 shrink-0" />
                <span className="flex-1 font-medium">Terms of Service</span>
              </button>

              <button
                role="menuitem"
                onClick={() => {
                  onClose();
                  onOpenLegalViewer('privacy');
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left hover:bg-claude-surface2-light dark:hover:bg-white/5 transition-colors group"
              >
                <Lock className="w-4 h-4 text-slate-500 shrink-0" />
                <span className="flex-1 font-medium">Privacy Policy</span>
              </button>

              <div className="my-1 border-t border-claude-border-light/60 dark:border-white/10" />

              <button
                role="menuitem"
                onClick={() => {
                  onClose();
                  onOpenReportBug();
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 transition-colors font-medium"
              >
                <Bug className="w-4 h-4 shrink-0" />
                <span className="flex-1">Report a Bug</span>
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(menuContent, document.body) : null;
};
