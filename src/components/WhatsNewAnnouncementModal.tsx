import React, { useEffect, useState, useMemo } from 'react';
import {
  X,
  Sparkles,
  ChevronRight,
  ExternalLink,
  CheckCircle,
  Bell,
  Layers,
  ArrowRight
} from 'lucide-react';
import type { Announcement, PlanTier } from '../../packages/contracts/src/index';
import { getAnnouncementsForTier } from '../../packages/contracts/src/index';
import {
  dismissAnnouncement,
  getDismissedAnnouncementIds
} from '../utils/announcements';

export interface WhatsNewAnnouncementModalProps {
  isOpen: boolean;
  onClose: () => void;
  userTier?: PlanTier;
  userId?: string | null;
  isFirstViewPopup?: boolean;
  focusedAnnouncement?: Announcement | null;
  onAction?: (actionUrlOrRoute: string) => void;
}

export const WhatsNewAnnouncementModal: React.FC<WhatsNewAnnouncementModalProps> = ({
  isOpen,
  onClose,
  userTier = 'free',
  userId,
  isFirstViewPopup = false,
  focusedAnnouncement,
  onAction
}) => {
  const [viewMode, setViewMode] = useState<'popup' | 'center'>(
    isFirstViewPopup ? 'popup' : 'center'
  );
  const [dismissedSet, setDismissedSet] = useState<Set<string>>(
    () => new Set(getDismissedAnnouncementIds(userId))
  );

  useEffect(() => {
    if (isOpen) {
      setViewMode(isFirstViewPopup ? 'popup' : 'center');
      setDismissedSet(new Set(getDismissedAnnouncementIds(userId)));
    }
  }, [isOpen, isFirstViewPopup, userId]);

  // Handle ESC key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        handleDismissCurrent();
      }
    };
    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  const allAnnouncements = useMemo(() => {
    const list = getAnnouncementsForTier(userTier);
    return [...list].sort(
      (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
    );
  }, [userTier]);

  const activeAnnouncement = focusedAnnouncement || allAnnouncements[0] || null;

  const handleDismissCurrent = () => {
    if (activeAnnouncement) {
      dismissAnnouncement(activeAnnouncement.id, userId);
      setDismissedSet(prev => new Set(prev).add(activeAnnouncement.id));
    }
    onClose();
  };

  const handleDismissItem = (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    dismissAnnouncement(id, userId);
    setDismissedSet(prev => new Set(prev).add(id));
  };

  const handleCtaClick = (ctaUrl?: string) => {
    if (activeAnnouncement) {
      dismissAnnouncement(activeAnnouncement.id, userId);
      setDismissedSet(prev => new Set(prev).add(activeAnnouncement.id));
    }
    onClose();
    if (ctaUrl && onAction) {
      onAction(ctaUrl);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      data-testid="whats-new-modal"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
    >
      <div
        className="w-full max-w-xl max-h-[85vh] flex flex-col rounded-2xl bg-white dark:bg-[#18181b] border border-stone-200 dark:border-white/10 shadow-2xl overflow-hidden transition-all"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-stone-100 dark:border-white/10 bg-stone-50/50 dark:bg-white/[0.02]">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-aira-blue/10 text-aira-blue dark:bg-aira-blue/20 dark:text-cyan-400">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-stone-900 dark:text-white">
                {viewMode === 'popup' ? "What's New in AIRA" : "What's New & Updates"}
              </h2>
              <p className="text-xs text-stone-500 dark:text-stone-400">
                {viewMode === 'popup'
                  ? 'Latest features and workspace enhancements'
                  : 'Complete changelog and feature releases'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {viewMode === 'popup' && allAnnouncements.length > 1 && (
              <button
                type="button"
                onClick={() => setViewMode('center')}
                className="text-xs font-semibold px-2.5 py-1.5 rounded-lg text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-white/10 transition-colors"
              >
                View All Releases
              </button>
            )}
            <button
              type="button"
              data-testid="whats-new-close-btn"
              onClick={handleDismissCurrent}
              aria-label="Close"
              className="p-1.5 rounded-lg text-stone-400 hover:text-stone-700 dark:hover:text-white hover:bg-stone-100 dark:hover:bg-white/10 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {viewMode === 'popup' && activeAnnouncement ? (
            /* Single Featured Announcement View */
            <div className="space-y-4" data-testid={`whats-new-item-${activeAnnouncement.id}`}>
              <div className="flex items-center gap-2">
                <span className="px-2.5 py-0.5 rounded-full text-xs font-bold tracking-wide uppercase bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                  {activeAnnouncement.badge || `v${activeAnnouncement.version}`}
                </span>
                <span className="text-xs text-stone-400">
                  {new Date(activeAnnouncement.publishedAt).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric'
                  })}
                </span>
                <span className="ml-auto text-xs px-2 py-0.5 rounded-md bg-stone-100 dark:bg-white/10 font-mono text-stone-600 dark:text-stone-300">
                  v{activeAnnouncement.version}
                </span>
              </div>

              <div>
                <h3 className="text-lg font-bold text-stone-900 dark:text-white leading-snug">
                  {activeAnnouncement.title}
                </h3>
                <p className="mt-1.5 text-sm text-stone-600 dark:text-stone-300 leading-relaxed">
                  {activeAnnouncement.summary}
                </p>
              </div>

              {activeAnnouncement.features && activeAnnouncement.features.length > 0 && (
                <div className="p-4 rounded-xl bg-stone-50 dark:bg-white/[0.03] border border-stone-200/60 dark:border-white/5 space-y-2.5">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-stone-500 dark:text-stone-400">
                    Key Highlights
                  </h4>
                  <ul className="space-y-2">
                    {activeAnnouncement.features.map((feature, idx) => (
                      <li key={idx} className="flex items-start gap-2.5 text-xs text-stone-700 dark:text-stone-300 leading-relaxed">
                        <CheckCircle className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            /* Full Releases Center List */
            <div className="space-y-4">
              {allAnnouncements.length === 0 ? (
                <div
                  data-testid="whats-new-empty"
                  className="py-12 text-center text-sm text-stone-500 dark:text-stone-400"
                >
                  No release announcements available for your plan.
                </div>
              ) : (
                allAnnouncements.map(announcement => {
                  const isDismissed = dismissedSet.has(announcement.id);
                  return (
                    <div
                      key={announcement.id}
                      data-testid={`whats-new-item-${announcement.id}`}
                      className="p-4 rounded-xl border border-stone-200/80 dark:border-white/10 bg-stone-50/50 dark:bg-white/[0.02] hover:border-aira-blue/40 dark:hover:border-aira-blue/40 transition-all space-y-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono font-bold px-2 py-0.5 rounded bg-stone-200 dark:bg-white/10 text-stone-700 dark:text-stone-300">
                            v{announcement.version}
                          </span>
                          <span className="text-xs font-semibold px-2 py-0.5 rounded-full uppercase tracking-wider bg-aira-blue/10 text-aira-blue dark:text-cyan-400">
                            {announcement.category}
                          </span>
                          {announcement.badge && (
                            <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                              {announcement.badge}
                            </span>
                          )}
                        </div>
                        <span className="text-xs text-stone-400">
                          {new Date(announcement.publishedAt).toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric'
                          })}
                        </span>
                      </div>

                      <div>
                        <h4 className="text-sm font-bold text-stone-900 dark:text-white">
                          {announcement.title}
                        </h4>
                        <p className="mt-1 text-xs text-stone-600 dark:text-stone-300 leading-relaxed">
                          {announcement.summary}
                        </p>
                      </div>

                      {announcement.features && announcement.features.length > 0 && (
                        <ul className="space-y-1.5 pt-1">
                          {announcement.features.map((feat, fidx) => (
                            <li key={fidx} className="flex items-center gap-2 text-xs text-stone-600 dark:text-stone-400">
                              <span className="w-1.5 h-1.5 rounded-full bg-aira-blue dark:bg-cyan-400 shrink-0" />
                              <span>{feat}</span>
                            </li>
                          ))}
                        </ul>
                      )}

                      <div className="flex items-center justify-between pt-2 border-t border-stone-100 dark:border-white/5">
                        {announcement.ctaText && (
                          <button
                            type="button"
                            onClick={() => {
                              onClose();
                              if (announcement.ctaUrl && onAction) {
                                onAction(announcement.ctaUrl);
                              }
                            }}
                            className="inline-flex items-center gap-1.5 text-xs font-bold text-aira-blue hover:text-aira-blue/80 dark:text-cyan-400 dark:hover:text-cyan-300 transition-colors"
                          >
                            <span>{announcement.ctaText}</span>
                            <ArrowRight className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {!isDismissed ? (
                          <button
                            type="button"
                            onClick={e => handleDismissItem(announcement.id, e)}
                            className="ml-auto text-xs px-2.5 py-1 rounded-lg text-stone-500 hover:text-stone-800 dark:hover:text-white hover:bg-stone-200/50 dark:hover:bg-white/10 transition-colors"
                          >
                            Mark Read
                          </button>
                        ) : (
                          <span className="ml-auto text-[11px] text-stone-400 flex items-center gap-1">
                            <CheckCircle className="w-3.5 h-3.5 text-emerald-500" />
                            Read
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-stone-100 dark:border-white/10 bg-stone-50/50 dark:bg-white/[0.02]">
          {viewMode === 'popup' && (
            <button
              type="button"
              onClick={() => setViewMode('center')}
              className="text-xs font-semibold text-stone-500 dark:text-stone-400 hover:text-stone-800 dark:hover:text-white transition-colors"
            >
              Release history
            </button>
          )}
          {viewMode === 'center' && (
            <button
              type="button"
              onClick={() => setViewMode('popup')}
              className="text-xs font-semibold text-stone-500 dark:text-stone-400 hover:text-stone-800 dark:hover:text-white transition-colors"
            >
              Back to latest
            </button>
          )}

          <div className="flex items-center gap-2.5 ml-auto">
            <button
              type="button"
              data-testid="whats-new-dismiss-btn"
              onClick={handleDismissCurrent}
              className="px-4 py-2 rounded-xl text-xs font-semibold text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-white/10 transition-colors"
            >
              Got it
            </button>
            {activeAnnouncement?.ctaText && (
              <button
                type="button"
                data-testid="whats-new-cta-btn"
                onClick={() => handleCtaClick(activeAnnouncement.ctaUrl)}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold text-white bg-aira-blue hover:bg-aira-blue/90 shadow-sm transition-all"
              >
                <span>{activeAnnouncement.ctaText}</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
