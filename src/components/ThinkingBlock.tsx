import React, { useState } from 'react';
import { Brain, ChevronDown, Cpu } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { ThinkingBlock as IThinkingBlock } from '../types';

interface ThinkingBlockProps {
  thinking: IThinkingBlock;
}

export const ThinkingBlock: React.FC<ThinkingBlockProps> = ({ thinking }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  if (!thinking.text && !thinking.isStreaming) return null;

  return (
    <motion.div 
      layout
      className={`my-3 rounded-2xl bg-claude-surface-light/80 dark:bg-claude-surface-dark/80 backdrop-blur-lg border ${thinking.isStreaming ? 'border-cyan-500/30 dark:border-cyan-400/30 shadow-[0_0_15px_rgba(6,182,212,0.1)]' : 'border-claude-border-light dark:border-claude-border-dark'} overflow-hidden text-sm transition-all duration-500`}
    >
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark transition-colors select-none"
      >
        <div className="flex items-center space-x-3 text-claude-muted-light dark:text-claude-muted-dark">
          <div className="p-1.5 rounded-lg bg-claude-surface2-light dark:bg-claude-surface2-dark">
            <Brain className={`w-4 h-4 ${thinking.isStreaming ? 'animate-pulse text-claude-terracotta' : 'text-claude-text-light/60 dark:text-claude-text-dark/60'}`} />
          </div>
          <span className="font-medium text-claude-text-light dark:text-claude-text-dark tracking-tight">
            {thinking.isStreaming ? 'Reasoning process...' : 'Reasoning summary'}
          </span>
          {thinking.durationSeconds && (
            <span className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark font-mono tabular-nums bg-claude-surface2-light dark:bg-claude-surface2-dark px-2 py-0.5 rounded-md">
              {thinking.durationSeconds.toFixed(1)}s
            </span>
          )}
        </div>

        <div className="flex items-center space-x-2 text-claude-muted-light dark:text-claude-muted-dark">
          {thinking.isStreaming && (
            <span className="flex items-center space-x-1.5 text-xs text-cyan-600 dark:text-cyan-400 font-medium animate-pulse bg-cyan-500/10 dark:bg-cyan-400/10 px-2.5 py-1 rounded-full border border-cyan-500/20 dark:border-cyan-400/20">
              <Cpu className="w-3.5 h-3.5" />
              <span>Analyzing...</span>
            </span>
          )}
          <motion.div
            animate={{ rotate: isExpanded ? 180 : 0 }}
            transition={{ type: "spring", stiffness: 200, damping: 20 }}
            className="p-1 rounded-md bg-claude-surface2-light dark:bg-claude-surface2-dark"
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </motion.div>
        </div>
      </button>

      {/* Expanded Reasoning Content */}
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div 
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 100, damping: 20 }}
            className="border-t border-claude-border-light dark:border-claude-border-dark overflow-hidden"
          >
            <div className="px-4 py-4 font-mono text-xs leading-[1.8] text-claude-muted-light dark:text-claude-muted-dark whitespace-pre-wrap bg-claude-surface2-light dark:bg-claude-surface2-dark max-h-96 overflow-y-auto">
              {thinking.text}
              {thinking.isStreaming && (
                <motion.span 
                  initial={{ opacity: 0 }}
                  animate={{ opacity: [0, 1, 0] }}
                  transition={{ duration: 1.5, repeat: Infinity, ease: 'linear' }}
                  className="inline-block w-1.5 h-3.5 ml-1.5 bg-violet-500 align-middle rounded-full"
                />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};
