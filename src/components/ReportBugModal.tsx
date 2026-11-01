import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  Bug, 
  X, 
  Send, 
  CheckCircle2, 
  Info,
  Copy,
  Check
} from 'lucide-react';
import { motion } from 'framer-motion';
import type { AppSettings } from '../types';

interface ReportBugModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
}

export const ReportBugModal: React.FC<ReportBugModalProps> = ({
  isOpen,
  onClose,
  settings,
}) => {
  const [category, setCategory] = useState<'ui' | 'inference' | 'billing' | 'artifacts' | 'performance' | 'other'>('ui');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [reproSteps, setReproSteps] = useState('');
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [consentChecked, setConsentChecked] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submittedTicket, setSubmittedTicket] = useState<string | null>(null);
  const [copiedTicket, setCopiedTicket] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);

  // Compute clean diagnostic payload (no tokens, no transcripts)
  const diagnostics = useMemo(() => ({
    timestamp: new Date().toISOString(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'Unknown',
    platform: typeof navigator !== 'undefined' ? navigator.platform : 'Unknown',
    screenSize: typeof window !== 'undefined' ? `${window.innerWidth}x${window.innerHeight}` : 'Unknown',
    activeTheme: settings.theme,
    aestheticPreset: settings.aestheticPreset || 'linear-precision',
    activeModel: settings.activeModel,
    reducedMotion: settings.reducedMotion || 'system',
    appVersion: '2.4.0',
  }), [settings]);

  useEffect(() => {
    if (!isOpen) {
      setSubmittedTicket(null);
      setTitle('');
      setDescription('');
      setReproSteps('');
    }
  }, [isOpen]);

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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !description.trim()) return;

    setIsSubmitting(true);
    setTimeout(() => {
      const ticketId = `AIRA-BUG-${Math.floor(100000 + Math.random() * 900000)}`;
      // Log report locally for developer inspection
      console.log(`[BugReport] Submitted ticket ${ticketId}`, {
        category,
        title,
        description,
        reproSteps,
        diagnostics: includeDiagnostics ? diagnostics : 'Excluded by user'
      });
      setIsSubmitting(false);
      setSubmittedTicket(ticketId);
    }, 600);
  };

  const handleCopyTicket = () => {
    if (!submittedTicket) return;
    navigator.clipboard.writeText(submittedTicket);
    setCopiedTicket(true);
    setTimeout(() => setCopiedTicket(false), 2000);
  };

  if (!isOpen) return null;

  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="report-bug-title"
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
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-rose-500/20 to-orange-500/20 border border-rose-500/30 flex items-center justify-center text-rose-500">
              <Bug className="w-5 h-5" />
            </div>
            <div>
              <h2 id="report-bug-title" className="text-base font-bold text-claude-text-light dark:text-white tracking-tight">
                Report an Issue or Bug
              </h2>
              <p className="text-xs text-claude-muted-light dark:text-claude-muted-dark">
                Direct feedback channel for engineering inspection and quality remediation
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
        <div className="flex-1 overflow-y-auto p-6">
          {submittedTicket ? (
            <div className="py-8 text-center space-y-4">
              <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-500 mx-auto">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-base font-bold text-claude-text-light dark:text-white">
                  Bug Report Dispatched
                </h3>
                <p className="text-xs text-claude-muted-light dark:text-claude-muted-dark mt-1 max-w-md mx-auto">
                  Thank you for helping us maintain zero release-blocking defects. Your report and diagnostics have been logged.
                </p>
              </div>

              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-claude-surface2-light dark:bg-white/5 border border-claude-border-light dark:border-white/10">
                <span className="text-xs text-claude-muted-light">Ticket ID:</span>
                <span className="text-xs font-mono font-bold text-aira-blue dark:text-aira-cyan">
                  {submittedTicket}
                </span>
                <button
                  onClick={handleCopyTicket}
                  className="p-1 rounded-md hover:bg-claude-surface-light dark:hover:bg-white/10 text-claude-muted-light hover:text-claude-text-light"
                  title="Copy Ticket ID"
                >
                  {copiedTicket ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>

              <div className="pt-4">
                <button
                  onClick={onClose}
                  className="px-6 py-2 rounded-xl bg-aira-blue hover:bg-aira-blue/90 text-white text-xs font-bold transition-colors shadow-sm"
                >
                  Return to AIRA
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Category Selector */}
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-claude-muted-light dark:text-claude-muted-dark mb-2">
                  Issue Category
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {[
                    { id: 'ui', label: 'UI / Visual Defect' },
                    { id: 'inference', label: 'Model / Inference' },
                    { id: 'artifacts', label: 'Artifact Studio' },
                    { id: 'billing', label: 'Account & Billing' },
                    { id: 'performance', label: 'Performance / Lag' },
                    { id: 'other', label: 'Other Issue' },
                  ].map((cat) => (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => setCategory(cat.id as any)}
                      className={`px-3 py-2 rounded-xl text-xs font-medium border text-left transition-all ${
                        category === cat.id
                          ? 'border-aira-blue bg-aira-blue/10 text-aira-blue dark:text-white font-bold ring-1 ring-aira-blue'
                          : 'border-claude-border-light dark:border-white/10 bg-claude-surface2-light/40 dark:bg-white/[0.02] text-claude-muted-light dark:text-claude-muted-dark hover:border-claude-border-light/80'
                      }`}
                    >
                      {cat.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Title Input */}
              <div>
                <label className="block text-xs font-semibold text-claude-text-light dark:text-white mb-1">
                  Issue Summary <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Artifact canvas fails to update upon switching versions"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-claude-surface2-light dark:bg-white/5 border border-claude-border-light dark:border-white/10 text-xs text-claude-text-light dark:text-white placeholder:text-claude-muted-light focus:outline-none focus:ring-2 focus:ring-aira-blue/40"
                />
              </div>

              {/* Description */}
              <div>
                <label className="block text-xs font-semibold text-claude-text-light dark:text-white mb-1">
                  Description of Defect <span className="text-rose-500">*</span>
                </label>
                <textarea
                  required
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Describe what occurred, what you expected to happen, and any error message displayed..."
                  className="w-full px-3.5 py-2.5 rounded-xl bg-claude-surface2-light dark:bg-white/5 border border-claude-border-light dark:border-white/10 text-xs text-claude-text-light dark:text-white placeholder:text-claude-muted-light focus:outline-none focus:ring-2 focus:ring-aira-blue/40 resize-none"
                />
              </div>

              {/* Reproduction Steps */}
              <div>
                <label className="block text-xs font-semibold text-claude-text-light dark:text-white mb-1">
                  Steps to Reproduce (Optional)
                </label>
                <textarea
                  rows={2}
                  value={reproSteps}
                  onChange={(e) => setReproSteps(e.target.value)}
                  placeholder="1. Open Artifact Studio&#10;2. Click version 2 tab&#10;3. Notice canvas remains blank..."
                  className="w-full px-3.5 py-2.5 rounded-xl bg-claude-surface2-light dark:bg-white/5 border border-claude-border-light dark:border-white/10 text-xs text-claude-text-light dark:text-white placeholder:text-claude-muted-light focus:outline-none focus:ring-2 focus:ring-aira-blue/40 resize-none font-mono text-[11px]"
                />
              </div>

              {/* Diagnostics Toggle */}
              <div className="p-3.5 rounded-xl border border-claude-border-light dark:border-white/10 bg-claude-surface2-light/30 dark:bg-white/[0.01]">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Info className="w-4 h-4 text-aira-blue" />
                    <span className="text-xs font-semibold text-claude-text-light dark:text-white">
                      Include System & Visual Diagnostics
                    </span>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={includeDiagnostics}
                      onChange={(e) => setIncludeDiagnostics(e.target.checked)}
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-claude-surface2-light dark:bg-white/20 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-aira-blue"></div>
                  </label>
                </div>

                {includeDiagnostics && (
                  <div className="text-[11px] font-mono text-claude-muted-light dark:text-claude-muted-dark bg-claude-surface-light dark:bg-black/20 p-2.5 rounded-lg border border-claude-border-light/50 dark:border-white/5 space-y-0.5">
                    <div>Browser / Platform: {diagnostics.platform}</div>
                    <div>Screen Viewport: {diagnostics.screenSize}</div>
                    <div>Theme & Preset: {diagnostics.activeTheme} / {diagnostics.aestheticPreset}</div>
                    <div>Active Model: {diagnostics.activeModel}</div>
                  </div>
                )}
              </div>

              {/* Privacy Consent Checkbox */}
              <div className="flex items-start gap-2.5 pt-1">
                <input
                  type="checkbox"
                  id="consent-check"
                  required
                  checked={consentChecked}
                  onChange={(e) => setConsentChecked(e.target.checked)}
                  className="mt-0.5 rounded border-claude-border-light text-aira-blue focus:ring-aira-blue"
                />
                <label htmlFor="consent-check" className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark leading-tight">
                  I consent to submitting this defect report. No conversation contents, private keys, or personal tokens are included.
                </label>
              </div>

              {/* Submit Buttons */}
              <div className="pt-2 flex items-center justify-end gap-2 border-t border-claude-border-light dark:border-white/10">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 rounded-xl text-xs font-medium text-claude-muted-light hover:text-claude-text-light transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || !title.trim() || !description.trim() || !consentChecked}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white text-xs font-bold transition-all shadow-sm active:scale-98"
                >
                  {isSubmitting ? (
                    <span>Submitting...</span>
                  ) : (
                    <>
                      <Send className="w-3.5 h-3.5" />
                      <span>Submit Bug Report</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          )}
        </div>
      </motion.div>
    </div>
  );
};
