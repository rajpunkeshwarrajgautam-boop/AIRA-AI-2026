import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { PanelLeft, Layers, Bookmark, Share2, Check, FolderGit2 } from 'lucide-react';
import type { Conversation, Message, Artifact, Attachment, Project, AppSettings, WorkspaceMode } from './types';
import {
  loadConversations, saveConversations, loadActiveChatId, saveActiveChatId,
  loadProjects, saveProjects, loadSettings, saveSettings, INITIAL_CONVERSATION
} from './utils/storage';
import { streamAIResponse } from './utils/aiEngine';
import { retrieveRelevantSubgraph } from './utils/knowledgeGraph';
import { Sidebar } from './components/Sidebar';
import { ChatMessage } from './components/ChatMessage';
import { ChatInput } from './components/ChatInput';
import { GreetingScreen } from './components/GreetingScreen';
import { ModelSelector } from './components/ModelSelector';
import { AiraMark } from './components/AiraMark';
import { CommandPalette } from './components/CommandPalette';
import { InlineToast } from './components/InlineToast';

// Lazy-loaded heavy auxiliary surfaces to optimize FCP and TTI
const ArtifactStudio = React.lazy(() => import('./components/ArtifactStudio').then(m => ({ default: m.ArtifactStudio })));
const ProjectsModal = React.lazy(() => import('./components/ProjectsModal').then(m => ({ default: m.ProjectsModal })));
const SettingsModal = React.lazy(() => import('./components/SettingsModal').then(m => ({ default: m.SettingsModal })));
import { MemoryVaultModal } from './components/MemoryVaultModal';

const MODE_CONTEXT: Record<WorkspaceMode, string> = {
  chat: '',
  research: 'Work in research mode. Decompose the question, identify evidence needs, distinguish facts from inference, and provide a structured synthesis.',
  library: 'Work in library mode. Prefer the supplied project knowledge and clearly distinguish retrieved context from general reasoning.',
  agents: 'Work in agent-mission mode. Convert the objective into an executable mission with steps, tools, checkpoints, risks, and a final deliverable.',
  automations: 'Work in automation-design mode. Identify the trigger, conditions, cadence, action, failure handling, and expected output.',
};

function App() {
  const [conversations, setConversations] = useState<Conversation[]>(() => loadConversations());
  const [activeChatId, setActiveChatId] = useState(() => loadActiveChatId());
  const [projects, setProjects] = useState<Project[]>(() => loadProjects());
  const [activeProjectId, setActiveProjectId] = useState<string | undefined>(() => localStorage.getItem('aira_active_project_id_v1') || undefined);
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('chat');
  const [sidebarOpen, setSidebarOpen] = useState(() => typeof window !== 'undefined' ? window.innerWidth >= 768 : true);
  const [isProjectsOpen, setIsProjectsOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isMemoryVaultOpen, setIsMemoryVaultOpen] = useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [activeArtifact, setActiveArtifact] = useState<Artifact | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [sharedCopied, setSharedCopied] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const activeConversation = useMemo(
    () => conversations.find(c => c.id === activeChatId) || conversations[0],
    [conversations, activeChatId]
  );
  const currentProject = useMemo(
    () => projects.find(p => p.id === activeProjectId),
    [projects, activeProjectId]
  );

  useEffect(() => saveConversations(conversations), [conversations]);
  useEffect(() => saveProjects(projects), [projects]);
  useEffect(() => saveSettings(settings), [settings]);
  useEffect(() => {
    if (activeProjectId) localStorage.setItem('aira_active_project_id_v1', activeProjectId);
    else localStorage.removeItem('aira_active_project_id_v1');
  }, [activeProjectId]);

  useEffect(() => {
    const root = document.documentElement;
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const dark = settings.theme === 'dark' || (settings.theme === 'system' && systemDark);
    root.classList.toggle('dark', dark);
    if (settings.aestheticPreset && settings.aestheticPreset !== 'default') root.dataset.theme = settings.aestheticPreset;
    else delete root.dataset.theme;
  }, [settings.theme, settings.aestheticPreset]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [activeConversation?.messages.length]);

  const updateConversation = (id: string, updater: (c: Conversation) => Conversation) => {
    setConversations(prev => prev.map(c => c.id === id ? updater(c) : c));
  };

  const showToast = useCallback((message: string) => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    setToastMessage(message);
    toastTimerRef.current = window.setTimeout(() => {
      setToastMessage(null);
      toastTimerRef.current = null;
    }, 1800);
  }, []);

  useEffect(() => () => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
  }, []);

  const handleNewChat = useCallback(() => {
    const id = 'chat-' + Date.now();
    const next: Conversation = { id, title: 'New task', messages: [], createdAt: Date.now(), updatedAt: Date.now(), projectId: activeProjectId };
    setConversations(prev => [next, ...prev]);
    setActiveChatId(id);
    saveActiveChatId(id);
    setActiveArtifact(null);
    setWorkspaceMode('chat');
  }, [activeProjectId]);

  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsCommandPaletteOpen(true);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        handleNewChat();
      }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [handleNewChat]);

  const handleSelectChat = (id: string) => {
    setActiveChatId(id);
    saveActiveChatId(id);
    setActiveArtifact(null);
  };

  const handleDeleteChat = (id: string) => {
    if (!conversations.some(conversation => conversation.id === id)) return;
    setConversations(prev => {
      const filtered = prev.filter(c => c.id !== id);
      const next = filtered.length ? filtered : [{ ...INITIAL_CONVERSATION, id: 'chat-' + Date.now(), createdAt: Date.now(), updatedAt: Date.now() }];
      if (id === activeChatId) {
        setActiveChatId(next[0].id);
        saveActiveChatId(next[0].id);
      }
      return next;
    });
    showToast('Conversation deleted');
  };

  const handleRenameChat = (id: string, title: string) => updateConversation(id, c => ({ ...c, title, updatedAt: Date.now() }));
  const handleToggleStar = (id: string) => updateConversation(id, c => ({ ...c, isPinned: !c.isPinned }));

  const handleDuplicateChat = (id: string) => {
    const source = conversations.find(c => c.id === id);
    if (!source) return;

    const now = Date.now();
    const duplicate: Conversation = {
      ...structuredClone(source),
      id: `chat-${crypto.randomUUID()}`,
      title: `${source.title} (copy)`,
      isPinned: false,
      createdAt: now,
      updatedAt: now,
      messages: source.messages.map(message => ({
        ...structuredClone(message),
        id: `${message.role}-${crypto.randomUUID()}`,
        artifacts: message.artifacts?.map(artifact => ({ ...structuredClone(artifact), id: `artifact-${crypto.randomUUID()}` })),
        attachments: message.attachments?.map(attachment => ({ ...structuredClone(attachment), id: `attachment-${crypto.randomUUID()}` })),
      })),
    };

    setConversations(prev => [duplicate, ...prev]);
    setActiveChatId(duplicate.id);
    saveActiveChatId(duplicate.id);
    setActiveArtifact(null);
    setWorkspaceMode('chat');
    showToast('Conversation duplicated');
  };

  const shareConversation = async (conversation: Conversation): Promise<boolean> => {
    const text = conversation.messages
      .map(m => `${m.role === 'user' ? 'You' : 'Aira'}: ${m.content}`)
      .join('\n\n') || conversation.title;

    if (navigator.share) {
      try {
        await navigator.share({ title: conversation.title, text });
        return true;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return false;
      }
    }

    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  };

  const handleShareChat = async (id: string) => {
    const conversation = conversations.find(c => c.id === id);
    if (!conversation) return;
    const shared = await shareConversation(conversation);
    if (shared) showToast('Conversation shared');
  };

  const handleSendMessage = async (rawText: string, attachments: Attachment[]) => {
    if (isLoading) return;
    let conversation = activeConversation;
    if (!conversation) return;

    const id = conversation.id;
    const cleanTitle = rawText.replace(/^\[[^\]]+\]\s*/, '').trim();
    const userMessage: Message = {
      id: 'user-' + Date.now(),
      role: 'user',
      content: rawText,
      attachments,
      timestamp: Date.now(),
    };

    const assistantId = 'assistant-' + (Date.now() + 1);
    const assistantMessage: Message = {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      modelUsed: settings.activeModel,
      isStreaming: true,
      thinking: settings.extendedThinking ? { text: '', isStreaming: true } : undefined,
      artifacts: [],
    };

    const history = conversation.messages.map(m => ({ role: m.role, content: m.content }));
    updateConversation(id, c => ({
      ...c,
      title: c.messages.length === 0 && cleanTitle ? cleanTitle.slice(0, 52) : c.title,
      messages: [...c.messages, userMessage, assistantMessage],
      updatedAt: Date.now(),
    }));
    setIsLoading(true);

    let projectContext = '';
    if (currentProject?.instructions) projectContext += `Project instructions:\n${currentProject.instructions}\n\n`;
    if (currentProject?.knowledgeGraph) {
      const retrieved = retrieveRelevantSubgraph(rawText, currentProject.knowledgeGraph);
      if (retrieved) projectContext += retrieved.formattedContext;
    }
    const modeContext = MODE_CONTEXT[workspaceMode];
    const systemContext = [settings.customInstructions, modeContext, projectContext].filter(Boolean).join('\n\n');

    try {
      await streamAIResponse(
        rawText,
        history,
        settings.activeModel,
        { ...settings, customInstructions: systemContext },
        attachments,
        {
          onThinkingChunk: chunk => updateConversation(id, c => ({
            ...c,
            messages: c.messages.map(m => m.id === assistantId ? {
              ...m,
              thinking: { text: (m.thinking?.text || '') + chunk, isStreaming: true },
            } : m),
          })),
          onContentChunk: chunk => updateConversation(id, c => ({
            ...c,
            messages: c.messages.map(m => m.id === assistantId ? { ...m, content: m.content + chunk } : m),
          })),
          onArtifactFound: artifact => {
            setActiveArtifact(artifact);
            updateConversation(id, c => ({
              ...c,
              messages: c.messages.map(m => m.id === assistantId ? { ...m, artifacts: [...(m.artifacts || []), artifact] } : m),
            }));
          },
          onComplete: () => {
            updateConversation(id, c => ({
              ...c,
              updatedAt: Date.now(),
              messages: c.messages.map(m => m.id === assistantId ? {
                ...m,
                isStreaming: false,
                thinking: m.thinking ? { ...m.thinking, isStreaming: false } : undefined,
              } : m),
            }));
            setIsLoading(false);
          },
          onError: error => {
            updateConversation(id, c => ({
              ...c,
              messages: c.messages.map(m => m.id === assistantId ? { ...m, content: `Aira encountered an execution error: ${error}`, isStreaming: false } : m),
            }));
            setIsLoading(false);
          },
        },
        projectContext || undefined
      );
    } catch {
      setIsLoading(false);
      updateConversation(id, c => ({
        ...c,
        messages: c.messages.map(m => m.id === assistantId ? { ...m, content: 'Aira could not complete this request.', isStreaming: false } : m),
      }));
    }
  };

  const handleShare = async () => {
    if (!activeConversation) return;
    const shared = await shareConversation(activeConversation);
    if (!shared) return;
    setSharedCopied(true);
    showToast('Conversation shared');
    setTimeout(() => setSharedCopied(false), 1500);
  };

  const updateSettings = (partial: Partial<AppSettings>) => setSettings(prev => ({ ...prev, ...partial }));

  return (
    <div className="h-[100dvh] w-screen flex overflow-hidden bg-claude-bg-light dark:bg-claude-bg-dark text-claude-text-light dark:text-claude-text-dark">
      <Sidebar
        conversations={conversations}
        activeChatId={activeChatId}
        onSelectChat={handleSelectChat}
        onNewChat={handleNewChat}
        onDeleteChat={handleDeleteChat}
        onRenameChat={handleRenameChat}
        onToggleStar={handleToggleStar}
        onDuplicateChat={handleDuplicateChat}
        onShareChat={handleShareChat}
        projects={projects}
        activeProjectId={activeProjectId}
        onOpenProjects={() => setIsProjectsOpen(true)}
        onOpenSettings={() => setIsSettingsOpen(true)}
        isOpen={sidebarOpen}
        onToggleOpen={() => setSidebarOpen(v => !v)}
        settings={settings}
        onUpdateSettings={updateSettings}
        workspaceMode={workspaceMode}
        onSelectWorkspace={setWorkspaceMode}
      />

      <CommandPalette
        isOpen={isCommandPaletteOpen}
        conversations={conversations}
        projects={projects}
        onClose={() => setIsCommandPaletteOpen(false)}
        onNewChat={handleNewChat}
        onSelectChat={handleSelectChat}
        onSelectWorkspace={setWorkspaceMode}
        onOpenProjects={() => setIsProjectsOpen(true)}
        onOpenSettings={() => setIsSettingsOpen(true)}
      />

      <InlineToast message={toastMessage} />

      <main className="flex-1 min-w-0 h-[100dvh] flex flex-col overflow-x-hidden w-full max-w-full bg-mesh-canvas">
        <header className="h-[54px] px-3 md:px-5 flex items-center justify-between border-b border-claude-border-light/80 dark:border-claude-border-dark/80 gradient-fade-header relative z-50 bg-claude-bg-light/95 dark:bg-claude-bg-dark/95 backdrop-blur-md">
          <div className="flex items-center gap-2 min-w-0">
            {(!sidebarOpen || (typeof window !== 'undefined' && window.innerWidth < 768)) && (
              <>
                <button 
                  onClick={() => setSidebarOpen(true)} 
                  className="p-2 -ml-1 rounded-lg text-claude-muted-light dark:text-claude-muted-dark hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark transition-colors touch-manipulation" 
                  title="Open sidebar"
                  aria-label="Open sidebar navigation"
                >
                  <PanelLeft className="w-4 h-4" />
                </button>
                <div className="flex items-center gap-1.5 mr-1">
                  <AiraMark size="sm" />
                </div>
              </>
            )}
            <ModelSelector
              currentModel={settings.activeModel}
              onSelectModel={model => updateSettings({ activeModel: model })}
              extendedThinking={settings.extendedThinking}
              onToggleThinking={enabled => updateSettings({ extendedThinking: enabled })}
            />
            {currentProject && <button onClick={() => setIsProjectsOpen(true)} className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-claude-terracotta/10 text-claude-terracotta text-xs max-w-[180px]"><FolderGit2 className="w-3 h-3" /><span className="truncate">{currentProject.name}</span></button>}
          </div>
          <div className="flex items-center gap-1.5">
            {activeConversation?.messages.some(m => (m.artifacts?.length || 0) > 0) && <button onClick={() => {
              if (activeArtifact) setActiveArtifact(null);
              else {
                const artifact = activeConversation.messages.flatMap(m => m.artifacts || [])[0];
                if (artifact) setActiveArtifact(artifact);
              }
            }} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs ${activeArtifact ? 'bg-claude-terracotta text-white' : 'hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark'}`}><Layers className="w-3.5 h-3.5" /><span className="hidden sm:inline">Output Studio</span></button>}
            {activeConversation && <button onClick={() => handleToggleStar(activeConversation.id)} className="p-1.5 rounded-lg hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark active:scale-95 transition-all" title={activeConversation.isPinned ? 'Remove bookmark' : 'Bookmark conversation'}><Bookmark className={`w-4 h-4 ${activeConversation.isPinned ? 'fill-claude-terracotta text-claude-terracotta' : 'text-claude-muted-light dark:text-claude-muted-dark'}`} /></button>}
            <button onClick={handleShare} className="p-1.5 rounded-lg hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark">{sharedCopied ? <Check className="w-4 h-4 text-emerald-400" /> : <Share2 className="w-4 h-4 text-claude-muted-light dark:text-claude-muted-dark" />}</button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto flex flex-col">
          {!activeConversation || activeConversation.messages.length === 0 ? (
            <GreetingScreen 
              userName={settings.userName} 
              workspaceMode={workspaceMode} 
              onSelectStarter={prompt => handleSendMessage(prompt, [])} 
              conversations={conversations}
              activeProject={currentProject}
              extendedThinking={settings.extendedThinking}
              onSelectChat={handleSelectChat}
            />
          ) : (
            <div className="flex-1 pb-6 space-y-4">
              {activeConversation.messages.map(message => <ChatMessage key={message.id} message={message} userName={settings.userName} onOpenArtifact={setActiveArtifact} />)}
              <div ref={messagesEndRef} />
            </div>
          )}

          <div className="sticky bottom-0 pt-4 gradient-mask-bottom">
            <ChatInput
              onSendMessage={handleSendMessage}
              isLoading={isLoading}
              currentModel={settings.activeModel}
              extendedThinking={settings.extendedThinking}
              workspaceMode={workspaceMode}
              onWorkspaceModeChange={setWorkspaceMode}
            />
          </div>
        </div>
      </main>

      <React.Suspense fallback={null}>
        {activeArtifact && <ArtifactStudio artifact={activeArtifact} onClose={() => setActiveArtifact(null)} />}

        {isProjectsOpen && (
          <ProjectsModal
            isOpen={isProjectsOpen}
            onClose={() => setIsProjectsOpen(false)}
            projects={projects}
            activeProjectId={activeProjectId}
            onSelectProject={setActiveProjectId}
            onSaveProject={project => setProjects(prev => [project, ...prev.filter(p => p.id !== project.id)])}
            onDeleteProject={id => {
              setProjects(prev => prev.filter(p => p.id !== id));
              if (activeProjectId === id) setActiveProjectId(undefined);
            }}
          />
        )}

        {isSettingsOpen && (
          <SettingsModal
            isOpen={isSettingsOpen}
            onClose={() => setIsSettingsOpen(false)}
            settings={settings}
            onSaveSettings={setSettings}
            conversations={conversations}
            projects={projects}
            onImportData={data => { setConversations(data.conversations); setProjects(data.projects); if (data.conversations[0]) handleSelectChat(data.conversations[0].id); }}
            onClearAll={() => {
              const fresh = { ...INITIAL_CONVERSATION, id: 'chat-' + Date.now(), createdAt: Date.now(), updatedAt: Date.now() };
              setConversations([fresh]); setActiveChatId(fresh.id); setProjects([]); setActiveProjectId(undefined); setSettings(loadSettings()); setActiveArtifact(null);
            }}
            onOpenMemoryVault={() => setIsMemoryVaultOpen(true)}
          />
        )}

        {isMemoryVaultOpen && (
          <MemoryVaultModal
            isOpen={isMemoryVaultOpen}
            onClose={() => setIsMemoryVaultOpen(false)}
          />
        )}
      </React.Suspense>
    </div>
  );
}

export default App;