import React, { useEffect, useRef, useState } from 'react';
import { 
  ShieldCheck, 
  X, 
  Download, 
  Trash2, 
  Lock, 
  EyeOff, 
  Server, 
  FileText, 
  Check, 
  AlertCircle 
} from 'lucide-react';
import { motion } from 'framer-motion';
import type { AppSettings, Conversation, Project } from '../types';

interface PrivacyCenterModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  onUpdateSettings: (settings: Partial<AppSettings>) => void;
  conversations: Conversation[];
  projects: Project[];
  onClearAllData?: () => void;
  onOpenLegalViewer?: (doc: 'terms' | 'privacy') => void;
}

export const PrivacyCenterModal: React.FC<PrivacyCenterModalProps> = ({
  isOpen,
  onClose,
  settings,
  onUpdateSettings,
  conversations,
  projects,
  onClearAllData,
  onOpenLegalViewer,
}) => {
  const [downloadSuccess, setDownloadSuccess] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);

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

  const handleExportData = () => {
    try {
      const exportPayload = {
        exportedAt: new Date().toISOString(),
        version: '2026.1',
        system: 'AIRA AI 2026 Privacy Export',
        conversations: conversations.map(c => ({
          id: c.id,
          title: c.title,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
          messages: c.messages.map(m => ({
            id: m.id,
            role: m.role,
            content: m.content,
            timestamp: m.timestamp,
            modelUsed: m.modelUsed,
          }))
        })),
        projects: projects.map(p => ({
          id: p.id,
          name: p.name,
          description: p.description,
          createdAt: p.createdAt,
        })),
        settings: {
          userName: settings.userName,
          email: settings.email,
          userBio: settings.userBio,
          customInstructions: settings.customInstructions,
          theme: settings.theme,
          aestheticPreset: settings.aestheticPreset,
          privacyScrubbing: settings.privacyScrubbing !== false,
          persistentMemoryEnabled: settings.persistentMemoryEnabled !== false,
          telemetryOptOut: settings.telemetryOptOut === true,
        }
      };
      const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `aira-privacy-data-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setDownloadSuccess(true);
      setTimeout(() => setDownloadSuccess(false), 3000);
    } catch (e) {
      console.error('Failed to export privacy data', e);
    }
  };

  if (!isOpen) return null;

  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="privacy-center-title"
    >
      <motion.div
        ref={modalRef}
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        className="w-full max-w-3xl max-h-[90vh] flex flex-col bg-claude-surface-light dark:bg-[#1a1b1e] border border-claude-border-light dark:border-white/10 rounded-2xl shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-claude-border-light dark:border-white/10 bg-claude-surface2-light/60 dark:bg-white/[0.02]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-500/20 to-teal-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-500 dark:text-emerald-400">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <h2 id="privacy-center-title" className="text-base font-bold text-claude-text-light dark:text-white tracking-tight">
                AIRA Privacy Center & Data Ownership
              </h2>
              <p className="text-xs text-claude-muted-light dark:text-claude-muted-dark">
                Inspect, control, and export your personal data and privacy protections
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-xl text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light dark:hover:text-white hover:bg-claude-surface2-light dark:hover:bg-white/5 transition-colors"
            aria-label="Close Privacy Center"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Functional Privacy Controls */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Lock className="w-4 h-4 text-emerald-500" />
              <h3 className="text-xs font-bold uppercase tracking-wider text-claude-muted-light dark:text-claude-muted-dark">
                Functional Privacy Controls
              </h3>
            </div>

            <div className="space-y-3">
              {/* Privacy Scrubbing (Always Enforced) */}
              <div className="p-4 rounded-xl border border-claude-border-light dark:border-white/10 bg-claude-surface2-light/40 dark:bg-white/[0.02] flex items-center justify-between gap-4">
                <div>
                  <h4 className="text-sm font-semibold text-claude-text-light dark:text-white">
                    Automatic Privacy Scrubbing
                  </h4>
                  <p className="text-xs text-claude-muted-light dark:text-claude-muted-dark mt-0.5">
                    Enforced platform safeguard that filters API keys, passwords, bearer tokens, and sensitive patterns before persisting client memory or logging diagnostics.
                  </p>
                </div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-2.5 py-1 rounded-md border border-emerald-500/20 shrink-0">
                  Enforced Safeguard
                </span>
              </div>

              {/* Persistent Memory */}
              <div className="p-4 rounded-xl border border-claude-border-light dark:border-white/10 bg-claude-surface2-light/40 dark:bg-white/[0.02] flex items-center justify-between gap-4">
                <div>
                  <h4 className="text-sm font-semibold text-claude-text-light dark:text-white">
                    Cross-Conversation Memory
                  </h4>
                  <p className="text-xs text-claude-muted-light dark:text-claude-muted-dark mt-0.5">
                    Permits the AI to recall relevant architectural decisions and user preferences from previous chats. When disabled, no previous conversation memories are recalled.
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    checked={settings.persistentMemoryEnabled !== false}
                    onChange={(e) => onUpdateSettings({ persistentMemoryEnabled: e.target.checked })}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-claude-surface2-light dark:bg-white/20 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500"></div>
                </label>
              </div>

              {/* Telemetry Opt-out */}
              <div className="p-4 rounded-xl border border-claude-border-light dark:border-white/10 bg-claude-surface2-light/40 dark:bg-white/[0.02] flex items-center justify-between gap-4">
                <div>
                  <h4 className="text-sm font-semibold text-claude-text-light dark:text-white">
                    Telemetry & Diagnostic Reporting Opt-Out
                  </h4>
                  <p className="text-xs text-claude-muted-light dark:text-claude-muted-dark mt-0.5">
                    Completely disables anonymous client error reports, performance logging, and latency observation.
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    checked={settings.telemetryOptOut === true}
                    onChange={(e) => onUpdateSettings({ telemetryOptOut: e.target.checked })}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-claude-surface2-light dark:bg-white/20 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500"></div>
                </label>
              </div>
            </div>
          </div>

          {/* Data Portability & Retention */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Download className="w-4 h-4 text-aira-blue" />
              <h3 className="text-xs font-bold uppercase tracking-wider text-claude-muted-light dark:text-claude-muted-dark">
                Data Portability & Erasure
              </h3>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Export Button */}
              <div className="p-4 rounded-xl border border-claude-border-light dark:border-white/10 bg-claude-surface2-light/40 dark:bg-white/[0.02] flex flex-col justify-between">
                <div>
                  <h4 className="text-sm font-semibold text-claude-text-light dark:text-white">
                    Export All Data
                  </h4>
                  <p className="text-xs text-claude-muted-light dark:text-claude-muted-dark mt-1">
                    Download a comprehensive JSON package containing your active conversations, projects, and saved settings.
                  </p>
                </div>
                <div className="mt-4 pt-2">
                  <button
                    onClick={handleExportData}
                    className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-aira-blue hover:bg-aira-blue/90 text-white font-medium text-xs transition-colors shadow-sm"
                  >
                    {downloadSuccess ? (
                      <>
                        <Check className="w-4 h-4 text-emerald-300" />
                        <span>Export Downloaded!</span>
                      </>
                    ) : (
                      <>
                        <Download className="w-4 h-4" />
                        <span>Download JSON Package</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Purge Local Data */}
              <div className="p-4 rounded-xl border border-rose-500/20 bg-rose-500/[0.02] flex flex-col justify-between">
                <div>
                  <h4 className="text-sm font-semibold text-rose-600 dark:text-rose-400">
                    Purge Local Storage
                  </h4>
                  <p className="text-xs text-claude-muted-light dark:text-claude-muted-dark mt-1">
                    Erase all local conversation history, projects, and custom instructions from this browser.
                  </p>
                  <p className="text-[10px] text-claude-muted-light/80 dark:text-claude-muted-dark/80 mt-1 italic">
                    Scope: Local browser cache and IndexedDB storage only. Server-side account data and active subscription records are managed via Account & Billing.
                  </p>
                </div>
                <div className="mt-4 pt-2">
                  {confirmClear ? (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          onClearAllData?.();
                          setConfirmClear(false);
                          onClose();
                        }}
                        className="flex-1 px-3 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold transition-colors"
                      >
                        Confirm Delete
                      </button>
                      <button
                        onClick={() => setConfirmClear(false)}
                        className="px-3 py-2 rounded-xl bg-claude-surface2-light dark:bg-white/10 text-xs font-medium"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmClear(true)}
                      className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-600 dark:text-rose-400 font-medium text-xs transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                      <span>Purge Local Storage</span>
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Privacy Guarantees */}
          <div className="p-4 rounded-xl border border-claude-border-light dark:border-white/10 bg-claude-surface2-light/20 dark:bg-white/[0.01] space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-claude-muted-light dark:text-claude-muted-dark">
              AIRA Operational Privacy Guarantees
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
              <div className="flex items-start gap-2">
                <EyeOff className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold text-claude-text-light dark:text-white block">Zero Model Training</span>
                  <span className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark">Your prompts, documents, and code are never used to train public AI models.</span>
                </div>
              </div>

              <div className="flex items-start gap-2">
                <Server className="w-4 h-4 text-aira-blue shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold text-claude-text-light dark:text-white block">Sandboxed BYOK</span>
                  <span className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark">Custom API keys are stored in client memory and never persisted to central databases.</span>
                </div>
              </div>

              <div className="flex items-start gap-2">
                <FileText className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold text-claude-text-light dark:text-white block">Operational Transparency</span>
                  <span className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark">Read our complete operational data retention and governance terms.</span>
                </div>
              </div>
            </div>

            <div className="pt-2 border-t border-claude-border-light/60 dark:border-white/10 flex items-center justify-between text-xs">
              <span className="text-claude-muted-light dark:text-claude-muted-dark">
                Have questions regarding operational data handling?
              </span>
              <button
                onClick={() => {
                  onClose();
                  onOpenLegalViewer?.('privacy');
                }}
                className="text-aira-blue hover:underline font-semibold flex items-center gap-1"
              >
                <span>Read Full Privacy Policy</span>
                <span aria-hidden="true">&rarr;</span>
              </button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-claude-border-light dark:border-white/10 bg-claude-surface2-light/60 dark:bg-white/[0.02] flex items-center justify-end text-xs">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-aira-blue hover:bg-aira-blue/90 text-white font-medium transition-colors"
          >
            Done
          </button>
        </div>
      </motion.div>
    </div>
  );
};
