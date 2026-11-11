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
      className="relative p-4 sm:p-5 rounded-2xl bg-gradient-to-r from-aira-blue/10 via-cyan-500/10 to-indigo-500/10 dark:from-aira-blue/20 dark:via-cyan-900/20 dark:to-indigo-900/20 border border-aira-blue/30 dark:border-cyan-500/30 shadow-lg backdrop-blur-sm transition-all duration-300 animate-in fade-in slide-in-from-top-2"
    >
      {/* Dismiss Button */}
      <button
        type="button"
        data-testid="feature-discovery-dismiss-btn"
        onClick={onDismiss}
        aria-label="Dismiss feature guidance"
        className="absolute top-3 right-3 p-1 rounded-lg text-stone-400 hover:text-stone-700 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
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
            <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
              Unlocked with {guidance.unlockedAtTier.toUpperCase()}
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
              <span className="text-[10px] font-bold uppercase tracking-wider text-stone-400 dark:text-stone-500 shrink-0">
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
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-aira-blue hover:bg-aira-blue/90 dark:bg-cyan-600 dark:hover:bg-cyan-500 shrink-0 shadow-sm transition-all"
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
