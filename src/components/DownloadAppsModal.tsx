import React, { useEffect, useRef, useState } from 'react';
import { 
  Laptop, 
  Smartphone, 
  Globe, 
  Check, 
  Download, 
  X, 
  Info,
  ExternalLink
} from 'lucide-react';
import { motion } from 'framer-motion';

interface DownloadAppsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface PlatformItem {
  id: string;
  name: string;
  category: 'Desktop' | 'Mobile' | 'Web';
  status: 'available' | 'roadmap';
  badge: string;
  description: string;
  details: string;
}

export const DownloadAppsModal: React.FC<DownloadAppsModalProps> = ({
  isOpen,
  onClose,
}) => {
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [pwaInstalled, setPwaInstalled] = useState(false);
  const [showManualInstructions, setShowManualInstructions] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstall);
    window.addEventListener('appinstalled', () => setPwaInstalled(true));

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
    };
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const handleInstallPWA = async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        setPwaInstalled(true);
      }
      setDeferredPrompt(null);
    } else {
      setShowManualInstructions(true);
    }
  };

  const platforms: PlatformItem[] = [
    {
      id: 'web-pwa',
      name: 'Web & Progressive Web App (PWA)',
      category: 'Web',
      status: 'available',
      badge: 'Available Now',
      description: 'Fully responsive workspace accessible in any modern web browser with offline asset caching and home screen installation.',
      details: 'Supported on Chrome, Edge, Safari, Firefox, and Chromium-based browsers via site.webmanifest.'
    },
    {
      id: 'macos',
      name: 'macOS Desktop Application',
      category: 'Desktop',
      status: 'roadmap',
      badge: 'Unreleased / Roadmap',
      description: 'Dedicated macOS desktop application.',
      details: 'Not currently distributed. Please use AIRA via web browser or PWA on macOS.'
    },
    {
      id: 'windows',
      name: 'Windows Desktop Application',
      category: 'Desktop',
      status: 'roadmap',
      badge: 'Unreleased / Roadmap',
      description: 'Dedicated Windows desktop application.',
      details: 'Not currently distributed. Please use AIRA via web browser or PWA on Windows.'
    },
    {
      id: 'mobile',
      name: 'iOS & Android Mobile Applications',
      category: 'Mobile',
      status: 'roadmap',
      badge: 'Unreleased / Roadmap',
      description: 'Native mobile app store binaries.',
      details: 'Not currently distributed in mobile app stores. On iOS and Android devices, use "Add to Home Screen" in Safari or Chrome for a full-screen mobile app experience.'
    }
  ];

  if (!isOpen) return null;

  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="download-apps-title"
    >
      <motion.div
        ref={modalRef}
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        className="w-full max-w-2xl max-h-[90vh] flex flex-col bg-claude-surface-light dark:bg-[#1a1b1e] border border-claude-border-light dark:border-white/10 rounded-2xl shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-claude-border-light dark:border-white/10 bg-claude-surface2-light/60 dark:bg-white/[0.02]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-aira-blue/20 to-indigo-500/20 border border-aira-blue/30 flex items-center justify-center text-aira-blue">
              <Download className="w-5 h-5" />
            </div>
            <div>
              <h2 id="download-apps-title" className="text-base font-bold text-claude-text-light dark:text-white tracking-tight">
                AIRA Applications & Platform Availability
              </h2>
              <p className="text-xs text-claude-muted-light dark:text-claude-muted-dark">
                Progressive Web App installation and platform status
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2 rounded-xl text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light dark:hover:text-white hover:bg-claude-surface2-light dark:hover:bg-white/5 transition-colors"
            aria-label="Close dialog"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* PWA Promotion Card */}
          <div className="p-4 rounded-xl border border-aira-blue/30 bg-aira-blue/[0.03] dark:bg-aira-blue/[0.06] flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Globe className="w-4 h-4 text-aira-blue" />
                <h3 className="text-sm font-bold text-claude-text-light dark:text-white">
                  Install Web Application (PWA)
                </h3>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                  Ready
                </span>
              </div>
              <p className="text-xs text-claude-muted-light dark:text-claude-muted-dark max-w-md">
                Install AIRA as a standalone desktop or mobile window with independent dock/taskbar presence, instant loading, and offline asset caching.
              </p>
            </div>

            <button
              onClick={handleInstallPWA}
              disabled={pwaInstalled}
              className="px-4 py-2 rounded-xl bg-aira-blue hover:bg-aira-blue/90 disabled:bg-emerald-500 text-white font-bold text-xs flex items-center gap-2 transition-all shadow-sm shrink-0"
            >
              {pwaInstalled ? (
                <>
                  <Check className="w-4 h-4" />
                  <span>Installed</span>
                </>
              ) : (
                <>
                  <Download className="w-4 h-4" />
                  <span>Install App</span>
                </>
              )}
            </button>
          </div>

          {/* Manual Instructions Dropdown if beforeinstallprompt not available */}
          {showManualInstructions && (
            <div className="p-3.5 rounded-xl border border-amber-500/30 bg-amber-500/5 text-[11px] text-claude-text-light/90 dark:text-white/80 space-y-2">
              <div className="flex items-center gap-1.5 font-bold text-amber-600 dark:text-amber-400">
                <Info className="w-3.5 h-3.5" />
                <span>Manual Installation Instructions</span>
              </div>
              <ul className="list-disc list-inside space-y-1 pl-1 text-claude-muted-light dark:text-claude-muted-dark">
                <li><strong className="text-claude-text-light dark:text-white">Chrome / Edge:</strong> Click the install icon (⊕) in the browser URL bar, or choose Menu &gt; Install AIRA.</li>
                <li><strong className="text-claude-text-light dark:text-white">Safari (macOS):</strong> Choose File &gt; Add to Dock.</li>
                <li><strong className="text-claude-text-light dark:text-white">Safari (iOS):</strong> Tap Share &gt; Add to Home Screen.</li>
              </ul>
            </div>
          )}

          {/* Platform Status List */}
          <div className="space-y-3 pt-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-claude-muted-light dark:text-claude-muted-dark">
              Platform Status Overview
            </h3>

            <div className="space-y-2.5">
              {platforms.map((platform) => (
                <div
                  key={platform.id}
                  className="p-3.5 rounded-xl border border-claude-border-light dark:border-white/10 bg-claude-surface2-light/40 dark:bg-white/[0.02] flex items-start gap-3.5"
                >
                  <div className="p-2 rounded-lg bg-claude-surface-light dark:bg-white/5 border border-claude-border-light/60 dark:border-white/10 shrink-0 text-claude-muted-light">
                    {platform.category === 'Desktop' ? (
                      <Laptop className="w-4 h-4" />
                    ) : platform.category === 'Mobile' ? (
                      <Smartphone className="w-4 h-4" />
                    ) : (
                      <Globe className="w-4 h-4" />
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold text-claude-text-light dark:text-white">
                        {platform.name}
                      </span>
                      <span
                        className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                          platform.status === 'available'
                            ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20'
                            : 'bg-claude-surface2-light dark:bg-white/5 text-claude-muted-light border-claude-border-light/60 dark:border-white/10'
                        }`}
                      >
                        {platform.badge}
                      </span>
                    </div>
                    <p className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark mt-0.5">
                      {platform.description}
                    </p>
                    <p className="text-[10px] text-claude-muted-light/70 dark:text-claude-muted-dark/70 mt-1 italic">
                      {platform.details}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-claude-border-light dark:border-white/10 bg-claude-surface2-light/60 dark:bg-white/[0.02] flex items-center justify-end text-xs">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg border border-claude-border-light dark:border-white/10 hover:bg-claude-surface2-light dark:hover:bg-white/5 text-claude-text-light dark:text-white font-medium transition-colors"
          >
            Close
          </button>
        </div>
      </motion.div>
    </div>
  );
};
