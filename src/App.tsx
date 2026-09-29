import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PanelLeft, Layers, Star, Share2, Check, FolderGit2 } from 'lucide-react';
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
import { ArtifactStudio } from './components/ArtifactStudio';
import { ModelSelector } from './components/ModelSelector';
import { ProjectsModal } from './components/ProjectsModal';
import { SettingsModal } from './components/SettingsModal';

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
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [isProjectsOpen, setIsProjectsOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [activeArtifact, setActiveArtifact] = useState<Artifact | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [sharedCopied, setSharedCopied] = useState(false);
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

  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        handleNewChat();
      }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  });

  const updateConversation = (id: string, updater: (c: Conversation) => Conversation) => {
    setConversations(prev => prev.map(c => c.id === id ? updater(c) : c));
  };

  const handleNewChat = () => {
    const id = 'chat-' + Date.now();
    const next: Conversation = { id, title: 'New task', messages: [], createdAt: Date.now(), updatedAt: Date.now(), projectId: activeProjectId };
    setConversations(prev => [next, ...prev]);
    setActiveChatId(id);
    saveActiveChatId(id);
    setActiveArtifact(null);
    setWorkspaceMode('chat');
  };

  const handleSelectChat = (id: string) => {
    setActiveChatId(id);
    saveActiveChatId(id);
    setActiveArtifact(null);
  };

  const handleDeleteChat = (id: string) => {
    setConversations(prev => {
      const filtered = prev.filter(c => c.id !== id);
      const next = filtered.length ? filtered : [{ ...INITIAL_CONVERSATION, id: 'chat-' + Date.now(), createdAt: Date.now(), updatedAt: Date.now() }];
      if (id === activeChatId) {
        setActiveChatId(next[0].id);
        saveActiveChatId(next[0].id);
      }
      return next;
    });
  };

  const handleRenameChat = (id: string, title: string) => updateConversation(id, c => ({ ...c, title, updatedAt: Date.now() }));
  const handleToggleStar = (id: string) => updateConversation(id, c => ({ ...c, isPinned: !c.isPinned }));

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
    } catch (error) {
      setIsLoading(false);
      updateConversation(id, c => ({
        ...c,
        messages: c.messages.map(m => m.id === assistantId ? { ...m, content: 'Aira could not complete this request.', isStreaming: false } : m),
      }));
    }
  };

  const handleShare = async () => {
    if (!activeConversation) return;
    const text = activeConversation.messages.map(m => `${m.role === 'user' ? 'You' : 'Aira'}: ${m.content}`).join('\n\n');
    await navigator.clipboard.writeText(text || 'Aira workspace');
    setSharedCopied(true);
    setTimeout(() => setSharedCopied(false), 1500);
  };

  const updateSettings = (partial: Partial<AppSettings>) => setSettings(prev => ({ ...prev, ...partial }));

  return (
    <div className="h-screen w-screen flex overflow-hidden bg-claude-bg-light dark:bg-claude-bg-dark text-claude-text-light dark:text-claude-text-dark">
      <Sidebar
        conversations={conversations}
        activeChatId={activeChatId}
        onSelectChat={handleSelectChat}
        onNewChat={handleNewChat}
        onDeleteChat={handleDeleteChat}
        onRenameChat={handleRenameChat}
        onToggleStar={handleToggleStar}
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

      <main className="flex-1 min-w-0 h-screen flex flex-col">
        <header className="h-[54px] px-3 md:px-5 flex items-center justify-between border-b border-claude-border-light dark:border-claude-border-dark bg-claude-bg-light/80 dark:bg-claude-bg-dark/80 backdrop-blur-xl">
          <div className="flex items-center gap-2 min-w-0">
            {!sidebarOpen && <button onClick={() => setSidebarOpen(true)} className="p-1.5 rounded-lg hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark"><PanelLeft className="w-4 h-4" /></button>}
            <div className="hidden md:flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-claude-muted-light dark:text-claude-muted-dark mr-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]" />Aira</div>
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
            {activeConversation && <button onClick={() => handleToggleStar(activeConversation.id)} className="p-1.5 rounded-lg hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark"><Star className={`w-4 h-4 ${activeConversation.isPinned ? 'fill-amber-400 text-amber-400' : 'text-claude-muted-light dark:text-claude-muted-dark'}`} /></button>}
            <button onClick={handleShare} className="p-1.5 rounded-lg hover:bg-claude-surface2-light dark:hover:bg-claude-surface2-dark">{sharedCopied ? <Check className="w-4 h-4 text-emerald-400" /> : <Share2 className="w-4 h-4 text-claude-muted-light dark:text-claude-muted-dark" />}</button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto flex flex-col">
          {!activeConversation || activeConversation.messages.length === 0 ? (
            <GreetingScreen userName={settings.userName} workspaceMode={workspaceMode} onSelectStarter={prompt => handleSendMessage(prompt, [])} />
          ) : (
            <div className="flex-1 pb-6 divide-y divide-claude-border-light/40 dark:divide-claude-border-dark/40">
              {activeConversation.messages.map(message => <ChatMessage key={message.id} message={message} userName={settings.userName} onOpenArtifact={setActiveArtifact} />)}
              <div ref={messagesEndRef} />
            </div>
          )}

          <div className="sticky bottom-0 pt-4 bg-gradient-to-t from-claude-bg-light via-claude-bg-light/95 to-transparent dark:from-claude-bg-dark dark:via-claude-bg-dark/95">
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

      {activeArtifact && <ArtifactStudio artifact={activeArtifact} onClose={() => setActiveArtifact(null)} />}

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
      />
    </div>
  );
}

export default App;
