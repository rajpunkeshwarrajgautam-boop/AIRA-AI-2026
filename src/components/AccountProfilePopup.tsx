import React, { useState, useEffect, useRef } from 'react';
import {
  Sparkles,
  Sliders,
  User as UserIcon,
  Settings,
  HelpCircle,
  LogOut,
  LogIn,
  ChevronRight,
  ChevronLeft,
  Check,
  ArrowLeftRight
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { NeonUser } from '../lib/neonAuth';

export interface AccountProfilePopupProps {
  isOpen: boolean;
  onClose: () => void;
  user: NeonUser | null;
  onOpenPricing: () => void;
  onOpenSettings: (tab?: string) => void;
  onOpenAuth: () => void;
  onSignOut: () => void | Promise<void>;
  onSwitchAccount?: () => void | Promise<void>;
  onOpenHelp?: () => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
  className?: string;
  defaultShowSwitcher?: boolean;
}

export const AccountProfilePopup: React.FC<AccountProfilePopupProps> = ({
  isOpen,
  onClose,
  user,
  onOpenPricing,
  onOpenSettings,
  onOpenAuth,
  onSignOut,
  onSwitchAccount,
  onOpenHelp,
  className = '',
  defaultShowSwitcher = false,
}) => {
  const [showAccountSwitcher, setShowAccountSwitcher] = useState(defaultShowSwitcher);
  const popupRef = useRef<HTMLDivElement>(null);
  const switcherRef = useRef<HTMLDivElement>(null);
  const [isMobileViewport, setIsMobileViewport] = useState(false);

  // Viewport resize detection for responsive flyout vs in-place switching
  useEffect(() => {
    const checkViewport = () => {
      setIsMobileViewport(window.innerWidth < 768);
    };
    checkViewport();
    window.addEventListener('resize', checkViewport);
    return () => window.removeEventListener('resize', checkViewport);
  }, []);

  // Reset nested popup state when closing
  useEffect(() => {
    if (!isOpen) {
      setShowAccountSwitcher(false);
    }
  }, [isOpen]);

  // Click outside and escape handling
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (
        popupRef.current &&
        !popupRef.current.contains(target) &&
        (!switcherRef.current || !switcherRef.current.contains(target))
      ) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showAccountSwitcher && isMobileViewport) {
          setShowAccountSwitcher(false);
        } else {
          onClose();
        }
      }
    };

    document.addEventListener('mousedown', handleClickOutside, true);
    document.addEventListener('touchstart', handleClickOutside, true);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside, true);
      document.removeEventListener('touchstart', handleClickOutside, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, showAccountSwitcher, isMobileViewport, onClose]);

  if (!isOpen) return null;

  const initials = user?.name
    ? user.name
        .split(' ')
        .map(n => n[0])
        .slice(0, 2)
        .join('')
        .toUpperCase()
    : user?.email
    ? user.email.slice(0, 2).toUpperCase()
    : 'G';

  const displayName = user?.name || (user?.email ? user.email.split('@')[0] : 'Guest Workspace');
  const userEmail = user?.email || 'guest@aira.internal';
  const planName = user ? 'Plus' : 'Free';

  const handleSwitchAccountClick = () => {
    setShowAccountSwitcher(false);
    onClose();
    if (onSwitchAccount) {
      onSwitchAccount();
    } else {
      onSignOut();
      onOpenAuth();
    }
  };

  const handleHelpClick = () => {
    if (onOpenHelp) {
      onOpenHelp();
    } else {
      window.open('https://github.com/rajpunkeshwarrajgautam-boop/AIRA-AI-2026/blob/main/README.md', '_blank', 'noopener,noreferrer');
    }
    onClose();
  };

  return (
    <>
      {/* Backdrop for mobile */}
      {isMobileViewport && (
        <div
          className="fixed inset-0 bg-black/40 backdrop-blur-[2px] z-[80]"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <div
        ref={popupRef}
        data-testid="account-profile-popup"
        role="dialog"
        aria-label="Account menu"
        className={`absolute z-[85] bottom-[calc(100%+8px)] left-2 right-2 sm:right-auto sm:w-[260px] ${className}`}
      >
        <motion.div
          initial={{ opacity: 0, y: 8, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 6, scale: 0.96 }}
          transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
          className="relative bg-white/95 dark:bg-[#0F172A]/95 backdrop-blur-xl border border-slate-200/90 dark:border-blue-900/40 rounded-2xl shadow-[0_12px_40px_-10px_rgba(0,0,0,0.18),0_0_20px_rgba(37,99,235,0.12)] p-1.5 overflow-hidden text-slate-800 dark:text-slate-200"
        >
          {/* Main Menu View (or in mobile when switcher is inactive) */}
          {(!isMobileViewport || !showAccountSwitcher) && (
            <div className="flex flex-col">
              {/* Account Header Item with Chevron to Switcher */}
              <button
                type="button"
                onClick={() => {
                  if (isMobileViewport) {
                    setShowAccountSwitcher(prev => !prev);
                  } else {
                    setShowAccountSwitcher(true);
                  }
                }}
                onMouseEnter={() => {
                  if (!isMobileViewport) setShowAccountSwitcher(true);
                }}
                className={`w-full flex items-center justify-between p-2 rounded-xl text-left transition-colors ${
                  showAccountSwitcher
                    ? 'bg-blue-50/90 dark:bg-blue-900/30'
                    : 'hover:bg-slate-100/80 dark:hover:bg-slate-800/60'
                }`}
                title="Account options & switcher"
              >
                <div className="flex items-center space-x-2.5 min-w-0">
                  <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-blue-700 via-blue-600 to-indigo-600 text-white font-semibold text-xs flex items-center justify-center flex-shrink-0 shadow-sm overflow-hidden">
                    {user?.image ? (
                      <img src={user.image} alt={displayName} className="w-full h-full object-cover" />
                    ) : (
                      <span>{initials}</span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold text-slate-900 dark:text-white truncate leading-tight">
                      {displayName}
                    </div>
                    <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400 leading-tight">
                      {planName}
                    </div>
                  </div>
                </div>
                <ChevronRight className="w-4 h-4 text-slate-400 shrink-0 ml-1.5" />
              </button>

              {/* Divider */}
              <div className="h-[1px] bg-slate-200/80 dark:bg-slate-800/80 my-1 mx-1" />

              {/* Action Menu Items */}
              <div className="flex flex-col space-y-0.5">
                {/* Upgrade plan */}
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onOpenPricing();
                  }}
                  className="w-full flex items-center space-x-2.5 px-2.5 py-2 rounded-xl text-[13px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100/80 dark:hover:bg-slate-800/60 transition-colors text-left group"
                >
                  <Sparkles className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />
                  <span className="flex-1">Upgrade plan</span>
                </button>

                {/* Personalization */}
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onOpenSettings('personalization');
                  }}
                  className="w-full flex items-center space-x-2.5 px-2.5 py-2 rounded-xl text-[13px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100/80 dark:hover:bg-slate-800/60 transition-colors text-left"
                >
                  <Sliders className="w-4 h-4 text-slate-500 dark:text-slate-400 shrink-0" />
                  <span className="flex-1">Personalization</span>
                </button>

                {/* Profile */}
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onOpenSettings('profile');
                  }}
                  className="w-full flex items-center space-x-2.5 px-2.5 py-2 rounded-xl text-[13px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100/80 dark:hover:bg-slate-800/60 transition-colors text-left"
                >
                  <UserIcon className="w-4 h-4 text-slate-500 dark:text-slate-400 shrink-0" />
                  <span className="flex-1">Profile</span>
                </button>

                {/* Settings */}
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onOpenSettings('general');
                  }}
                  className="w-full flex items-center space-x-2.5 px-2.5 py-2 rounded-xl text-[13px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100/80 dark:hover:bg-slate-800/60 transition-colors text-left"
                >
                  <Settings className="w-4 h-4 text-slate-500 dark:text-slate-400 shrink-0" />
                  <span className="flex-1">Settings</span>
                </button>
              </div>

              {/* Divider */}
              <div className="h-[1px] bg-slate-200/80 dark:bg-slate-800/80 my-1 mx-1" />

              {/* Bottom Items: Help & Log Out / Sign In */}
              <div className="flex flex-col space-y-0.5">
                {/* Help */}
                <button
                  type="button"
                  onClick={handleHelpClick}
                  className="w-full flex items-center justify-between px-2.5 py-2 rounded-xl text-[13px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100/80 dark:hover:bg-slate-800/60 transition-colors text-left"
                >
                  <div className="flex items-center space-x-2.5">
                    <HelpCircle className="w-4 h-4 text-slate-500 dark:text-slate-400 shrink-0" />
                    <span>Help</span>
                  </div>
                  <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
                </button>

                {/* Log out / Sign in */}
                {user ? (
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      onSignOut();
                    }}
                    className="w-full flex items-center space-x-2.5 px-2.5 py-2 rounded-xl text-[13px] font-medium text-rose-600 dark:text-rose-400 hover:bg-rose-50/80 dark:hover:bg-rose-950/30 transition-colors text-left"
                  >
                    <LogOut className="w-4 h-4 shrink-0" />
                    <span>Log out</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      onOpenAuth();
                    }}
                    className="w-full flex items-center space-x-2.5 px-2.5 py-2 rounded-xl text-[13px] font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50/80 dark:hover:bg-blue-950/30 transition-colors text-left"
                  >
                    <LogIn className="w-4 h-4 shrink-0" />
                    <span>Sign in</span>
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Mobile In-Place Account Switcher Sub-View */}
          {isMobileViewport && showAccountSwitcher && (
            <div className="flex flex-col p-1">
              <button
                type="button"
                onClick={() => setShowAccountSwitcher(false)}
                className="flex items-center space-x-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white p-1.5 mb-1 rounded-lg"
              >
                <ChevronLeft className="w-4 h-4" />
                <span>Back to menu</span>
              </button>

              {/* User Email Header */}
              <div className="flex items-center space-x-2 px-2.5 py-1.5 text-xs text-slate-500 dark:text-slate-400 truncate">
                <UserIcon className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">{userEmail}</span>
              </div>

              {/* Active Account Item */}
              <div className="flex items-center justify-between p-2 rounded-xl bg-blue-50/80 dark:bg-blue-900/20 border border-blue-200/50 dark:border-blue-800/40 my-1">
                <div className="flex items-center space-x-2 min-w-0">
                  <div className="w-7 h-7 rounded-full bg-gradient-to-tr from-blue-700 to-indigo-600 text-white font-semibold text-[11px] flex items-center justify-center shrink-0">
                    {initials}
                  </div>
                  <div className="text-[13px] font-medium text-slate-900 dark:text-white truncate">
                    Personal account
                  </div>
                </div>
                <Check className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0 font-bold" />
              </div>

              {/* Divider */}
              <div className="h-[1px] bg-slate-200/80 dark:bg-slate-800/80 my-1.5" />

              {/* Switch account button (truthful single-principal session transition) */}
              <button
                type="button"
                data-testid="switch-account-button"
                onClick={handleSwitchAccountClick}
                className="flex items-center space-x-2.5 px-2.5 py-2 rounded-xl text-[13px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100/80 dark:hover:bg-slate-800/60 transition-colors text-left"
              >
                <ArrowLeftRight className="w-4 h-4 text-slate-500 dark:text-slate-400" />
                <span>Switch account</span>
              </button>
            </div>
          )}
        </motion.div>

        {/* Desktop Nested Account Switcher Flyout (Screenshot 2) */}
        {!isMobileViewport && (
          <AnimatePresence>
            {showAccountSwitcher && (
              <motion.div
                ref={switcherRef}
                data-testid="account-switcher-flyout"
                initial={{ opacity: 0, x: -8, scale: 0.96 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={{ opacity: 0, x: -6, scale: 0.96 }}
                transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
                onMouseLeave={() => setShowAccountSwitcher(false)}
                className="absolute left-[calc(100%+8px)] bottom-0 w-[270px] bg-white/95 dark:bg-[#0F172A]/95 backdrop-blur-xl border border-slate-200/90 dark:border-blue-900/40 rounded-2xl shadow-[0_12px_40px_-10px_rgba(0,0,0,0.18),0_0_20px_rgba(37,99,235,0.12)] p-2 z-[90] text-slate-800 dark:text-slate-200"
              >
                {/* Header: User Email */}
                <div className="flex items-center space-x-2 px-2.5 py-1.5 text-xs text-slate-500 dark:text-slate-400 truncate border-b border-slate-100 dark:border-slate-800/60 pb-2 mb-1">
                  <UserIcon className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  <span className="truncate font-medium">{userEmail}</span>
                </div>

                {/* Active Account Item */}
                <div className="flex items-center justify-between p-2 rounded-xl bg-blue-50/80 dark:bg-blue-900/20 border border-blue-200/60 dark:border-blue-800/40 my-1">
                  <div className="flex items-center space-x-2.5 min-w-0">
                    <div className="w-7 h-7 rounded-full bg-gradient-to-tr from-blue-700 via-blue-600 to-indigo-600 text-white font-semibold text-[11px] flex items-center justify-center shrink-0 shadow-sm">
                      {initials}
                    </div>
                    <div className="text-[13px] font-medium text-slate-900 dark:text-white truncate">
                      Personal account
                    </div>
                  </div>
                  <Check className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0 font-bold" />
                </div>

                {/* Divider */}
                <div className="h-[1px] bg-slate-200/80 dark:bg-slate-800/80 my-1.5 mx-1" />

                {/* Switch account button (truthful single-principal session transition) */}
                <button
                  type="button"
                  data-testid="switch-account-button-desktop"
                  onClick={handleSwitchAccountClick}
                  className="w-full flex items-center space-x-2.5 px-2.5 py-2 rounded-xl text-[13px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100/80 dark:hover:bg-slate-800/60 transition-colors text-left group"
                >
                  <ArrowLeftRight className="w-4 h-4 text-slate-500 dark:text-slate-400 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors" />
                  <span>Switch account</span>
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        )}
      </div>
    </>
  );
};
export default AccountProfilePopup;
