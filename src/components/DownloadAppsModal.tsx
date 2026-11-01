import React, { useEffect, useRef, useState } from 'react';
import { 
  Laptop, 
  Smartphone, 
  Globe, 
  Check, 
  Download, 
  X, 
  ShieldCheck
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
  status: 'available' | 'preview' | 'roadmap';
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
      // Platform instruction fallback
      alert('To install AIRA as a Progressive Web App (PWA):\n\n• Chrome/Edge: Click the install icon in the address bar or choose Settings > Install AIRA.\n• Safari (iOS/macOS): Choose Share > Add to Dock / Home Screen.');
    }
  };

  const platforms: PlatformItem[] = [
    {
      id: 'web-pwa',
      name: 'Web & Progressive Web App (PWA)',
      category: 'Web',
      status: 'available',
      badge: 'Available Now',
      description: 'Fully functional desktop & mobile experience with offline asset caching and hardware acceleration.',
      details: 'Supported on Chrome, Edge, Safari, Firefox, and Chromium-based browsers with site.webmanifest.'
    },
    {
      id: 'macos',
      name: 'macOS Native App',
      category: 'Desktop',
      status: 'preview',
      badge: 'Private Alpha',
      description: 'SwiftUI & Metal native menu-bar companion for macOS Sonoma and Sequoia.',
      details: 'Currently in internal testing. Public beta release planned for early 2027.'
    },
    {
      id: 'windows',
      name: 'Windows Desktop App',
      category: 'Desktop',
      status: 'roadmap',
      badge: 'In Roadmap',
      description: 'Native Windows 11 Fluent experience with Copilot key and system tray hooks.',
      details: 'Scheduled for development following public API stabilization.'
    },
    {
      id: 'mobile',
      name: 'iOS & Android Companions',
      category: 'Mobile',
      status: 'roadmap',
      badge: 'In Roadmap',
      description: 'Native mobile companion apps with widget support and push notifications.',
      details: 'Please use the PWA (Add to Home Screen) on mobile devices for the full app experience today.'
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
                Official releases and transparent platform development roadmap
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
          {/* Honest Availability Notice */}
          <div className="p-4 rounded-xl border border-aira-blue/30 bg-aira-blue/5 flex items-start gap-3 text-xs leading-relaxed text-claude-text-light/90 dark:text-white/80">
            <ShieldCheck className="w-5 h-5 text-aira-blue shrink-0 mt-0.5" />
            <div>
              <strong className="text-claude-text-light dark:text-white block font-semibold mb-0.5">
                Transparent Platform Commitment
              </strong>
              AIRA is currently delivered as a zero-install, high-performance Progressive Web Application (PWA). We never distribute mock binaries, fake installer links, or unverified packages. Standalone native desktop and mobile applications are actively being engineered.
            </div>
          </div>

          {/* Platform Cards */}
          <div className="space-y-3">
            {platforms.map((p) => {
              const isAvailable = p.status === 'available';
              return (
                <div
                  key={p.id}
                  className={`p-4 rounded-xl border transition-all ${
                    isAvailable
                      ? 'border-emerald-500/30 bg-emerald-500/[0.03] dark:bg-emerald-500/[0.02]'
                      : 'border-claude-border-light dark:border-white/10 bg-claude-surface2-light/30 dark:bg-white/[0.01]'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
                        p.category === 'Web'
                          ? 'bg-aira-blue/10 text-aira-blue'
                          : p.category === 'Desktop'
                          ? 'bg-indigo-500/10 text-indigo-500'
                          : 'bg-teal-500/10 text-teal-500'
                      }`}>
                        {p.category === 'Web' ? (
                          <Globe className="w-4 h-4" />
                        ) : p.category === 'Desktop' ? (
                          <Laptop className="w-4 h-4" />
                        ) : (
                          <Smartphone className="w-4 h-4" />
                        )}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-sm font-bold text-claude-text-light dark:text-white">
                            {p.name}
                          </h3>
                          <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${
                            p.status === 'available'
                              ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20'
                              : p.status === 'preview'
                              ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20'
                              : 'bg-claude-surface2-light dark:bg-white/10 text-claude-muted-light'
                          }`}>
                            {p.badge}
                          </span>
                        </div>
                        <p className="text-xs text-claude-muted-light dark:text-claude-muted-dark mt-1">
                          {p.description}
                        </p>
                        <p className="text-[11px] text-claude-muted-light/80 dark:text-claude-muted-dark/80 mt-1 italic">
                          {p.details}
                        </p>
                      </div>
                    </div>

                    {isAvailable && (
                      <button
                        onClick={handleInstallPWA}
                        className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-xs shadow-sm transition-colors"
                      >
                        {pwaInstalled ? (
                          <>
                            <Check className="w-3.5 h-3.5" />
                            <span>Installed</span>
                          </>
                        ) : (
                          <>
                            <Download className="w-3.5 h-3.5" />
                            <span>Install PWA</span>
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-claude-border-light dark:border-white/10 bg-claude-surface2-light/60 dark:bg-white/[0.02] flex items-center justify-between text-xs">
          <span className="text-claude-muted-light dark:text-claude-muted-dark">
            Progressive Web App installation requires no admin rights or disk permissions.
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-claude-surface2-light dark:bg-white/10 hover:bg-claude-surface2-light/80 text-claude-text-light dark:text-white font-medium transition-colors"
          >
            Close
          </button>
        </div>
      </motion.div>
    </div>
  );
};
