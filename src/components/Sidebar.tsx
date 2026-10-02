import React, { useState, useMemo } from 'react';
import {
  Plus,
  Star,
  Trash2,
  Edit3,
  FolderGit2,
  Settings,
  Search,
  ChevronDown,
  ChevronRight,
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
import type { Conversation, Project, AppSettings, WorkspaceMode } from '../types';
import { AiraMark } from './AiraMark';

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

  const { starred, grouped } = useMemo(() => {
    const filtered = conversations.filter(c => c.title.toLowerCase().includes(searchQuery.toLowerCase()));
    const now = Date.now();
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
  }, [conversations, searchQuery]);

  const handleStartRename = (c: Conversation, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingChatId(c.id);
    setEditTitle(c.title);
  };

  const handleSaveRename = (id: string) => {
    if (editTitle.trim()) onRenameChat(id, editTitle.trim());
    setEditingChatId(null);
  };

  const cycleTheme = () => {
    const nextTheme = settings.theme === 'light' ? 'dark' : settings.theme === 'dark' ? 'system' : 'light';
    onUpdateSettings({ theme: nextTheme });
  };

  const navItem = (mode: WorkspaceMode, label: string, icon: React.ReactNode, badge?: string) => (
    <button
      onClick={() => onSelectWorkspace(mode)}
      className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-all duration-300 [@media(hover:hover)_and_(pointer:fine)]:hover:translate-x-1 ${workspaceMode === mode ? 'bg-claude-terracotta/12 text-claude-text-light dark:text-claude-text-dark border border-claude-terracotta/20' : 'text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light dark:hover:text-claude-text-dark hover:bg-claude-surface-light/70 dark:hover:bg-claude-surface-dark/70 border border-transparent'}`}
    >
      <span className="flex items-center gap-2.5">{icon}<span>{label}</span></span>
      {badge && <span className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-claude-surface-light dark:bg-claude-surface-dark border border-claude-border-light dark:border-claude-border-dark text-claude-muted-light dark:text-claude-muted-dark">{badge}</span>}
    </button>
  );

  const renderChatItem = (c: Conversation) => (
    <div
      key={c.id}
      onClick={() => onSelectChat(c.id)}
      className={`group flex items-center px-2.5 py-2 rounded-lg cursor-pointer transition-all duration-300 [@media(hover:hover)_and_(pointer:fine)]:hover:translate-x-1 ${activeChatId === c.id ? 'bg-claude-surface-light dark:bg-claude-surface-dark text-claude-text-light dark:text-claude-text-dark shadow-sm border border-claude-border-light/80 dark:border-claude-border-dark/80' : 'text-claude-muted-light dark:text-claude-muted-dark hover:bg-claude-surface-light/60 dark:hover:bg-claude-surface-dark/60 hover:text-claude-text-light dark:hover:text-claude-text-dark border border-transparent'}`}
    >
      <MessageSquareText className="w-3.5 h-3.5 flex-shrink-0 mr-2" />
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
          className="flex-1 min-w-0 text-xs bg-transparent outline-none border-b border-claude-terracotta"
        />
      ) : (
        <span className="text-xs truncate flex-1">{c.title}</span>
      )}
      <div className={`flex items-center gap-0.5 ml-1 ${activeChatId === c.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} transition-opacity`}>
        <button onClick={e => { e.stopPropagation(); onToggleStar(c.id); }} className="p-1 rounded hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark" title="Star">
          <Star className={`w-3 h-3 ${c.isPinned ? 'fill-amber-400 text-amber-400' : ''}`} />
        </button>
        <button onClick={e => handleStartRename(c, e)} className="p-1 rounded hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark" title="Rename"><Edit3 className="w-3 h-3" /></button>
        <button onClick={e => { e.stopPropagation(); onDeleteChat(c.id); }} className="p-1 rounded hover:bg-red-500/10 hover:text-red-400" title="Delete"><Trash2 className="w-3 h-3" /></button>
      </div>
    </div>
  );

  if (!isOpen) return null;

  return (
    <aside className="w-64 md:w-72 h-screen flex flex-col bg-claude-surface2-light dark:bg-claude-surface2-dark border-r border-claude-border-light dark:border-claude-border-dark select-none flex-shrink-0 z-30 transition-all duration-200">
      <div className="p-4 pb-3 flex items-center justify-between">
        <div className="flex items-center space-x-2.5">
          <AiraMark size="sm" />
          <div>
            <div className="font-semibold text-[17px] tracking-[-0.035em] text-claude-text-light dark:text-claude-text-dark leading-none">Aira</div>
            <div className="text-[9px] uppercase tracking-[0.16em] text-claude-muted-light dark:text-claude-muted-dark mt-1">AI workspace</div>
          </div>
        </div>
        <button onClick={onToggleOpen} className="p-1.5 rounded-lg text-claude-muted-light dark:text-claude-muted-dark hover:bg-claude-border-light/60 dark:hover:bg-claude-border-dark/60 transition-colors" title="Close sidebar">
          <PanelLeftClose className="w-4 h-4" />
        </button>
      </div>

      <div className="px-3 py-1.5">
        <button onClick={() => { onSelectWorkspace('chat'); onNewChat(); }} className="btn-whimsy w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl bg-claude-surface-light dark:bg-claude-surface-dark border border-claude-border-light dark:border-claude-border-dark shadow-claude-card hover:border-claude-terracotta/40 hover:shadow-sm text-claude-text-light dark:text-claude-text-dark text-xs font-medium transition-all group">
          <div className="flex items-center space-x-2.5"><Plus className="w-4 h-4 text-claude-terracotta group-hover:rotate-90 transition-transform duration-200" /><span>New task</span></div>
          <kbd className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-claude-surface2-light dark:bg-claude-surface2-dark text-claude-muted-light dark:text-claude-muted-dark border border-claude-border-light/80 dark:border-claude-border-dark/80">Ctrl K</kbd>
        </button>
      </div>

      <div className="px-3 pt-2 pb-1 space-y-0.5">
        {navItem('chat', 'Chat', <MessageSquareText className="w-4 h-4" />)}
        {navItem('research', 'Research', <Telescope className="w-4 h-4" />, 'beta')}
        {navItem('library', 'Library', <Library className="w-4 h-4" />, 'shell')}
        <button onClick={onOpenProjects} className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-all duration-300 [@media(hover:hover)_and_(pointer:fine)]:hover:translate-x-1 ${activeProjectId ? 'bg-claude-terracotta/12 text-claude-text-light dark:text-claude-text-dark border border-claude-terracotta/20' : 'text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light dark:hover:text-claude-text-dark hover:bg-claude-surface-light/70 dark:hover:bg-claude-surface-dark/70 border border-transparent'}`}>
          <span className="flex items-center gap-2.5"><FolderGit2 className="w-4 h-4" /><span>Projects</span></span>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-claude-surface-light dark:bg-claude-surface-dark border border-claude-border-light dark:border-claude-border-dark">{projects.length}</span>
        </button>
        {navItem('agents', 'Agents', <Bot className="w-4 h-4" />, 'shell')}
        {navItem('automations', 'Automations', <Workflow className="w-4 h-4" />, 'shell')}
      </div>

      <div className="px-3 pt-3 pb-1">
        <div className="relative flex items-center">
          <Search className="w-3.5 h-3.5 absolute left-3 text-claude-muted-light dark:text-claude-muted-dark" />
          <input type="text" placeholder="Search workspace..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} className="w-full text-xs pl-8 pr-3 py-1.5 rounded-lg bg-claude-surface-light dark:bg-claude-surface-dark border border-claude-border-light dark:border-claude-border-dark placeholder-claude-muted-light dark:placeholder-claude-muted-dark focus:outline-none focus:border-claude-terracotta/70 text-claude-text-light dark:text-claude-text-dark transition" />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-4">
        {starred.length > 0 && (
          <div>
            <button onClick={() => setStarredExpanded(!starredExpanded)} className="flex items-center space-x-1 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-claude-muted-light dark:text-claude-muted-dark hover:text-claude-text-light dark:hover:text-claude-text-dark w-full">
              {starredExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}<span>Starred</span><span className="text-[9px] ml-auto">{starred.length}</span>
            </button>
            {starredExpanded && <div className="mt-1 space-y-0.5">{starred.map(renderChatItem)}</div>}
          </div>
        )}
        {grouped.map(group => (
          <div key={group.title}>
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-claude-muted-light dark:text-claude-muted-dark">{group.title}</div>
            <div className="mt-0.5 space-y-0.5">{group.list.map(renderChatItem)}</div>
          </div>
        ))}
      </div>

      <div className="p-3 border-t border-claude-border-light dark:border-claude-border-dark bg-claude-surface-light/30 dark:bg-claude-surface-dark/30">
        <div className="flex items-center justify-between">
          <button onClick={onOpenSettings} className="flex items-center space-x-2.5 p-1.5 -ml-1 rounded-lg hover:bg-claude-border-light/60 dark:hover:bg-claude-border-dark/60 transition flex-1 min-w-0 text-left">
            <div className="w-8 h-8 rounded-full bg-claude-terracotta/15 text-claude-terracotta font-semibold text-xs flex items-center justify-center border border-claude-terracotta/25 flex-shrink-0">{settings.userName ? settings.userName.slice(0, 2).toUpperCase() : 'AI'}</div>
            <div className="min-w-0 flex-1"><div className="text-xs font-semibold text-claude-text-light dark:text-claude-text-dark truncate">{settings.userName || 'Aira User'}</div><div className="text-[10px] text-claude-muted-light dark:text-claude-muted-dark">Workspace settings</div></div>
            <Settings className="w-3.5 h-3.5 text-claude-muted-light dark:text-claude-muted-dark" />
          </button>
          <button onClick={cycleTheme} className="p-2 rounded-lg text-claude-muted-light dark:text-claude-muted-dark hover:bg-claude-border-light/60 dark:hover:bg-claude-border-dark/60 transition" title={`Theme: ${settings.theme}`}>
            {settings.theme === 'light' ? <Sun className="w-4 h-4" /> : settings.theme === 'dark' ? <Moon className="w-4 h-4" /> : <Laptop className="w-4 h-4" />}
          </button>
        </div>
      </div>
    </aside>
  );
};
