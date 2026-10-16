import React, { useState, useEffect, useMemo } from 'react';
import {
  Library as LibraryIcon,
  Search,
  Plus,
  Trash2,
  ExternalLink,
  ShieldCheck,
  BrainCircuit,
  FileText,
  Clock,
  Sparkles,
  RefreshCw,
  AlertCircle,
  Database,
  Eye,
  CheckCircle2,
  X
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { authenticatedApiFetch } from '../lib/neonAuth';

interface KnowledgeSource {
  id: string;
  principalId?: string;
  workspaceId?: string;
  isSystem: boolean;
  visibility?: 'private' | 'workspace' | 'system';
  projectId?: string;
  title: string;
  uri?: string;
  mimeType: string;
  contentHash: string;
  rawContent: string;
  createdAt: number;
  updatedAt: number;
}

interface MemoryRecord {
  id: string;
  principalId?: string;
  isSystem: boolean;
  key: string;
  value: string;
  category: 'fact' | 'decision' | 'preference' | 'pattern' | 'constraint';
  confidence: number;
  provenance: string;
  createdAt: number;
}

interface KnowledgeEntity {
  id: string;
  principalId?: string;
  isSystem: boolean;
  name: string;
  type: string;
  confidence: number;
  sourceIds: string[];
}

interface KnowledgeEdge {
  id: string;
  principalId?: string;
  isSystem: boolean;
  sourceEntityId: string;
  targetEntityId: string;
  relation: string;
  confidence: number;
}

interface SearchResult {
  chunk: {
    id: string;
    sourceId: string;
    text: string;
    chunkIndex: number;
  };
  score: number;
  citation: {
    id: string;
    sourceTitle: string;
    snippet: string;
    score: number;
  };
}

export const LibraryView: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'sources' | 'memories' | 'graph'>('sources');
  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [entities, setEntities] = useState<KnowledgeEntity[]>([]);
  const [edges, setEdges] = useState<KnowledgeEdge[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  // Ingestion Modal State
  const [isIngestOpen, setIsIngestOpen] = useState(false);
  const [ingestTitle, setIngestTitle] = useState('');
  const [ingestContent, setIngestContent] = useState('');
  const [ingestMimeType, setIngestMimeType] = useState('text/markdown');
  const [isIngesting, setIsIngesting] = useState(false);
  const [ingestError, setIngestError] = useState<string | null>(null);

  // Detail Modal State
  const [selectedSource, setSelectedSource] = useState<KnowledgeSource | null>(null);

  const fetchKnowledgeData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [sourcesRes, graphRes] = await Promise.all([
        authenticatedApiFetch('/api/knowledge/sources'),
        authenticatedApiFetch('/api/knowledge/graph')
      ]);

      if (!sourcesRes.ok) throw new Error('Failed to load knowledge sources.');
      const sourcesData = await sourcesRes.json();
      setSources(sourcesData.sources || []);
      setMemories(sourcesData.memories || []);

      if (graphRes.ok) {
        const graphData = await graphRes.json();
        setEntities(graphData.entities || []);
        setEdges(graphData.edges || []);
      }
    } catch (err: any) {
      setError(err.message || 'Unable to connect to Knowledge Engine.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchKnowledgeData();
  }, []);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) {
      setSearchResults(null);
      return;
    }
    setIsSearching(true);
    try {
      const res = await authenticatedApiFetch('/api/knowledge/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: searchQuery.trim(), limit: 10 })
      });
      if (!res.ok) throw new Error('Search request failed');
      const data = await res.json();
      setSearchResults(data.results || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsSearching(false);
    }
  };

  const handleIngest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ingestTitle.trim() || !ingestContent.trim()) {
      setIngestError('Title and content are required.');
      return;
    }
    setIsIngesting(true);
    setIngestError(null);
    try {
      const res = await authenticatedApiFetch('/api/knowledge/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: ingestTitle.trim(),
          content: ingestContent.trim(),
          mimeType: ingestMimeType
        })
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Document ingestion failed.');
      }
      setIsIngestOpen(false);
      setIngestTitle('');
      setIngestContent('');
      await fetchKnowledgeData();
    } catch (err: any) {
      setIngestError(err.message);
    } finally {
      setIsIngesting(false);
    }
  };

  const handleDeleteSource = async (id: string) => {
    if (!confirm('Are you sure you want to delete this document from the library?')) return;
    try {
      const res = await authenticatedApiFetch(`/api/knowledge/sources/${encodeURIComponent(id)}`, {
        method: 'DELETE'
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to delete source.');
      }
      if (selectedSource?.id === id) setSelectedSource(null);
      await fetchKnowledgeData();
    } catch (err: any) {
      alert(`Deletion error: ${err.message}`);
    }
  };

  const filteredSources = useMemo(() => {
    if (!searchQuery.trim() || searchResults !== null) return sources;
    const q = searchQuery.toLowerCase();
    return sources.filter(s => s.title.toLowerCase().includes(q) || s.rawContent.toLowerCase().includes(q));
  }, [sources, searchQuery, searchResults]);

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-claude-bg-light dark:bg-claude-bg-dark text-claude-text-light dark:text-claude-text-dark">
      {/* Header */}
      <div className="border-b border-claude-border-light dark:border-claude-border-dark px-6 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-claude-surface-light/50 dark:bg-claude-surface-dark/50 backdrop-blur-sm">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-claude-terracotta/10 text-claude-accentInk flex items-center justify-center">
              <LibraryIcon className="w-4 h-4" />
            </div>
            <h1 className="text-xl font-serif font-medium tracking-tight">Library & Knowledge Base</h1>
            <span className="text-xs px-2 py-0.5 rounded-full font-mono bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 flex items-center gap-1">
              <ShieldCheck className="w-3 h-3" /> Principal Isolated
            </span>
          </div>
          <p className="text-xs text-claude-muted-light dark:text-claude-muted-dark mt-1">
            Server-authoritative document indexing, entity graph extraction, and private memory records.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={() => fetchKnowledgeData()}
            className="p-2 rounded-xl border border-claude-border-light dark:border-claude-border-dark hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light transition-all"
            title="Refresh Knowledge Data"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={() => setIsIngestOpen(true)}
            className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-claude-terracotta hover:bg-[#d97757]/90 text-white font-medium text-xs shadow-sm shadow-claude-terracotta/20 transition-all active:scale-95"
          >
            <Plus className="w-4 h-4" />
            <span>Ingest Document</span>
          </button>
        </div>
      </div>

      {/* Tabs & Search Filter */}
      <div className="px-6 py-3 border-b border-claude-border-light dark:border-claude-border-dark flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-claude-surface2-light/40 dark:bg-claude-surface2-dark/40">
        <div className="flex items-center gap-1 p-1 bg-claude-surface-light dark:bg-claude-surface-dark border border-claude-border-light dark:border-claude-border-dark rounded-xl">
          <button
            onClick={() => setActiveTab('sources')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'sources'
                ? 'bg-claude-terracotta text-white shadow-sm'
                : 'text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light'
            }`}
          >
            Documents ({sources.length})
          </button>
          <button
            onClick={() => setActiveTab('memories')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'memories'
                ? 'bg-claude-terracotta text-white shadow-sm'
                : 'text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light'
            }`}
          >
            Memories ({memories.length})
          </button>
          <button
            onClick={() => setActiveTab('graph')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              activeTab === 'graph'
                ? 'bg-claude-terracotta text-white shadow-sm'
                : 'text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light'
            }`}
          >
            Entity Graph ({entities.length})
          </button>
        </div>

        {activeTab === 'sources' && (
          <form onSubmit={handleSearch} className="relative flex-1 max-w-sm">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-claude-muted-light dark:text-claude-muted-dark" />
            <input
              type="text"
              placeholder="Search documents or semantic chunks..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                if (!e.target.value.trim()) setSearchResults(null);
              }}
              className="w-full pl-9 pr-8 py-1.5 rounded-xl text-xs bg-claude-surface-light dark:bg-claude-surface-dark border border-claude-border-light dark:border-claude-border-dark focus:outline-none focus:border-claude-terracotta transition-colors"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('');
                  setSearchResults(null);
                }}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-claude-muted-light hover:text-claude-text-light"
              >
                ✕
              </button>
            )}
          </form>
        )}
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto p-6">
        {error && (
          <div className="mb-4 p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 text-claude-muted-light dark:text-claude-muted-dark">
            <RefreshCw className="w-6 h-6 animate-spin text-claude-accentInk mb-2" />
            <p className="text-xs">Loading authorized knowledge repository...</p>
          </div>
        ) : activeTab === 'sources' ? (
          <div>
            {/* Search Results Banner */}
            {searchResults !== null && (
              <div className="mb-4 p-3 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark flex items-center justify-between text-xs">
                <span className="font-medium">
                  Found {searchResults.length} semantic chunk {searchResults.length === 1 ? 'match' : 'matches'} for "{searchQuery}"
                </span>
                <button
                  onClick={() => setSearchResults(null)}
                  className="text-claude-accentInk hover:underline text-xs"
                >
                  Clear search
                </button>
              </div>
            )}

            {/* Semantic Search Result Cards */}
            {searchResults !== null ? (
              <div className="space-y-3">
                {searchResults.length === 0 ? (
                  <div className="text-center py-12 text-claude-muted-light dark:text-claude-muted-dark text-xs">
                    No authorized knowledge chunks match your search.
                  </div>
                ) : (
                  searchResults.map((res, i) => (
                    <div
                      key={i}
                      className="p-4 rounded-xl bg-claude-surface-light dark:bg-claude-surface-dark border border-claude-border-light dark:border-claude-border-dark shadow-sm hover:border-claude-terracotta/40 transition-all"
                    >
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <span className="font-medium text-xs text-claude-accentInk">
                          {res.citation.sourceTitle}
                        </span>
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-claude-surface2-light dark:bg-claude-surface2-dark text-claude-muted-light">
                          Relevance {(res.score * 100).toFixed(0)}%
                        </span>
                      </div>
                      <p className="text-xs leading-relaxed text-claude-text-light/90 dark:text-claude-text-dark/90 font-mono bg-claude-surface2-light/50 dark:bg-black/20 p-2.5 rounded-lg border border-claude-border-light/50 dark:border-claude-border-dark/50">
                        {res.chunk.text}
                      </p>
                    </div>
                  ))
                )}
              </div>
            ) : filteredSources.length === 0 ? (
              <div className="text-center py-20 flex flex-col items-center justify-center">
                <div className="w-12 h-12 rounded-2xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark flex items-center justify-center text-claude-muted-light mb-3">
                  <FileText className="w-6 h-6" />
                </div>
                <h3 className="font-serif text-base font-medium">No documents in library</h3>
                <p className="text-xs text-claude-muted-light dark:text-claude-muted-dark max-w-sm mt-1 mb-4">
                  Ingest notes, architecture guides, specs, or documents to enable contextual AI reasoning and citations.
                </p>
                <button
                  onClick={() => setIsIngestOpen(true)}
                  className="px-4 py-2 rounded-xl bg-claude-terracotta hover:bg-[#d97757]/90 text-white font-medium text-xs shadow-sm transition-all"
                >
                  Ingest First Document
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {filteredSources.map((source) => (
                  <motion.div
                    key={source.id}
                    layout
                    className="p-4 rounded-xl bg-claude-surface-light dark:bg-claude-surface-dark border border-claude-border-light dark:border-claude-border-dark shadow-sm hover:border-claude-terracotta/40 hover:shadow-md transition-all flex flex-col justify-between"
                  >
                    <div>
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <div className="flex items-center gap-2">
                          <FileText className="w-4 h-4 text-claude-accentInk shrink-0" />
                          <h4 className="font-serif font-medium text-sm leading-snug line-clamp-1">
                            {source.title}
                          </h4>
                        </div>
                        <span
                          className={`text-[9px] font-mono uppercase px-2 py-0.5 rounded-full font-bold ${
                            source.isSystem
                              ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20'
                              : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20'
                          }`}
                        >
                          {source.isSystem ? 'System' : 'Private'}
                        </span>
                      </div>

                      <p className="text-xs text-claude-muted-light dark:text-claude-muted-dark line-clamp-3 mb-3 leading-relaxed">
                        {source.rawContent}
                      </p>
                    </div>

                    <div className="border-t border-claude-border-light/60 dark:border-claude-border-dark/60 pt-3 flex items-center justify-between text-[11px] text-claude-muted-light dark:text-claude-muted-dark">
                      <div className="flex items-center gap-1 font-mono">
                        <Clock className="w-3 h-3" />
                        <span>{new Date(source.createdAt).toLocaleDateString()}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => setSelectedSource(source)}
                          className="p-1 rounded hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark text-claude-text-light dark:text-claude-text-dark"
                          title="Inspect document"
                        >
                          <Eye className="w-3.5 h-3.5" />
                        </button>
                        {!source.isSystem && (
                          <button
                            onClick={() => handleDeleteSource(source.id)}
                            className="p-1 rounded hover:bg-rose-500/10 text-rose-500 transition-colors"
                            title="Delete document"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  </motion.div>
                ))}
              </div>
            )}
          </div>
        ) : activeTab === 'memories' ? (
          <div>
            {memories.length === 0 ? (
              <div className="text-center py-20 text-claude-muted-light text-xs">
                No active memory records found for this principal.
              </div>
            ) : (
              <div className="space-y-3">
                {memories.map((mem) => (
                  <div
                    key={mem.id}
                    className="p-4 rounded-xl bg-claude-surface-light dark:bg-claude-surface-dark border border-claude-border-light dark:border-claude-border-dark flex items-start justify-between gap-4"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-bold text-claude-accentInk">
                          {mem.key}
                        </span>
                        <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-claude-surface2-light dark:bg-claude-surface2-dark text-claude-muted-light">
                          {mem.category}
                        </span>
                        {mem.isSystem && (
                          <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-amber-500/10 text-amber-600 border border-amber-500/20">
                            system
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-claude-text-light/90 dark:text-claude-text-dark/90 leading-relaxed font-sans">
                        {mem.value}
                      </p>
                    </div>
                    <span className="text-[10px] font-mono text-claude-muted-light shrink-0">
                      {new Date(mem.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Entities */}
              <div className="p-4 rounded-xl bg-claude-surface-light dark:bg-claude-surface-dark border border-claude-border-light dark:border-claude-border-dark">
                <h3 className="font-serif font-medium text-sm mb-3 flex items-center gap-2">
                  <BrainCircuit className="w-4 h-4 text-claude-accentInk" />
                  <span>Knowledge Graph Entities ({entities.length})</span>
                </h3>
                {entities.length === 0 ? (
                  <p className="text-xs text-claude-muted-light">No entities extracted yet.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {entities.map((ent) => (
                      <span
                        key={ent.id}
                        className="px-2.5 py-1 rounded-lg text-xs font-mono bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark flex items-center gap-1.5"
                      >
                        <span className="font-semibold text-claude-accentInk">{ent.name}</span>
                        <span className="text-[9px] text-claude-muted-light">({ent.type})</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Edges */}
              <div className="p-4 rounded-xl bg-claude-surface-light dark:bg-claude-surface-dark border border-claude-border-light dark:border-claude-border-dark">
                <h3 className="font-serif font-medium text-sm mb-3 flex items-center gap-2">
                  <Database className="w-4 h-4 text-claude-accentInk" />
                  <span>Entity Relationships & Edges ({edges.length})</span>
                </h3>
                {edges.length === 0 ? (
                  <p className="text-xs text-claude-muted-light">No relationship edges found.</p>
                ) : (
                  <div className="space-y-2 max-h-80 overflow-y-auto">
                    {edges.map((edge) => (
                      <div
                        key={edge.id}
                        className="text-xs font-mono p-2 rounded-lg bg-claude-surface2-light dark:bg-claude-surface2-dark flex items-center justify-between"
                      >
                        <span className="truncate max-w-[120px]">{edge.sourceEntityId}</span>
                        <span className="text-[10px] px-2 py-0.5 rounded bg-claude-terracotta/10 text-claude-accentInk font-bold">
                          {edge.relation}
                        </span>
                        <span className="truncate max-w-[120px]">{edge.targetEntityId}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Ingest Modal */}
      <AnimatePresence>
        {isIngestOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="w-full max-w-lg rounded-2xl bg-claude-surface-light dark:bg-claude-surface-dark border border-claude-border-light dark:border-claude-border-dark shadow-2xl p-6"
            >
              <div className="flex items-center justify-between pb-4 border-b border-claude-border-light dark:border-claude-border-dark">
                <h3 className="font-serif font-medium text-base">Ingest New Document</h3>
                <button
                  onClick={() => setIsIngestOpen(false)}
                  className="p-1 rounded-lg text-claude-muted-light hover:text-claude-text-light"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {ingestError && (
                <div className="mt-4 p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-500 text-xs">
                  {ingestError}
                </div>
              )}

              <form onSubmit={handleIngest} className="mt-4 space-y-4">
                <div>
                  <label className="block text-xs font-medium text-claude-muted-light mb-1">
                    Document Title
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Q4 Financial Projections or API Specification"
                    value={ingestTitle}
                    onChange={(e) => setIngestTitle(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl text-xs bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark focus:outline-none focus:border-claude-terracotta"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-claude-muted-light mb-1">
                    Document Content (Markdown / Text)
                  </label>
                  <textarea
                    required
                    rows={8}
                    placeholder="Enter full document text or markdown..."
                    value={ingestContent}
                    onChange={(e) => setIngestContent(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl text-xs font-mono bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark focus:outline-none focus:border-claude-terracotta resize-none"
                  />
                </div>

                <div className="flex items-center justify-between pt-2">
                  <span className="text-[10px] text-claude-muted-light flex items-center gap-1">
                    <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
                    Indexed privately under your execution principal
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setIsIngestOpen(false)}
                      className="px-3 py-1.5 rounded-xl text-xs text-claude-muted-light hover:text-claude-text-light"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={isIngesting}
                      className="px-4 py-1.5 rounded-xl bg-claude-terracotta hover:bg-[#d97757]/90 text-white text-xs font-medium transition-all disabled:opacity-50"
                    >
                      {isIngesting ? 'Indexing...' : 'Index Document'}
                    </button>
                  </div>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Source Detail Modal */}
      <AnimatePresence>
        {selectedSource && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-2xl bg-claude-surface-light dark:bg-claude-surface-dark border border-claude-border-light dark:border-claude-border-dark shadow-2xl p-6"
            >
              <div className="flex items-start justify-between pb-4 border-b border-claude-border-light dark:border-claude-border-dark">
                <div>
                  <h3 className="font-serif font-medium text-lg">{selectedSource.title}</h3>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-claude-surface2-light dark:bg-claude-surface2-dark text-claude-muted-light">
                      ID: {selectedSource.id}
                    </span>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-claude-surface2-light dark:bg-claude-surface2-dark text-claude-muted-light">
                      SHA-256: {selectedSource.contentHash.slice(0, 16)}...
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => setSelectedSource(null)}
                  className="p-1 rounded-lg text-claude-muted-light hover:text-claude-text-light"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto py-4">
                <div className="p-4 rounded-xl font-mono text-xs bg-claude-surface2-light/60 dark:bg-black/30 border border-claude-border-light dark:border-claude-border-dark whitespace-pre-wrap leading-relaxed">
                  {selectedSource.rawContent}
                </div>
              </div>

              <div className="pt-4 border-t border-claude-border-light dark:border-claude-border-dark flex items-center justify-between text-xs text-claude-muted-light">
                <span>
                  Created: {new Date(selectedSource.createdAt).toLocaleString()}
                </span>
                <button
                  onClick={() => setSelectedSource(null)}
                  className="px-4 py-1.5 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark text-claude-text-light dark:text-claude-text-dark text-xs font-medium"
                >
                  Close
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};
