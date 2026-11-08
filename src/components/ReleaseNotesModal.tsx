import React, { useEffect, useRef } from 'react';
import { Sparkles, X, Calendar, CheckCircle2 } from 'lucide-react';
import { motion } from 'framer-motion';

interface ReleaseNotesModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenHelpCenter?: () => void;
}

interface ReleaseRecord {
  version: string;
  codename: string;
  date: string;
  tag: 'Latest' | 'Stable' | 'Major';
  summary: string;
  highlights: string[];
  features: { category: string; description: string }[];
}

export const ReleaseNotesModal: React.FC<ReleaseNotesModalProps> = ({
  isOpen,
  onClose,
  onOpenHelpCenter,
}) => {
  const modalRef = useRef<HTMLDivElement>(null);

  const releases: ReleaseRecord[] = [
    {
      version: 'v2.4.0',
      codename: 'Sheared Perspective Portal',
      date: 'November 2026',
      tag: 'Latest',
      summary: 'Complete brand identity transition to the Sheared Perspective Portal geometry, paired with an architectural Account Menu, Personalization, and Help Center ecosystem.',
      highlights: [
        'Integrated official Sheared Perspective Portal brand identity with 10-facet precision geometry.',
        'Concept A Architectural Alignment motion for UI navigation, Concept C Sculptural Assembly for signature hero canvas.',
        'High-density favicon matrix (16px, 24px, 32px, 64px, SVG, PWA manifest) with automatic dark/light theme switching.',
        'Complete Account Menu, Personalization, Settings, and Help Center integration.',
        'Live system-wide accessibility controls (Reduced Motion, High Contrast, Font Scaling).'
      ],
      features: [
        { category: 'Brand Architecture', description: 'Replaced legacy Neural Knot with 10-facet Sheared Perspective Portal across all responsive viewports.' },
        { category: 'Account Ecosystem', description: 'Unified Account menu with authenticated tier badges, initials fallback, and quick routing.' },
        { category: 'Help & Governance', description: 'Comprehensive searchable Help Center, dedicated Privacy Center, and Bug Reporting workflow.' },
        { category: 'System Title Safety', description: 'Dynamic document title preservation prevents favicon updates from overriding chat titles.' }
      ]
    },
    {
      version: 'v2.3.0',
      codename: 'Adaptive Reasoning & Multi-Provider',
      date: 'October 2026',
      tag: 'Stable',
      summary: 'Major platform upgrade introducing dual-mode Adaptive Workspaces (Chat vs. Agent) and deep reasoning budget controls.',
      highlights: [
        'Adaptive Workspace switcher: conversational reasoning vs. autonomous agent execution pipelines.',
        'Extended Thinking budget sliders calibrated from 1,024 up to 64,000 reasoning tokens.',
        'Multi-provider failover routing connecting Anthropic Claude 3.7, DeepSeek R1, and NVIDIA Nemotron.'
      ],
      features: [
        { category: 'Inference Engine', description: 'Atomic MVCC capacity admission and sub-second time-to-first-token (TTFT) routing.' },
        { category: 'Agent Workspace', description: 'Autonomous agent runtime with background computer use and tool delegation.' },
        { category: 'Conversation Search', description: 'Hybrid lexical and semantic conversation retrieval across all session records.' }
      ]
    },
    {
      version: 'v2.0.0',
      codename: 'Artifact Studio & Aesthetic Systems',
      date: 'October 2026',
      tag: 'Major',
      summary: 'Introduction of the Claude-inspired Artifact Studio for live code and graphic execution, along with 8 architectural aesthetic presets.',
      highlights: [
        'Artifact Studio: live multi-runtime streaming sandbox for React, HTML5, SVG, Markdown, and Mermaid diagrams.',
        'Eight bespoke aesthetic presets: Claude Editorial, Warm Parchment, Liquid Glass, Industrial Brutalist, Nordic Earth, Solaris Gold, Tokyo Cyber, and Vanguard Monolith.',
        'Persistent Memory Vault with automated privacy scrubbing and semantic tagging.'
      ],
      features: [
        { category: 'Artifact Execution', description: 'Live interactive sandboxing with instant code copying, download, and version diffing.' },
        { category: 'Design Tokens', description: 'Handcrafted palette tokens with full support for Light, Dark, and System appearance.' },
        { category: 'Memory Architecture', description: 'Tiered memory engine (working, episodic, semantic, procedural) with local IndexedDB persistence.' }
      ]
    },
    {
      version: 'v1.0.0',
      codename: 'Commercial Platform Foundation',
      date: 'September 2026',
      tag: 'Major',
      summary: 'Initial commercial foundation of AIRA AI 2026 with enterprise authentication and multi-tier subscription quotas.',
      highlights: [
        'NeonAuth multi-tenant authentication with OAuth, social providers, and durable session validation.',
        'Commercial tier entitlements for Free, Pro, and Enterprise accounts with INR/USD currency support.',
        'Isolated Builder Agent environment with sandboxed execution containers.'
      ],
      features: [
        { category: 'Authentication', description: 'Zero-trust principal verification and seamless guest-to-authenticated session migration.' },
        { category: 'Commercial Engine', description: 'Usage tracking, daily/monthly chat quotas, and top-up credit management.' },
        { category: 'Infrastructure', description: 'Serverless Edge API gateway with comprehensive security and rate limiting.' }
      ]
    }
  ];

  useEffect(() => {
    if (!isOpen) return;
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
      aria-labelledby="release-notes-title"
    >
      <motion.div
        ref={modalRef}
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        className="w-full max-w-3xl max-h-[90vh] flex flex-col bg-claude-surface-light dark:bg-[#1a1b1e] border border-claude-border-light dark:border-white/10 rounded-2xl shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-claude-border-light dark:border-white/10 bg-claude-surface2-light/60 dark:bg-white/[0.02]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-claude-terracotta/15 border border-claude-terracotta/20 flex items-center justify-center text-claude-accentInk">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h2 id="release-notes-title" className="text-base font-bold text-claude-text-light dark:text-white tracking-tight">
                AIRA Release Notes & Changelog
              </h2>
              <p className="text-xs text-claude-muted-light dark:text-claude-muted-dark">
                Verified chronological records of architecture, features, and brand enhancements
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-xl text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light dark:hover:text-white hover:bg-claude-surface2-light dark:hover:bg-white/5 transition-colors"
            aria-label="Close Release Notes"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Timeline Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-8">
          {releases.map((release, idx) => (
            <div key={release.version} className="relative pl-6 sm:pl-8 border-l-2 border-claude-border-light dark:border-white/10 last:border-l-transparent">
              {/* Timeline marker */}
              <div className={`absolute -left-[9px] top-0 w-4 h-4 rounded-full border-2 ${
                idx === 0 
                  ? 'bg-aira-blue border-white dark:border-[#1a1b1e] ring-4 ring-aira-blue/20' 
                  : 'bg-claude-surface2-light dark:bg-white/20 border-white dark:border-[#1a1b1e]'
              }`} />

              {/* Version & Date */}
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <span className="text-base font-bold text-claude-text-light dark:text-white">
                  {release.version}
                </span>
                <span className="text-xs text-claude-muted-light dark:text-claude-muted-dark font-medium">
                  ({release.codename})
                </span>
                <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${
                  release.tag === 'Latest'
                    ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20'
                    : release.tag === 'Major'
                    ? 'bg-claude-terracotta/10 text-claude-accentInk border border-claude-terracotta/20'
                    : 'bg-claude-surface2-light dark:bg-white/10 text-claude-muted-light'
                }`}>
                  {release.tag}
                </span>
                <div className="flex items-center gap-1 ml-auto text-xs text-claude-muted-light dark:text-claude-muted-dark">
                  <Calendar className="w-3 h-3" />
                  <span>{release.date}</span>
                </div>
              </div>

              {/* Summary */}
              <p className="text-xs leading-relaxed text-claude-text-light/90 dark:text-white/80 mb-3">
                {release.summary}
              </p>

              {/* Highlights Box */}
              <div className="p-3.5 rounded-xl bg-claude-surface2-light/40 dark:bg-white/[0.02] border border-claude-border-light dark:border-white/10 mb-3">
                <h4 className="text-[11px] font-bold uppercase tracking-wider text-claude-muted-light dark:text-claude-muted-dark mb-2">
                  Key Enhancements
                </h4>
                <ul className="space-y-1.5 text-xs text-claude-text-light/90 dark:text-white/80">
                  {release.highlights.map((h, hIdx) => (
                    <li key={hIdx} className="flex items-start gap-2">
                      <CheckCircle2 className="w-3.5 h-3.5 text-aira-blue dark:text-aira-cyan shrink-0 mt-0.5" />
                      <span>{h}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Detailed Breakdown */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                {release.features.map((feat, fIdx) => (
                  <div key={fIdx} className="p-2.5 rounded-lg bg-claude-surface2-light/20 dark:bg-white/[0.01] border border-claude-border-light/50 dark:border-white/5">
                    <span className="font-semibold text-claude-text-light dark:text-white block mb-0.5">
                      {feat.category}
                    </span>
                    <span className="text-[11px] text-claude-muted-light dark:text-claude-muted-dark leading-snug block">
                      {feat.description}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-claude-border-light dark:border-white/10 bg-claude-surface2-light/60 dark:bg-white/[0.02] flex items-center justify-between text-xs">
          <span className="text-claude-muted-light dark:text-claude-muted-dark">
            All releases adhere to Semantic Versioning (SemVer 2.0).
          </span>
          <div className="flex items-center gap-2">
            {onOpenHelpCenter && (
              <button
                onClick={() => {
                  onClose();
                  onOpenHelpCenter();
                }}
                className="text-aira-blue hover:underline font-medium"
              >
                Browse Documentation
              </button>
            )}
            <button
              onClick={onClose}
              className="px-4 py-1.5 rounded-lg bg-aira-blue hover:bg-aira-blue/90 text-white font-medium transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
};
