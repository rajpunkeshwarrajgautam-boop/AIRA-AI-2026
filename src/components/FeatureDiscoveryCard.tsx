import React from 'react';
import { Sparkles, X, ArrowRight, Play, Zap } from 'lucide-react';
import type { FeatureGuidanceItem } from '../utils/featureDiscovery';

export interface FeatureDiscoveryCardProps {
  guidance: FeatureGuidanceItem;
  onDismiss: () => void;
  onTryFeature: (samplePrompt: string, targetMode?: 'chat' | 'agent') => void;
}

export const FeatureDiscoveryCard: React.FC<FeatureDiscoveryCardProps> = ({
  guidance,
  onDismiss,
  onTryFeature
}) => {
  return (
    <div
      data-testid="feature-discovery-card"
      className="relative p-4 sm:p-5 rounded-2xl bg-gradient-to-r from-claude-terracotta/10 to-transparent dark:from-claude-terracotta/20 dark:to-transparent border border-claude-border dark:border-claude-borderMuted shadow-sm backdrop-blur-sm transition-opacity duration-200 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2 motion-reduce:animate-none"
    >
      {/* Dismiss Button */}
      <button
        type="button"
        data-testid="feature-discovery-dismiss-btn"
        onClick={onDismiss}
        aria-label="Dismiss feature guidance"
        className="absolute top-3 right-3 p-1 rounded-lg text-stone-400 hover:text-stone-700 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10 active:scale-95 disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-terracotta transition-colors"
      >
        <X className="w-4 h-4" />
      </button>

      <div className="flex flex-col sm:flex-row items-start gap-4">
        {/* Feature Icon */}
        <div className="p-2.5 rounded-xl bg-aira-blue/20 text-aira-blue dark:bg-cyan-500/20 dark:text-cyan-400 shrink-0">
          <Zap className="w-5 h-5" />
        </div>

        {/* Info & Sample Prompt */}
        <div className="flex-1 min-w-0 pr-6">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
              Unlocked with {guidance.unlockedAtTier}
            </span>
            <span className="text-xs text-stone-500 dark:text-stone-400">
              {guidance.subtitle}
            </span>
          </div>

          <h4
            data-testid="feature-discovery-title"
            className="text-base font-bold text-stone-900 dark:text-white mt-1"
          >
            {guidance.title}
          </h4>

          <p className="text-xs text-stone-600 dark:text-stone-300 mt-1 leading-relaxed">
            {guidance.description}
          </p>

          {/* Sample Prompt Box */}
          <div className="mt-3 p-2.5 rounded-xl bg-white/80 dark:bg-black/40 border border-stone-200/80 dark:border-white/10 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-xs font-medium text-stone-500 dark:text-stone-400 shrink-0">
                Try Prompt:
              </span>
              <p
                data-testid="feature-discovery-sample-prompt"
                className="text-xs font-mono text-stone-800 dark:text-stone-200 truncate"
              >
                "{guidance.samplePrompt}"
              </p>
            </div>

            <button
              type="button"
              data-testid="feature-discovery-try-btn"
              onClick={() => onTryFeature(guidance.samplePrompt, guidance.targetMode)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-claude-terracotta hover:bg-claude-terracotta-hover active:scale-95 disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-terracotta shrink-0 shadow-sm transition-colors duration-150"
            >
              <span>Try Feature</span>
              <Play className="w-3 h-3 fill-current" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
