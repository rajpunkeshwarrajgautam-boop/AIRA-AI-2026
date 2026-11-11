import React, { useState, useMemo, useEffect, useRef } from 'react';
import { 
  HelpCircle, 
  Search, 
  X, 
  Sparkles, 
  Cpu, 
  Brain, 
  Code2, 
  UploadCloud, 
  AlertTriangle, 
  LifeBuoy, 
  ChevronRight, 
  ExternalLink,
  Bug
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface HelpCenterModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenReportBug?: () => void;
  onOpenShortcuts?: () => void;
  onOpenPrivacyCenter?: () => void;
  onOpenMotionStudio?: () => void;
}

interface HelpArticle {
  id: string;
  category: string;
  title: string;
  summary: string;
  content: string[];
  actionLabel?: string;
  actionHandler?: () => void;
}

export const HelpCenterModal: React.FC<HelpCenterModalProps> = ({
  isOpen,
  onClose,
  onOpenReportBug,
  onOpenShortcuts,
  onOpenPrivacyCenter,
  onOpenMotionStudio,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [expandedArticleId, setExpandedArticleId] = useState<string | null>('getting-started-overview');
  const modalRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const categories = [
    { id: 'all', label: 'All Topics', icon: HelpCircle },
    { id: 'getting-started', label: 'Getting Started', icon: Sparkles },
    { id: 'models', label: 'Models & Reasoning', icon: Cpu },
    { id: 'memory', label: 'Memory & Personalization', icon: Brain },
    { id: 'artifacts', label: 'Artifact Studio', icon: Code2 },
    { id: 'uploads', label: 'Uploads & Files', icon: UploadCloud },
    { id: 'troubleshooting', label: 'Troubleshooting', icon: AlertTriangle },
    { id: 'support', label: 'Support & Bug Reporting', icon: LifeBuoy },
  ];

  const articles: HelpArticle[] = useMemo(() => [
    {
      id: 'getting-started-overview',
      category: 'getting-started',
      title: 'Welcome to AIRA AI 2026',
      summary: 'An architectural AI operating environment pairing next-generation reasoning with structured artifact execution.',
      content: [
        'AIRA provides two primary workspace modes:',
        '• Chat Workspace: Conversational reasoning, continuous synthesis, and markdown formatting.',
        '• Agent Workspace: Multi-step execution with autonomous tool invocation, computer use, and background pipelines.',
        'Toggle between modes instantly via the top navigation selector or the Cmd/Ctrl + K command palette.'
      ]
    },
    {
      id: 'getting-started-navigation',
      category: 'getting-started',
      title: 'Navigation & Keyboard Shortcuts',
      summary: 'Navigate rapidly across chats, projects, settings, and command palette with ergonomic keystrokes.',
      content: [
        'Press Cmd/Ctrl + K from any screen to open the global Command Palette.',
        'Press Cmd/Ctrl + N to start a fresh conversation with your default model.',
        'Press ? or access the Keyboard Shortcuts menu to view the comprehensive shortcut map.'
      ],
      actionLabel: 'View Keyboard Shortcuts',
      actionHandler: onOpenShortcuts
    },
    {
      id: 'getting-started-motion-showcase',
      category: 'getting-started',
      title: 'Feature Showcase & Motion Studio',
      summary: 'Explore the 30-second motion walkthrough highlighting Groq LPU inference, Nemotron 70B reasoning, and cognitive settings.',
      content: [
        'Watch the interactive Video Studio showcasing AIRA\'s verified capabilities.',
        '• Scene 1: Multi-Model Cognitive Architecture & 128K Context',
        '• Scene 2: Ultra-Fast Groq LPU with Google Gemini Failover',
        '• Scene 3: NVIDIA Nemotron 70B Deep Reasoning Traces',
        '• Scene 4: Account-Scoped Onboarding Tour',
        '• Scene 5: Cognitive Settings & Enforced Privacy Safeguards'
      ],
      actionLabel: 'Launch Video Studio',
      actionHandler: onOpenMotionStudio
    },
    {
      id: 'models-reasoning-budget',
      category: 'models',
      title: 'Extended Thinking & Reasoning Budgets',
      summary: 'Configure deep thinking budgets for complex coding, architectural synthesis, and mathematical proofs.',
      content: [
        'When using reasoning-capable modes (e.g. AIRA Deep or NVIDIA Nemotron 70B), toggle Extended Thinking in the model selector.',
        'You can calibrate the reasoning budget from 1,024 up to 8,192 tokens inside Settings > Model & Reasoning.',
        'Reasoning blocks display real-time elapsed duration and expandable step traces.'
      ]
    },
    {
      id: 'models-provider-switching',
      category: 'models',
      title: 'Model Providers & Operational Routing',
      summary: 'High-speed multi-provider routing across Groq LPU, Google Gemini, and NVIDIA NIM.',
      content: [
        'AIRA connects via high-speed server-side inference gateways (Groq LPU, Google Gemini, and NVIDIA NIM).',
        'AIRA Auto dynamically selects the fastest engine for low-latency queries and deep reasoning for complex analysis.',
        'Credentials and upstream access are secured behind authenticated server-side boundaries.'
      ]
    },
    {
      id: 'memory-persistent-vault',
      category: 'memory',
      title: 'Persistent Memory & Privacy Scrubbing',
      summary: 'Cross-conversation knowledge retention with automatic privacy scrubbing.',
      content: [
        'AIRA integrates a persistent memory vault across working, episodic, semantic, and procedural memory tiers.',
        'All extracted memory items pass through a privacy scrubber to prevent secrets or credentials from persisting.',
        'You can inspect, search, edit, or purge memories anytime in Settings > Personalization or via the Memory Vault modal.'
      ]
    },
    {
      id: 'memory-aesthetic-presets',
      category: 'memory',
      title: 'Aesthetic Presets & Visual Systems',
      summary: 'Eight handcrafted design systems balancing typographic rhythm and architectural contrast.',
      content: [
        'Choose from Aira Atelier, Warm Parchment, Liquid Glass, Industrial Brutalist, Nordic Earth, Solaris Gold, Tokyo Cyber, or Vanguard Monolith.',
        'All presets seamlessly adapt across Light, Dark, and System appearance modes.',
        'Visual preferences persist automatically across your browser sessions.'
      ]
    },
    {
      id: 'artifacts-studio-features',
      category: 'artifacts',
      title: 'Artifact Studio & Live Previews',
      summary: 'Interactive rendering for React components, SVG illustrations, HTML5 prototypes, and Mermaid diagrams.',
      content: [
        'When AIRA generates comprehensive code or diagrams, Artifact Studio opens in a split-screen canvas.',
        'Features include live interactive preview, syntax-highlighted code inspection, copy-to-clipboard, and version history.',
        'Toggle automatic artifact opening in Settings > General.'
      ]
    },
    {
      id: 'uploads-supported-types',
      category: 'uploads',
      title: 'File Uploads & Multi-modal Inputs',
      summary: 'Attach source code, data sheets, and images directly to your conversational prompts.',
      content: [
        'Drag and drop files into the composer or click the paperclip icon.',
        'Supported formats include .ts, .tsx, .py, .json, .csv, .md, .pdf, and common image formats (.png, .jpg, .webp).',
        'Uploaded files are processed securely within sandboxed isolated execution containers.'
      ]
    },
    {
      id: 'troubleshooting-connection-recovery',
      category: 'troubleshooting',
      title: 'Connection & Stream Recovery',
      summary: 'Resolving streaming interruptions, rate limit delays, or network reconnections.',
      content: [
        'If an SSE response stream is interrupted, AIRA automatically attempts state resumption without losing previous turns.',
        'If you encounter a rate limit warning, allow the countdown timer to refresh or switch to an alternate provider in Settings.',
        'To force a fresh session, use Settings > Privacy & Data > Clear Application Cache.'
      ]
    },
    {
      id: 'support-reporting-bugs',
      category: 'support',
      title: 'Reporting Issues & Diagnostics',
      summary: 'Submit structured bug reports with reproduction steps and optional system telemetry.',
      content: [
        'Found a rendering glitch, reasoning defect, or unexpected behavior?',
        'Use the built-in Report a Bug workflow to deliver structured feedback with optional diagnostic metadata.',
        'Diagnostics never include conversation transcripts, personal credentials, or session tokens.'
      ],
      actionLabel: 'Report a Bug Now',
      actionHandler: onOpenReportBug
    },
    {
      id: 'support-privacy-compliance',
      category: 'support',
      title: 'Privacy Controls & Data Ownership',
      summary: 'Full control over data retention, local exports, and telemetry settings.',
      content: [
        'You own your conversational data. AIRA does not sell or distribute personal training data.',
        'Export your full conversational history and project configurations anytime in JSON format.',
        'Review complete privacy controls in the dedicated Privacy Center.'
      ],
      actionLabel: 'Open Privacy Center',
      actionHandler: onOpenPrivacyCenter
    }
  ], [onOpenReportBug, onOpenShortcuts, onOpenPrivacyCenter]);

  // Filter articles based on category and search
  const filteredArticles = useMemo(() => {
    return articles.filter(article => {
      const matchesCategory = selectedCategory === 'all' || article.category === selectedCategory;
      const matchesSearch = !searchQuery.trim() || 
        article.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        article.summary.toLowerCase().includes(searchQuery.toLowerCase()) ||
        article.content.some(line => line.toLowerCase().includes(searchQuery.toLowerCase()));
      return matchesCategory && matchesSearch;
    });
  }, [articles, selectedCategory, searchQuery]);

  // Trap focus and handle escape
  useEffect(() => {
    if (!isOpen) return;
    searchInputRef.current?.focus();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="help-center-title"
    >
      <motion.div
        ref={modalRef}
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        className="w-full max-w-4xl max-h-[90vh] flex flex-col bg-claude-surface-light dark:bg-[#1a1b1e] border border-claude-border-light dark:border-white/10 rounded-2xl shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-claude-border-light dark:border-white/10 bg-claude-surface2-light/60 dark:bg-white/[0.02]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-aira-blue/20 to-aira-cyan/20 border border-aira-blue/30 flex items-center justify-center text-aira-blue dark:text-aira-cyan">
              <HelpCircle className="w-5 h-5" />
            </div>
            <div>
              <h2 id="help-center-title" className="text-base font-bold text-claude-text-light dark:text-white tracking-tight">
                AIRA Help Center & Guides
              </h2>
              <p className="text-xs text-claude-muted-light dark:text-claude-muted-dark">
                Searchable documentation, architecture manuals, and support resources
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-xl text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light dark:hover:text-white hover:bg-claude-surface2-light dark:hover:bg-white/5 transition-colors"
            aria-label="Close Help Center"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Search Bar */}
        <div className="p-4 sm:px-6 border-b border-claude-border-light dark:border-white/10 bg-claude-surface-light dark:bg-[#18191c]">
          <div className="relative">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-claude-muted-light dark:text-claude-muted-dark" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search help topics, models, memory, shortcuts, or troubleshooting..."
              className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-claude-surface2-light dark:bg-white/5 border border-claude-border-light dark:border-white/10 text-sm text-claude-text-light dark:text-white placeholder:text-claude-muted-light dark:placeholder:text-claude-muted-dark focus:outline-none focus:ring-2 focus:ring-aira-blue/40 transition-all"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-claude-muted-light hover:text-claude-text-light"
              >
                Clear
              </button>
            )}
          </div>

          {/* Category Tabs */}
          <div className="flex items-center gap-1.5 mt-3 overflow-x-auto pb-1 scrollbar-none">
            {categories.map((cat) => {
              const Icon = cat.icon;
              const isActive = selectedCategory === cat.id;
              return (
                <button
                  key={cat.id}
                  onClick={() => setSelectedCategory(cat.id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                    isActive
                      ? 'bg-aira-blue text-white shadow-sm'
                      : 'text-claude-muted-light dark:text-claude-muted-dark hover:bg-claude-surface2-light dark:hover:bg-white/5 hover:text-claude-text-light dark:hover:text-white'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{cat.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Article Content List */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-3">
          {filteredArticles.length === 0 ? (
            <div className="text-center py-12">
              <HelpCircle className="w-10 h-10 mx-auto text-claude-muted-light/50 dark:text-claude-muted-dark/50 mb-3" />
              <p className="text-sm font-semibold text-claude-text-light dark:text-white">No articles found</p>
              <p className="text-xs text-claude-muted-light dark:text-claude-muted-dark mt-1">
                Try searching for different keywords like &quot;models&quot;, &quot;memory&quot;, or &quot;shortcuts&quot;.
              </p>
            </div>
          ) : (
            filteredArticles.map((article) => {
              const isExpanded = expandedArticleId === article.id;
              return (
                <div
                  key={article.id}
                  className="border border-claude-border-light dark:border-white/10 rounded-xl bg-claude-surface2-light/30 dark:bg-white/[0.02] overflow-hidden transition-all"
                >
                  <button
                    onClick={() => setExpandedArticleId(isExpanded ? null : article.id)}
                    className="w-full flex items-start justify-between p-4 text-left hover:bg-claude-surface2-light/60 dark:hover:bg-white/[0.04] transition-colors"
                  >
                    <div className="pr-4">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-aira-blue/10 text-aira-blue dark:text-aira-cyan">
                          {categories.find(c => c.id === article.category)?.label || article.category}
                        </span>
                      </div>
                      <h3 className="text-sm font-bold text-claude-text-light dark:text-white">
                        {article.title}
                      </h3>
                      <p className="text-xs text-claude-muted-light dark:text-claude-muted-dark mt-0.5">
                        {article.summary}
                      </p>
                    </div>
                    <ChevronRight className={`w-4 h-4 text-claude-muted-light shrink-0 mt-1 transition-transform ${isExpanded ? 'rotate-90 text-aira-blue' : ''}`} />
                  </button>

                  <AnimatePresence>
                    {isExpanded && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        className="px-4 pb-4 pt-1 border-t border-claude-border-light/50 dark:border-white/5 space-y-2 text-xs text-claude-text-light/90 dark:text-white/80"
                      >
                        {article.content.map((p, idx) => (
                          <p key={idx} className="leading-relaxed">{p}</p>
                        ))}
                        {article.actionLabel && article.actionHandler && (
                          <div className="pt-2">
                            <button
                              onClick={() => {
                                article.actionHandler?.();
                                onClose();
                              }}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-aira-blue/10 hover:bg-aira-blue/20 text-aira-blue dark:text-aira-cyan font-semibold transition-colors"
                            >
                              <span>{article.actionLabel}</span>
                              <ExternalLink className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })
          )}
        </div>

        {/* Footer Quick Support Actions */}
        <div className="px-6 py-3.5 border-t border-claude-border-light dark:border-white/10 bg-claude-surface2-light/60 dark:bg-white/[0.02] flex items-center justify-between text-xs">
          <span className="text-claude-muted-light dark:text-claude-muted-dark">
            Need additional assistance or encountered a defect?
          </span>
          <div className="flex items-center gap-2">
            {onOpenReportBug && (
              <button
                onClick={() => {
                  onClose();
                  onOpenReportBug();
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-600 dark:text-rose-400 font-semibold transition-colors"
              >
                <Bug className="w-3.5 h-3.5" />
                <span>Report Bug</span>
              </button>
            )}
            <button
              onClick={onClose}
              className="px-3.5 py-1.5 rounded-lg bg-claude-surface2-light dark:bg-white/10 hover:bg-claude-surface2-light/80 text-claude-text-light dark:text-white font-medium transition-colors"
            >
              Done
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
};
