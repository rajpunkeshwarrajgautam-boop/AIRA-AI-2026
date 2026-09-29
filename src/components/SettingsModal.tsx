import React, { useState } from 'react';
import { Settings, X, Check, Download, Upload, Brain } from 'lucide-react';
import type { AppSettings, Conversation, Project } from '../types';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSaveSettings: (settings: AppSettings) => void;
  conversations: Conversation[];
  projects: Project[];
  onImportData: (data: { conversations: Conversation[]; projects: Project[] }) => void;
  onClearAll: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen, onClose, settings, onSaveSettings, conversations, projects, onImportData, onClearAll,
}) => {
  const [form, setForm] = useState<AppSettings>({ ...settings });
  const [saved, setSaved] = useState(false);
  if (!isOpen) return null;

  const save = () => {
    onSaveSettings(form);
    setSaved(true);
    setTimeout(() => { setSaved(false); onClose(); }, 500);
  };

  const exportData = () => {
    const blob = new Blob([JSON.stringify({ conversations, projects, settings: form }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'aira-workspace-backup.json'; a.click();
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

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-xl rounded-2xl border border-claude-border-light dark:border-claude-border-dark bg-claude-surface-light dark:bg-claude-surface-dark shadow-2xl overflow-hidden">
        <header className="px-6 py-4 border-b border-claude-border-light dark:border-claude-border-dark flex items-center justify-between">
          <div className="flex items-center gap-3"><div className="p-2 rounded-xl bg-claude-terracotta/10 text-claude-terracotta"><Settings className="w-5 h-5" /></div><div><h2 className="font-semibold">Aira Settings</h2><p className="text-xs text-claude-muted-light dark:text-claude-muted-dark">Workspace and intelligence preferences.</p></div></div>
          <button onClick={onClose} className="p-2"><X className="w-4 h-4" /></button>
        </header>
        <div className="p-6 space-y-5 max-h-[70vh] overflow-y-auto">
          <div>
            <label className="text-xs font-semibold">Your name</label>
            <input value={form.userName} onChange={e => setForm({ ...form, userName: e.target.value })} className="mt-1 w-full px-3.5 py-2.5 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark text-sm outline-none focus:border-claude-terracotta" />
          </div>
          <div>
            <label className="text-xs font-semibold">Appearance</label>
            <div className="grid grid-cols-3 gap-2 mt-2">
              {(['light','dark','system'] as const).map(theme => <button key={theme} onClick={() => setForm({ ...form, theme })} className={`p-2.5 rounded-xl border text-xs capitalize ${form.theme === theme ? 'border-claude-terracotta bg-claude-terracotta/10 text-claude-terracotta' : 'border-claude-border-light dark:border-claude-border-dark'}`}>{theme}</button>)}
            </div>
          </div>
          <div>
            <label className="text-xs font-semibold">Aesthetic system</label>
            <select value={form.aestheticPreset || 'linear-precision'} onChange={e => setForm({ ...form, aestheticPreset: e.target.value as AppSettings['aestheticPreset'] })} className="mt-1 w-full px-3.5 py-2.5 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark text-sm">
              <option value="linear-precision">Linear Precision</option><option value="default">Aira Light</option><option value="warm-parchment">Warm Parchment</option><option value="liquid-glass">Liquid Glass</option><option value="industrial-brutalist">Industrial Brutalist</option><option value="nordic-moss">Nordic Earth</option>
            </select>
          </div>
          <div className="p-4 rounded-xl border border-claude-border-light dark:border-claude-border-dark">
            <div className="flex items-center gap-2 mb-2"><Brain className="w-4 h-4 text-claude-terracotta" /><span className="text-xs font-semibold">Reasoning budget</span><span className="ml-auto text-xs font-mono text-claude-terracotta">{form.thinkingBudget} tokens</span></div>
            <input type="range" min="1024" max="16384" step="1024" value={form.thinkingBudget} onChange={e => setForm({ ...form, thinkingBudget: Number(e.target.value) })} className="w-full accent-claude-terracotta" />
          </div>
          <div>
            <label className="text-xs font-semibold">Custom instructions</label>
            <textarea rows={4} value={form.customInstructions} onChange={e => setForm({ ...form, customInstructions: e.target.value })} placeholder="How should Aira work with you?" className="mt-1 w-full px-3.5 py-2.5 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark text-sm outline-none focus:border-claude-terracotta" />
          </div>
          <div className="pt-4 border-t border-claude-border-light dark:border-claude-border-dark">
            <div className="text-xs font-semibold mb-2">Data portability</div>
            <div className="flex gap-2">
              <button onClick={exportData} className="flex-1 p-2.5 rounded-xl border border-claude-border-light dark:border-claude-border-dark text-xs flex items-center justify-center gap-2"><Download className="w-4 h-4" />Export</button>
              <label className="flex-1 p-2.5 rounded-xl border border-claude-border-light dark:border-claude-border-dark text-xs flex items-center justify-center gap-2 cursor-pointer"><Upload className="w-4 h-4" />Import<input type="file" accept=".json" onChange={importData} className="hidden" /></label>
            </div>
            <button onClick={() => { if (confirm('Reset all Aira local data?')) onClearAll(); }} className="mt-3 text-xs text-red-400">Reset local data</button>
          </div>
        </div>
        <footer className="px-6 py-4 border-t border-claude-border-light dark:border-claude-border-dark flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-xs">Cancel</button>
          <button onClick={save} className="px-4 py-2 rounded-xl bg-claude-terracotta text-white text-xs flex items-center gap-1.5">{saved && <Check className="w-3.5 h-3.5" />}{saved ? 'Saved' : 'Save preferences'}</button>
        </footer>
      </div>
    </div>
  );
};
