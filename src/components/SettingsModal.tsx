import React, { useEffect, useRef, useState } from 'react';
import { 
  Settings, 
  X, 
  Check, 
  Download, 
  Upload, 
  Brain, 
  User, 
  Sliders, 
  ShieldCheck,
  Palette,
  FileCode2,
  Database,
  CreditCard,
  Keyboard,
  Eye,
  Sparkles,
  Lock
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import type { AppSettings, Conversation, Project } from '../types';
import { AVAILABLE_MODELS } from '../utils/constants';
import { neonAuth } from '../lib/neonAuth';

export interface PresetTheme {
  id: NonNullable<AppSettings['aestheticPreset']>;
  name: string;
  badge: string;
  feature: string;
  swatches: [string, string, string];
}

export const PRESET_THEMES: PresetTheme[] = [
  {
    id: 'linear-precision',
    name: 'Claude Editorial',
    badge: 'Default',
    feature: 'Warm cream canvas, coral accents & editorial serif typography',
    swatches: ['#FAF9F5', '#181715', '#CC785C'],
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

export type SettingsTab = 'general' | 'reasoning' | 'memory' | 'instructions' | 'artifacts' | 'data';

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
  initialTab?: string;
  onOpenBilling?: () => void;
  onOpenPricing?: () => void;
  onOpenShortcuts?: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  onSaveSettings,
  conversations,
  projects,
  onImportData,
  onClearAll,
  onOpenMemoryVault,
  initialTab = 'general',
  onOpenBilling,
  onOpenPricing,
  onOpenShortcuts,
}) => {
  const resolveTab = (tab?: string): SettingsTab => {
    if (tab === 'appearance' || tab === 'accessibility') return 'general';
    if (tab === 'instructions' || tab === 'personalization') return 'instructions';
    if (tab === 'account' || tab === 'privacy' || tab === 'shortcuts') return 'data';
    if (tab === 'reasoning' || tab === 'memory' || tab === 'artifacts' || tab === 'data') return tab;
    return 'general';
  };

  const [activeTab, setActiveTab] = useState<SettingsTab>(() => resolveTab(initialTab));
  const [form, setForm] = useState<AppSettings>({ ...settings });
  const [saved, setSaved] = useState(false);
  const [currentUser, setCurrentUser] = useState(() => neonAuth.getCurrentUser());
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const closeHandler = useRef(onClose);

  useEffect(() => {
    closeHandler.current = onClose;
  }, [onClose]);

  const [viewport, setViewport] = useState(() => ({
    top: 0, 
    left: 0,
    width: typeof window === 'undefined' ? 1024 : window.innerWidth,
    height: typeof window === 'undefined' ? 768 : window.innerHeight,
  }));
  const compactHeight = viewport.height < 430;

  useEffect(() => {
    if (isOpen) {
      setForm({ ...settings });
      setActiveTab(resolveTab(initialTab));
      setCurrentUser(neonAuth.getCurrentUser());
    }
  }, [isOpen, initialTab, settings]);

  useEffect(() => {
    if (!isOpen) return;
    const visual = window.visualViewport;
    const measure = () => setViewport({
      top: visual?.offsetTop ?? 0,
      left: visual?.offsetLeft ?? 0,
      width: visual?.width ?? window.innerWidth,
      height: visual?.height ?? window.innerHeight,
    });
    measure();
    window.addEventListener('resize', measure);
    visual?.addEventListener('resize', measure);
    visual?.addEventListener('scroll', measure);
    requestAnimationFrame(() => closeButtonRef.current?.focus({ preventScroll: true }));

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeHandler.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const tabbable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href]'
      ) || []).filter(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
      if (!tabbable.length) return;
      const first = tabbable[0], last = tabbable[tabbable.length - 1];
      if (!dialogRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('resize', measure);
      visual?.removeEventListener('resize', measure);
      visual?.removeEventListener('scroll', measure);
      document.removeEventListener('keydown', handleKey);
    };
  }, [isOpen]);

  const save = () => {
    onSaveSettings(form);
    setSaved(true);
    setTimeout(() => {
      setSaved(false);
      onClose();
    }, 500);
  };

  const exportData = () => {
    const data = {
      conversations,
      projects,
      settings: form,
      exportedAt: new Date().toISOString(),
      version: '2026.1'
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; 
    a.download = `aira-workspace-${new Date().toISOString().slice(0, 10)}.json`; 
    a.click();
    URL.revokeObjectURL(url);
  };

  const importData = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; 
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const data = JSON.parse(String(ev.target?.result || '{}'));
        if (Array.isArray(data.conversations)) {
          onImportData({ conversations: data.conversations, projects: data.projects || [] });
        }
      } catch { 
        alert('Invalid Aira backup file.'); 
      }
    };
    reader.readAsText(file);
  };

  const tabs: Array<{ id: SettingsTab; label: string; icon: React.ReactNode }> = [
    { id: 'general', label: 'General & Appearance', icon: <Palette className="w-4 h-4" /> },
    { id: 'reasoning', label: 'Model & Reasoning', icon: <Brain className="w-4 h-4" /> },
    { id: 'memory', label: 'Agent Memory', icon: <Database className="w-4 h-4" /> },
    { id: 'instructions', label: 'Personalization', icon: <Sliders className="w-4 h-4" /> },
    { id: 'artifacts', label: 'Artifact Studio', icon: <FileCode2 className="w-4 h-4" /> },
    { id: 'data', label: 'Account & Privacy', icon: <ShieldCheck className="w-4 h-4" /> },
  ];

  return (
    <AnimatePresence>
      {isOpen && (
        <div 
          data-testid="settings-viewport"
          className="fixed z-[70] flex items-center justify-center p-2 sm:p-6 select-none"
          style={{ top: viewport.top, left: viewport.left, width: viewport.width, height: viewport.height }}
        >
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
            <header 
              data-testid="settings-header" 
              className="shrink-0 px-3 sm:px-7 py-3 sm:py-4 border-b border-claude-border-light dark:border-claude-border-dark flex items-start justify-between gap-2 bg-claude-surface2-light dark:bg-claude-surface2-dark"
            >
              <div className="flex min-w-0 items-start gap-2 sm:gap-3">
                <div className="shrink-0 p-2 rounded-xl bg-claude-terracotta/10 text-claude-accentInk">
                  <Settings className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <h2 id="aira-settings-title" className="font-bold text-base sm:text-lg tracking-tight leading-snug text-claude-text-light dark:text-white">
                    Workspace Settings
                  </h2>
                  <p className="text-[11px] font-medium text-claude-muted-light dark:text-claude-muted-dark">
                    Preferences, intelligence, accessibility, and account management
                  </p>
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

            {/* Mobile section dropdown (strict 6 options for responsive tests) */}
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

            {/* Desktop Tab Strip (strict 6 tabs) */}
            <div role="tablist" aria-label="Settings categories" data-testid="settings-desktop-tabs" className="hidden sm:flex shrink-0 border-b border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light/60 dark:bg-claude-surface2-dark/60 px-5 sm:px-7 overflow-x-auto gap-1 pt-2">
              {tabs.map(tab => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  id={`aira-settings-tab-${tab.id}`} data-testid={`settings-tab-${tab.id}`}
                  aria-controls="aira-settings-panel"
                  className={`shrink-0 flex items-center gap-2 px-3 py-2.5 text-xs font-semibold rounded-t-xl transition-all border-b-2 whitespace-nowrap ${
                    activeTab === tab.id
                      ? 'border-claude-terracotta text-claude-accentInk bg-claude-surface-light dark:bg-claude-surface-dark shadow-[0_-2px_10px_-4px_rgba(0,0,0,0.03)]'
                      : 'border-transparent text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light dark:hover:text-white'
                  }`}
                >
                  {tab.icon}
                  <span>{tab.label}</span>
                </button>
              ))}
            </div>

            {/* Tab Body */}
            <div id="aira-settings-panel" data-testid="settings-content" className={`min-w-0 p-3 sm:p-7 space-y-6 bg-transparent ${compactHeight ? 'shrink-0' : 'min-h-0 flex-1 overflow-y-auto overscroll-contain'}`}>
              
              {/* TAB 1: GENERAL & APPEARANCE */}
              {activeTab === 'general' && (
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
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
                              ? 'border-claude-terracotta bg-claude-terracotta text-claude-onAccent shadow-sm' 
                              : 'border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light dark:bg-claude-surface2-dark text-claude-muted-light dark:text-claude-muted-dark hover:border-claude-terracotta/40'
                          }`}
                        >
                          {theme}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 8 Aesthetic Presets */}
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <label className="text-[11px] font-bold uppercase tracking-wider text-claude-muted-light dark:text-claude-muted-dark block">
                        Aesthetic Preset & Visual System
                      </label>
                      <span className="text-[10px] font-semibold text-claude-accentInk bg-claude-terracotta/10 px-2 py-0.5 rounded-full">
                        8 Curated Systems
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      {PRESET_THEMES.map(preset => {
                        const isSelected = (form.aestheticPreset || 'linear-precision') === preset.id;
                        return (
                          <motion.button
                            key={preset.id}
                            type="button"
                            whileHover={{ scale: 1.01 }}
                            whileTap={{ scale: 0.99 }}
                            onClick={() => {
                              setForm({ ...form, aestheticPreset: preset.id });
                              onSaveSettings({ ...settings, ...form, aestheticPreset: preset.id });
                            }}
                            className={`p-3 rounded-2xl border text-left transition-all relative overflow-hidden flex flex-col justify-between ${
                              isSelected
                                ? 'border-claude-terracotta bg-claude-terracotta/5 dark:bg-claude-terracotta/10 shadow-sm ring-1 ring-claude-terracotta'
                                : 'border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light dark:bg-claude-surface2-dark/60 hover:border-claude-terracotta/40'
                            }`}
                          >
                            <div className="flex items-start justify-between gap-2 mb-2">
                              <div>
                                <div className="text-[13px] font-bold text-claude-text-light dark:text-white flex items-center gap-1.5">
                                  <span>{preset.name}</span>
                                  {isSelected && <Check className="w-3.5 h-3.5 text-claude-terracotta" />}
                                </div>
                                <span className="text-[9px] font-extrabold uppercase tracking-wider text-claude-accentInk">
                                  {preset.badge}
                                </span>
                              </div>
                              <div className="flex items-center -space-x-1.5 shrink-0 p-1 rounded-lg bg-black/5 dark:bg-white/5 border border-black/5 dark:border-white/5">
                                {preset.swatches.map((color, idx) => (
                                  <span
                                    key={idx}
                                    className="w-3.5 h-3.5 rounded-full border border-white/60 dark:border-black/60 shadow-xs"
                                    style={{ backgroundColor: color }}
                                  />
                                ))}
                              </div>
                            </div>
                            <p className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark leading-snug">
                              {preset.feature}
                            </p>
                          </motion.button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Accessibility Section within General */}
                  <div className="p-4 rounded-xl border border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light/40 dark:bg-claude-surface2-dark/40 space-y-4">
                    <div className="flex items-center gap-2">
                      <Eye className="w-4 h-4 text-claude-accentInk" />
                      <span className="text-xs font-bold uppercase tracking-wider text-claude-text-light dark:text-white">
                        Accessibility & Motion
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="text-[10px] font-bold uppercase text-claude-muted-light block mb-1">Reduced Motion</label>
                        <select
                          aria-label="Reduced Motion" value={form.reducedMotion || 'system'}
                          onChange={e => setForm({ ...form, reducedMotion: e.target.value as any })}
                          className="w-full px-3 py-2 rounded-lg bg-claude-surface-light dark:bg-black/20 border border-claude-border-light dark:border-claude-border-dark text-xs font-medium"
                        >
                          <option value="system">Follow System</option>
                          <option value="always">Reduce Motion</option>
                          <option value="never">Full Animations</option>
                        </select>
                      </div>

                      <div>
                        <label className="text-[10px] font-bold uppercase text-claude-muted-light block mb-1">Font Scale</label>
                        <select
                          aria-label="Font Scale" value={form.fontSize || 'base'}
                          onChange={e => setForm({ ...form, fontSize: e.target.value as any })}
                          className="w-full px-3 py-2 rounded-lg bg-claude-surface-light dark:bg-black/20 border border-claude-border-light dark:border-claude-border-dark text-xs font-medium"
                        >
                          <option value="sm">Compact (13px)</option>
                          <option value="base">Standard (14px)</option>
                          <option value="lg">Large (16px)</option>
                        </select>
                      </div>
                    </div>

                    <div className="flex items-center justify-between pt-2 border-t border-claude-border-light/60 dark:border-claude-border-dark/60">
                      <div>
                        <div className="text-xs font-bold text-claude-text-light dark:text-white">High Contrast Outlines</div>
                        <div className="text-[10px] text-claude-muted-light">Enhance contrast ratios for borders and focus indicators.</div>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          checked={form.highContrast === true}
                          onChange={e => setForm({ ...form, highContrast: e.target.checked })}
                          className="sr-only peer"
                        />
                        <div className="w-9 h-5 bg-claude-surface2-light dark:bg-white/20 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-claude-terracotta"></div>
                      </label>
                    </div>
                  </div>
                </motion.div>
              )}

              {/* TAB 2: MODEL & REASONING */}
              {activeTab === 'reasoning' && (
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-5">
                  <div>
                    <label htmlFor="aira-settings-default-model" className="text-[11px] font-bold uppercase tracking-wider text-claude-muted-light dark:text-claude-muted-dark block mb-2">Default Model</label>
                    <select
                      id="aira-settings-default-model"
                      value={form.activeModel}
                      onChange={e => setForm({ ...form, activeModel: e.target.value as any })}
                      className="w-full px-4 py-3 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark text-[13px] font-semibold text-claude-text-light dark:text-white outline-none focus:border-claude-terracotta transition-all"
                    >
                      {AVAILABLE_MODELS.map(m => (
                        <option key={m.id} value={m.id}>
                          {m.name} ({m.badge}) - {m.description}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="p-4 rounded-xl border border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light/40 dark:bg-claude-surface2-dark/40 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-xs font-bold text-claude-text-light dark:text-white">Extended Thinking by Default</div>
                        <div className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark mt-0.5">Permits models to output step-by-step reasoning tokens before responding.</div>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          checked={form.extendedThinking}
                          onChange={e => setForm({ ...form, extendedThinking: e.target.checked })}
                          className="sr-only peer"
                        />
                        <div className="w-11 h-6 bg-claude-surface2-light dark:bg-white/20 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-claude-terracotta"></div>
                      </label>
                    </div>

                    {form.extendedThinking && (
                      <div className="pt-2 border-t border-claude-border-light/60 dark:border-claude-border-dark/60">
                        <div className="flex justify-between text-xs font-bold mb-1">
                          <span className="text-claude-muted-light dark:text-claude-muted-dark">Reasoning Token Budget</span>
                          <span className="text-claude-accentInk font-mono">{form.thinkingBudget.toLocaleString()} tokens</span>
                        </div>
                        <input
                          type="range"
                          min={1024}
                          max={64000}
                          step={1024}
                          value={form.thinkingBudget}
                          onChange={e => setForm({ ...form, thinkingBudget: Number(e.target.value) })}
                          className="w-full accent-claude-terracotta cursor-pointer"
                        />
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="text-[11px] font-bold uppercase tracking-wider text-claude-muted-light dark:text-claude-muted-dark block mb-2">Response Style</label>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {[
                        { id: 'normal', label: 'Balanced & Adaptive' },
                        { id: 'concise', label: 'Concise & Direct' },
                        { id: 'explanatory', label: 'Detailed & Pedagogical' },
                        { id: 'academic', label: 'Academic & Rigorous' },
                        { id: 'code-first', label: 'Code-First & Dense' },
                      ].map(style => (
                        <button
                          key={style.id}
                          type="button"
                          onClick={() => setForm({ ...form, responseStyle: style.id as any })}
                          className={`p-2.5 rounded-xl border text-xs font-semibold text-left transition-all ${
                            form.responseStyle === style.id
                              ? 'border-claude-terracotta bg-claude-terracotta/10 text-claude-accentInk'
                              : 'border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light dark:bg-claude-surface2-dark text-claude-muted-light hover:border-claude-terracotta/40'
                          }`}
                        >
                          {style.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </motion.div>
              )}

              {/* TAB 3: AGENT MEMORY */}
              {activeTab === 'memory' && (
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-5">
                  <div className="p-4 rounded-xl border border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light/40 dark:bg-claude-surface2-dark/40 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-xs font-bold text-claude-text-light dark:text-white">Cross-Conversation Memory</div>
                        <div className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark mt-0.5">Retain architectural decisions and preferences across separate sessions.</div>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          checked={form.persistentMemoryEnabled !== false}
                          onChange={e => setForm({ ...form, persistentMemoryEnabled: e.target.checked })}
                          className="sr-only peer"
                        />
                        <div className="w-11 h-6 bg-claude-surface2-light dark:bg-white/20 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-claude-terracotta"></div>
                      </label>
                    </div>

                    <div className="flex items-center justify-between pt-2 border-t border-claude-border-light/60 dark:border-claude-border-dark/60">
                      <div>
                        <div className="text-xs font-bold text-claude-text-light dark:text-white">Automatic Privacy Scrubbing</div>
                        <div className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark mt-0.5">Filter API keys and secrets before saving memory items.</div>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          checked={form.privacyScrubbing !== false}
                          onChange={e => setForm({ ...form, privacyScrubbing: e.target.checked })}
                          className="sr-only peer"
                        />
                        <div className="w-9 h-5 bg-claude-surface2-light dark:bg-white/20 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-claude-terracotta"></div>
                      </label>
                    </div>

                    {onOpenMemoryVault && (
                      <div className="pt-2 border-t border-claude-border-light/60 dark:border-claude-border-dark/60 flex items-center justify-between">
                        <span className="text-[11px] text-claude-muted-light">Inspect, search, and edit saved memory items:</span>
                        <button
                          type="button"
                          onClick={() => {
                            onClose();
                            onOpenMemoryVault();
                          }}
                          className="px-3 py-1.5 rounded-lg bg-claude-terracotta/10 hover:bg-claude-terracotta/20 text-claude-accentInk font-bold text-xs transition-colors"
                        >
                          Open Memory Vault
                        </button>
                      </div>
                    )}
                  </div>
                </motion.div>
              )}

              {/* TAB 4: PERSONALIZATION & INSTRUCTIONS */}
              {activeTab === 'instructions' && (
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-5">
                  <div>
                    <label htmlFor="aira-settings-instructions" className="text-[11px] font-bold uppercase tracking-wider text-claude-muted-light dark:text-claude-muted-dark block mb-2">Custom System Directives</label>
                    <textarea 
                      id="aira-settings-instructions"
                      rows={5}
                      value={form.customInstructions} 
                      onChange={e => setForm({ ...form, customInstructions: e.target.value })} 
                      placeholder="Directives injected into the top of every conversation context (e.g., prefer functional TypeScript, provide mathematical proof where applicable)..." 
                      className="w-full px-4 py-3 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark text-[13px] font-mono outline-none focus:border-claude-terracotta transition-all resize-none" 
                    />
                  </div>

                  <div>
                    <label htmlFor="aira-settings-bio" className="text-[11px] font-bold uppercase tracking-wider text-claude-muted-light dark:text-claude-muted-dark block mb-2">User Context & Bio</label>
                    <textarea 
                      id="aira-settings-bio"
                      rows={3}
                      value={form.userBio || ''} 
                      onChange={e => setForm({ ...form, userBio: e.target.value })} 
                      placeholder="e.g. Senior Principal Architect specializing in distributed systems and React 19."
                      className="w-full px-4 py-3 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark text-[13px] font-medium outline-none focus:border-claude-terracotta transition-all resize-none" 
                    />
                  </div>
                </motion.div>
              )}

              {/* TAB 5: ARTIFACT STUDIO */}
              {activeTab === 'artifacts' && (
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-5">
                  <div className="p-4 rounded-xl border border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light/40 dark:bg-claude-surface2-dark/40 flex items-center justify-between">
                    <div>
                      <div className="text-xs font-bold text-claude-text-light dark:text-white">Auto-Open Artifact Studio</div>
                      <div className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark mt-0.5">Automatically open the side canvas when an interactive code artifact or diagram is generated.</div>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={form.autoOpenArtifacts !== false}
                        onChange={e => setForm({ ...form, autoOpenArtifacts: e.target.checked })}
                        className="sr-only peer"
                      />
                      <div className="w-11 h-6 bg-claude-surface2-light dark:bg-white/20 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-claude-terracotta"></div>
                    </label>
                  </div>

                  <div className="p-4 rounded-xl border border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light/40 dark:bg-claude-surface2-dark/40 flex items-center justify-between">
                    <div>
                      <div className="text-xs font-bold text-claude-text-light dark:text-white">Interactive Sandbox Runtime</div>
                      <div className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark mt-0.5">Live execute HTML, SVG, and Tailwind previews inside a secure isolated iframe.</div>
                    </div>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10 px-2.5 py-1 rounded-md border border-emerald-200/50 dark:border-emerald-500/20">Active</span>
                  </div>
                </motion.div>
              )}

              {/* TAB 6: ACCOUNT & PRIVACY DATA */}
              {activeTab === 'data' && (
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-5">
                  {/* Account / Subscription Banner */}
                  <div className="p-4 rounded-2xl border border-claude-terracotta/20 bg-claude-terracotta/5 dark:bg-claude-terracotta/10 flex items-center justify-between">
                    <div>
                      <div className="text-xs uppercase font-bold tracking-wider text-claude-accentInk">
                        {currentUser ? 'Authenticated Profile' : 'Subscription Plan'}
                      </div>
                      <div className="text-sm font-bold text-claude-text-light dark:text-white mt-0.5">
                        {currentUser ? `${currentUser.name || 'User'} (Aira Pro Workspace)` : 'Aira Pro (Multi-Model Extended Intelligence)'}
                      </div>
                      <div className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark mt-0.5">
                        {currentUser ? currentUser.email : '200K token context window with hybrid reasoning.'}
                      </div>
                    </div>
                    <span className="text-xs font-bold px-3 py-1 rounded-full bg-claude-terracotta text-claude-onAccent">Active</span>
                  </div>

                  {/* Actions for Billing & Pricing */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {onOpenBilling && (
                      <button
                        type="button"
                        onClick={() => {
                          onClose();
                          onOpenBilling();
                        }}
                        className="p-3 rounded-xl border border-claude-border-light dark:border-white/10 bg-claude-surface2-light dark:bg-white/5 hover:border-claude-terracotta/50 text-left transition-colors flex items-center gap-2.5"
                      >
                        <CreditCard className="w-4 h-4 text-claude-accentInk shrink-0" />
                        <div>
                          <div className="text-xs font-bold text-claude-text-light dark:text-white">Account & Billing</div>
                          <div className="text-[10px] text-claude-muted-light">Usage, quotas & top-ups</div>
                        </div>
                      </button>
                    )}

                    {onOpenPricing && (
                      <button
                        type="button"
                        onClick={() => {
                          onClose();
                          onOpenPricing();
                        }}
                        className="p-3 rounded-xl border border-claude-border-light dark:border-white/10 bg-claude-surface2-light dark:bg-white/5 hover:border-claude-terracotta/50 text-left transition-colors flex items-center gap-2.5"
                      >
                        <Sparkles className="w-4 h-4 text-claude-accentInk shrink-0" />
                        <div>
                          <div className="text-xs font-bold text-claude-text-light dark:text-white">Upgrade Plan</div>
                          <div className="text-[10px] text-claude-muted-light">Compare Free, Pro & Enterprise</div>
                        </div>
                      </button>
                    )}
                  </div>

                  {/* Privacy Controls */}
                  <div className="p-4 rounded-xl border border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light/40 dark:bg-claude-surface2-dark/40 flex items-center justify-between">
                    <div>
                      <div className="text-xs font-bold text-claude-text-light dark:text-white">Telemetry Opt-Out</div>
                      <div className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark mt-0.5">Disable all anonymous client diagnostic telemetry.</div>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={form.telemetryOptOut === true}
                        onChange={e => setForm({ ...form, telemetryOptOut: e.target.checked })}
                        className="sr-only peer"
                      />
                      <div className="w-9 h-5 bg-claude-surface2-light dark:bg-white/20 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-claude-terracotta"></div>
                    </label>
                  </div>

                  {/* Backup & Portability */}
                  <div className="pt-2">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-claude-muted-light dark:text-claude-muted-dark mb-3">Workspace Backup & Portability</div>
                    <div className="flex gap-3">
                      <motion.button 
                        whileHover={{ scale: 1.02 }} 
                        whileTap={{ scale: 0.98 }} 
                        onClick={exportData} 
                        className="flex-1 p-3 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark text-[13px] font-bold text-claude-text-light dark:text-white flex items-center justify-center gap-2 hover:border-claude-terracotta/50 transition-colors shadow-sm"
                      >
                        <Download className="w-4 h-4 text-claude-accentInk" />
                        <span>Export Data (JSON)</span>
                      </motion.button>
                      <motion.label 
                        whileHover={{ scale: 1.02 }} 
                        whileTap={{ scale: 0.98 }} 
                        className="flex-1 p-3 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark text-[13px] font-bold text-claude-text-light dark:text-white flex items-center justify-center gap-2 cursor-pointer hover:border-claude-terracotta/50 transition-colors shadow-sm"
                      >
                        <Upload className="w-4 h-4 text-claude-accentInk" />
                        <span>Import Backup</span>
                        <input type="file" accept=".json" onChange={importData} className="hidden" />
                      </motion.label>
                    </div>
                  </div>

                  {/* Quick Shortcuts Trigger */}
                  {onOpenShortcuts && (
                    <div className="p-3 rounded-xl border border-claude-border-light/60 dark:border-claude-border-dark/60 bg-claude-surface2-light/20 dark:bg-white/[0.01] flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <Keyboard className="w-4 h-4 text-claude-accentInk" />
                        <span className="font-medium text-claude-text-light dark:text-white">Keyboard Shortcuts Map</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          onClose();
                          onOpenShortcuts();
                        }}
                        className="text-claude-accentInk font-bold hover:underline"
                      >
                        View Table
                      </button>
                    </div>
                  )}

                  <div className="pt-4 border-t border-claude-border-light dark:border-claude-border-dark">
                    <button 
                      onClick={() => { if (confirm('Reset all Aira local data, conversations, and projects from this browser? (Local device data only; does not affect server-side accounts)')) onClearAll(); }} 
                      className="text-xs font-bold text-red-500 hover:text-red-600 transition-colors block w-full text-center p-2 rounded-xl hover:bg-red-50 dark:hover:bg-red-500/10"
                    >
                      Reset all local workspace data (This device only)
                    </button>
                  </div>
                </motion.div>
              )}
            </div>

            {/* Footer */}
            <footer 
              data-testid="settings-footer" 
              className="shrink-0 px-3 sm:px-7 py-2.5 sm:py-3.5 border-t border-claude-border-light dark:border-claude-border-dark flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3 bg-claude-surface2-light dark:bg-claude-surface2-dark" 
              style={{ paddingBottom: 'max(0.625rem, env(safe-area-inset-bottom, 0px))' }}
            >
              <span className="block text-center sm:text-left text-[11px] font-medium tracking-tight text-claude-muted-light dark:text-claude-muted-dark">
                Product of Virexa AI Ventures
              </span>
              <div className="grid grid-cols-2 sm:flex sm:items-center gap-2 min-w-0">
                <button 
                  type="button" 
                  onClick={onClose} 
                  className="min-w-0 px-3 py-2.5 rounded-xl text-[13px] font-medium text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light dark:hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <motion.button 
                  whileHover={{ scale: 1.02 }} 
                  whileTap={{ scale: 0.98 }} 
                  onClick={save}
                  data-testid="settings-save"
                  className="min-w-0 justify-center px-3 sm:px-5 py-2.5 rounded-xl bg-claude-terracotta text-claude-onAccent text-[13px] font-bold hover:bg-claude-terracotta-hover transition-colors flex items-center gap-1.5 shadow-sm"
                >
                  {saved && <Check className="w-4 h-4" />}
                  {saved ? 'Preferences Saved' : 'Save Changes'}
                </motion.button>
              </div>
            </footer>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
