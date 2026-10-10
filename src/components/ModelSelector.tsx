import React, { useEffect, useRef, useState } from 'react';
import { Brain, Check, ChevronDown, Gauge, Sparkles, Zap } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { ModelId } from '../types';
import { AVAILABLE_MODELS } from '../utils/constants';

interface ModelSelectorProps {
  currentModel: ModelId;
  onSelectModel: (model: ModelId) => void;
  extendedThinking: boolean;
  onToggleThinking: (enabled: boolean) => void;
}

const modelGlyph = (name: string) => {
  if (name.includes('Fast')) return Zap;
  if (name.includes('Deep') || name.includes('Nemotron')) return Brain;
  if (name.includes('Auto')) return Sparkles;
  return Gauge;
};

export const ModelSelector: React.FC<ModelSelectorProps> = ({
  currentModel,
  onSelectModel,
  extendedThinking,
  onToggleThinking,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [activeRow, setActiveRow] = useState(currentModel);
  const containerRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const activeModelInfo = AVAILABLE_MODELS.find(model => model.id === currentModel) || AVAILABLE_MODELS[0];
  const ActiveIcon = modelGlyph(activeModelInfo.name);

  useEffect(() => {
    if (!isOpen) return;
    const handlePointer = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setIsOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
        (containerRef.current?.querySelector('button') as HTMLButtonElement | null)?.focus();
      }
    };
    document.addEventListener('pointerdown', handlePointer);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('pointerdown', handlePointer);
      document.removeEventListener('keydown', handleKey);
    };
  }, [isOpen]);

  const selectModel = (model: (typeof AVAILABLE_MODELS)[number]) => {
    onSelectModel(model.id);
    if (!model.supportsThinking && extendedThinking) onToggleThinking(false);
    setIsOpen(false);
  };

  return (
    <div className="relative z-50 inline-block min-w-0" ref={containerRef}>
      <motion.button
        type="button"
        onClick={() => setIsOpen(open => !open)}
        whileTap={reducedMotion ? undefined : { scale: 0.98 }}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        className="group flex min-w-0 max-w-full items-center gap-1 sm:gap-2 rounded-xl px-1.5 sm:px-2.5 py-1.5 text-left transition-colors hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark"
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] bg-claude-terracotta/10 text-claude-terracotta">
          <ActiveIcon className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="block max-w-[88px] min-[375px]:max-w-[116px] sm:max-w-[180px] truncate text-[12px] sm:text-[13px] font-semibold text-claude-text-light dark:text-white">{activeModelInfo.name}</span>
            {extendedThinking && activeModelInfo.supportsThinking && <Brain className="h-3.5 w-3.5 text-claude-terracotta" />}
          </span>
          <span className="hidden text-[10px] font-medium text-claude-muted-light sm:block dark:text-claude-muted-dark">
            {activeModelInfo.badge || 'Aira'} · {activeModelInfo.contextWindow}
          </span>
        </span>
        <motion.span
          animate={reducedMotion ? undefined : { rotate: isOpen ? 180 : 0 }}
          transition={{ type: 'spring', stiffness: 360, damping: 28 }}
          className="ml-0.5 text-claude-muted-light dark:text-claude-muted-dark"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </motion.span>
      </motion.button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 5, scale: 0.985 }}
            transition={reducedMotion ? { duration: 0.08 } : { type: 'spring', stiffness: 390, damping: 31 }}
            className="absolute left-0 mt-2 w-[calc(100vw-96px)] sm:w-[calc(100vw-120px)] max-w-[380px] overflow-hidden rounded-[18px] border border-claude-border-light bg-white/95 p-2 shadow-[0_20px_55px_-22px_rgba(45,40,30,0.5)] backdrop-blur-2xl dark:border-claude-border-dark dark:bg-[#1c1b18]/95 dark:shadow-[0_24px_60px_-24px_rgba(0,0,0,0.9)]"
          >
            <div className="flex items-center justify-between px-2.5 pb-2 pt-1.5">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-claude-muted-light dark:text-claude-muted-dark">Aira intelligence</div>
                <div className="mt-0.5 text-[12px] font-medium text-claude-text-light dark:text-white">Choose the engine for this task</div>
              </div>
              <span className="rounded-lg bg-claude-terracotta/10 p-1.5 text-claude-terracotta">
                <Sparkles className="h-4 w-4" />
              </span>
            </div>

            <div role="listbox" aria-label="Available Aira models" className="space-y-1">
              {AVAILABLE_MODELS.map(model => {
                const selected = model.id === currentModel;
                const focused = model.id === activeRow;
                const Icon = modelGlyph(model.name);
                return (
                  <button
                    key={model.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onMouseEnter={() => setActiveRow(model.id)}
                    onFocus={() => setActiveRow(model.id)}
                    onClick={() => selectModel(model)}
                    className="relative isolate flex w-full items-start gap-3 rounded-[13px] px-3 py-2.5 text-left outline-none"
                  >
                    {(focused || selected) && (
                      <motion.span
                        layoutId="aira-model-row"
                        className={`absolute inset-0 -z-10 rounded-[13px] border ${
                          selected
                            ? 'border-claude-terracotta/20 bg-claude-terracotta/[0.07]'
                            : 'border-transparent bg-claude-surface2-light dark:bg-claude-surface2-dark'
                        }`}
                        transition={reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 430, damping: 35 }}
                      />
                    )}
                    <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] ${
                      selected
                        ? 'bg-claude-terracotta text-white'
                        : 'bg-claude-surface2-light text-claude-muted-light dark:bg-claude-surface2-dark dark:text-claude-muted-dark'
                    }`}>
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-[13px] font-semibold text-claude-text-light dark:text-white">{model.name}</span>
                        {model.badge && (
                          <span className="rounded-md bg-claude-surface2-light px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-claude-muted-light dark:bg-claude-surface2-dark dark:text-claude-muted-dark">
                            {model.badge}
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 block text-[11px] leading-relaxed text-claude-muted-light dark:text-claude-muted-dark">{model.description}</span>
                      <span className="mt-1.5 flex items-center gap-1.5 text-[9px] font-medium uppercase tracking-wider text-claude-muted-light/80 dark:text-claude-muted-dark/80">
                        <span>{model.contextWindow}</span>
                        {model.supportsThinking && <><span>•</span><span>Deep reasoning</span></>}
                      </span>
                    </span>
                    {selected && <Check className="mt-1 h-4 w-4 shrink-0 text-claude-terracotta" />}
                  </button>
                );
              })}
            </div>

            <div className="mt-2 border-t border-claude-border-light pt-2 dark:border-claude-border-dark">
              <button
                type="button"
                role="switch"
                aria-checked={extendedThinking && activeModelInfo.supportsThinking}
                disabled={!activeModelInfo.supportsThinking}
                onClick={() => activeModelInfo.supportsThinking && onToggleThinking(!extendedThinking)}
                className="flex w-full items-center justify-between gap-3 rounded-[13px] px-3 py-2.5 text-left transition-colors hover:bg-claude-surface2-light disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-claude-surface2-dark"
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-claude-terracotta/10 text-claude-terracotta">
                    <Brain className="h-4 w-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[12px] font-semibold text-claude-text-light dark:text-white">Deep reasoning</span>
                    <span className="block truncate text-[10px] text-claude-muted-light dark:text-claude-muted-dark">
                      {activeModelInfo.supportsThinking ? 'Use more compute for complex work' : 'Not available for this model'}
                    </span>
                  </span>
                </span>
                <span className={`relative h-6 w-10 shrink-0 rounded-full transition-colors ${
                  extendedThinking && activeModelInfo.supportsThinking ? 'bg-claude-terracotta' : 'bg-claude-border-light dark:bg-[#47443f]'
                }`}>
                  <motion.span
                    className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm"
                    animate={{ x: extendedThinking && activeModelInfo.supportsThinking ? 16 : 0 }}
                    transition={reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 30 }}
                  />
                </span>
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
