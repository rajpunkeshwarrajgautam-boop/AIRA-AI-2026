import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bot,
  Command,
  FolderGit2,
  Library,
  MessageSquareText,
  Plus,
  Search,
  Settings,
  Telescope,
  Workflow,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { Conversation, Project, WorkspaceMode } from '../types';

interface CommandPaletteProps {
  isOpen: boolean;
  conversations: Conversation[];
  projects: Project[];
  onClose: () => void;
  onNewChat: () => void;
  onSelectChat: (id: string) => void;
  onSelectWorkspace: (mode: WorkspaceMode) => void;
  onOpenProjects: () => void;
  onOpenSettings: () => void;
}

type PaletteItem = {
  id: string;
  label: string;
  description: string;
  keywords: string;
  icon: React.ReactNode;
  run: () => void;
};

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  conversations,
  projects,
  onClose,
  onNewChat,
  onSelectChat,
  onSelectWorkspace,
  onOpenProjects,
  onOpenSettings,
}) => {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setActiveIndex(0);
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen]);

  const closeAndRun = (run: () => void) => {
    onClose();
    run();
  };

  const items = useMemo<PaletteItem[]>(() => {
    const commands: PaletteItem[] = [
      {
        id: 'new-chat',
        label: 'New chat',
        description: 'Start a fresh Aira conversation',
        keywords: 'new chat task conversation',
        icon: <Plus className="h-4 w-4" />,
        run: onNewChat,
      },
      {
        id: 'mode-chat',
        label: 'Chat workspace',
        description: 'General conversation and problem solving',
        keywords: 'chat workspace',
        icon: <MessageSquareText className="h-4 w-4" />,
        run: () => onSelectWorkspace('chat'),
      },
      {
        id: 'mode-research',
        label: 'Research workspace',
        description: 'Structured investigation and synthesis',
        keywords: 'research investigate citations',
        icon: <Telescope className="h-4 w-4" />,
        run: () => onSelectWorkspace('research'),
      },
      {
        id: 'mode-library',
        label: 'Library workspace',
        description: 'Query workspace knowledge',
        keywords: 'library files knowledge',
        icon: <Library className="h-4 w-4" />,
        run: () => onSelectWorkspace('library'),
      },
      {
        id: 'mode-agents',
        label: 'Agents workspace',
        description: 'Plan and execute autonomous missions',
        keywords: 'agents missions bot',
        icon: <Bot className="h-4 w-4" />,
        run: () => onSelectWorkspace('agents'),
      },
      {
        id: 'mode-automations',
        label: 'Automations workspace',
        description: 'Design trigger-action workflows',
        keywords: 'automations workflow schedule',
        icon: <Workflow className="h-4 w-4" />,
        run: () => onSelectWorkspace('automations'),
      },
      {
        id: 'projects',
        label: 'Open projects',
        description: `${projects.length} project${projects.length === 1 ? '' : 's'} in this workspace`,
        keywords: `projects ${projects.map(project => project.name).join(' ')}`,
        icon: <FolderGit2 className="h-4 w-4" />,
        run: onOpenProjects,
      },
      {
        id: 'settings',
        label: 'Workspace settings',
        description: 'Appearance, intelligence, memory and data',
        keywords: 'settings preferences theme memory',
        icon: <Settings className="h-4 w-4" />,
        run: onOpenSettings,
      },
    ];

    const recentChats = conversations.slice(0, 30).map<PaletteItem>(conversation => ({
      id: `chat-${conversation.id}`,
      label: conversation.title,
      description: conversation.isPinned ? 'Bookmarked conversation' : 'Conversation',
      keywords: `conversation chat ${conversation.title}`,
      icon: <MessageSquareText className="h-4 w-4" />,
      run: () => onSelectChat(conversation.id),
    }));

    return [...commands, ...recentChats];
  }, [conversations, onNewChat, onOpenProjects, onOpenSettings, onSelectChat, onSelectWorkspace, projects]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return items.slice(0, 12);
    return items
      .filter(item => `${item.label} ${item.description} ${item.keywords}`.toLowerCase().includes(normalized))
      .slice(0, 12);
  }, [items, query]);

  useEffect(() => {
    setActiveIndex(index => Math.min(index, Math.max(filtered.length - 1, 0)));
  }, [filtered.length]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-[200] flex items-start justify-center bg-stone-950/20 px-3 pt-[12vh] backdrop-blur-[2px] dark:bg-black/45"
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
            aria-label="Aira command search"
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.985 }}
            transition={reducedMotion ? { duration: 0.08 } : { type: 'spring', stiffness: 360, damping: 30 }}
            className="w-full max-w-[620px] overflow-hidden rounded-[20px] border border-claude-border-light bg-white/95 shadow-[0_28px_80px_-28px_rgba(28,25,23,0.55)] backdrop-blur-2xl dark:border-claude-border-dark dark:bg-[#1c1b18]/95 dark:shadow-[0_28px_90px_-28px_rgba(0,0,0,0.85)]"
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
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    setActiveIndex(index => filtered.length ? (index + 1) % filtered.length : 0);
                  }
                  if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    setActiveIndex(index => filtered.length ? (index - 1 + filtered.length) % filtered.length : 0);
                  }
                  if (event.key === 'Enter' && filtered[activeIndex]) {
                    event.preventDefault();
                    closeAndRun(filtered[activeIndex].run);
                  }
                }}
                placeholder="Search chats, workspaces and actions..."
                className="h-14 min-w-0 flex-1 bg-transparent text-[14px] text-claude-text-light outline-hidden placeholder:text-claude-muted-light/60 dark:text-white dark:placeholder:text-claude-muted-dark/60"
              />
              <div className="hidden items-center gap-1 rounded-lg border border-claude-border-light bg-claude-surface2-light px-2 py-1 text-[10px] font-medium text-claude-muted-light sm:flex dark:border-claude-border-dark dark:bg-claude-surface2-dark dark:text-claude-muted-dark">
                ESC
              </div>
            </div>

            <div className="max-h-[52vh] overflow-y-auto p-2">
              {filtered.length ? (
                <div className="space-y-1">
                  {filtered.map((item, index) => (
                    <button
                      key={item.id}
                      type="button"
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => closeAndRun(item.run)}
                      className="relative flex w-full items-center gap-3 rounded-[12px] px-3 py-2.5 text-left outline-hidden"
                    >
                      {activeIndex === index && (
                        <motion.span
                          layoutId="aira-command-active"
                          className="absolute inset-0 rounded-[12px] bg-claude-surface2-light dark:bg-claude-surface2-dark"
                          transition={reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 34 }}
                        />
                      )}
                      <span className={`relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border ${
                        activeIndex === index
                          ? 'border-claude-terracotta/20 bg-claude-terracotta/10 text-claude-terracotta'
                          : 'border-claude-border-light bg-white text-claude-muted-light dark:border-claude-border-dark dark:bg-claude-surface-dark dark:text-claude-muted-dark'
                      }`}>
                        {item.icon}
                      </span>
                      <span className="relative z-10 min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-semibold text-claude-text-light dark:text-white">{item.label}</span>
                        <span className="mt-0.5 block truncate text-[11px] text-claude-muted-light dark:text-claude-muted-dark">{item.description}</span>
                      </span>
                      {item.id === 'new-chat' && (
                        <span className="relative z-10 hidden items-center gap-1 text-[10px] font-mono text-claude-muted-light sm:flex dark:text-claude-muted-dark">
                          <Command className="h-3 w-3" /> N
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="px-4 py-10 text-center">
                  <div className="text-[13px] font-medium text-claude-text-light dark:text-white">No matching command</div>
                  <div className="mt-1 text-[11px] text-claude-muted-light dark:text-claude-muted-dark">Try a chat title, workspace, project or action.</div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-claude-border-light bg-claude-surface2-light/60 px-4 py-2 text-[10px] text-claude-muted-light dark:border-claude-border-dark dark:bg-claude-surface2-dark/50 dark:text-claude-muted-dark">
              <span>↑↓ Navigate · Enter Select</span>
              <span>Ctrl/⌘ K Command Search</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
};
