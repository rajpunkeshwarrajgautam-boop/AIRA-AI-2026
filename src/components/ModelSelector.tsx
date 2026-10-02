import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, Sparkles, Brain, Check, Route } from 'lucide-react';
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
    <div className="relative inline-block" ref={containerRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center space-x-2 px-3 py-1.5 rounded-full bg-claude-surface2-light dark:bg-claude-surface2-dark hover:bg-claude-border-light dark:hover:bg-claude-border-dark border border-claude-border-light/80 dark:border-claude-border-dark/80 text-xs font-medium text-claude-text-light dark:text-claude-text-dark transition shadow-xs"
      >
        <Route className="w-3.5 h-3.5 text-claude-terracotta" />
        <span className="font-semibold">{activeModelInfo.name}</span>
        {activeModelInfo.badge && (
          <span className="hidden sm:inline text-[9px] px-1.5 py-0.5 rounded-full bg-claude-terracotta/10 text-claude-terracotta font-semibold uppercase tracking-wide">
            {activeModelInfo.badge}
          </span>
        )}
        {currentModel === 'claude-3-7-sonnet' && extendedThinking && <Brain className="w-3 h-3 text-violet-300" />}
        <ChevronDown className="w-3.5 h-3.5 text-claude-muted-light dark:text-claude-muted-dark" />
      </button>

      {isOpen && (
        <div className="absolute left-0 mt-2 w-[340px] rounded-2xl bg-claude-surface-light dark:bg-claude-surface-dark border border-claude-border-light dark:border-claude-border-dark shadow-claude-popup p-2 z-50 animate-in-spring">
          <div className="px-3 py-2 border-b border-claude-border-light/60 dark:border-claude-border-dark/60 mb-1 flex items-center justify-between">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-claude-muted-light dark:text-claude-muted-dark">Aira intelligence</div>
              <div className="text-[10px] text-claude-muted-light/80 dark:text-claude-muted-dark/80 mt-0.5">Choose how Aira should approach the task.</div>
            </div>
            <Sparkles className="w-3.5 h-3.5 text-claude-terracotta" />
          </div>

          <div className="space-y-1">
            {AVAILABLE_MODELS.map(model => {
              const isSelected = model.id === currentModel;
              return (
                <button
                  type="button"
                  key={model.id}
                  onClick={() => { onSelectModel(model.id); setIsOpen(false); }}
                  className={`w-full text-left p-2.5 rounded-xl transition ${isSelected ? 'bg-claude-terracotta/10 border border-claude-terracotta/20' : 'hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark border border-transparent'}`}
                >
                  <div className="flex items-center justify-between mb-0.5">
                    <div className="flex items-center space-x-2">
                      <span className="text-xs font-semibold text-claude-text-light dark:text-claude-text-dark">{model.name}</span>
                      {model.badge && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-claude-surface2-light dark:bg-claude-surface2-dark text-claude-muted-light dark:text-claude-muted-dark uppercase tracking-wide">{model.badge}</span>}
                    </div>
                    {isSelected && <Check className="w-3.5 h-3.5 text-claude-terracotta" />}
                  </div>
                  <p className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark leading-snug">{model.description}</p>
                </button>
              );
            })}
          </div>

          <div className="mt-2 pt-2 border-t border-claude-border-light/60 dark:border-claude-border-dark/60 px-2 py-1">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center space-x-2">
                <Brain className="w-4 h-4 text-violet-300" />
                <div>
                  <div className="text-xs font-medium text-claude-text-light dark:text-claude-text-dark">Deep reasoning</div>
                  <div className="text-[10px] text-claude-muted-light dark:text-claude-muted-dark">Spend more reasoning budget on complex tasks.</div>
                </div>
              </div>
              <label className="relative inline-flex items-center cursor-pointer flex-shrink-0">
                <input type="checkbox" checked={extendedThinking} onChange={e => onToggleThinking(e.target.checked)} className="sr-only peer" />
                <div className="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-claude-terracotta" />
              </label>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
