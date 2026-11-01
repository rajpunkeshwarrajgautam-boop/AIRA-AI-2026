import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  Bug, 
  X, 
  Send, 
  CheckCircle2, 
  Info,
  Copy,
  Check,
  Download,
  AlertCircle
} from 'lucide-react';
import { motion } from 'framer-motion';
import type { AppSettings } from '../types';

interface ReportBugModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
}

interface StoredBugReport {
  id: string;
  category: string;
  title: string;
  description: string;
  reproSteps: string;
  diagnostics: Record<string, unknown> | null;
  createdAt: string;
}

const BUG_STORAGE_KEY = 'aira_bug_reports_v1';

export const ReportBugModal: React.FC<ReportBugModalProps> = ({
  isOpen,
  onClose,
  settings,
}) => {
  const [category, setCategory] = useState<'ui' | 'inference' | 'billing' | 'artifacts' | 'performance' | 'other'>('ui');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [reproSteps, setReproSteps] = useState('');
  const [includeDiagnostics, setIncludeDiagnostics] = useState(() => !(settings?.telemetryOptOut));
  const [consentChecked, setConsentChecked] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);
  const [submittedDraftRef, setSubmittedDraftRef] = useState<string | null>(null);
  const [copiedDraftRef, setCopiedDraftRef] = useState(false);
  const [copiedMarkdown, setCopiedMarkdown] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);

  // Compute clean diagnostic payload (no tokens, no transcripts, sanitized geometry & environment)
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
      setSubmittedDraftRef(null);
      setTitle('');
      setDescription('');
      setReproSteps('');
      setDuplicateWarning(null);
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
    if (!title.trim() || !description.trim() || !consentChecked) return;

    setIsSubmitting(true);
    setDuplicateWarning(null);

    // Retrieve existing reports to check for duplicates
    let existingReports: StoredBugReport[] = [];
    try {
      const raw = localStorage.getItem(BUG_STORAGE_KEY);
      if (raw) existingReports = JSON.parse(raw);
    } catch {
      existingReports = [];
    }

    const isDuplicate = existingReports.some(
      r => r.title.trim().toLowerCase() === title.trim().toLowerCase() &&
           r.category === category
    );

    if (isDuplicate) {
      setIsSubmitting(false);
      setDuplicateWarning('A similar defect report has already been recorded in your local queue. Please update the title or verify existing logs.');
      return;
    }

    // Local Draft Reference strictly indicates client-side storage, not a remote ticket
    const draftId = `AIRA-LOCAL-DRAFT-${Date.now().toString(36).toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const newReport: StoredBugReport = {
      id: draftId,
      category,
      title: title.trim(),
      description: description.trim(),
      reproSteps: reproSteps.trim(),
      diagnostics: includeDiagnostics ? diagnostics : null,
      createdAt: new Date().toISOString(),
    };

    try {
      existingReports.unshift(newReport);
      // Keep up to 50 local reports
      localStorage.setItem(BUG_STORAGE_KEY, JSON.stringify(existingReports.slice(0, 50)));
    } catch (err) {
      console.warn('[BugReport] Failed to persist report locally', err);
    }

    setTimeout(() => {
      setIsSubmitting(false);
      setSubmittedDraftRef(draftId);
    }, 400);
  };

  const handleCopyDraftRef = () => {
    if (!submittedDraftRef) return;
    navigator.clipboard.writeText(submittedDraftRef);
    setCopiedDraftRef(true);
    setTimeout(() => setCopiedDraftRef(false), 2000);
  };

  const handleCopyMarkdown = () => {
    if (!submittedDraftRef) return;
    const md = [
      `### [${category.toUpperCase()}] ${title}`,
      `**Local Draft Reference:** \`${submittedDraftRef}\``,
      `**Classification:** Local Report Draft / Diagnostic Export (Client-Side Only)`,
      `**Remote Status:** Pending manual export (No remote support ticket created)`,
      `**Date:** ${new Date().toUTCString()}`,
      '',
      '#### Description',
      description,
      '',
      '#### Steps to Reproduce',
      reproSteps || 'N/A',
      '',
      '#### System Diagnostics',
      includeDiagnostics ? '```json\n' + JSON.stringify(diagnostics, null, 2) + '\n```' : 'Diagnostics excluded by user.'
    ].join('\n');

    navigator.clipboard.writeText(md);
    setCopiedMarkdown(true);
    setTimeout(() => setCopiedMarkdown(false), 2000);
  };

  const handleDownloadJSON = () => {
    if (!submittedDraftRef) return;
    const reportData = {
      id: submittedDraftRef,
      category,
      title,
      description,
      reproSteps,
      diagnostics: includeDiagnostics ? diagnostics : null,
      createdAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(reportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${submittedDraftRef}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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
                Report a Defect or Issue
              </h2>
              <p className="text-xs text-claude-muted-light dark:text-claude-muted-dark">
                Submit an actionable diagnostic bug report to help improve AIRA
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
          {submittedDraftRef ? (
            /* Submission Confirmation */
            <div className="py-6 flex flex-col items-center text-center space-y-4">
              <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-500">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-base font-bold text-claude-text-light dark:text-white">
                  Local Report Draft Recorded
                </h3>
                <p className="text-xs text-claude-muted-light dark:text-claude-muted-dark max-w-md mx-auto mt-1">
                  Your defect draft has been durably stored in this browser with draft reference:
                </p>
              </div>

              {/* Draft Reference Box */}
              <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-claude-surface2-light dark:bg-white/5 border border-claude-border-light dark:border-white/10 font-mono text-sm font-bold text-claude-text-light dark:text-white">
                <span>{submittedDraftRef}</span>
                <button
                  onClick={handleCopyDraftRef}
                  className="p-1 rounded-lg hover:bg-claude-surface-light dark:hover:bg-white/10 text-claude-muted-light hover:text-claude-text-light transition-colors"
                  title="Copy draft reference"
                  aria-label="Copy draft reference"
                >
                  {copiedDraftRef ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>

              {/* Infrastructure Transparency Notice */}
              <div className="p-3.5 rounded-xl border border-amber-500/30 bg-amber-500/5 text-left max-w-lg text-[11px] text-claude-text-light/90 dark:text-white/80 space-y-1">
                <div className="font-semibold text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                  <Info className="w-3.5 h-3.5" />
                  <span>Classification: Local Report Draft / Diagnostic Export</span>
                </div>
                <p>
                  This report is durably stored strictly within this browser&apos;s local storage. It does <strong>not</strong> reach a remote server or ticketing backend, and cannot be retrieved by administrators unless exported. To submit to engineering, copy the formatted Markdown report below and open a GitHub Issue or contact support.
                </p>
              </div>

              {/* Actions */}
              <div className="pt-2 flex flex-wrap items-center justify-center gap-3">
                <button
                  onClick={handleCopyMarkdown}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-aira-blue text-white text-xs font-bold transition-all shadow-sm active:scale-98"
                >
                  {copiedMarkdown ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  <span>{copiedMarkdown ? 'Markdown Copied!' : 'Copy Markdown Report'}</span>
                </button>

                <button
                  onClick={handleDownloadJSON}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-claude-surface2-light dark:bg-white/10 text-claude-text-light dark:text-white text-xs font-medium hover:bg-claude-surface2-light/80 transition-colors"
                >
                  <Download className="w-4 h-4" />
                  <span>Download JSON</span>
                </button>

                <button
                  onClick={onClose}
                  className="px-4 py-2 rounded-xl border border-claude-border-light dark:border-white/10 text-xs font-medium text-claude-text-light dark:text-white hover:bg-claude-surface2-light dark:hover:bg-white/5 transition-colors"
                >
                  Done
                </button>
              </div>
            </div>
          ) : (
            /* Bug Report Form */
            <form onSubmit={handleSubmit} className="space-y-4">
              {duplicateWarning && (
                <div className="p-3 rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400 text-xs flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{duplicateWarning}</span>
                </div>
              )}

              {/* Category Selector */}
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-claude-muted-light dark:text-claude-muted-dark mb-1.5">
                  Category
                </label>
                <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-xs">
                  {[
                    { id: 'ui', label: 'User Interface' },
                    { id: 'inference', label: 'AI Output' },
                    { id: 'billing', label: 'Billing/Plan' },
                    { id: 'artifacts', label: 'Artifacts' },
                    { id: 'performance', label: 'Performance' },
                    { id: 'other', label: 'Other' },
                  ].map((cat) => (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => setCategory(cat.id as any)}
                      className={`p-2 rounded-xl border text-center font-medium transition-all ${
                        category === cat.id
                          ? 'border-rose-500 bg-rose-500/10 text-rose-600 dark:text-rose-400 font-bold'
                          : 'border-claude-border-light dark:border-white/10 hover:bg-claude-surface2-light dark:hover:bg-white/5 text-claude-muted-light dark:text-claude-muted-dark'
                      }`}
                    >
                      {cat.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Title */}
              <div>
                <label htmlFor="bug-title" className="block text-xs font-bold uppercase tracking-wider text-claude-muted-light dark:text-claude-muted-dark mb-1">
                  Summary / Title <span className="text-rose-500">*</span>
                </label>
                <input
                  id="bug-title"
                  type="text"
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Model response stream freezes when generating Mermaid chart"
                  className="w-full px-3.5 py-2.5 rounded-xl border border-claude-border-light dark:border-white/10 bg-claude-surface2-light/40 dark:bg-white/[0.02] text-xs text-claude-text-light dark:text-white placeholder:text-claude-muted-light/60 focus:outline-none focus:border-rose-500 transition-colors"
                />
              </div>

              {/* Description */}
              <div>
                <label htmlFor="bug-desc" className="block text-xs font-bold uppercase tracking-wider text-claude-muted-light dark:text-claude-muted-dark mb-1">
                  Detailed Description <span className="text-rose-500">*</span>
                </label>
                <textarea
                  id="bug-desc"
                  required
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What happened? What did you expect to happen instead?"
                  className="w-full px-3.5 py-2.5 rounded-xl border border-claude-border-light dark:border-white/10 bg-claude-surface2-light/40 dark:bg-white/[0.02] text-xs text-claude-text-light dark:text-white placeholder:text-claude-muted-light/60 focus:outline-none focus:border-rose-500 transition-colors resize-none"
                />
              </div>

              {/* Steps to Reproduce */}
              <div>
                <label htmlFor="bug-repro" className="block text-xs font-bold uppercase tracking-wider text-claude-muted-light dark:text-claude-muted-dark mb-1">
                  Steps to Reproduce (Optional)
                </label>
                <textarea
                  id="bug-repro"
                  rows={2}
                  value={reproSteps}
                  onChange={(e) => setReproSteps(e.target.value)}
                  placeholder="1. Open artifact studio&#10;2. Click on preview tab&#10;3. Resize window"
                  className="w-full px-3.5 py-2.5 rounded-xl border border-claude-border-light dark:border-white/10 bg-claude-surface2-light/40 dark:bg-white/[0.02] text-xs text-claude-text-light dark:text-white placeholder:text-claude-muted-light/60 focus:outline-none focus:border-rose-500 transition-colors resize-none"
                />
              </div>

              {/* Diagnostics Section */}
              <div className="p-3.5 rounded-xl border border-claude-border-light dark:border-white/10 bg-claude-surface2-light/40 dark:bg-white/[0.02] space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Info className="w-4 h-4 text-claude-muted-light" />
                    <span className="text-xs font-bold text-claude-text-light dark:text-white">
                      System Diagnostics
                    </span>
                  </div>
                  <label className="text-xs flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={includeDiagnostics}
                      onChange={(e) => setIncludeDiagnostics(e.target.checked)}
                      className="rounded border-claude-border-light text-aira-blue focus:ring-aira-blue"
                    />
                    <span className="text-claude-muted-light dark:text-claude-muted-dark">
                      {settings?.telemetryOptOut ? 'Include sanitized metrics (Opt-Out active in Settings)' : 'Include sanitized metrics'}
                    </span>
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
                  I consent to recording this defect report. No conversation contents, private keys, or personal tokens are included.
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
                    <span>Recording...</span>
                  ) : (
                    <>
                      <Send className="w-3.5 h-3.5" />
                      <span>Save Local Report Draft & Export</span>
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
