import React, { useState, useMemo, useRef, useSyncExternalStore } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Brain,
  Search,
  Plus,
  Trash2,
  Download,
  Upload,
  Pin,
  ShieldCheck,
  Zap,
  Layers,
  Sparkles,
  ExternalLink,
  X,
} from 'lucide-react';
import type { MemoryItem, MemoryTier } from '../types';
import { agentMemory } from '../utils/agentMemoryEngine';

interface MemoryVaultModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const MemoryVaultModal: React.FC<MemoryVaultModalProps> = ({ isOpen, onClose }) => {
  const [activeTier, setActiveTier] = useState<MemoryTier | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // New Memory Form State
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [newTier, setNewTier] = useState<MemoryTier>('semantic');
  const [newCategory, setNewCategory] = useState<MemoryItem['category']>('preference');
  const [newTags, setNewTags] = useState('');
  const [isNewPinned, setIsNewPinned] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Subscribe to persistent memory engine mutations with stable snapshot
  const rawVault = useSyncExternalStore(
    agentMemory.subscribe,
    agentMemory.getSnapshot
  );

  const memories = useMemo(() => {
    if (!isOpen) return [];
    if (searchQuery.trim()) {
      return agentMemory.recall({
        query: searchQuery,
        tiers: activeTier === 'all' ? undefined : [activeTier],
        limit: 50,
        minScore: 0.05,
      });
    }
    return activeTier === 'all' ? rawVault : rawVault.filter(m => m.tier === activeTier);
  }, [isOpen, activeTier, searchQuery, rawVault]);

  const stats = agentMemory.getStats();

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  const handleCreateMemory = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newContent.trim()) return;

    try {
      const tagsArray = newTags
        .split(',')
        .map(t => t.trim())
        .filter(Boolean);

      agentMemory.remember(newContent, {
        title: newTitle || undefined,
        tier: newTier,
        category: newCategory,
        tags: tagsArray.length > 0 ? tagsArray : undefined,
        isPinned: isNewPinned,
      });

      setNewTitle('');
      setNewContent('');
      setNewTags('');
      setIsNewPinned(false);
      setIsAdding(false);
      showToast('Memory committed to persistent vault.');
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'Failed to save memory.');
    }
  };

  const handleDelete = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    agentMemory.forget(id);
    showToast('Memory removed.');
  };

  const handleTogglePin = (id: string, currentPin: boolean, e: React.MouseEvent) => {
    e.stopPropagation();
    agentMemory.update(id, { isPinned: !currentPin });
  };

  const handleExport = () => {
    const jsonStr = agentMemory.exportVault();
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `aira-agentmemory-vault-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Vault exported to JSON.');
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = evt => {
      const content = evt.target?.result as string;
      const res = agentMemory.importVault(content);
      showToast(`Imported ${res.imported} memories (${res.errors} skipped).`);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handlePurgeUnpinned = () => {
    if (confirm('Purge all unpinned memories in this tier? Pinned memories will be preserved.')) {
      const count = agentMemory.purge(activeTier === 'all' ? undefined : activeTier, true);
      showToast(`Purged ${count} unpinned memories.`);
    }
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 select-none">
        {/* Backdrop */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="fixed inset-0 bg-black/60 backdrop-blur-md transition-opacity"
        />

        {/* Modal Window */}
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 16 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 16 }}
          transition={{ type: 'spring', stiffness: 350, damping: 28 }}
          className="relative w-full max-w-4xl max-h-[88vh] flex flex-col rounded-2xl bg-claude-surface-light dark:bg-[#1C1B19] border border-claude-border-light dark:border-claude-border-dark shadow-2xl overflow-hidden z-10 font-sans"
        >
          {/* Header */}
          <div className="p-5 border-b border-claude-border-light dark:border-claude-border-dark flex items-center justify-between bg-claude-surface2-light/60 dark:bg-black/20">
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 rounded-xl bg-claude-terracotta/10 border border-claude-terracotta/30 flex items-center justify-center text-claude-accentInk shadow-sm">
                <Brain className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center space-x-2">
                  <h2 className="font-serif text-xl font-medium tracking-tight text-claude-text-light dark:text-white">
                    Agent Persistent Memory
                  </h2>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-mono tracking-wide uppercase bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                    4-Tier Vault
                  </span>
                </div>
                <p className="text-xs text-claude-muted-light dark:text-claude-muted-dark">
                  Cross-session persistent context engine inspired by rohitg00/agentmemory benchmarks.
                </p>
              </div>
            </div>

            <div className="flex items-center space-x-2">
              <button
                onClick={() => setIsAdding(!isAdding)}
                className={`px-3 py-1.5 rounded-xl text-xs font-medium flex items-center space-x-1.5 transition-all shadow-sm ${
                  isAdding
                    ? 'bg-claude-surface2-light dark:bg-stone-800 text-claude-text-light dark:text-white'
                    : 'bg-claude-terracotta text-claude-onAccent hover:bg-claude-terracotta-hover active:scale-95'
                }`}
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{isAdding ? 'Cancel' : 'Add Memory'}</span>
              </button>

              <button
                onClick={onClose}
                className="p-2 rounded-xl text-claude-muted-light dark:text-claude-muted-dark hover:bg-claude-surface2-light dark:hover:bg-stone-800 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Telemetry & Controls Ribbon */}
          <div className="px-5 py-3 border-b border-claude-border-light dark:border-claude-border-dark flex flex-wrap items-center justify-between gap-3 text-xs bg-claude-surface-light dark:bg-[#181716]">
            {/* Stats Metrics */}
            <div className="flex items-center space-x-4 text-claude-muted-light dark:text-stone-400 font-mono text-[11px]">
              <span className="flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-claude-accentInk" />
                <strong>{stats.totalCount}</strong> Memories
              </span>
              <span className="hidden sm:inline-flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-amber-500" />
                <strong>~{stats.tokensSavedEstimate}</strong> Tokens Saved
              </span>
              <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                <ShieldCheck className="w-3.5 h-3.5" />
                Privacy Scrubber Active
              </span>
            </div>

            {/* Quick Actions */}
            <div className="flex items-center space-x-1.5">
              <input
                ref={fileInputRef}
                type="file"
                accept=".json"
                onChange={handleImportFile}
                className="hidden"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-2.5 py-1 rounded-lg border border-claude-border-light dark:border-stone-800 text-claude-muted-light dark:text-stone-400 hover:text-claude-text-light dark:hover:text-white transition-colors flex items-center gap-1"
                title="Import memories from JSON file"
              >
                <Upload className="w-3 h-3" />
                <span>Import</span>
              </button>
              <button
                onClick={handleExport}
                className="px-2.5 py-1 rounded-lg border border-claude-border-light dark:border-stone-800 text-claude-muted-light dark:text-stone-400 hover:text-claude-text-light dark:hover:text-white transition-colors flex items-center gap-1"
                title="Export vault to JSON file"
              >
                <Download className="w-3 h-3" />
                <span>Export</span>
              </button>
              <button
                onClick={handlePurgeUnpinned}
                className="px-2.5 py-1 rounded-lg border border-claude-border-light dark:border-stone-800 text-rose-500 hover:bg-rose-500/10 transition-colors flex items-center gap-1"
                title="Purge unpinned memories in current view"
              >
                <Trash2 className="w-3 h-3" />
                <span>Purge</span>
              </button>
            </div>
          </div>

          {/* Inline Add Memory Form */}
          <AnimatePresence>
            {isAdding && (
              <motion.form
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                onSubmit={handleCreateMemory}
                className="p-5 border-b border-claude-border-light dark:border-claude-border-dark bg-claude-surface2-light/40 dark:bg-black/30 space-y-3 overflow-hidden"
              >
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold text-claude-muted-light dark:text-stone-400 mb-1">
                      Tier
                    </label>
                    <select
                      value={newTier}
                      onChange={e => setNewTier(e.target.value as MemoryTier)}
                      className="w-full text-xs p-2 rounded-xl bg-claude-surface-light dark:bg-stone-900 border border-claude-border-light dark:border-stone-800 text-claude-text-light dark:text-white focus:outline-none focus:border-claude-terracotta"
                    >
                      <option value="semantic">Semantic (Knowledge & Decisions)</option>
                      <option value="procedural">Procedural (Workflows & Commands)</option>
                      <option value="episodic">Episodic (Task History & Events)</option>
                      <option value="working">Working (Active Session Scratchpad)</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-claude-muted-light dark:text-stone-400 mb-1">
                      Category
                    </label>
                    <select
                      value={newCategory}
                      onChange={e => setNewCategory(e.target.value as MemoryItem['category'])}
                      className="w-full text-xs p-2 rounded-xl bg-claude-surface-light dark:bg-stone-900 border border-claude-border-light dark:border-stone-800 text-claude-text-light dark:text-white focus:outline-none focus:border-claude-terracotta"
                    >
                      <option value="preference">User Preference</option>
                      <option value="architecture">Architecture Rule</option>
                      <option value="decision">Technical Decision</option>
                      <option value="workflow">Workflow & Recipe</option>
                      <option value="bugfix">Bugfix Lesson</option>
                      <option value="general">General Memory</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-claude-muted-light dark:text-stone-400 mb-1">
                      Tags (comma separated)
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. react, api, lint"
                      value={newTags}
                      onChange={e => setNewTags(e.target.value)}
                      className="w-full text-xs p-2 rounded-xl bg-claude-surface-light dark:bg-stone-900 border border-claude-border-light dark:border-stone-800 text-claude-text-light dark:text-white focus:outline-none focus:border-claude-terracotta"
                    />
                  </div>
                </div>

                <div>
                  <input
                    type="text"
                    placeholder="Memory title (e.g. API Schema Strict Typing Convention)"
                    value={newTitle}
                    onChange={e => setNewTitle(e.target.value)}
                    className="w-full text-xs p-2.5 rounded-xl bg-claude-surface-light dark:bg-stone-900 border border-claude-border-light dark:border-stone-800 text-claude-text-light dark:text-white focus:outline-none focus:border-claude-terracotta mb-2"
                  />
                  <textarea
                    rows={3}
                    placeholder="Enter the persistent memory content. (Sensitive keys like sk-... will be automatically scrubbed for security)"
                    value={newContent}
                    onChange={e => setNewContent(e.target.value)}
                    required
                    className="w-full text-xs p-2.5 rounded-xl bg-claude-surface-light dark:bg-stone-900 border border-claude-border-light dark:border-stone-800 text-claude-text-light dark:text-white focus:outline-none focus:border-claude-terracotta resize-none"
                  />
                </div>

                <div className="flex items-center justify-between">
                  <label className="flex items-center space-x-2 text-xs text-claude-muted-light dark:text-stone-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={isNewPinned}
                      onChange={e => setIsNewPinned(e.target.checked)}
                      className="rounded text-claude-accentInk focus:ring-0"
                    />
                    <span>Pin memory (permanent high retrieval priority)</span>
                  </label>

                  <div className="flex items-center space-x-2">
                    <button
                      type="button"
                      onClick={() => setIsAdding(false)}
                      className="px-3 py-1.5 rounded-xl text-xs text-claude-muted-light dark:text-stone-400 hover:text-white"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="px-4 py-1.5 rounded-xl text-xs font-medium bg-claude-terracotta text-claude-onAccent hover:bg-claude-terracotta-hover shadow-sm"
                    >
                      Commit Memory
                    </button>
                  </div>
                </div>
              </motion.form>
            )}
          </AnimatePresence>

          {/* Search & Tier Filters */}
          <div className="p-4 border-b border-claude-border-light dark:border-claude-border-dark flex flex-col sm:flex-row items-center gap-3">
            {/* Search Input */}
            <div className="relative flex-1 w-full">
              <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-claude-muted-light dark:text-stone-400" />
              <input
                type="text"
                placeholder="Hybrid search memory (BM25 + semantic similarity)..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2 text-xs rounded-xl bg-claude-surface2-light dark:bg-stone-900 border border-claude-border-light dark:border-stone-800 placeholder-claude-muted-light dark:placeholder-stone-500 text-claude-text-light dark:text-white focus:outline-none focus:border-claude-terracotta"
              />
            </div>

            {/* Tier Segmented Tabs */}
            <div className="flex items-center p-1 rounded-xl bg-claude-surface2-light dark:bg-stone-900 border border-claude-border-light dark:border-stone-800 text-[11px] font-medium w-full sm:w-auto overflow-x-auto">
              {(['all', 'semantic', 'procedural', 'episodic', 'working'] as const).map(tier => (
                <button
                  key={tier}
                  onClick={() => setActiveTier(tier)}
                  className={`px-3 py-1 rounded-lg capitalize whitespace-nowrap transition-all ${
                    activeTier === tier
                      ? 'bg-claude-surface-light dark:bg-stone-800 text-claude-text-light dark:text-white font-semibold shadow-sm'
                      : 'text-claude-muted-light dark:text-stone-400 hover:text-claude-text-light dark:hover:text-white'
                  }`}
                >
                  {tier}
                </button>
              ))}
            </div>
          </div>

          {/* Memory List Area */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {memories.length === 0 ? (
              <div className="py-16 text-center text-claude-muted-light dark:text-stone-500">
                <Brain className="w-10 h-10 mx-auto mb-3 opacity-30 text-claude-accentInk" />
                <p className="text-sm font-medium">No persistent memories found.</p>
                <p className="text-xs mt-1 max-w-sm mx-auto">
                  {searchQuery
                    ? `No memories matched "${searchQuery}". Try different keywords.`
                    : 'Teach Aira conventions using the Add Memory button, or chat naturally to allow auto-consolidation.'}
                </p>
              </div>
            ) : (
              memories.map(mem => {
                const tierColor =
                  mem.tier === 'semantic'
                    ? 'text-amber-500 bg-amber-500/10 border-amber-500/20'
                    : mem.tier === 'procedural'
                    ? 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20'
                    : mem.tier === 'episodic'
                    ? 'text-sky-500 bg-sky-500/10 border-sky-500/20'
                    : 'text-purple-500 bg-purple-500/10 border-purple-500/20';

                return (
                  <motion.div
                    key={mem.id}
                    layout
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={`group p-4 rounded-xl border transition-all ${
                      mem.isPinned
                        ? 'bg-claude-surface-light dark:bg-[#201F1D] border-claude-terracotta/30 shadow-sm'
                        : 'bg-claude-surface-light dark:bg-[#1A1918] border-claude-border-light dark:border-stone-800 hover:border-claude-terracotta/20'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        {/* Badges & Meta */}
                        <div className="flex flex-wrap items-center gap-2 mb-1.5">
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-mono uppercase tracking-wider border ${tierColor}`}>
                            {mem.tier}
                          </span>
                          <span className="text-[11px] font-medium text-claude-muted-light dark:text-stone-400 capitalize">
                            {mem.category}
                          </span>
                          {mem.score !== undefined && (
                            <span className="text-[10px] font-mono text-claude-accentInk bg-claude-terracotta/10 px-1.5 py-0.2 rounded">
                              Match: {(mem.score * 100).toFixed(0)}%
                            </span>
                          )}
                          {mem.accessCount > 0 && (
                            <span className="text-[10px] font-mono text-claude-muted-light dark:text-stone-500">
                              Accessed {mem.accessCount}x
                            </span>
                          )}
                        </div>

                        {/* Title */}
                        <h4 className="text-sm font-semibold text-claude-text-light dark:text-white tracking-tight mb-1">
                          {mem.title}
                        </h4>

                        {/* Content */}
                        <p className="text-xs text-claude-muted-light dark:text-stone-300 leading-relaxed font-sans whitespace-pre-wrap">
                          {mem.content}
                        </p>

                        {/* Tags */}
                        {mem.tags && mem.tags.length > 0 && (
                          <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
                            {mem.tags.map((tag: string) => (
                              <span
                                key={tag}
                                className="text-[10px] px-2 py-0.5 rounded-md bg-claude-surface2-light dark:bg-stone-800/80 text-claude-muted-light dark:text-stone-400 border border-claude-border-light dark:border-stone-700/40"
                              >
                                #{tag}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Card Actions */}
                      <div className="flex items-center space-x-1 opacity-70 group-hover:opacity-100 transition-opacity flex-shrink-0">
                        <button
                          onClick={e => handleTogglePin(mem.id, !!mem.isPinned, e)}
                          className={`p-1.5 rounded-lg border transition-colors ${
                            mem.isPinned
                              ? 'text-claude-accentInk border-claude-terracotta/30 bg-claude-terracotta/10'
                              : 'text-claude-muted-light dark:text-stone-400 border-transparent hover:border-claude-border-light dark:hover:border-stone-700'
                          }`}
                          title={mem.isPinned ? 'Unpin memory' : 'Pin memory'}
                        >
                          <Pin className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={e => handleDelete(mem.id, e)}
                          className="p-1.5 rounded-lg text-claude-muted-light dark:text-stone-400 hover:text-rose-500 hover:bg-rose-500/10 border border-transparent hover:border-rose-500/20 transition-colors"
                          title="Delete memory"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </motion.div>
                );
              })
            )}
          </div>

          {/* Footer Ribbon with External Daemon Status */}
          <div className="p-3.5 border-t border-claude-border-light dark:border-claude-border-dark flex items-center justify-between text-xs text-claude-muted-light dark:text-stone-400 bg-claude-surface2-light/40 dark:bg-black/40">
            <div className="flex items-center space-x-2">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span>agentmemory runtime active</span>
            </div>

            <a
              href="http://localhost:3113"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center space-x-1.5 text-claude-accentInk hover:underline font-medium"
            >
              <span>Launch External Web Viewer (Port 3113)</span>
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>

          {/* Toast Notification */}
          <AnimatePresence>
            {toastMessage && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 10 }}
                className="absolute bottom-16 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full bg-stone-900 border border-stone-700 text-white text-xs shadow-xl flex items-center gap-2 pointer-events-none z-50"
              >
                <Zap className="w-3.5 h-3.5 text-claude-accentInk" />
                <span>{toastMessage}</span>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
