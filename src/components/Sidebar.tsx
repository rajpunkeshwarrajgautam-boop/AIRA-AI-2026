import React, { useState, useMemo } from 'react';
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
  Telescope,
  Library,
  Bot,
  Workflow,
  MessageSquareText,
} from 'lucide-react';
import { motion, AnimatePresence, Variants } from 'framer-motion';
import type { Conversation, Project, AppSettings, WorkspaceMode } from '../types';
import { AiraMark } from './AiraMark';
import { ConversationActionsDropdown } from './ConversationActionsDropdown';

interface SidebarProps {
  conversations: Conversation[];
  activeChatId: string;
  onSelectChat: (id: string) => void;
  onNewChat: () => void;
  onDeleteChat: (id: string) => void;
  onRenameChat: (id: string, newTitle: string) => void;
  onToggleStar: (id: string) => void;
  projects: Project[];
  activeProjectId?: string;
  onOpenProjects: () => void;
  onOpenSettings: () => void;
  isOpen: boolean;
  onToggleOpen: () => void;
  settings: AppSettings;
  onUpdateSettings: (settings: Partial<AppSettings>) => void;
  workspaceMode: WorkspaceMode;
  onSelectWorkspace: (mode: WorkspaceMode) => void;
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
    { id: 'light', icon: Sun, colorClass: 'from-[#eb6e4b] to-[#d97757]', shadowClass: 'shadow-[0_2px_8px_-2px_rgba(235,110,75,0.4)]' },
    { id: 'system', icon: Laptop, colorClass: 'from-slate-500 to-slate-600', shadowClass: 'shadow-[0_2px_8px_-2px_rgba(100,116,139,0.4)]' },
    { id: 'dark', icon: Moon, colorClass: 'from-indigo-500 to-purple-600', shadowClass: 'shadow-[0_2px_8px_-2px_rgba(99,102,241,0.4)]' },
  ] as const;

  return (
    <div className="flex items-center gap-0.5 bg-claude-surface-light dark:bg-black/30 p-1 rounded-[14px] border border-claude-border-light dark:border-claude-border-dark shadow-inner relative overflow-hidden">
      {/* Subtle inner shadow for depth */}
      <div className="absolute inset-0 shadow-[inset_0_1px_4px_rgba(0,0,0,0.05)] dark:shadow-[inset_0_1px_5px_rgba(0,0,0,0.3)] pointer-events-none rounded-[14px]"></div>
      
      {options.map(({ id, icon: Icon, colorClass, shadowClass }) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          className={`relative p-2 rounded-xl flex items-center justify-center transition-all duration-300 outline-none ${
            theme === id 
              ? 'text-white' 
              : 'text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light dark:hover:text-white'
          }`}
          title={id.charAt(0).toUpperCase() + id.slice(1)}
        >
          {theme === id && (
            <motion.div
              layoutId="theme-active-pill"
              className={`absolute inset-0 bg-gradient-to-br ${colorClass} rounded-[10px] ${shadowClass}`}
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
  projects,
  activeProjectId,
  onOpenProjects,
  onOpenSettings,
  isOpen,
  onToggleOpen,
  settings,
  onUpdateSettings,
  workspaceMode,
  onSelectWorkspace,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
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

  const handleStartRename = (c: Conversation, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingChatId(c.id);
    setEditTitle(c.title);
  };

  const handleSaveRename = (id: string) => {
    if (editTitle.trim()) onRenameChat(id, editTitle.trim());
    setEditingChatId(null);
  };

  const handleSelectChatMobile = (id: string) => {
    onSelectChat(id);
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      onToggleOpen();
    }
  };

  const handleNewChatMobile = () => {
    onSelectWorkspace('chat');
    onNewChat();
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      onToggleOpen();
    }
  };

  const navItem = (mode: WorkspaceMode, label: string, icon: React.ReactNode, badge?: string) => (
    <button
      onClick={() => {
        onSelectWorkspace(mode);
        if (typeof window !== 'undefined' && window.innerWidth < 768) onToggleOpen();
      }}
      className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-[13px] font-semibold transition-all duration-300 ${workspaceMode === mode ? 'bg-claude-surface-light dark:bg-claude-surface-dark text-claude-text-light dark:text-white shadow-[0_2px_10px_-4px_rgba(0,0,0,0.05)] border border-claude-border-light dark:border-claude-border-dark' : 'text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light dark:hover:text-white hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark border border-transparent'}`}
    >
      <span className="flex items-center gap-3">{icon}<span>{label}</span></span>
      {badge && <span className="text-[9px] uppercase tracking-wider font-bold px-2 py-0.5 rounded-md bg-claude-surface2-light dark:bg-claude-surface2-dark text-claude-muted-light dark:text-claude-muted-dark">{badge}</span>}
    </button>
  );

  const renderChatItem = (c: Conversation) => (
    <motion.div
      variants={itemVariants}
      key={c.id}
      onClick={() => handleSelectChatMobile(c.id)}
      className={`group flex items-center px-3 py-2.5 rounded-xl cursor-pointer transition-all duration-300 relative ${activeChatId === c.id ? 'text-claude-text-light dark:text-white' : 'text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light dark:hover:text-white'}`}
    >
      {activeChatId === c.id && (
        <motion.div 
          layoutId="active-chat-indicator"
          className="absolute inset-0 bg-gradient-to-r from-claude-surface-light via-claude-surface-light to-claude-surface2-light/60 dark:from-claude-surface-dark dark:via-claude-surface-dark dark:to-claude-surface2-dark/60 rounded-xl shadow-[0_2px_10px_-4px_rgba(0,0,0,0.05)] border border-claude-border-light dark:border-claude-border-dark z-0"
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
          onRename={() => {
            setEditingChatId(c.id);
            setEditTitle(c.title);
          }}
          onDelete={() => onDeleteChat(c.id)}
        />
      </div>
    </motion.div>
  );

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Mobile backdrop */}
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onToggleOpen}
            className="fixed inset-0 bg-stone-900/40 dark:bg-black/60 backdrop-blur-sm z-40 md:hidden"
            aria-hidden="true"
          />
          <motion.aside 
            initial={{ x: -320, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: -320, opacity: 0 }}
            transition={{ type: "spring", stiffness: 320, damping: 32 }}
            className="fixed inset-y-0 left-0 z-50 md:relative md:z-30 w-72 md:w-80 h-[100dvh] flex flex-col bg-claude-surface2-light dark:bg-claude-surface2-dark border-r border-claude-border-light dark:border-claude-border-dark select-none flex-shrink-0 shadow-2xl md:shadow-none"
          >
            <div className="p-4 pb-3 flex items-center justify-between">
              <div className="flex items-center space-x-2.5">
                <AiraMark size="md" />
                <div>
                  <div className="font-serif font-medium text-[19px] tracking-tight text-claude-text-light dark:text-claude-text-dark leading-none">Aira</div>
                </div>
              </div>
              <button onClick={onToggleOpen} className="p-1.5 rounded-lg text-claude-muted-light dark:text-claude-muted-dark hover:bg-claude-surface-light dark:hover:bg-claude-surface-dark hover:text-claude-text-light dark:hover:text-claude-text-dark transition-colors" title="Close sidebar">
                <PanelLeftClose className="w-4 h-4" />
              </button>
            </div>

            <div className="px-3.5 py-1.5">
              <button onClick={handleNewChatMobile} className="w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl bg-gradient-to-b from-white/95 to-white/80 dark:from-[#2A2926] dark:to-[#22211F] border border-claude-border-light dark:border-claude-border-dark text-claude-text-light dark:text-claude-text-dark text-[13px] font-medium transition-all shadow-[0_1px_3px_rgba(45,40,30,0.04)] hover:border-claude-terracotta/40 hover:shadow-[0_4px_14px_-2px_rgba(217,119,87,0.12)] active:scale-[0.98] group">
                <div className="flex items-center space-x-2.5">
                  <Plus className="w-4 h-4 text-claude-terracotta" />
                  <span>Start new chat</span>
                </div>
                <kbd className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark text-claude-muted-light dark:text-claude-muted-dark">Ctrl K</kbd>
              </button>
            </div>

          <div className="px-4 pt-3 pb-2 space-y-1">
            {navItem('chat', 'Chat', <MessageSquareText className="w-4 h-4" />)}
            {navItem('research', 'Research', <Telescope className="w-4 h-4" />, 'beta')}
            {navItem('library', 'Library', <Library className="w-4 h-4" />, 'shell')}
            <button onClick={onOpenProjects} className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-[13px] font-semibold transition-all duration-300 ${activeProjectId ? 'bg-claude-surface-light dark:bg-claude-surface-dark text-claude-text-light dark:text-white shadow-[0_2px_10px_-4px_rgba(0,0,0,0.05)] border border-claude-border-light dark:border-claude-border-dark' : 'text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light dark:hover:text-white hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark border border-transparent'}`}>
              <span className="flex items-center gap-3"><FolderGit2 className="w-4 h-4" /><span>Projects</span></span>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-claude-surface2-light dark:bg-claude-surface2-dark text-claude-muted-light dark:text-claude-muted-dark">{projects.length}</span>
            </button>
            {navItem('agents', 'Agents', <Bot className="w-4 h-4" />, 'shell')}
            {navItem('automations', 'Automations', <Workflow className="w-4 h-4" />, 'shell')}
          </div>

          <div className="px-4 pt-4 pb-2">
            <div className="relative flex items-center group">
              <Search className="w-4 h-4 absolute left-3.5 text-claude-muted-light dark:text-claude-muted-dark group-focus-within:text-claude-text-light dark:group-focus-within:text-white transition-colors" />
              <input type="text" placeholder="Search workspace..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} className="w-full text-[13px] font-medium pl-10 pr-4 py-2.5 rounded-xl bg-claude-surface2-light dark:bg-claude-surface2-dark border border-claude-border-light dark:border-claude-border-dark placeholder-claude-muted-light dark:placeholder-claude-muted-dark focus:outline-none focus:border-claude-terracotta/50 focus:shadow-[0_0_0_2px_rgba(235,110,75,0.1)] text-claude-text-light dark:text-white transition-all duration-300" />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-3 overflow-x-hidden">
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

          <div className="p-4 bg-claude-surface2-light dark:bg-claude-surface2-dark/50 backdrop-blur-md border-t border-claude-border-light dark:border-claude-border-dark">
            <div className="flex items-center justify-between gap-2">
              <button onClick={onOpenSettings} className="flex items-center space-x-3 p-2.5 rounded-xl hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark hover:shadow-sm border border-transparent hover:border-claude-border-light dark:hover:border-claude-border-dark transition-all duration-300 flex-1 min-w-0 text-left active:scale-[0.98]">
                <div className="w-8 h-8 rounded-[10px] bg-gradient-to-br from-claude-terracotta to-claude-terracotta-hover text-white font-medium text-xs flex items-center justify-center flex-shrink-0 shadow-sm border border-white/20">{settings.userName ? settings.userName.slice(0, 2).toUpperCase() : 'AI'}</div>
                <div className="min-w-0 flex-1"><div className="text-[13px] font-bold text-claude-text-light dark:text-white tracking-tight truncate">{settings.userName || 'Aira User'}</div><div className="text-[11px] font-medium text-claude-muted-light dark:text-claude-muted-dark">Workspace settings</div></div>
                <Settings className="w-4 h-4 text-claude-muted-light dark:text-claude-muted-dark" />
              </button>
              <ThemeToggle theme={settings.theme} onChange={(t) => onUpdateSettings({ theme: t })} />
            </div>
          </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
};