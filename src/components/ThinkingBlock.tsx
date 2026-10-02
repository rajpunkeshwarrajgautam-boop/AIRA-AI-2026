import React, { useState } from 'react';
import { Brain, ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import { ThinkingBlock as IThinkingBlock } from '../types';

interface ThinkingBlockProps {
  thinking: IThinkingBlock;
}

export const ThinkingBlock: React.FC<ThinkingBlockProps> = ({ thinking }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  if (!thinking.text && !thinking.isStreaming) return null;

  return (
    <div className={`my-2.5 rounded-xl border border-claude-border-light dark:border-claude-border-dark border-l-2 border-l-claude-terracotta bg-claude-surface2-light/40 dark:bg-claude-surface2-dark/40 overflow-hidden transition-all text-xs shadow-xs animate-slide-up ${thinking.isStreaming ? 'shimmer-active' : ''}`}>
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-3.5 py-2 flex items-center justify-between text-left hover:bg-claude-border-light/30 dark:hover:bg-claude-border-dark/30 transition select-none"
      >
        <div className="flex items-center space-x-2 text-claude-muted-light dark:text-claude-muted-dark">
          <Brain className={`w-3.5 h-3.5 text-claude-terracotta ${thinking.isStreaming ? 'animate-pulse' : ''}`} />
          <span className="font-semibold text-claude-text-light dark:text-claude-text-dark tracking-tight">
            {thinking.isStreaming ? 'Reasoning...' : 'Reasoning summary'}
          </span>
          {thinking.durationSeconds && (
            <span className="text-[10px] text-claude-muted-light dark:text-claude-muted-dark font-mono">
              ({thinking.durationSeconds.toFixed(1)}s)
            </span>
          )}
        </div>

        <div className="flex items-center space-x-1.5 text-claude-muted-light dark:text-claude-muted-dark">
          {thinking.isStreaming && (
            <span className="flex items-center space-x-1 text-[10px] text-claude-terracotta font-medium animate-pulse">
              <Sparkles className="w-3 h-3" />
              <span>Analyzing</span>
            </span>
          )}
          {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </div>
      </button>

      {/* Expanded Reasoning Content */}
      {isExpanded && (
        <div className="px-3.5 py-3 border-t border-claude-border-light/70 dark:border-claude-border-dark/70 font-mono text-[11px] leading-relaxed text-claude-muted-light dark:text-claude-muted-dark whitespace-pre-wrap bg-claude-surface-light/40 dark:bg-claude-surface-dark/40 max-h-72 overflow-y-auto">
          {thinking.text}
          {thinking.isStreaming && (
            <span className="inline-block w-1.5 h-3 ml-1 bg-claude-terracotta animate-pulse"></span>
          )}
        </div>
      )}
    </div>
  );
};
