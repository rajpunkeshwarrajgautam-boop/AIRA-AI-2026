import React, { useEffect, useRef, useState } from 'react';
import { FileText, X, AlertTriangle, Printer } from 'lucide-react';
import { motion } from 'framer-motion';

interface LegalViewerModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialDocument?: 'terms' | 'privacy';
}

export const LegalViewerModal: React.FC<LegalViewerModalProps> = ({
  isOpen,
  onClose,
  initialDocument = 'terms',
}) => {
  const [activeDoc, setActiveDoc] = useState<'terms' | 'privacy'>(initialDocument);
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setActiveDoc(initialDocument);
  }, [initialDocument]);

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

  if (!isOpen) return null;

  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="legal-viewer-title"
    >
      <motion.div
        ref={modalRef}
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        className="w-full max-w-3xl max-h-[90vh] flex flex-col bg-claude-surface-light dark:bg-stone-900 border border-claude-border-light dark:border-white/10 rounded-2xl shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-claude-border-light dark:border-white/10 bg-claude-surface2-light/60 dark:bg-white/[0.02]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-slate-500/20 to-aira-blue/20 border border-slate-500/30 flex items-center justify-center text-slate-700 dark:text-slate-300">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 id="legal-viewer-title" className="text-base font-bold text-claude-text-light dark:text-white tracking-tight">
                  AIRA Operational Legal & Governance Policies
                </h2>
                <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                  Draft
                </span>
              </div>
              <p className="text-xs text-claude-muted-light dark:text-claude-muted-dark">
                Terms of service, operational governance, and privacy disclosures
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => window.print()}
              className="p-2 rounded-xl text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light dark:hover:text-white hover:bg-claude-surface2-light dark:hover:bg-white/5 transition-colors"
              title="Print policy"
              aria-label="Print policy"
            >
              <Printer className="w-4 h-4" />
            </button>
            <button
              onClick={onClose}
              className="p-2 rounded-xl text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light dark:hover:text-white hover:bg-claude-surface2-light dark:hover:bg-white/5 transition-colors"
              aria-label="Close dialog"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Document Switcher Tabs */}
        <div className="px-6 py-3 border-b border-claude-border-light dark:border-white/10 bg-claude-surface-light dark:bg-stone-900 flex items-center gap-2">
          <button
            onClick={() => setActiveDoc('terms')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
              activeDoc === 'terms'
                ? 'bg-aira-blue text-white shadow-xs'
                : 'text-claude-muted-light dark:text-claude-muted-dark hover:bg-claude-surface2-light dark:hover:bg-white/5 hover:text-claude-text-light dark:hover:text-white'
            }`}
          >
            Terms of Service
          </button>
          <button
            onClick={() => setActiveDoc('privacy')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
              activeDoc === 'privacy'
                ? 'bg-aira-blue text-white shadow-xs'
                : 'text-claude-muted-light dark:text-claude-muted-dark hover:bg-claude-surface2-light dark:hover:bg-white/5 hover:text-claude-text-light dark:hover:text-white'
            }`}
          >
            Privacy Policy
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4 text-xs leading-relaxed text-claude-text-light/90 dark:text-white/80">
          {/* Honest Legal Counsel Pending Banner */}
          <div className="p-3.5 rounded-xl border border-amber-500/30 bg-amber-500/5 flex items-start gap-3">
            <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
            <div className="text-[11px] text-claude-text-light/90 dark:text-white/80 leading-normal">
              <strong className="text-amber-600 dark:text-amber-400 block font-semibold mb-0.5">
                Draft Operational Policy: Ratification Status
              </strong>
              This document reflects AIRA&apos;s active operational architecture and data governance practices. Formal external legal counsel review and approval are pending prior to public general release; external review is not currently underway.
            </div>
          </div>

          {activeDoc === 'terms' ? (
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-bold text-claude-text-light dark:text-white mb-1">
                  1. Acceptance of Terms
                </h3>
                <p>
                  By accessing or using AIRA AI 2026 (&quot;the Service&quot;), you agree to be bound by these Terms of Service. If you do not agree to these terms, do not access or use the application.
                </p>
              </div>

              <div>
                <h3 className="text-sm font-bold text-claude-text-light dark:text-white mb-1">
                  2. Architectural & AI Disclaimer
                </h3>
                <p>
                  AIRA integrates advanced artificial intelligence models (including Groq-accelerated models, Google Gemini, and NVIDIA Nemotron). While engineered for high accuracy, large language models may occasionally generate inaccurate, incomplete, or unexpected outputs. You remain responsible for verifying and validating generated software code, architectural recommendations, and critical data before deployment to production environments.
                </p>
              </div>

              <div>
                <h3 className="text-sm font-bold text-claude-text-light dark:text-white mb-1">
                  3. Acceptable Use Policy
                </h3>
                <p>You agree not to use the Service to:</p>
                <ul className="list-disc list-inside mt-1 space-y-1 pl-2">
                  <li>Generate malicious code, exploit vectors, or automated cyberattacks.</li>
                  <li>Circumvent multi-tenant isolation, authorization barriers, or rate limiting controls.</li>
                  <li>Engage in unauthorized data extraction or reverse engineer proprietary model weights.</li>
                  <li>Violate applicable national, federal, state, or international laws.</li>
                </ul>
              </div>

              <div>
                <h3 className="text-sm font-bold text-claude-text-light dark:text-white mb-1">
                  4. Intellectual Property & Code Ownership
                </h3>
                <p>
                  You retain complete intellectual property ownership of your input prompts, uploaded files, and output artifacts generated through your authenticated workspace. AIRA does not claim ownership of user-generated code or creative works.
                </p>
              </div>

              <div>
                <h3 className="text-sm font-bold text-claude-text-light dark:text-white mb-1">
                  5. Quotas & Subscriptions
                </h3>
                <p>
                  Access to inference models and reasoning budgets is governed by your active account tier (Guest, Free, Plus, or Pro). Quotas are non-transferable and subject to our fair usage and capacity admission policies.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-bold text-claude-text-light dark:text-white mb-1">
                  1. Zero Third-Party Model Training
                </h3>
                <p>
                  AIRA enforces a strict zero-retention policy for model training. User prompts, project documents, and code artifacts are never sold, rented, or contributed to public model training datasets.
                </p>
              </div>

              <div>
                <h3 className="text-sm font-bold text-claude-text-light dark:text-white mb-1">
                  2. Information We Store
                </h3>
                <p>To provide conversational continuity and agent capabilities, we store:</p>
                <ul className="list-disc list-inside mt-1 space-y-1 pl-2">
                  <li>Account identifiers: Email address and display name (via authenticated NeonAuth provider).</li>
                  <li>Local storage: Conversational history, project files, and user preferences stored on your local device.</li>
                  <li>Persistent Memory: Memory items retained in the user&apos;s private vault, subject to automated privacy scrubbing.</li>
                </ul>
              </div>

              <div>
                <h3 className="text-sm font-bold text-claude-text-light dark:text-white mb-1">
                  3. Bring Your Own Key (BYOK) Security
                </h3>
                <p>
                  When you provide your own API keys (Anthropic, OpenRouter), they are held exclusively within client-side sandboxed browser storage. Keys are never transmitted to AIRA&apos;s central backend databases and are sent strictly in authorization headers to the chosen inference endpoint.
                </p>
              </div>

              <div>
                <h3 className="text-sm font-bold text-claude-text-light dark:text-white mb-1">
                  4. Data Portability & Erasure Rights
                </h3>
                <p>
                  AIRA provides self-service data portability and local erasure tools. You may export a complete machine-readable JSON package of your stored conversations, projects, and settings, or purge local browser storage at any time via the Privacy Center. Server-side account closure can be initiated through Account & Billing.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-claude-border-light dark:border-white/10 bg-claude-surface2-light/60 dark:bg-white/[0.02] flex items-center justify-between text-xs">
          <span className="text-claude-muted-light dark:text-claude-muted-dark">
            Last updated: November 2026 • Policy Version 2.4-DRAFT
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-aira-blue hover:bg-aira-blue/90 text-white font-medium transition-colors"
          >
            I Understand
          </button>
        </div>
      </motion.div>
    </div>
  );
};
