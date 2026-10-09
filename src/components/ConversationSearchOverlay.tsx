import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Bookmark, FolderGit2, MessageSquareText, Search, X } from 'lucide-react';
import type { Conversation, Project } from '../types';
import {
  searchConversationsServer,
  type ConversationSearchResult
} from '../utils/conversationSearch';

interface ConversationSearchOverlayProps {
  isOpen: boolean;
  initialQuery?: string;
  conversations: Conversation[];
  projects: Project[];
  onClose: () => void;
  onSelectChat: (conversationId: string, messageId?: string) => void;
}

function localSnippet(content: string, query: string, maxLength = 260): string {
  const clean = content.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) return clean;
  const lower = clean.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx < 0) return clean.slice(0, maxLength - 1) + '…';
  const start = Math.max(0, idx - Math.floor(maxLength / 2));
  const end = Math.min(clean.length, start + maxLength);
  return (start > 0 ? '…' : '') + clean.slice(start, end) + (end < clean.length ? '…' : '');
}

function localSearch(conversations: Conversation[], query: string): ConversationSearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const results: ConversationSearchResult[] = [];
  for (const conversation of conversations) {
    const titleMatch = conversation.title.toLowerCase().includes(q);
    let best:
      | { id: string; role: 'user' | 'assistant'; content: string; timestamp: number; score: number }
      | undefined;

    for (const message of conversation.messages) {
      const contentLower = message.content.toLowerCase();
      const index = contentLower.indexOf(q);
      if (index < 0) continue;
      const score = 0.8 + (index === 0 ? 0.15 : 0);
      if (!best || score > best.score) {
        best = {
          id: message.id,
          role: message.role,
          content: message.content,
          timestamp: message.timestamp,
          score
        };
      }
    }

    if (!titleMatch && !best) continue;

    const fallbackMessage = best || conversation.messages[conversation.messages.length - 1];
    results.push({
      conversationId: conversation.id,
      messageId: fallbackMessage?.id || '',
      title: conversation.title,
      projectId: conversation.projectId,
      role: fallbackMessage?.role || 'user',
      snippet: fallbackMessage ? localSnippet(fallbackMessage.content, query) : conversation.title,
      score: (titleMatch ? 1.15 : 0) + (best?.score || 0) + (conversation.isPinned ? 0.05 : 0),
      updatedAt: conversation.updatedAt,
      messageCreatedAt: fallbackMessage?.timestamp || conversation.updatedAt,
      isPinned: Boolean(conversation.isPinned),
      matchType: titleMatch ? 'title' : 'exact'
    });
  }

  return results
    .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
    .slice(0, 20);
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  const trimmed = query.trim();
  if (!trimmed) return <>{text}</>;
  const lower = text.toLowerCase();
  const index = lower.indexOf(trimmed.toLowerCase());
  if (index < 0) return <>{text}</>;

  return (
    <>
      {text.slice(0, index)}
      <mark className="rounded bg-claude-terracotta/15 px-0.5 text-inherit">
        {text.slice(index, index + trimmed.length)}
      </mark>
      {text.slice(index + trimmed.length)}
    </>
  );
}

export const ConversationSearchOverlay: React.FC<ConversationSearchOverlayProps> = ({
  isOpen,
  initialQuery = '',
  conversations,
  projects,
  onClose,
  onSelectChat
}) => {
  const [query, setQuery] = useState(initialQuery);
  const [serverResults, setServerResults] = useState<ConversationSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [serverAvailable, setServerAvailable] = useState(true);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (!isOpen) return;
    setQuery(initialQuery);
    setServerResults([]);
    setActiveIndex(0);
    setServerAvailable(true);
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen, initialQuery]);

  useEffect(() => {
    if (!isOpen) return;
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setServerResults([]);
      setIsSearching(false);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setIsSearching(true);
      try {
        const response = await searchConversationsServer(trimmed, { limit: 20 });
        if (!cancelled) {
          setServerResults(response.results);
          setServerAvailable(true);
        }
      } catch {
        if (!cancelled) {
          setServerResults([]);
          setServerAvailable(false);
        }
      } finally {
        if (!cancelled) setIsSearching(false);
      }
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [isOpen, query]);

  const localResults = useMemo(
    () => localSearch(conversations, query),
    [conversations, query]
  );

  const results = useMemo(() => {
    const merged = new Map<string, ConversationSearchResult>();
    for (const result of localResults) merged.set(result.conversationId, result);
    for (const result of serverResults) {
      const existing = merged.get(result.conversationId);
      if (!existing || result.score >= existing.score) merged.set(result.conversationId, result);
    }
    return Array.from(merged.values())
      .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
      .slice(0, 20);
  }, [localResults, serverResults]);

  useEffect(() => {
    setActiveIndex(index => Math.min(index, Math.max(results.length - 1, 0)));
  }, [results.length]);

  const projectName = (projectId?: string) =>
    projectId ? projects.find(project => project.id === projectId)?.name : undefined;

  const choose = (result: ConversationSearchResult) => {
    onClose();
    onSelectChat(result.conversationId, result.messageId || undefined);
  };

  if (typeof document === 'undefined') return null;

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-[220] flex items-start justify-center bg-stone-950/25 px-3 pt-[8vh] backdrop-blur-[3px] dark:bg-black/55"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reducedMotion ? 0.08 : 0.16 }}
          onMouseDown={event => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Search Aira conversations"
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -12, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.99 }}
            transition={reducedMotion ? { duration: 0.08 } : { type: 'spring', stiffness: 360, damping: 31 }}
            className="w-full max-w-[720px] overflow-hidden rounded-[22px] border border-claude-border-light bg-white/97 shadow-[0_32px_100px_-32px_rgba(28,25,23,0.62)] backdrop-blur-2xl dark:border-claude-border-dark dark:bg-[#1c1b18]/97 dark:shadow-[0_32px_100px_-32px_rgba(0,0,0,0.9)]"
          >
            <div className="flex items-center gap-3 border-b border-claude-border-light px-4 dark:border-claude-border-dark">
              <Search className="h-4 w-4 shrink-0 text-claude-muted-light dark:text-claude-muted-dark" />
              <input
                ref={inputRef}
                value={query}
                onChange={event => {
                  setQuery(event.target.value);
                  setActiveIndex(0);
                }}
                onKeyDown={event => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    onClose();
                  }
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    setActiveIndex(index => results.length ? (index + 1) % results.length : 0);
                  }
                  if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    setActiveIndex(index => results.length ? (index - 1 + results.length) % results.length : 0);
                  }
                  if (event.key === 'Enter' && results[activeIndex]) {
                    event.preventDefault();
                    choose(results[activeIndex]);
                  }
                }}
                placeholder="Search titles and everything inside your chats..."
                className="h-16 min-w-0 flex-1 bg-transparent text-[15px] text-claude-text-light outline-none placeholder:text-claude-muted-light/60 dark:text-white dark:placeholder:text-claude-muted-dark/60"
              />
              {isSearching && (
                <span className="text-[10px] font-medium text-claude-muted-light dark:text-claude-muted-dark">
                  Searching…
                </span>
              )}
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg p-1.5 text-claude-muted-light transition hover:bg-claude-surface2-light hover:text-claude-text-light dark:text-claude-muted-dark dark:hover:bg-claude-surface2-dark dark:hover:text-white"
                aria-label="Close search"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex items-center justify-between border-b border-claude-border-light/70 px-4 py-2 text-[10px] text-claude-muted-light dark:border-claude-border-dark/70 dark:text-claude-muted-dark">
              <span>{query.trim().length < 2 ? 'Type at least 2 characters' : `${results.length} conversation${results.length === 1 ? '' : 's'} found`}</span>
              <span>{serverAvailable ? 'Full-content search' : 'Local fallback active'}</span>
            </div>

            <div className="max-h-[62vh] overflow-y-auto p-2">
              {query.trim().length < 2 ? (
                <div className="px-5 py-12 text-center">
                  <Search className="mx-auto h-6 w-6 text-claude-muted-light/60 dark:text-claude-muted-dark/60" />
                  <div className="mt-3 text-[13px] font-semibold text-claude-text-light dark:text-white">
                    Search your conversation history
                  </div>
                  <div className="mt-1 text-[11px] text-claude-muted-light dark:text-claude-muted-dark">
                    Search titles, your prompts and Aira responses.
                  </div>
                </div>
              ) : results.length ? (
                <div className="space-y-1">
                  {results.map((result, index) => {
                    const project = projectName(result.projectId);
                    return (
                      <button
                        key={`${result.conversationId}:${result.messageId}`}
                        type="button"
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => choose(result)}
                        className="relative flex w-full gap-3 rounded-[14px] px-3 py-3 text-left outline-none"
                      >
                        {activeIndex === index && (
                          <motion.span
                            layoutId="aira-conversation-search-active"
                            className="absolute inset-0 rounded-[14px] bg-claude-surface2-light dark:bg-claude-surface2-dark"
                            transition={reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 34 }}
                          />
                        )}
                        <span className={`relative z-10 mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] border ${
                          activeIndex === index
                            ? 'border-claude-terracotta/20 bg-claude-terracotta/10 text-claude-terracotta'
                            : 'border-claude-border-light bg-white text-claude-muted-light dark:border-claude-border-dark dark:bg-claude-surface-dark dark:text-claude-muted-dark'
                        }`}>
                          <MessageSquareText className="h-4 w-4" />
                        </span>
                        <span className="relative z-10 min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-[13px] font-semibold text-claude-text-light dark:text-white">
                              <HighlightedText text={result.title} query={query} />
                            </span>
                            {result.isPinned && <Bookmark className="h-3 w-3 shrink-0 fill-claude-terracotta text-claude-terracotta" />}
                          </span>
                          <span className="mt-1 line-clamp-2 text-[11px] leading-5 text-claude-muted-light dark:text-claude-muted-dark">
                            <HighlightedText text={result.snippet} query={query} />
                          </span>
                          <span className="mt-1.5 flex items-center gap-2 text-[9px] uppercase tracking-[0.08em] text-claude-muted-light/80 dark:text-claude-muted-dark/80">
                            <span>{result.role === 'user' ? 'You' : 'Aira'}</span>
                            <span>·</span>
                            <span>{new Date(result.messageCreatedAt).toLocaleDateString()}</span>
                            {project && (
                              <>
                                <span>·</span>
                                <span className="inline-flex min-w-0 items-center gap-1 normal-case tracking-normal">
                                  <FolderGit2 className="h-2.5 w-2.5" />
                                  <span className="max-w-[180px] truncate">{project}</span>
                                </span>
                              </>
                            )}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="px-5 py-12 text-center">
                  <div className="text-[13px] font-semibold text-claude-text-light dark:text-white">No matching conversations</div>
                  <div className="mt-1 text-[11px] text-claude-muted-light dark:text-claude-muted-dark">
                    Try another phrase, filename, branch, error code or topic.
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-claude-border-light bg-claude-surface2-light/60 px-4 py-2 text-[10px] text-claude-muted-light dark:border-claude-border-dark dark:bg-claude-surface2-dark/50 dark:text-claude-muted-dark">
              <span>↑↓ Navigate · Enter Open · Esc Close</span>
              <span>Search includes message content</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
};
