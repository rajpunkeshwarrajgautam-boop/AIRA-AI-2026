import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import {
  Plus,
  FolderGit2,
  Settings,
  Search,
  ChevronDown,
  PanelLeftClose,
  Sun,
  Moon,
  Laptop,
  MessageSquareText,
  ShieldCheck,
} from 'lucide-react';
import { motion, AnimatePresence, Variants } from 'framer-motion';
import type { Conversation, Project, AppSettings, WorkspaceMode } from '../types';
import { AiraMark } from './AiraMark';
import { ConversationActionsDropdown } from './ConversationActionsDropdown';
import { AccountMenuDropdown } from './AccountMenuDropdown';
import { neonAuth, NeonUser } from '../lib/neonAuth';
import type { PlanTier } from '../types/commercial-types';

interface SidebarProps {
  conversations: Conversation[];
  activeChatId: string;
  onSelectChat: (id: string) => void;
  onNewChat: () => void;
  onDeleteChat: (id: string) => void;
  onRenameChat: (id: string, newTitle: string) => void;
  onToggleStar: (id: string) => void;
  onDuplicateChat: (id: string) => void;
  onShareChat: (id: string) => void | Promise<void>;
  projects: Project[];
  activeProjectId?: string;
  onOpenProjects: () => void;
  onOpenSettings: (tab?: string) => void;
  onOpenAuth?: () => void;
  onOpenSearch: (query?: string) => void;
  isOpen: boolean;
  onToggleOpen: () => void;
  onClose?: () => void;
  settings: AppSettings;
  onUpdateSettings: (settings: Partial<AppSettings>) => void;
  workspaceMode: WorkspaceMode;
  onSelectWorkspace: (mode: WorkspaceMode) => void;
  onOpenVisionStudio?: () => void;
  onOpenPricing?: () => void;
  onOpenBilling?: () => void;
  onOpenHelpCenter?: () => void;
  onOpenPrivacyCenter?: () => void;
  onOpenReleaseNotes?: () => void;
  onOpenDownloadApps?: () => void;
  onOpenShortcuts?: () => void;
  onOpenLegalViewer?: (doc: 'terms' | 'privacy') => void;
  onOpenReportBug?: () => void;
  userTier?: PlanTier;
  onOpenWhatsNew?: () => void;
  onRestartOnboarding?: () => void;
  unreadAnnouncementsCount?: number;
}

const listVariants: Variants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.05 }
  }
};

const itemVariants: Variants = {
  hidden: { opacity: 0, x: -10 },
  show: { opacity: 1, x: 0, transition: { type: "spring", stiffness: 300, damping: 24 } }
};

const ThemeToggle = ({ theme, onChange }: { theme: 'light' | 'dark' | 'system', onChange: (theme: 'light' | 'dark' | 'system') => void }) => {
  const options = [
    { id: 'light', icon: Sun },
    { id: 'system', icon: Laptop },
    { id: 'dark', icon: Moon },
  ] as const;

  return (
    <div className="flex items-center gap-0.5 bg-claude-surface-light p-1 rounded-[10px] border border-claude-border-light dark:border-claude-border-dark relative overflow-hidden">
      {options.map(({ id, icon: Icon }) => (
        <button
          key={id}
          type="button"
          aria-label={`Use ${id} theme`}
          aria-pressed={theme === id}
          onClick={() => onChange(id)}
          className={`relative p-2 rounded-[8px] flex items-center justify-center transition-colors duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-claude-terracotta ${
            theme === id 
              ? 'text-claude-onAccent'
              : 'text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light dark:hover:text-white'
          }`}
          title={id.charAt(0).toUpperCase() + id.slice(1)}
        >
          {theme === id && (
            <motion.div
              layoutId="theme-active-pill"
              className="absolute inset-0 bg-claude-terracotta-hover rounded-[8px]"
              transition={{ type: "spring", stiffness: 400, damping: 25 }}
            />
          )}
          <Icon className="w-4 h-4 relative z-10" />
        </button>
      ))}
    </div>
  );
};

export const Sidebar: React.FC<SidebarProps> = ({
  conversations,
  activeChatId,
  onSelectChat,
  onNewChat,
  onDeleteChat,
  onRenameChat,
  onToggleStar,
  onDuplicateChat,
  onShareChat,
  projects,
  activeProjectId,
  onOpenProjects,
  onOpenSettings,
  onOpenAuth,
  onOpenSearch,
  isOpen,
  onToggleOpen,
  onClose,
  settings,
  onUpdateSettings,
  workspaceMode: _workspaceMode,
  onSelectWorkspace,
  onOpenVisionStudio: _onOpenVisionStudio,
  onOpenPricing,
  onOpenBilling,
  onOpenHelpCenter,
  onOpenPrivacyCenter,
  onOpenReleaseNotes,
  onOpenDownloadApps,
  onOpenShortcuts,
  onOpenLegalViewer,
  onOpenReportBug,
  userTier = 'free',
  onOpenWhatsNew,
  onRestartOnboarding,
  unreadAnnouncementsCount,
}) => {
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
  const accountButtonRef = useRef<HTMLButtonElement>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [neonUser, setNeonUser] = useState<NeonUser | null>(() => neonAuth.getCurrentUser());
  const drawerRef = useRef<HTMLElement>(null);

  const prefersReducedMotion = useMemo(() => {
    return typeof window !== 'undefined' && Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }, []);

  const handleClose = useCallback(() => {
    if (onClose) {
      onClose();
    } else {
      onToggleOpen();
    }
  }, [onClose, onToggleOpen]);

  useEffect(() => {
    return neonAuth.onAuthStateChange((user) => setNeonUser(user));
  }, []);

  // Temporary navigation behaves as a keyboard-accessible drawer.
  useEffect(() => {
    if (!isOpen || (typeof window !== 'undefined' && window.innerWidth >= 1280)) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', handleEscape);
    const closeButton = drawerRef.current?.querySelector<HTMLButtonElement>('[aria-label="Close sidebar navigation"]');
    closeButton?.focus({ preventScroll: true });
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, handleClose]);
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [starredExpanded, setStarredExpanded] = useState(true);

  const [now] = useState(() => Date.now());

  const { starred, grouped } = useMemo(() => {
    const filtered = conversations.filter(c => c.title.toLowerCase().includes(searchQuery.toLowerCase()));
    const oneDay = 24 * 60 * 60 * 1000;
    const sevenDays = 7 * oneDay;
    const starredList = filtered.filter(c => c.isPinned);
    const unstarred = filtered.filter(c => !c.isPinned);
    const today: Conversation[] = [];
    const yesterday: Conversation[] = [];
    const previous7Days: Conversation[] = [];
    const older: Conversation[] = [];

    unstarred.forEach(c => {
      const diff = now - c.updatedAt;
      if (diff < oneDay) today.push(c);
      else if (diff < 2 * oneDay) yesterday.push(c);
      else if (diff < sevenDays) previous7Days.push(c);
      else older.push(c);
    });

    return {
      starred: starredList,
      grouped: [
        { title: 'Today', list: today },
        { title: 'Yesterday', list: yesterday },
        { title: 'Previous 7 days', list: previous7Days },
        { title: 'Older', list: older },
      ].filter(g => g.list.length > 0),
    };
  }, [conversations, searchQuery, now]);

  const handleStartRename = (c: Conversation) => {
    setEditingChatId(c.id);
    setEditTitle(c.title);
  };

  const handleSaveRename = (id: string) => {
    if (editTitle.trim()) onRenameChat(id, editTitle.trim());
    setEditingChatId(null);
  };

  const handleSelectChatMobile = (id: string) => {
    onSelectChat(id);
    if (typeof window !== 'undefined' && window.innerWidth < 1280) {
      handleClose();
    }
  };

  const handleNewChatMobile = () => {
    onSelectWorkspace('chat');
    onNewChat();
    if (typeof window !== 'undefined' && window.innerWidth < 1280) {
      handleClose();
    }
  };

  const renderChatItem = (c: Conversation) => (
    <motion.div
      variants={itemVariants}
      key={c.id}
      onClick={() => handleSelectChatMobile(c.id)}
      className={`group flex items-center px-3 py-2.5 rounded-lg cursor-pointer transition-colors duration-200 relative ${activeChatId === c.id ? 'text-claude-text-light dark:text-white' : 'text-claude-muted-light dark:text-claude-muted-dark hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark hover:text-claude-text-light dark:hover:text-white'}`}
    >
      {activeChatId === c.id && (
        <motion.div 
          layoutId="active-chat-indicator"
          className="absolute inset-0 bg-claude-surface2-light dark:bg-claude-surface2-dark rounded-lg border border-claude-border-light dark:border-claude-border-dark z-0"
          transition={{ type: "spring", stiffness: 400, damping: 30 }}
        />
      )}
      <div className="relative z-10 flex items-center w-full min-w-0">
        <MessageSquareText className="w-4 h-4 flex-shrink-0 mr-3 opacity-70" />
        {editingChatId === c.id ? (
          <input
            autoFocus
            value={editTitle}
            onChange={e => setEditTitle(e.target.value)}
            onClick={e => e.stopPropagation()}
            onBlur={() => handleSaveRename(c.id)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleSaveRename(c.id);
              if (e.key === 'Escape') setEditingChatId(null);
            }}
            className="flex-1 min-w-0 text-[13px] font-medium bg-transparent outline-none border-b border-claude-terracotta"
          />
        ) : (
          <span className="text-[13px] font-medium truncate flex-1 tracking-tight">{c.title}</span>
        )}
        <ConversationActionsDropdown
          conversationId={c.id}
          isPinned={c.isPinned}
          visible={activeChatId === c.id}
          onToggleStar={() => onToggleStar(c.id)}
          onRename={() => handleStartRename(c)}
          onDuplicate={() => onDuplicateChat(c.id)}
          onShare={() => onShareChat(c.id)}
          onDelete={() => onDeleteChat(c.id)}
        />
      </div>
    </motion.div>
  );

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div 
          key="sidebar-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, pointerEvents: 'none' }}
          transition={prefersReducedMotion ? { duration: 0 } : undefined}
          style={{ pointerEvents: isOpen ? 'auto' : 'none' }}
          onClick={handleClose}
          className="fixed inset-0 bg-stone-900/40 dark:bg-black/60 backdrop-blur-sm z-[60] xl:hidden"
          aria-hidden="true"
        />
      )}
      {isOpen && (
        <motion.aside 
          key="sidebar-drawer"
          ref={drawerRef}
          data-testid="sidebar-drawer"
          aria-label="Workspace navigation"
          initial={{ x: -320, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: -320, opacity: 0, pointerEvents: 'none' }}
          transition={prefersReducedMotion ? { duration: 0 } : { type: "spring", stiffness: 320, damping: 32 }}
          style={{ pointerEvents: isOpen ? 'auto' : 'none' }}
          className="aira-sidebar-shell fixed inset-y-0 left-0 z-[70] xl:relative xl:z-30 w-[min(19rem,100vw)] xl:w-[272px] h-[100dvh] min-h-0 overflow-hidden flex flex-col bg-claude-surface-light dark:bg-claude-surface-dark border-r border-claude-border-light dark:border-claude-border-dark select-none flex-shrink-0 shadow-2xl xl:shadow-none"
        >
            <div className="shrink-0 p-5 pb-3 flex items-center justify-between">
              <div className="flex items-center space-x-2.5">
                <AiraMark size="md" isAnimated={true} motionConcept="a" />
                <div>
                  <div className="font-serif font-normal text-[24px] tracking-tight text-claude-text-light dark:text-claude-text-dark leading-none">Aira</div>
                </div>
              </div>
              <button type="button" aria-label="Close sidebar navigation" onClick={handleClose} className="p-1.5 rounded-lg text-claude-muted-light dark:text-claude-muted-dark hover:bg-claude-surface-light dark:hover:bg-claude-surface-dark hover:text-claude-text-light dark:hover:text-claude-text-dark transition-colors" title="Close sidebar">
                <PanelLeftClose className="w-4 h-4" />
              </button>
            </div>

            <div className="shrink-0 px-3.5 py-1.5">
              <button onClick={handleNewChatMobile} className="w-full flex items-center justify-between px-3.5 py-2.5 rounded-lg bg-claude-terracotta-hover hover:bg-claude-terracotta text-claude-onAccent text-[13px] font-medium transition-colors active:scale-[0.99] group">
                <div className="flex items-center space-x-2.5">
                  <Plus className="w-4 h-4" />
                  <span>Start new chat</span>
                </div>
                <kbd className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-current/20 bg-black/5">Ctrl N</kbd>
              </button>
            </div>

          {/* Navigation, search and all conversation groups share one genuine touch-scroll surface. */}
          <div data-testid="sidebar-scroll-region" className="aira-sidebar-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain touch-pan-y">
          <div className="px-3.5 pt-2 pb-1 space-y-1">
            <button
              onClick={onOpenProjects}
              className={`w-full flex items-center justify-between px-3.5 py-2 rounded-xl text-[13px] font-semibold transition-all duration-300 ${activeProjectId ? 'bg-claude-surface-light dark:bg-claude-surface-dark text-claude-text-light dark:text-white shadow-[0_2px_10px_-4px_rgba(0,0,0,0.05)] border border-claude-border-light dark:border-claude-border-dark' : 'text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light dark:hover:text-white hover:bg-claude-surface-light dark:hover:bg-claude-surface-dark border border-transparent'}`}
            >
              <span className="flex items-center gap-2.5">
                <FolderGit2 className="w-4 h-4 text-claude-accentInk" />
                <span>Projects</span>
              </span>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-claude-surface2-light dark:bg-claude-surface2-dark text-claude-muted-light dark:text-claude-muted-dark">
                {projects.length}
              </span>
            </button>
          </div>

          <div className="px-4 pt-4 pb-2">
            <div className="relative flex items-center group">
              <button
                type="button"
                onClick={() => onOpenSearch(searchQuery)}
                className="absolute left-2.5 z-10 rounded-md p-1 text-claude-muted-light transition-colors hover:text-claude-accentInk dark:text-claude-muted-dark"
                title="Search all conversation content"
                aria-label="Search all conversation content"
              >
                <Search className="w-4 h-4" />
              </button>
              <input
                type="text"
                placeholder="Search workspace..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    onOpenSearch(searchQuery);
                  }
                }}
                className="w-full text-[13px] font-medium pl-10 pr-4 py-2.5 rounded-xl bg-claude-surface-light dark:bg-claude-surface-dark border border-claude-border-light dark:border-claude-border-dark placeholder-claude-muted-light dark:placeholder-claude-muted-dark focus:outline-none focus:border-claude-terracotta/50 text-claude-text-light dark:text-white transition-all duration-300"
              />
            </div>
            <button
              type="button"
              onClick={() => onOpenSearch(searchQuery)}
              className="mt-1.5 w-full px-1 text-left text-[10px] font-medium text-claude-muted-light/80 transition-colors hover:text-claude-accentInk dark:text-claude-muted-dark/80"
            >
              Search inside messages · Enter
            </button>
          </div>

          <div className="px-3 pt-3 pb-4">
            <motion.div variants={listVariants} initial="hidden" animate="show" className="space-y-6">
              {starred.length > 0 && (
                <div>
                  <button onClick={() => setStarredExpanded(!starredExpanded)} className="flex items-center space-x-2 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.15em] text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light dark:hover:text-white w-full transition-colors">
                    <motion.div animate={{ rotate: starredExpanded ? 0 : -90 }} transition={{ type: "spring", stiffness: 200, damping: 20 }}>
                      <ChevronDown className="w-3.5 h-3.5" />
                    </motion.div>
                    <span>Bookmarked</span>
                    <span className="text-[10px] tabular-nums font-mono bg-claude-surface2-light dark:bg-claude-surface2-dark px-1.5 py-0.5 rounded-md ml-auto">{starred.length}</span>
                  </button>
                  <AnimatePresence initial={false}>
                    {starredExpanded && (
                      <motion.div 
                        variants={{
                          hidden: { height: 0, opacity: 0 },
                          show: { height: 'auto', opacity: 1 }
                        }}
                        initial="hidden" 
                        animate="show" 
                        exit="hidden" 
                        className="mt-2 space-y-1 overflow-hidden"
                      >
                        {starred.map(renderChatItem)}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )}
              {grouped.map(group => (
                <div key={group.title}>
                  <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.15em] text-claude-muted-light dark:text-claude-muted-dark">{group.title}</div>
                  <div className="mt-1 space-y-1">{group.list.map(renderChatItem)}</div>
                </div>
              ))}
            </motion.div>
          </div>

          </div>

          <div data-testid="sidebar-footer" className="aira-sidebar-footer relative z-20 shrink-0 p-3 bg-claude-surface-light dark:bg-claude-surface-dark border-t border-claude-border-light dark:border-claude-border-dark">
            <div className="flex flex-col gap-2">
              <button
                type="button"
                data-testid="sidebar-plan-badge"
                onClick={() => onOpenSettings('plan')}
                className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-xl bg-claude-surface2-light/60 dark:bg-white/[0.04] border border-claude-border-light/60 dark:border-white/10 hover:border-claude-terracotta/40 transition-all text-left group"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${
                    userTier === 'pro' ? 'bg-purple-500' : userTier === 'plus' ? 'bg-amber-500' : userTier === 'free' ? 'bg-emerald-500' : 'bg-stone-400'
                  }`} />
                  <span className="text-[11px] font-bold text-claude-text-light dark:text-white truncate">
                    {userTier === 'pro' ? 'AIRA Pro' : userTier === 'plus' ? 'AIRA Plus' : userTier === 'free' ? 'AIRA Free' : 'Guest Workspace'}
                  </span>
                </div>
                <span className="text-[10px] font-bold text-claude-accentInk group-hover:underline flex items-center gap-0.5 shrink-0">
                  <span>Usage</span>
                  <ChevronDown className="w-3 h-3 -rotate-90" />
                </span>
              </button>

              <div className="flex items-center gap-1.5">
                <div className="relative flex-1 min-w-0">
                <button
                  ref={accountButtonRef}
                  type="button"
                  data-testid="account-button"
                  aria-haspopup="menu"
                  aria-expanded={isAccountMenuOpen}
                  aria-label={neonUser ? "Open user account and help menu" : "Sign in to account and workspace menu"}
                  onClick={() => setIsAccountMenuOpen(prev => !prev)}
                  className="flex w-full min-w-0 items-center space-x-2.5 p-2 rounded-xl hover:bg-claude-surface-light dark:hover:bg-claude-surface-dark border border-claude-border-light/60 dark:border-claude-border-dark/60 transition-all text-left active:scale-[0.98]"
                >
                  <div className="w-7 h-7 rounded-[8px] bg-claude-terracotta-hover text-claude-onAccent font-semibold text-xs flex items-center justify-center flex-shrink-0 overflow-hidden">
                    {neonUser?.image ? (
                      <img src={neonUser.image} alt={neonUser.name || 'User'} className="w-full h-full object-cover" />
                    ) : neonUser ? (
                      neonUser.name ? neonUser.name.slice(0, 2).toUpperCase() : 'AI'
                    ) : (
                      <ShieldCheck className="w-3.5 h-3.5" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[12px] font-bold text-claude-text-light dark:text-white tracking-tight truncate">
                      {neonUser ? neonUser.name || neonUser.email || 'Authenticated User' : 'Guest Workspace'}
                    </div>
                    <div className="text-[10px] font-medium text-claude-muted-light dark:text-claude-muted-dark flex items-center space-x-1">
                      {neonUser ? (
                        <>
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                          <span>Account & Billing</span>
                        </>
                      ) : (
                        <span>Sign in · Persistent sync</span>
                      )}
                    </div>
                  </div>
                </button>

                <AccountMenuDropdown
                  isOpen={isAccountMenuOpen}
                  onClose={() => setIsAccountMenuOpen(false)}
                  neonUser={neonUser}
                  settings={settings}
                  anchorRef={accountButtonRef}
                  onOpenSettings={(tab) => {
                    onOpenSettings(tab);
                    setIsAccountMenuOpen(false);
                  }}
                  onOpenBilling={() => {
                    onOpenBilling?.();
                    setIsAccountMenuOpen(false);
                  }}
                  onOpenPricing={() => {
                    onOpenPricing?.();
                    setIsAccountMenuOpen(false);
                  }}
                  onOpenAuth={() => {
                    onOpenAuth?.();
                    setIsAccountMenuOpen(false);
                  }}
                  onOpenHelpCenter={() => {
                    onOpenHelpCenter?.();
                    setIsAccountMenuOpen(false);
                  }}
                  onOpenPrivacyCenter={() => {
                    onOpenPrivacyCenter?.();
                    setIsAccountMenuOpen(false);
                  }}
                  onOpenReleaseNotes={() => {
                    onOpenReleaseNotes?.();
                    setIsAccountMenuOpen(false);
                  }}
                  onOpenDownloadApps={() => {
                    onOpenDownloadApps?.();
                    setIsAccountMenuOpen(false);
                  }}
                  onOpenShortcuts={() => {
                    onOpenShortcuts?.();
                    setIsAccountMenuOpen(false);
                  }}
                  onOpenLegalViewer={(doc) => {
                    onOpenLegalViewer?.(doc);
                    setIsAccountMenuOpen(false);
                  }}
                  onOpenReportBug={() => {
                    onOpenReportBug?.();
                    setIsAccountMenuOpen(false);
                  }}
                  onSignOutSuccess={() => {
                    setNeonUser(null);
                    setIsAccountMenuOpen(false);
                  }}
                  onOpenWhatsNew={() => {
                    onOpenWhatsNew?.();
                    setIsAccountMenuOpen(false);
                  }}
                  onRestartOnboarding={() => {
                    onRestartOnboarding?.();
                    setIsAccountMenuOpen(false);
                  }}
                  unreadAnnouncementsCount={unreadAnnouncementsCount}
                />
                </div>

                <button
                  type="button"
                  aria-label="Open settings"
                  onClick={() => onOpenSettings('general')}
                  className="p-2 rounded-xl hover:bg-claude-surface-light dark:hover:bg-claude-surface-dark border border-claude-border-light/60 dark:border-claude-border-dark/60 text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light transition-all"
                  title="Settings"
                >
                  <Settings className="w-4 h-4" />
                </button>
              </div>

              <div className="flex items-center justify-between gap-2 px-1">
                <span className="text-xs font-semibold text-claude-muted-light dark:text-claude-muted-dark">Theme</span>
                <ThemeToggle theme={settings.theme} onChange={(t) => onUpdateSettings({ theme: t })} />
              </div>
            </div>
          </div>
          </motion.aside>
      )}
    </AnimatePresence>
  );
};
