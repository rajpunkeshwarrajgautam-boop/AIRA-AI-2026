import React, { useEffect, useRef, useState } from 'react';
import { 
  Settings, 
  X, 
  Check, 
  Download, 
  Upload, 
  Brain, 
  User, 
  FileCode2, 
  Sliders, 
  ShieldCheck,
  Palette,
  Database,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import type { AppSettings, Conversation, Project } from '../types';
import { AVAILABLE_MODELS } from '../utils/constants';

interface PresetTheme {
  id: NonNullable<AppSettings['aestheticPreset']>;
  name: string;
  badge: string;
  feature: string;
  swatches: [string, string, string];
}

const PRESET_THEMES: PresetTheme[] = [
  {
    id: 'linear-precision',
    name: 'Claude Editorial',
    badge: 'Linear Precision',
    feature: 'Ivory parchment & terracotta kinetic starburst',
    swatches: ['#FAF9F5', '#1F1E1D', '#D97757'],
  },
  {
    id: 'warm-parchment',
    name: 'Warm Parchment',
    badge: 'Antiquarian',
    feature: 'Antique book sepia & burnt copper halo',
    swatches: ['#F5EFEB', '#2C2016', '#BA582F'],
  },
  {
    id: 'liquid-glass',
    name: 'Liquid Glass',
    badge: 'VisionOS Specular',
    feature: 'Frosted crystal refractions & cobalt cyan',
    swatches: ['#EDF3F8', '#0A1629', '#0284C7'],
  },
  {
    id: 'industrial-brutalist',
    name: 'Industrial Brutalist',
    badge: 'Bauhaus Grid',
    feature: 'Architectural matte concrete & safety orange',
    swatches: ['#EDEDEA', '#0F0F0E', '#FF4D00'],
  },
  {
    id: 'nordic-moss',
    name: 'Nordic Earth',
    badge: 'Biophilic Sanctuary',
    feature: 'Scandinavian lichen & aurora emerald pulse',
    swatches: ['#F1F4EE', '#18261B', '#2E7D52'],
  },
  {
    id: 'solar-gold',
    name: 'Solaris Gold',
    badge: 'Haute Horlogerie',
    feature: '24K molten gold flare & champagne shimmer',
    swatches: ['#F7F5EE', '#0D0C09', '#E5B94E'],
  },
  {
    id: 'tokyo-neon',
    name: 'Tokyo Cyber',
    badge: 'Shibuya Night',
    feature: 'Laser scanline glow & dual-tone neon pulse',
    swatches: ['#090611', '#120D22', '#EC4899'],
  },
  {
    id: 'vanguard-monolith',
    name: 'Vanguard Monolith',
    badge: 'High Fashion',
    feature: 'Mirror platinum reflection & magnetic contrast',
    swatches: ['#F4F4F4', '#050505', '#FFFFFF'],
  },
];


interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSaveSettings: (settings: AppSettings) => void;
  conversations: Conversation[];
  projects: Project[];
  onImportData: (data: { conversations: Conversation[]; projects: Project[] }) => void;
  onClearAll: () => void;
  onOpenMemoryVault?: () => void;
}

type SettingsTab = 'general' | 'reasoning' | 'memory' | 'instructions' | 'artifacts' | 'data';

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen, onClose, settings, onSaveSettings, conversations, projects, onImportData, onClearAll, onOpenMemoryVault,
}) => {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [form, setForm] = useState<AppSettings>({ ...settings });
  const [saved, setSaved] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const closeHandler = useRef(onClose);
  closeHandler.current = onClose;
  const [viewport, setViewport] = useState(() => ({
    top: 0, left: 0,
    width: typeof window === 'undefined' ? 1024 : window.innerWidth,
    height: typeof window === 'undefined' ? 768 : window.innerHeight,
  }));
  const compactHeight = viewport.height < 430;

  // Browser chrome and the mobile keyboard can change the visual viewport
  // without resizing the layout viewport. Keep every dialog edge visible.
  useEffect(() => {
    if (!isOpen) return;
    const visual = window.visualViewport;
    const measure = () => setViewport({
      top: visual?.offsetTop ?? 0,
      left: visual?.offsetLeft ?? 0,
      width: visual?.width ?? window.innerWidth,
      height: visual?.height ?? window.innerHeight,
    });
    const previousFocus = document.activeElement as HTMLElement | null;
    measure();
    window.addEventListener('resize', measure);
    visual?.addEventListener('resize', measure);
    visual?.addEventListener('scroll', measure);
    const focusFrame = requestAnimationFrame(() => closeButtonRef.current?.focus({ preventScroll: true }));
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeHandler.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const tabbable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href]'
      );
      if (!tabbable?.length) return;
      const first = tabbable[0], last = tabbable[tabbable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleKey);
      window.removeEventListener('resize', measure);
      visual?.removeEventListener('resize', measure);
      visual?.removeEventListener('scroll', measure);
      previousFocus?.focus?.({ preventScroll: true });
    };
  }, [isOpen]);


  const save = () => {
    onSaveSettings(form);
    setSaved(true);
    setTimeout(() => { setSaved(false); onClose(); }, 500);
  };

  const exportData = () => {
    const blob = new Blob([JSON.stringify({ conversations, projects, settings: form }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `aira-workspace-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    URL.revokeObjectURL(url);
  };

  const importData = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const data = JSON.parse(String(ev.target?.result || '{}'));
        if (Array.isArray(data.conversations)) onImportData({ conversations: data.conversations, projects: data.projects || [] });
      } catch { alert('Invalid Aira backup file.'); }
    };
    reader.readAsText(file);
  };

  const tabs: Array<{ id: SettingsTab; label: string; icon: React.ReactNode }> = [
    { id: 'general', label: 'General', icon: <User className="w-4 h-4" /> },
    { id: 'reasoning', label: 'Model & Reasoning', icon: <Brain className="w-4 h-4" /> },
    { id: 'memory', label: 'Agent Memory', icon: <Database className="w-4 h-4" /> },
    { id: 'instructions', label: 'Custom Instructions', icon: <Sliders className="w-4 h-4" /> },
    { id: 'artifacts', label: 'Artifacts', icon: <FileCode2 className="w-4 h-4" /> },
    { id: 'data', label: 'Account & Data', icon: <ShieldCheck className="w-4 h-4" /> },
  ];

  return (
    <AnimatePresence>
      {isOpen && (
        <div data-testid="settings-viewport"
          className="fixed z-[70] flex items-center justify-center p-2 sm:p-6 select-none"
          style={{ top: viewport.top, left: viewport.left, width: viewport.width, height: viewport.height }}>
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="absolute inset-0 bg-stone-900/40 dark:bg-black/60 backdrop-blur-md"
            onClick={onClose}
          />
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="aira-settings-title"
            tabIndex={-1}
            data-testid="settings-dialog"
            initial={{ opacity: 0, scale: 0.96, y: 15 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 10 }}
            transition={{ type: "spring", stiffness: 350, damping: 28 }}
            style={{ maxHeight: Math.max(0, viewport.height - (viewport.width >= 640 ? 48 : 16)) }}
            className={`aira-settings-dialog w-full min-w-0 max-w-2xl h-full max-h-full sm:h-auto sm:max-h-[min(90dvh,900px)] rounded-2xl sm:rounded-[1.75rem] border border-claude-border-light dark:border-claude-border-dark bg-claude-surface-light dark:bg-claude-surface-dark shadow-[0_20px_60px_-15px_rgba(0,0,0,0.15)] dark:shadow-[0_20px_60px_-15px_rgba(0,0,0,0.7)] flex flex-col relative z-10 ${compactHeight ? 'overflow-y-auto overscroll-contain' : 'overflow-hidden'}`}
          >
            {/* Header */}
            <header data-testid="settings-header" className="shrink-0 px-3 sm:px-7 py-3 sm:py-4 border-b border-claude-border-light dark:border-claude-border-dark flex items-start justify-between gap-2 bg-claude-surface2-light dark:bg-claude-surface2-dark">
              <div className="flex min-w-0 items-start gap-2 sm:gap-3">
                <div className="shrink-0 p-2 rounded-xl bg-claude-terracotta/10 text-claude-terracotta">
                  <Settings className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <h2 id="aira-settings-title" className="font-bold text-base sm:text-lg tracking-tight leading-snug text-claude-text-light dark:text-white">Workspace Settings</h2>
                  <p className="text-[11px] font-medium text-claude-muted-light dark:text-claude-muted-dark">Preferences, intelligence, and system personality</p>
                </div>
              </div>
              <motion.button
                ref={closeButtonRef}
                type="button"
                aria-label="Close settings"
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={onClose}
                className="shrink-0 p-2 rounded-xl hover:bg-claude-surface-light dark:hover:bg-claude-surface-dark text-claude-muted-light dark:text-claude-muted-dark transition-colors"
              >
                <X className="w-5 h-5" />
              </motion.button>
            </header>

            {/* Native mobile picker keeps all six settings sections accessible. */}
            <div data-testid="settings-mobile-navigation" className="shrink-0 px-3 py-2 border-b border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light/60 dark:bg-claude-surface2-dark/60 sm:hidden">
              <label htmlFor="aira-settings-section" className="block mb-1 text-[11px] font-semibold text-claude-muted-light dark:text-claude-muted-dark">Settings section</label>
              <select
                id="aira-settings-section"
                aria-label="Settings section"
                value={activeTab}
                onChange={event => setActiveTab(event.target.value as SettingsTab)}
                className="w-full min-w-0 rounded-xl border border-claude-border-light dark:border-claude-border-dark bg-claude-surface-light dark:bg-claude-surface-dark text-claude-text-light dark:text-white px-3 py-2.5 text-sm font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-claude-terracotta"
              >
                {tabs.map(tab => <option key={tab.id} value={tab.id}>{tab.label}</option>)}
              </select>
            </div>
            {/* Full-width tab strip remains for tablet and desktop. */}
            <div role="tablist" aria-label="Settings categories" data-testid="settings-desktop-tabs" className="hidden sm:flex shrink-0 border-b border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light/60 dark:bg-claude-surface2-dark/60 px-5 sm:px-7 overflow-x-auto gap-1 pt-2">
              {tabs.map(tab => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`shrink-0 flex items-center gap-2 px-3 py-2.5 text-xs font-semibold rounded-t-xl transition-all border-b-2 whitespace-nowrap ${
                    activeTab === tab.id
                      ? 'border-claude-terracotta text-claude-terracotta bg-claude-surface-light dark:bg-claude-surface-dark shadow-[0_-2px_10px_-4px_rgba(0,0,0,0.03)]'
                      : 'border-transparent text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light dark:hover:text-white'
                  }`}
                >
                  {tab.icon}
                  <span>{tab.label}</span>
                </button>
              ))}
            </div>

            {/* Body Content */}
            <div data-testid="settings-content" className={`min-w-0 p-3 sm:p-7 space-y-6 bg-transparent ${compactHeight ? 'shrink-0' : 'min-h-0 flex-1 overflow-y-auto overscroll-contain'}`}>
              
              {/* TAB 1: GENERAL */}
              {activeTab === 'general' && (
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-5">
                  <div>
                    <label htmlFor="aira-settings-name" className="text-[11px] font-bold uppercase tracking-wider text-claude-muted-light dark:text-claude-muted-dark block mb-2">Display Name</label>
                    <input 
                      id="aira-settings-name"
                      value={form.userName} 
                      onChange={e => setForm({ ...form, userName: e.target.value })} 
                      placeholder="Enter your name (e.g. Punkeshwar)" 
                      className="w-full px-4 py-3 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark text-[13px] font-medium outline-none focus:border-claude-terracotta focus:shadow-[0_0_0_2px_rgba(217,119,87,0.15)] transition-all placeholder:text-claude-muted-light/50" 
                    />
                    <p className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark mt-1">Used to personalize dynamic greetings and conversation synthesis.</p>
                  </div>

                  <div>
                    <label htmlFor="aira-settings-email" className="text-[11px] font-bold uppercase tracking-wider text-claude-muted-light dark:text-claude-muted-dark block mb-2">Account Email</label>
                    <input 
                      id="aira-settings-email"
                      value={form.email || 'user@aira.internal'} 
                      onChange={e => setForm({ ...form, email: e.target.value })} 
                      className="w-full px-4 py-3 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark text-[13px] font-medium outline-none focus:border-claude-terracotta transition-all" 
                    />
                  </div>

                  <div>
                    <label className="text-[11px] font-bold uppercase tracking-wider text-claude-muted-light dark:text-claude-muted-dark block mb-2">Theme Mode</label>
                    <div className="grid grid-cols-3 gap-2.5">
                      {(['light','dark','system'] as const).map(theme => (
                        <button 
                          type="button"
                          key={theme} 
                          onClick={() => {
                            setForm({ ...form, theme });
                            onSaveSettings({ ...settings, ...form, theme });
                          }} 
                          className={`py-2.5 rounded-xl border text-[13px] font-bold capitalize transition-all ${
                            form.theme === theme 
                              ? 'border-claude-terracotta bg-claude-terracotta text-white shadow-sm' 
                              : 'border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light dark:bg-claude-surface2-dark text-claude-muted-light dark:text-claude-muted-dark hover:border-claude-terracotta/40'
                          }`}
                        >
                          {theme}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <label className="text-[11px] font-bold uppercase tracking-wider text-claude-muted-light dark:text-claude-muted-dark block">
                        Aesthetic Preset & Interactive Features
                      </label>
                      <span className="text-[10px] font-semibold text-claude-terracotta bg-claude-terracotta/10 px-2 py-0.5 rounded-full flex items-center gap-1">
                        <Palette className="w-3 h-3" />
                        <span>8 Curated Themes</span>
                      </span>
                    </div>

                    {/* Interactive Visual Theme Swatch Gallery Grid */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-h-[380px] overflow-y-auto pr-1">
                      {PRESET_THEMES.map(theme => {
                        const isSelected = (form.aestheticPreset || 'linear-precision') === theme.id;
                        return (
                          <div
                            key={theme.id}
                            onClick={() => {
                              setForm({ ...form, aestheticPreset: theme.id });
                              onSaveSettings({ ...settings, ...form, aestheticPreset: theme.id });
                            }}
                            className={`group relative p-3 rounded-2xl border transition-all duration-300 cursor-pointer select-none ${
                              isSelected
                                ? 'border-claude-terracotta bg-claude-terracotta/5 dark:bg-claude-terracotta/10 shadow-[0_2px_12px_-2px_rgba(217,119,87,0.25)]'
                                : 'border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light/60 dark:bg-claude-surface2-dark/60 hover:border-claude-terracotta/40 hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark'
                            }`}
                          >
                            <div className="flex items-center justify-between mb-2">
                              {/* Swatch palette preview dots */}
                              <div className="flex items-center space-x-1.5 p-1 rounded-full bg-black/5 dark:bg-white/5 border border-black/5 dark:border-white/5">
                                {theme.swatches.map((color, idx) => (
                                  <span
                                    key={idx}
                                    className="w-2.5 h-2.5 rounded-full shadow-inner"
                                    style={{ backgroundColor: color }}
                                  />
                                ))}
                              </div>

                              <span className="text-[9px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-md bg-claude-surface-light dark:bg-claude-surface-dark text-claude-muted-light dark:text-claude-muted-dark border border-claude-border-light dark:border-claude-border-dark">
                                {theme.badge}
                              </span>
                            </div>

                            <div className="flex items-center justify-between">
                              <span className="text-[13px] font-bold text-claude-text-light dark:text-white group-hover:text-claude-terracotta transition-colors">
                                {theme.name}
                              </span>
                              {isSelected && (
                                <Check className="w-4 h-4 text-claude-terracotta flex-shrink-0" />
                              )}
                            </div>

                            <p className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark mt-1 line-clamp-2 leading-relaxed font-sans">
                              {theme.feature}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </motion.div>
              )}

              {/* TAB 2: MODEL & REASONING */}
              {activeTab === 'reasoning' && (
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-5">
                  <div>
                    <label className="text-[11px] font-bold uppercase tracking-wider text-claude-muted-light dark:text-claude-muted-dark block mb-2">Default Intelligence Engine</label>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      {AVAILABLE_MODELS.map(model => (
                        <div
                          key={model.id}
                          onClick={() => setForm({ ...form, activeModel: model.id })}
                          className={`p-3 rounded-xl border cursor-pointer transition-all ${
                            form.activeModel === model.id
                              ? 'border-claude-terracotta bg-claude-terracotta/5 dark:bg-claude-terracotta/10 shadow-sm'
                              : 'border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light dark:bg-claude-surface2-dark hover:border-claude-border-light/80'
                          }`}
                        >
                          <div className="flex items-center justify-between mb-1">
                            <span className={`text-[13px] font-bold ${form.activeModel === model.id ? 'text-claude-terracotta' : 'text-claude-text-light dark:text-white'}`}>{model.name}</span>
                            {model.badge && <span className="text-[9px] uppercase font-bold px-1.5 py-0.5 rounded bg-claude-surface-light dark:bg-claude-surface-dark text-claude-muted-light dark:text-claude-muted-dark">{model.badge}</span>}
                          </div>
                          <p className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark line-clamp-2 leading-relaxed">{model.description}</p>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Deep Reasoning exact screenshot component */}
                  <div className="p-3.5 sm:p-4 rounded-2xl border border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light dark:bg-claude-surface2-dark shadow-sm">
                    <div 
                      onClick={() => setForm({ ...form, extendedThinking: !form.extendedThinking })}
                      className="flex items-center justify-between gap-3 cursor-pointer select-none"
                    >
                      <div className="flex items-center space-x-3 min-w-0">
                        <div className="w-10 h-10 rounded-xl bg-[#EDE9FE] dark:bg-[#2E274D] flex items-center justify-center flex-shrink-0 shadow-sm">
                          <Brain className="w-5 h-5 text-[#7C3AED] dark:text-[#A78BFA]" />
                        </div>
                        <div className="min-w-0">
                          <div className="text-[13px] font-bold tracking-tight text-claude-text-light dark:text-white">Deep reasoning</div>
                          <div className="text-[12px] text-claude-muted-light dark:text-claude-muted-dark leading-snug">Spend more compute on complex tasks.</div>
                        </div>
                      </div>
                      <button 
                        type="button"
                        role="switch"
                        aria-checked={form.extendedThinking}
                        onClick={(e) => {
                          e.stopPropagation();
                          setForm({ ...form, extendedThinking: !form.extendedThinking });
                        }}
                        className={`group relative inline-flex h-[28px] w-[50px] flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-300 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00BCD4] focus-visible:ring-offset-2 dark:focus-visible:ring-offset-claude-bg-dark ${
                          form.extendedThinking ? 'bg-[#00BCD4]' : 'bg-[#D5D2CA] dark:bg-[#4A4740]'
                        }`}
                        style={{ boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.15)' }}
                      >
                        <span className="sr-only">Toggle Deep reasoning</span>
                        <span
                          aria-hidden="true"
                          className={`pointer-events-none inline-block h-[24px] w-[24px] transform rounded-full bg-white shadow-[0_2px_5px_rgba(0,0,0,0.2)] ring-0 transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] group-active:w-[32px] ${
                            form.extendedThinking ? 'translate-x-[22px] group-active:translate-x-[14px]' : 'translate-x-0'
                          }`}
                        />
                      </button>
                    </div>

                    {/* Extended Thinking Token Budget */}
                    {form.extendedThinking && (
                      <motion.div 
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        className="mt-4 pt-4 border-t border-claude-border-light dark:border-claude-border-dark"
                      >
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-[11px] font-bold uppercase tracking-wider text-claude-muted-light dark:text-claude-muted-dark">Thinking Token Budget</span>
                          <span className="text-[11px] font-mono font-bold px-2 py-0.5 rounded-md bg-[#EDE9FE] dark:bg-[#2E274D] text-[#7C3AED] dark:text-[#A78BFA]">
                            {form.thinkingBudget.toLocaleString()} tokens
                          </span>
                        </div>
                        <input 
                          type="range" 
                          min="1024" 
                          max="32768" 
                          step="1024" 
                          value={form.thinkingBudget} 
                          onChange={e => setForm({ ...form, thinkingBudget: Number(e.target.value) })} 
                          className="w-full h-1.5 bg-claude-surface-light dark:bg-claude-surface-dark rounded-lg appearance-none cursor-pointer accent-[#D97757]" 
                        />
                        <div className="flex flex-wrap gap-1.5 mt-2.5">
                          {[2048, 4096, 8192, 16384, 32768].map(tokens => (
                            <button
                              type="button"
                              key={tokens}
                              onClick={() => setForm({ ...form, thinkingBudget: tokens })}
                              className={`text-[10px] font-mono px-2 py-1 rounded-lg border transition-colors ${
                                form.thinkingBudget === tokens
                                  ? 'border-[#D97757] bg-[#D97757]/10 text-[#D97757] font-bold'
                                  : 'border-claude-border-light dark:border-claude-border-dark bg-claude-surface-light dark:bg-claude-surface-dark text-claude-muted-light dark:text-claude-muted-dark'
                              }`}
                            >
                              {(tokens / 1024).toFixed(0)}k
                            </button>
                          ))}
                        </div>
                      </motion.div>
                    )}
                  </div>
                </motion.div>
              )}

              {/* TAB: AGENT MEMORY */}
              {activeTab === 'memory' && (
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
                  {/* Enable Persistent Memory Toggle */}
                  <div className="p-4 rounded-2xl border border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light dark:bg-claude-surface2-dark flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[13px] font-bold text-claude-text-light dark:text-white">Enable Persistent Memory</div>
                      <div className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark mt-0.5">Maintain cross-session context across Working, Episodic, Semantic, and Procedural tiers.</div>
                    </div>
                    <div 
                      onClick={() => setForm({ ...form, persistentMemoryEnabled: !(form.persistentMemoryEnabled ?? true) })}
                      className="w-11 h-6 rounded-full p-[2px] transition-colors duration-200 cursor-pointer flex-shrink-0 flex items-center"
                      style={{ backgroundColor: (form.persistentMemoryEnabled ?? true) ? '#D97757' : '#D5D2CA' }}
                    >
                      <motion.div 
                        layout
                        transition={{ type: "spring", stiffness: 500, damping: 30 }}
                        className={`w-5 h-5 rounded-full bg-white shadow-sm ${(form.persistentMemoryEnabled ?? true) ? 'ml-auto' : 'mr-auto'}`}
                      />
                    </div>
                  </div>

                  {/* Auto-Consolidate Memory Toggle */}
                  <div className="p-4 rounded-2xl border border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light dark:bg-claude-surface2-dark flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[13px] font-bold text-claude-text-light dark:text-white">Auto-Consolidation Worker</div>
                      <div className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark mt-0.5">Automatically extract preferences, decisions, and proven workflows from conversations.</div>
                    </div>
                    <div 
                      onClick={() => setForm({ ...form, autoConsolidateMemory: !(form.autoConsolidateMemory ?? true) })}
                      className="w-11 h-6 rounded-full p-[2px] transition-colors duration-200 cursor-pointer flex-shrink-0 flex items-center"
                      style={{ backgroundColor: (form.autoConsolidateMemory ?? true) ? '#D97757' : '#D5D2CA' }}
                    >
                      <motion.div 
                        layout
                        transition={{ type: "spring", stiffness: 500, damping: 30 }}
                        className={`w-5 h-5 rounded-full bg-white shadow-sm ${(form.autoConsolidateMemory ?? true) ? 'ml-auto' : 'mr-auto'}`}
                      />
                    </div>
                  </div>

                  {/* Privacy Filter Toggle */}
                  <div className="p-4 rounded-2xl border border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light dark:bg-claude-surface2-dark flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[13px] font-bold text-claude-text-light dark:text-white">Strict Secrets Scrubber</div>
                      <div className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark mt-0.5">Redact API keys (Anthropic, OpenAI, GitHub), tokens, and passwords prior to memory persistence.</div>
                    </div>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10 px-2.5 py-1 rounded-md border border-emerald-200/50 dark:border-emerald-500/20">Enforced</span>
                  </div>

                  {/* Memory Token Budget */}
                  <div className="p-4 rounded-2xl border border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light dark:bg-claude-surface2-dark">
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-[13px] font-bold text-claude-text-light dark:text-white">Memory Context Budget</div>
                      <span className="text-xs font-mono font-bold text-claude-terracotta">{form.memoryTokenBudget || 800} tokens</span>
                    </div>
                    <input
                      type="range"
                      min={200}
                      max={2000}
                      step={100}
                      value={form.memoryTokenBudget || 800}
                      onChange={e => setForm({ ...form, memoryTokenBudget: Number(e.target.value) })}
                      className="w-full accent-claude-terracotta"
                    />
                    <div className="flex justify-between text-[10px] text-claude-muted-light dark:text-claude-muted-dark mt-1">
                      <span>200 tokens (Minimal)</span>
                      <span>800 tokens (Balanced)</span>
                      <span>2000 tokens (Deep Recall)</span>
                    </div>
                  </div>

                  {/* Vault Actions */}
                  <div className="pt-2 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        if (onOpenMemoryVault) onOpenMemoryVault();
                      }}
                      className="flex-1 py-2.5 px-4 rounded-xl bg-claude-terracotta text-white font-semibold text-xs hover:bg-claude-terracotta-hover transition-colors shadow-sm"
                    >
                      Open Memory Vault Inspector
                    </button>
                    <a
                      href="http://localhost:3113"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="py-2.5 px-4 rounded-xl border border-claude-border-light dark:border-claude-border-dark text-xs font-semibold text-claude-text-light dark:text-white hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark transition-colors inline-flex items-center gap-1.5"
                    >
                      <span>Web Viewer (:3113)</span>
                    </a>
                  </div>
                </motion.div>
              )}

              {/* TAB 3: CUSTOM INSTRUCTIONS */}
              {activeTab === 'instructions' && (
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-5">
                  <div>
                    <label className="text-[11px] font-bold uppercase tracking-wider text-claude-muted-light dark:text-claude-muted-dark block mb-2">What should Aira know about you?</label>
                    <textarea 
                      rows={3} 
                      value={form.userBio || ''} 
                      onChange={e => setForm({ ...form, userBio: e.target.value })} 
                      placeholder="e.g. Senior frontend engineer building responsive TypeScript applications, prefers direct answers and production-ready code." 
                      className="w-full px-4 py-3 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark text-[13px] font-medium outline-none focus:border-claude-terracotta transition-all resize-none placeholder:text-claude-muted-light/50" 
                    />
                  </div>

                  <div>
                    <label className="text-[11px] font-bold uppercase tracking-wider text-claude-muted-light dark:text-claude-muted-dark block mb-2">How would you like Aira to respond?</label>
                    <textarea 
                      rows={4} 
                      value={form.customInstructions} 
                      onChange={e => setForm({ ...form, customInstructions: e.target.value })} 
                      placeholder="e.g. Provide concise responses, highlight critical edge cases, prefer modern vanilla CSS and TypeScript, avoid unnecessary conversational filler." 
                      className="w-full px-4 py-3 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark text-[13px] font-medium outline-none focus:border-claude-terracotta transition-all resize-none placeholder:text-claude-muted-light/50" 
                    />
                  </div>

                  <div>
                    <label className="text-[11px] font-bold uppercase tracking-wider text-claude-muted-light dark:text-claude-muted-dark block mb-2">Response Style Preset</label>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {[
                        { id: 'normal', label: 'Balanced' },
                        { id: 'concise', label: 'Concise & Direct' },
                        { id: 'explanatory', label: 'In-Depth' },
                        { id: 'academic', label: 'Rigorous / Cited' },
                        { id: 'code-first', label: 'Code First' }
                      ].map(style => (
                        <button
                          type="button"
                          key={style.id}
                          onClick={() => setForm({ ...form, responseStyle: style.id as AppSettings['responseStyle'] })}
                          className={`p-2.5 rounded-xl border text-xs font-semibold text-center transition-all ${
                            form.responseStyle === style.id
                              ? 'border-claude-terracotta bg-claude-terracotta/10 text-claude-terracotta'
                              : 'border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light dark:bg-claude-surface2-dark text-claude-muted-light dark:text-claude-muted-dark hover:border-claude-terracotta/40'
                          }`}
                        >
                          {style.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </motion.div>
              )}

              {/* TAB 4: ARTIFACTS */}
              {activeTab === 'artifacts' && (
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
                  <div className="p-4 rounded-2xl border border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light dark:bg-claude-surface2-dark flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[13px] font-bold text-claude-text-light dark:text-white">Auto-launch Artifact Studio</div>
                      <div className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark mt-0.5">Automatically open side studio when generating code, HTML, or SVG.</div>
                    </div>
                    <div 
                      onClick={() => setForm({ ...form, autoOpenArtifacts: !(form.autoOpenArtifacts ?? true) })}
                      className="w-11 h-6 rounded-full p-[2px] transition-colors duration-200 cursor-pointer flex-shrink-0 flex items-center"
                      style={{ backgroundColor: (form.autoOpenArtifacts ?? true) ? '#D97757' : '#D5D2CA' }}
                    >
                      <motion.div 
                        layout
                        transition={{ type: "spring", stiffness: 500, damping: 30 }}
                        className={`w-5 h-5 rounded-full bg-white shadow-sm ${(form.autoOpenArtifacts ?? true) ? 'ml-auto' : 'mr-auto'}`}
                      />
                    </div>
                  </div>

                  <div className="p-4 rounded-2xl border border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light dark:bg-claude-surface2-dark flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[13px] font-bold text-claude-text-light dark:text-white">Interactive Preview Sandboxing</div>
                      <div className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark mt-0.5">Live execute HTML, SVG, and Tailwind previews inside a secure isolated iframe.</div>
                    </div>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10 px-2.5 py-1 rounded-md border border-emerald-200/50 dark:border-emerald-500/20">Active</span>
                  </div>
                </motion.div>
              )}

              {/* TAB 5: ACCOUNT & DATA */}
              {activeTab === 'data' && (
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-5">
                  <div className="p-4 rounded-2xl border border-claude-terracotta/20 bg-claude-terracotta/5 dark:bg-claude-terracotta/10 flex items-center justify-between">
                    <div>
                      <div className="text-xs uppercase font-bold tracking-wider text-claude-terracotta">Subscription Plan</div>
                      <div className="text-sm font-bold text-claude-text-light dark:text-white mt-0.5">Aira Pro (Claude 3.7 Extended Limits)</div>
                      <div className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark mt-0.5">200K token context window with hybrid reasoning.</div>
                    </div>
                    <span className="text-xs font-bold px-3 py-1 rounded-full bg-claude-terracotta text-white">Active</span>
                  </div>

                  <div className="pt-2">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-claude-muted-light dark:text-claude-muted-dark mb-3">Workspace Backup & Portability</div>
                    <div className="flex gap-3">
                      <motion.button 
                        whileHover={{ scale: 1.02 }} 
                        whileTap={{ scale: 0.98 }} 
                        onClick={exportData} 
                        className="flex-1 p-3 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark text-[13px] font-bold text-claude-text-light dark:text-white flex items-center justify-center gap-2 hover:border-claude-terracotta/50 transition-colors shadow-sm"
                      >
                        <Download className="w-4 h-4 text-claude-terracotta" />
                        <span>Export Data (JSON)</span>
                      </motion.button>
                      <motion.label 
                        whileHover={{ scale: 1.02 }} 
                        whileTap={{ scale: 0.98 }} 
                        className="flex-1 p-3 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark text-[13px] font-bold text-claude-text-light dark:text-white flex items-center justify-center gap-2 cursor-pointer hover:border-claude-terracotta/50 transition-colors shadow-sm"
                      >
                        <Upload className="w-4 h-4 text-claude-terracotta" />
                        <span>Import Backup</span>
                        <input type="file" accept=".json" onChange={importData} className="hidden" />
                      </motion.label>
                    </div>
                  </div>

                  <div className="pt-4 border-t border-claude-border-light dark:border-claude-border-dark">
                    <button 
                      onClick={() => { if (confirm('Reset all Aira local data, conversations, and projects?')) onClearAll(); }} 
                      className="text-xs font-bold text-red-500 hover:text-red-600 transition-colors block w-full text-center p-2 rounded-xl hover:bg-red-50 dark:hover:bg-red-500/10"
                    >
                      Reset all local workspace data
                    </button>
                  </div>
                </motion.div>
              )}
            </div>

            {/* Footer */}
            <footer data-testid="settings-footer" className="shrink-0 px-3 sm:px-7 py-2.5 sm:py-3.5 border-t border-claude-border-light dark:border-claude-border-dark flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3 bg-claude-surface2-light dark:bg-claude-surface2-dark" style={{ paddingBottom: 'max(0.625rem, env(safe-area-inset-bottom, 0px))' }}>
              <span className="block text-center sm:text-left text-[11px] font-medium tracking-tight text-claude-muted-light dark:text-claude-muted-dark">Product of Virexa AI Ventures</span>
              <div className="grid grid-cols-2 sm:flex sm:items-center gap-2 min-w-0">
                <button type="button" onClick={onClose} className="min-w-0 px-3 py-2.5 rounded-xl text-[13px] font-medium text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light dark:hover:text-white transition-colors">Cancel</button>
                <motion.button 
                  whileHover={{ scale: 1.02 }} 
                  whileTap={{ scale: 0.98 }} 
                  onClick={save} 
                  className="min-w-0 justify-center px-3 sm:px-5 py-2.5 rounded-xl bg-claude-terracotta text-white text-[13px] font-bold hover:bg-claude-terracotta-hover transition-colors flex items-center gap-1.5 shadow-sm"
                >
                  {saved && <Check className="w-4 h-4" />}{saved ? 'Preferences Saved' : 'Save Changes'}
                </motion.button>
              </div>
            </footer>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
