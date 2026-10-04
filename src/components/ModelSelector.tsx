import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, Zap, Brain, Check } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import type { ModelId } from '../types';
import { AVAILABLE_MODELS } from '../utils/constants';

interface ModelSelectorProps {
  currentModel: ModelId;
  onSelectModel: (model: ModelId) => void;
  extendedThinking: boolean;
  onToggleThinking: (enabled: boolean) => void;
}

export const ModelSelector: React.FC<ModelSelectorProps> = ({
  currentModel,
  onSelectModel,
  extendedThinking,
  onToggleThinking,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const activeModelInfo = AVAILABLE_MODELS.find(m => m.id === currentModel) || AVAILABLE_MODELS[0];

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setIsOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div className="relative inline-block z-50" ref={containerRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center space-x-1.5 px-2.5 py-1.5 rounded-lg hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark text-sm font-medium text-claude-text-light dark:text-claude-text-dark transition-colors"
      >
        <span>{activeModelInfo.name}</span>
        {activeModelInfo.badge && (
          <span className="hidden sm:inline text-[10px] font-mono px-1.5 py-0.2 rounded bg-claude-surface2-light dark:bg-claude-surface2-dark text-claude-muted-light dark:text-claude-muted-dark">
            {activeModelInfo.badge}
          </span>
        )}
        {currentModel === 'claude-3-7-sonnet' && extendedThinking && <Brain className="w-3.5 h-3.5 text-claude-terracotta" />}
        <motion.div animate={{ rotate: isOpen ? 180 : 0 }} transition={{ type: "spring", stiffness: 300, damping: 20 }}>
          <ChevronDown className="w-3.5 h-3.5 text-claude-muted-light dark:text-claude-muted-dark" />
        </motion.div>
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div 
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
            className="absolute left-0 mt-2 w-[calc(100vw-24px)] sm:w-[340px] max-w-[340px] rounded-2xl bg-claude-surface-light dark:bg-claude-surface-dark border border-claude-border-light dark:border-claude-border-dark shadow-[0_4px_24px_rgba(45,40,30,0.08)] dark:shadow-[0_4px_24px_rgba(0,0,0,0.5)] p-2 z-50 origin-top-left overflow-hidden"
          >
            <div className="px-3 py-2.5 border-b border-claude-border-light dark:border-claude-border-dark mb-1.5 flex items-center justify-between bg-claude-surface2-light dark:bg-claude-surface2-dark rounded-t-xl">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-[0.15em] text-claude-text-light dark:text-white">Aira intelligence</div>
                <div className="text-[11px] font-medium text-claude-muted-light dark:text-claude-muted-dark mt-0.5">Choose how Aira approaches the task.</div>
              </div>
              <div className="p-1.5 bg-claude-terracotta/10 rounded-lg">
                <Zap className="w-4 h-4 text-claude-terracotta" />
              </div>
            </div>

            <div className="space-y-1">
              {AVAILABLE_MODELS.map((model, idx) => {
                const isSelected = model.id === currentModel;
                return (
                  <motion.button
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: idx * 0.05 }}
                    type="button"
                    key={model.id}
                    onClick={() => { onSelectModel(model.id); setIsOpen(false); }}
                    className={`w-full text-left p-3 rounded-xl transition-all duration-300 relative group overflow-hidden ${isSelected ? 'shadow-sm' : 'hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark border-transparent'}`}
                  >
                    {isSelected && (
                      <motion.div layoutId="model-active-bg" className="absolute inset-0 bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark shadow-sm rounded-xl -z-10" />
                    )}
                    <div className="relative z-10">
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center space-x-2.5">
                          <span className={`text-[13px] font-bold tracking-tight ${isSelected ? 'text-claude-terracotta dark:text-white' : 'text-claude-text-light dark:text-white'}`}>{model.name}</span>
                          {model.badge && <span className="text-[9px] font-bold px-2 py-0.5 rounded-md bg-claude-surface2-light dark:bg-claude-surface2-dark text-claude-muted-light dark:text-claude-muted-dark uppercase tracking-wider">{model.badge}</span>}
                        </div>
                        {isSelected && <Check className="w-4 h-4 text-claude-terracotta" />}
                      </div>
                      <p className="text-[12px] font-medium text-claude-muted-light dark:text-claude-muted-dark leading-[1.4] pr-4">{model.description}</p>
                    </div>
                  </motion.button>
                );
              })}
            </div>

            <div className="mt-2 pt-2 border-t border-claude-border-light dark:border-claude-border-dark px-2 py-1.5 bg-claude-surface2-light dark:bg-claude-surface2-dark rounded-b-xl">
              <div 
                onClick={() => onToggleThinking(!extendedThinking)}
                className="flex items-center justify-between gap-3 p-3 mt-1 rounded-xl hover:bg-claude-surface-light/60 dark:hover:bg-claude-surface-dark/60 cursor-pointer transition-colors select-none group"
              >
                <div className="flex items-center space-x-3 min-w-0">
                  <div className="w-9 h-9 rounded-xl bg-[#EDE9FE] dark:bg-[#2E274D] flex items-center justify-center flex-shrink-0 shadow-sm">
                    <Brain className="w-5 h-5 text-[#7C3AED] dark:text-[#A78BFA]" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold tracking-tight text-claude-text-light dark:text-white">Deep reasoning</div>
                    <div className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark leading-snug">Spend more compute on complex tasks.</div>
                  </div>
                </div>
                <button 
                  type="button"
                  role="switch"
                  aria-checked={extendedThinking}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleThinking(!extendedThinking);
                  }}
                  className={`group relative inline-flex h-[28px] w-[50px] flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-300 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00BCD4] focus-visible:ring-offset-2 dark:focus-visible:ring-offset-claude-bg-dark ${
                    extendedThinking ? 'bg-[#00BCD4]' : 'bg-claude-border-light dark:bg-[#4A4740]'
                  }`}
                  style={{ boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.15)' }}
                >
                  <span className="sr-only">Toggle Deep reasoning</span>
                  <span
                    aria-hidden="true"
                    className={`pointer-events-none inline-block h-[24px] w-[24px] transform rounded-full bg-white shadow-[0_2px_5px_rgba(0,0,0,0.2)] ring-0 transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] group-active:w-[32px] ${
                      extendedThinking ? 'translate-x-[22px] group-active:translate-x-[14px]' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
