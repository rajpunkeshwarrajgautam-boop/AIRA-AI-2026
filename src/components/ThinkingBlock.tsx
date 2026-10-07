import React, { useState } from 'react';
import { Brain, ChevronDown, Cpu, Sparkles } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ThinkingBlock as IThinkingBlock } from '../types';

interface ThinkingBlockProps {
  thinking: IThinkingBlock;
}

export const ThinkingBlock: React.FC<ThinkingBlockProps> = ({ thinking }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const reducedMotion = useReducedMotion();

  if (!thinking.text && !thinking.isStreaming) return null;

  return (
    <motion.div
      layout
      className={`my-3 overflow-hidden rounded-[15px] border text-sm ${
        thinking.isStreaming
          ? 'border-claude-terracotta/25 bg-claude-terracotta/[0.035]'
          : 'border-claude-border-light bg-claude-surface-light/70 dark:border-claude-border-dark dark:bg-claude-surface-dark/70'
      }`}
    >
      <button
        type="button"
        aria-expanded={isExpanded}
        onClick={() => setIsExpanded(expanded => !expanded)}
        className="flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-claude-surface2-light/70 dark:hover:bg-claude-surface2-dark/70"
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <span className={`relative flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] ${
            thinking.isStreaming
              ? 'bg-claude-terracotta/10 text-claude-terracotta'
              : 'bg-claude-surface2-light text-claude-muted-light dark:bg-claude-surface2-dark dark:text-claude-muted-dark'
          }`}>
            {thinking.isStreaming ? <Cpu className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
            {thinking.isStreaming && (
              <motion.span
                className="absolute inset-0 rounded-[9px] border border-claude-terracotta/25"
                animate={reducedMotion ? undefined : { opacity: [0.2, 0.8, 0.2], scale: [1, 1.08, 1] }}
                transition={{ duration: 1.8, repeat: Infinity }}
              />
            )}
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className="text-[12px] font-semibold text-claude-text-light dark:text-white">
                {thinking.isStreaming ? 'Aira is reasoning' : 'Reasoning details'}
              </span>
              {thinking.durationSeconds !== undefined && !thinking.isStreaming && (
                <span className="rounded-md bg-claude-surface2-light px-1.5 py-0.5 font-mono text-[9px] tabular-nums text-claude-muted-light dark:bg-claude-surface2-dark dark:text-claude-muted-dark">
                  {thinking.durationSeconds.toFixed(1)}s
                </span>
              )}
            </span>
            <span className="mt-0.5 block truncate text-[10px] text-claude-muted-light dark:text-claude-muted-dark">
              {thinking.isStreaming ? 'Working through the task before answering' : 'Expand to review the reasoning summary'}
            </span>
          </span>
        </span>

        <motion.span
          animate={reducedMotion ? undefined : { rotate: isExpanded ? 180 : 0 }}
          transition={{ type: 'spring', stiffness: 300, damping: 26 }}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[8px] text-claude-muted-light dark:text-claude-muted-dark"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </motion.span>
      </button>

      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={reducedMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reducedMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={reducedMotion ? { duration: 0.08 } : { type: 'spring', stiffness: 160, damping: 24 }}
            className="overflow-hidden border-t border-claude-border-light dark:border-claude-border-dark"
          >
            <div className="max-h-80 overflow-y-auto bg-claude-surface2-light/70 px-4 py-3.5 font-mono text-[11px] leading-[1.75] whitespace-pre-wrap text-claude-muted-light dark:bg-claude-surface2-dark/70 dark:text-claude-muted-dark">
              {thinking.text}
              {thinking.isStreaming && (
                <motion.span
                  initial={{ opacity: 0 }}
                  animate={{ opacity: [0, 1, 0] }}
                  transition={{ duration: 1.2, repeat: Infinity, ease: 'linear' }}
                  className="ml-1.5 inline-block h-3 w-1 rounded-full bg-claude-terracotta align-middle"
                />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};
