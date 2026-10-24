import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { PanelLeft, Layers, Bookmark, Share2, Check, FolderGit2, Bot, AlertTriangle } from 'lucide-react';
import type { Conversation, Message, Artifact, Attachment, Project, AppSettings, WorkspaceMode } from './types';
import {
  loadConversations, saveConversations, saveActiveChatId,
  getSessionActiveChatId, setSessionActiveChatId,
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
import { ConversationSearchOverlay } from './components/ConversationSearchOverlay';
import { InlineToast } from './components/InlineToast';
import { backfillConversationsBestEffort, deleteConversationFromServer, fetchAllConversationsFromServer, fetchConversationFromServer, syncConversationToServer } from './utils/conversationSearch';
import { useAnimatedFavicon } from './utils/animatedFavicon';
import { detectCapabilityIntent, executeVisionGeneration, createBackendAutomation, getVisionTariff } from './utils/capabilityDispatcher';
import { AgentContextualPanel } from './components/AgentContextualPanel';

// Lazy-loaded heavy auxiliary surfaces to optimize FCP and TTI
const ArtifactStudio = React.lazy(() => import('./components/ArtifactStudio').then(m => ({ default: m.ArtifactStudio })));
const ProjectsModal = React.lazy(() => import('./components/ProjectsModal').then(m => ({ default: m.ProjectsModal })));
const SettingsModal = React.lazy(() => import('./components/SettingsModal').then(m => ({ default: m.SettingsModal })));
import { MemoryVaultModal } from './components/MemoryVaultModal';
import { AuthModal } from './components/AuthModal';
import { PricingModal } from './components/PricingModal';
import { VisionStudioModal } from './components/VisionStudioModal';
import { AccountBillingModal } from './components/AccountBillingModal';
import { neonAuth, authenticatedApiFetch } from './lib/neonAuth';

const MODE_CONTEXT: Record<WorkspaceMode, string> = {
  chat: '',
  agent: 'Work in agent-mission mode. Plan and execute multi-step objectives with tool use, verification checkpoints, file creation, sandbox execution, and deliverables.',
};

function App() {
  useAnimatedFavicon();
  const [currentUserId, setCurrentUserId] = useState<string | null>(() => neonAuth.getCurrentUser()?.id || null);
  const [conversations, setConversations] = useState<Conversation[]>(() => {
    const user = neonAuth.getCurrentUser();
    return loadConversations(user?.id);
  });
  // Root visits without an active tab session start on a transient welcome draft.
  // When an active session exists (in-tab session or ?c= param), restore it on reload.
  const [activeChatId, setActiveChatId] = useState<string>(() => {
    const sessionChatId = getSessionActiveChatId();
    if (sessionChatId) {
      const user = neonAuth.getCurrentUser();
      const stored = loadConversations(user?.id);
      if (stored.some(c => c.id === sessionChatId)) {
        return sessionChatId;
      }
    }
    return '';
  });
  const [welcomeConversation] = useState<Conversation>(() => ({
    ...INITIAL_CONVERSATION, id: `chat-${crypto.randomUUID()}`,
    createdAt: Date.now(), updatedAt: Date.now(), messages: [],
  }));
  const [projects, setProjects] = useState<Project[]>(() => loadProjects());
  const [activeProjectId, setActiveProjectId] = useState<string | undefined>(() => localStorage.getItem('aira_active_project_id_v1') || undefined);
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [workspaceMode, setWorkspaceModeState] = useState<WorkspaceMode>(() => {
    const user = neonAuth.getCurrentUser();
    const key = `aira_workspace_mode_${user?.id || 'guest'}`;
    const stored = typeof window !== 'undefined' ? localStorage.getItem(key) : null;
    return (stored === 'agent' || stored === 'chat') ? stored : 'chat';
  });

  const setWorkspaceMode = useCallback((mode: WorkspaceMode) => {
    setWorkspaceModeState(mode);
    const user = neonAuth.getCurrentUser();
    const key = `aira_workspace_mode_${user?.id || 'guest'}`;
    try {
      localStorage.setItem(key, mode);
    } catch {
      // ignore storage errors
    }
  }, []);

  const [isAgentPanelOpen, setIsAgentPanelOpen] = useState(false);
  const [activeAgentPrompt, setActiveAgentPrompt] = useState<string | undefined>(undefined);
  const activeAbortControllerRef = useRef<AbortController | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const activeAssistantMsgIdRef = useRef<string | null>(null);
  const [cancelBuilderSignal, setCancelBuilderSignal] = useState(0);
  const [isBuilderBusy, setIsBuilderBusy] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => typeof window !== 'undefined' ? window.innerWidth >= 1280 : true);
  const pendingAutomationIdsRef = useRef<Set<string>>(new Set());
  const [confirmingAutoId, setConfirmingAutoId] = useState<string | null>(null);
  const pendingVisionOpsRef = useRef<Set<string>>(new Set());
  const [authorizingVisionId, setAuthorizingVisionId] = useState<string | null>(null);
  const [isProjectsOpen, setIsProjectsOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isAuthOpen, setIsAuthOpen] = useState(false);
  const [isPricingOpen, setIsPricingOpen] = useState(false);
  const [isVisionOpen, setIsVisionOpen] = useState(false);
  const [isAccountBillingOpen, setIsAccountBillingOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<'general' | 'reasoning' | 'memory' | 'instructions' | 'artifacts' | 'data' | 'personalization' | 'profile' | 'billing' | 'security'>('general');
  const [billingInitialTab, setBillingInitialTab] = useState<'overview' | 'usage' | 'topup' | 'security'>('overview');

  const handleOpenSettingsTab = (tab?: string) => {
    if (tab === 'billing') {
      setBillingInitialTab('overview');
      setIsAccountBillingOpen(true);
    } else if (tab === 'security') {
      setBillingInitialTab('security');
      setIsAccountBillingOpen(true);
    } else if (tab === 'profile') {
      setSettingsInitialTab('data');
      setIsSettingsOpen(true);
    } else if (tab === 'personalization') {
      setSettingsInitialTab('instructions');
      setIsSettingsOpen(true);
    } else {
      setSettingsInitialTab((tab as any) || 'general');
      setIsSettingsOpen(true);
    }
  };

  const [isMemoryVaultOpen, setIsMemoryVaultOpen] = useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [isConversationSearchOpen, setIsConversationSearchOpen] = useState(false);
  const [conversationSearchSeed, setConversationSearchSeed] = useState('');
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [activeArtifact, setActiveArtifact] = useState<Artifact | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [sharedCopied, setSharedCopied] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = useState<{
    id: string;
    runId: string;
    toolName?: string;
    reason?: string;
  } | null>(null);
  const [isSubmittingApproval, setIsSubmittingApproval] = useState(false);
  const [executionStatus, setExecutionStatus] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const conversationSyncVersionsRef = useRef<Map<string, string>>(new Map());
  const initialConversationBackfillRef = useRef(false);
  const authEpochRef = useRef(0);
  const conversationsOwnerRef = useRef<string | null>(currentUserId);

  const activeConversation = useMemo(
    () => conversations.find(c => c.id === activeChatId) || welcomeConversation,
    [conversations, activeChatId, welcomeConversation]
  );
  const currentProject = useMemo(
    () => projects.find(p => p.id === activeProjectId),
    [projects, activeProjectId]
  );

  // The sidebar is a desktop rail at xl and a temporary drawer below xl.
  // Reconcile visibility when an orientation change crosses that boundary.
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 1280px)');
    const onBreakpointChange = (event: MediaQueryListEvent) => setSidebarOpen(event.matches);
    desktop.addEventListener('change', onBreakpointChange);
    return () => desktop.removeEventListener('change', onBreakpointChange);
  }, []);

  // Proactively restore first-party BFF session from HttpOnly cookie on mount
  useEffect(() => {
    if (typeof window !== 'undefined' && window.location?.search) {
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.get('auth_error')) {
        setIsAuthOpen(true);
      }
    }
    neonAuth.restoreSession().catch((err) => {
      console.warn('[App] First-party session restore notice:', err);
    });
  }, []);

  useEffect(() => {
    return neonAuth.onAuthStateChange(async (user) => {
      const epoch = ++authEpochRef.current;
      const nextUserId = user?.id || null;

      // Identity transition boundary: immediately isolate and purge prior account in-memory state
      if (nextUserId !== currentUserId) {
        if (activeAbortControllerRef.current) {
          activeAbortControllerRef.current.abort();
          activeAbortControllerRef.current = null;
        }
        activeRunIdRef.current = null;
        activeAssistantMsgIdRef.current = null;
        pendingAutomationIdsRef.current.clear();
        pendingVisionOpsRef.current.clear();
        setConfirmingAutoId(null);
        setAuthorizingVisionId(null);
        setIsLoading(false);
        setExecutionStatus(null);
        setActiveAgentPrompt(undefined);
        setIsAgentPanelOpen(false);

        // Restore user-scoped workspace mode
        try {
          const modeKey = `aira_workspace_mode_${nextUserId || 'guest'}`;
          const storedMode = localStorage.getItem(modeKey);
          setWorkspaceModeState((storedMode === 'agent' || storedMode === 'chat') ? storedMode : 'chat');
        } catch {
          // ignore storage errors
        }

        setActiveChatId('');
        setSessionActiveChatId(null);
        setActiveArtifact(null);
        setHighlightedMessageId(null);
        conversationSyncVersionsRef.current.clear();
      }

      setCurrentUserId(nextUserId);

      if (user) {
        setSettings(s => ({
          ...s,
          userName: user.name || s.userName,
          email: user.email || s.email,
        }));

        // Immediately load cached conversations belonging to this verified user
        const cached = loadConversations(user.id);
        conversationsOwnerRef.current = user.id;
        setConversations(cached);

        // Hydrate persistent conversations from PostgreSQL server
        try {
          const serverConvs = await fetchAllConversationsFromServer();
          // Discard stale hydration response if user logged out or switched accounts while fetch was in flight
          if (authEpochRef.current !== epoch) return;

          if (serverConvs && serverConvs.length > 0) {
            conversationsOwnerRef.current = user.id;
            setConversations(serverConvs);
            saveConversations(serverConvs, user.id);
            setActiveChatId(prev => (serverConvs.some(c => c.id === prev) ? prev : ''));
          }
        } catch {
          // Server fetch failed: cached local state remains active
        }
      } else {
        // Account signed out: revert to isolated guest state and clear memory
        setSettings(s => ({
          ...s,
          userName: 'Guest User',
          email: '',
        }));
        conversationsOwnerRef.current = null;
        const guestConvs = loadConversations();
        setConversations(guestConvs);
        // Preserve root welcome screen contract on fresh tab; restore only if already active
        setActiveChatId(prev => (guestConvs.some(c => c.id === prev) ? prev : ''));
      }
    });
  }, [currentUserId]);

  useEffect(() => {
    // Only persist conversations if in-memory data strictly belongs to current active user
    if (conversationsOwnerRef.current === currentUserId) {
      saveConversations(conversations, currentUserId || undefined);
    }
  }, [conversations, currentUserId]);

  useEffect(() => {
    if (!initialConversationBackfillRef.current) {
      initialConversationBackfillRef.current = true;
      for (const conversation of conversations) {
        const stableMessages = conversation.messages.filter(message => !message.isStreaming).length;
        conversationSyncVersionsRef.current.set(
          conversation.id,
          `${conversation.updatedAt}:${stableMessages}:${conversation.title}:${Boolean(conversation.isPinned)}`
        );
      }
      const populated = conversations.filter(c => c.messages.some(m => !m.isStreaming));
      if (populated.length > 0) {
        void backfillConversationsBestEffort(populated);
      }
      return;
    }

    for (const conversation of conversations) {
      // Never persist a partially streamed assistant response into the durable
      // transcript. Existing local state remains the immediate UI source.
      if (conversation.messages.some(message => message.isStreaming)) continue;

      const stableMessages = conversation.messages.length;
      if (stableMessages === 0) continue;
      const version = `${conversation.updatedAt}:${stableMessages}:${conversation.title}:${Boolean(conversation.isPinned)}`;
      if (conversationSyncVersionsRef.current.get(conversation.id) === version) continue;

      conversationSyncVersionsRef.current.set(conversation.id, version);
      void syncConversationToServer(conversation);
    }
  }, [conversations]);

  useEffect(() => saveProjects(projects), [projects]);
  useEffect(() => saveSettings(settings), [settings]);
  useEffect(() => {
    setSessionActiveChatId(activeChatId || null);
  }, [activeChatId]);
  useEffect(() => {
    if (activeProjectId) localStorage.setItem('aira_active_project_id_v1', activeProjectId);
    else localStorage.removeItem('aira_active_project_id_v1');
  }, [activeProjectId]);

  useEffect(() => {
    const root = document.documentElement;
    const systemColor = window.matchMedia('(prefers-color-scheme: dark)');
    const applyTheme = () => {
      const dark = settings.theme === 'dark' || (settings.theme === 'system' && systemColor.matches);
      root.classList.toggle('dark', dark);
      if (settings.aestheticPreset && settings.aestheticPreset !== 'default') root.dataset.theme = settings.aestheticPreset;
      else delete root.dataset.theme;
    };
    applyTheme();
    systemColor.addEventListener('change', applyTheme);
    return () => systemColor.removeEventListener('change', applyTheme);
  }, [settings.theme, settings.aestheticPreset]);

  // Only scroll the conversation region; scrollIntoView can also move the
  // document/root viewport and leave a blank page after long conversations.
  useEffect(() => {
    const scrollRegion = chatScrollRef.current;
    if (!scrollRegion) return;
    scrollRegion.scrollTo({ top: scrollRegion.scrollHeight, behavior: 'instant' });
  }, [activeConversation?.id, activeConversation?.messages.length]);

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
    setSessionActiveChatId(id);
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
    setSessionActiveChatId(id);
    setActiveArtifact(null);
  };

  const handleOpenConversationSearch = (query = '') => {
    setConversationSearchSeed(query);
    setIsConversationSearchOpen(true);
  };

  const handleSelectSearchResult = async (conversationId: string, messageId?: string) => {
    let available = conversations.some(conversation => conversation.id === conversationId);

    if (!available) {
      const hydrated = await fetchConversationFromServer(conversationId);
      if (!hydrated) {
        showToast('Conversation could not be loaded');
        return;
      }

      setConversations(prev => {
        if (prev.some(conversation => conversation.id === hydrated.id)) return prev;
        return [hydrated, ...prev];
      });
      available = true;
    }

    if (!available) return;

    setWorkspaceMode('chat');
    handleSelectChat(conversationId);

    if (!messageId) return;

    setHighlightedMessageId(messageId);
    window.setTimeout(() => {
      const scrollRegion = chatScrollRef.current;
      const target = document.getElementById(`message-${messageId}`);
      if (!scrollRegion || !target || !scrollRegion.contains(target)) return;
      const containerRect = scrollRegion.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const targetScrollTop = scrollRegion.scrollTop +
        targetRect.top - containerRect.top -
        (scrollRegion.clientHeight - targetRect.height) / 2;
      scrollRegion.scrollTo({
        top: Math.max(0, targetScrollTop),
        behavior: 'smooth'
      });
    }, 120);
    window.setTimeout(() => setHighlightedMessageId(current => current === messageId ? null : current), 1800);
  };

  const handleDeleteChat = (id: string) => {
    if (!conversations.some(conversation => conversation.id === id)) return;
    setConversations(prev => {
      const filtered = prev.filter(c => c.id !== id);
      const next = filtered.length ? filtered : [{ ...INITIAL_CONVERSATION, id: 'chat-' + Date.now(), createdAt: Date.now(), updatedAt: Date.now() }];
      if (id === activeChatId) {
        setActiveChatId(next[0].id);
        saveActiveChatId(next[0].id);
        setSessionActiveChatId(next[0].id);
      }
      return next;
    });
    conversationSyncVersionsRef.current.delete(id);
    void deleteConversationFromServer(id);
    showToast('Conversation deleted');
  };

  const handleRenameChat = (id: string, title: string) => updateConversation(id, c => ({ ...c, title, updatedAt: Date.now() }));
  const handleToggleStar = (id: string) => updateConversation(id, c => ({ ...c, isPinned: !c.isPinned, updatedAt: Date.now() }));

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
    setSessionActiveChatId(duplicate.id);
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

  const handleCancelExecution = useCallback(async () => {
    // 1. Abort active streaming fetch
    if (activeAbortControllerRef.current) {
      activeAbortControllerRef.current.abort();
      activeAbortControllerRef.current = null;
    }

    // 2. Stop active sandboxed builder execution in AgentContextualPanel
    setCancelBuilderSignal(prev => prev + 1);

    // 3. Notify backend run cancellation if active run ID exists
    const runId = activeRunIdRef.current;
    if (runId) {
      activeRunIdRef.current = null;
      try {
        await authenticatedApiFetch(`/api/runs/${runId}/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (err) {
        console.warn('[App] Backend run cancellation notice:', err);
      }
    }

    // 4. Mark active assistant message as cancelled
    const assistantId = activeAssistantMsgIdRef.current;
    if (assistantId && activeChatId) {
      updateConversation(activeChatId, c => ({
        ...c,
        updatedAt: Date.now(),
        messages: c.messages.map(m => m.id === assistantId ? {
          ...m,
          content: m.content
            ? `${m.content}\n\n*[Execution cancelled by user. Transport connection aborted. Note: If backend provider processing had already begun, billing is reconciled by backend ledger rules.]*`
            : '*[Execution cancelled by user. Transport connection aborted]*',
          isStreaming: false,
          thinking: m.thinking ? { ...m.thinking, isStreaming: false } : undefined,
          visionProposal: undefined,
        } : m),
      }));
      activeAssistantMsgIdRef.current = null;
    }

    setIsLoading(false);
    setExecutionStatus(null);
    showToast('Execution cancelled');
  }, [activeChatId, showToast]);

  const handleSwitchToAgentAndReview = useCallback((prompt: string) => {
    setWorkspaceMode('agent');
    setActiveAgentPrompt(prompt);
    setIsAgentPanelOpen(true);
    showToast('Switched to Agent Mode. Review task and sandbox permissions in the panel.');
  }, [setWorkspaceMode, showToast]);

  const handleConfirmAutomation = useCallback(async (proposal: {
    id?: string;
    name: string;
    objective: string;
    trigger: any;
    cronExpression?: string;
    targetRunAt?: number;
    humanSchedule?: string;
    timezone?: string;
  }) => {
    if (!activeChatId) return;
    const opKey = proposal.id || `${proposal.name}_${proposal.cronExpression || proposal.targetRunAt || 'one_time'}`;
    if (pendingAutomationIdsRef.current.has(opKey)) return;
    pendingAutomationIdsRef.current.add(opKey);
    setConfirmingAutoId(opKey);
    setIsLoading(true);
    setExecutionStatus('Persisting automation to backend engine…');
    try {
      const result = await createBackendAutomation({
        name: proposal.name,
        objective: proposal.objective,
        trigger: proposal.trigger,
        cronExpression: proposal.cronExpression,
        targetRunAt: proposal.targetRunAt,
        timezone: proposal.timezone,
        clientOperationId: proposal.id,
      });
      setIsLoading(false);
      setExecutionStatus(null);

      if (result.success && result.automationId) {
        const confirmMsgId = 'assistant-' + Date.now();
        const scheduleInfo = proposal.humanSchedule ? `\n**Proposed Cadence:** ${proposal.humanSchedule}` : '';
        const tzInfo = proposal.timezone ? `\n**Timezone:** ${proposal.timezone}` : '';
        const triggerDetail = proposal.cronExpression ? ` (\`${proposal.cronExpression}\`)` : (proposal.targetRunAt ? ' (one-time)' : '');
        
        const isActuallyActive = result.enabled === true;
        const statusLabel = isActuallyActive ? 'ACTIVE' : 'INACTIVE (Draft)';
        const headerTitle = isActuallyActive ? '[Automation Confirmed & Activated]' : '[Automation Saved — Inactive Draft]';
        const noticeBody = isActuallyActive
          ? 'Your automation has been persisted to the server-authoritative engine and scheduled for autonomous execution.'
          : 'Autonomous scheduling is temporarily unavailable in this environment. Your automation has been securely saved to the database as an inactive draft and will not execute autonomously until a certified scheduler is configured.';

        const confirmationMessage: Message = {
          id: confirmMsgId,
          role: 'assistant',
          content: `${headerTitle}\n\n**Automation ID:** \`${result.automationId}\`\n**Name:** ${proposal.name}${scheduleInfo}${tzInfo}\n**Trigger:** ${proposal.trigger}${triggerDetail}\n**Status:** ${statusLabel}\n\n${noticeBody}`,
          timestamp: Date.now(),
          isStreaming: false,
        };
        updateConversation(activeChatId, c => ({
          ...c,
          updatedAt: Date.now(),
          messages: [...c.messages, confirmationMessage],
        }));
        showToast(isActuallyActive ? 'Automation activated successfully' : 'Automation saved as inactive draft');
      } else {
        showToast(result.error || 'Automation persistence failed');
      }
    } catch (err: any) {
      setIsLoading(false);
      setExecutionStatus(null);
      showToast(`Automation error: ${err.message || 'Failed to create automation'}`);
    } finally {
      pendingAutomationIdsRef.current.delete(opKey);
      setConfirmingAutoId(null);
    }
  }, [activeChatId, showToast]);

  const handleAuthorizeVision = useCallback(async (proposal: NonNullable<Message['visionProposal']>) => {
    if (!activeChatId) return;
    if (pendingVisionOpsRef.current.has(proposal.id)) return;
    pendingVisionOpsRef.current.add(proposal.id);
    setAuthorizingVisionId(proposal.id);

    const controller = new AbortController();
    activeAbortControllerRef.current = controller;
    const currentUserIdAtStart = currentUserId;
    const epochAtStart = authEpochRef.current;

    setIsLoading(true);
    setExecutionStatus('Invoking Vision Engine backend…');

    try {
      const visionRes = await executeVisionGeneration(
        proposal.prompt,
        {
          aspectRatio: proposal.options?.aspectRatio,
          quality: proposal.options?.quality,
          resolution: proposal.options?.resolution,
          numImages: proposal.options?.numImages,
          clientOperationId: proposal.id,
        },
        controller.signal
      );

      // Verify identity and transport integrity: discard stale results if user switched or operation cancelled
      if (authEpochRef.current !== epochAtStart || controller.signal.aborted || currentUserId !== currentUserIdAtStart) {
        setIsLoading(false);
        setExecutionStatus(null);
        activeAbortControllerRef.current = null;
        updateConversation(activeChatId, c => ({
          ...c,
          updatedAt: Date.now(),
          messages: c.messages.map(m => m.visionProposal?.id === proposal.id ? {
            ...m,
            content: `${m.content}\n\n*[Vision generation cancelled by user. Stale result suppressed.]*`,
            visionProposal: undefined,
          } : m),
        }));
        return;
      }

      setIsLoading(false);
      setExecutionStatus(null);
      activeAbortControllerRef.current = null;

      if (visionRes.authRequired) {
        setIsAuthOpen(true);
        updateConversation(activeChatId, c => ({
          ...c,
          updatedAt: Date.now(),
          messages: c.messages.map(m => m.visionProposal?.id === proposal.id ? {
            ...m,
            content: '[Authentication Required]: Please sign in to generate images with AIRA Vision Engine.',
            visionProposal: undefined,
          } : m),
        }));
        return;
      }

      if (visionRes.success && visionRes.imageUrl) {
        const billingText = typeof visionRes.creditsCharged === 'number'
          ? `*Generated by AIRA Vision Engine (${visionRes.creditsCharged} credits billed)*`
          : '*Generated by AIRA Vision Engine*';
        updateConversation(activeChatId, c => ({
          ...c,
          updatedAt: Date.now(),
          messages: c.messages.map(m => m.visionProposal?.id === proposal.id ? {
            ...m,
            content: `Here is the generated image for "${proposal.prompt}":\n\n![${proposal.prompt}](${visionRes.imageUrl})\n\n${billingText}`,
            visionProposal: undefined,
          } : m),
        }));
      } else if (visionRes.quotaExceeded) {
        updateConversation(activeChatId, c => ({
          ...c,
          updatedAt: Date.now(),
          messages: c.messages.map(m => m.visionProposal?.id === proposal.id ? {
            ...m,
            content: `[Quota Exceeded] **Vision Quota Exceeded**: You need additional credits to generate images.\n\n${visionRes.error || 'Please upgrade your plan or purchase image credits in Account & Billing.'}`,
            visionProposal: undefined,
          } : m),
        }));
      } else if (visionRes.providerUnavailable) {
        updateConversation(activeChatId, c => ({
          ...c,
          updatedAt: Date.now(),
          messages: c.messages.map(m => m.visionProposal?.id === proposal.id ? {
            ...m,
            content: `[Vision Service Unavailable] **Vision Engine Not Ready**: ${visionRes.error || 'No active image generation provider is configured or available. Zero credits were deducted.'}`,
            visionProposal: undefined,
          } : m),
        }));
      } else if (visionRes.cancelled) {
        updateConversation(activeChatId, c => ({
          ...c,
          updatedAt: Date.now(),
          messages: c.messages.map(m => m.visionProposal?.id === proposal.id ? {
            ...m,
            content: `${m.content}\n\n*[Vision generation cancelled by user. Transport connection aborted.]*`,
            visionProposal: undefined,
          } : m),
        }));
      } else {
        updateConversation(activeChatId, c => ({
          ...c,
          updatedAt: Date.now(),
          messages: c.messages.map(m => m.visionProposal?.id === proposal.id ? {
            ...m,
            content: `[Notice] **Vision Notice**: ${visionRes.error || 'Failed to generate visual render.'}`,
            visionProposal: undefined,
          } : m),
        }));
      }
    } catch (err: any) {
      setIsLoading(false);
      setExecutionStatus(null);
      activeAbortControllerRef.current = null;
      updateConversation(activeChatId, c => ({
        ...c,
        updatedAt: Date.now(),
        messages: c.messages.map(m => m.visionProposal?.id === proposal.id ? {
          ...m,
          content: `[Error] **Vision Error**: ${err.message || 'Image generation service error.'}`,
          visionProposal: undefined,
        } : m),
      }));
    } finally {
      pendingVisionOpsRef.current.delete(proposal.id);
      setAuthorizingVisionId(null);
    }
  }, [activeChatId, currentUserId]);

  const handleCancelVisionProposal = useCallback((proposalId: string) => {
    if (!activeChatId) return;
    updateConversation(activeChatId, c => ({
      ...c,
      updatedAt: Date.now(),
      messages: c.messages.map(m => m.visionProposal?.id === proposalId ? {
        ...m,
        content: `${m.content}\n\n*[Vision generation cancelled by user]*`,
        visionProposal: undefined,
      } : m),
    }));
    showToast('Vision generation cancelled');
  }, [activeChatId, showToast]);

  const handleSendMessage = async (rawText: string, attachments: Attachment[]) => {
    if (isLoading) return;
    let conversation = activeConversation;
    if (!conversation) return;

    const id = conversation.id;
    if (!conversations.some(c => c.id === id)) {
      conversation = { ...conversation, projectId: activeProjectId };
      const draft = conversation;
      setConversations(prev => [draft, ...prev]);
      setActiveChatId(id);
      saveActiveChatId(id);
      setSessionActiveChatId(id);
    }
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

    const controller = new AbortController();
    activeAbortControllerRef.current = controller;
    activeAssistantMsgIdRef.current = assistantId;
    activeRunIdRef.current = null;

    const intent = detectCapabilityIntent(rawText, workspaceMode);

    // 1. VISION ENGINE CAPABILITY DISPATCH (Requires explicit user authorization and tariff disclosure)
    if (intent.capability === 'IMAGE_GENERATION') {
      setIsLoading(false);
      activeAbortControllerRef.current = null;
      activeAssistantMsgIdRef.current = null;
      const tariff = getVisionTariff(intent.parameters);
      updateConversation(id, c => ({
        ...c,
        updatedAt: Date.now(),
        messages: c.messages.map(m => m.id === assistantId ? {
          ...m,
          content: `I prepared a visual generation request for your prompt: **"${intent.cleanPrompt}"**.\n\nImage generation is a billable operation requiring **${tariff} Credits** (${intent.parameters?.quality === 'premium' ? 'Premium' : 'Standard Economy'}, ${intent.parameters?.aspectRatio || '1:1'}). Under AIRA commercial safety controls, billable operations require explicit authorization before execution. Review the details below and authorize generation to proceed.`,
          isStreaming: false,
          visionProposal: {
            id: `vis_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            prompt: intent.cleanPrompt,
            estimatedCredits: tariff,
            options: intent.parameters,
          },
        } : m),
      }));
      return;
    }

    // 2. BUILDER APP IN CHAT MODE (Propose switching to Agent Mode with actionable handoff)
    if (intent.capability === 'BUILDER_APP' && workspaceMode === 'chat') {
      setIsLoading(false);
      activeAbortControllerRef.current = null;
      activeAssistantMsgIdRef.current = null;
      updateConversation(id, c => ({
        ...c,
        updatedAt: Date.now(),
        messages: c.messages.map(m => m.id === assistantId ? {
          ...m,
          content: `I recognized your request to scaffold and build an application: **"${intent.cleanPrompt}"**.\n\nTo create files, inspect the codebase, execute commands in an isolated sandbox, run tests, and generate live previews, this task requires **Agent Mode** with explicit sandbox permissions.`,
          isStreaming: false,
          builderHandoff: {
            prompt: intent.cleanPrompt,
            conversationId: id,
          },
        } : m),
      }));
      return;
    }

    // 3. BUILDER APP IN AGENT MODE (Launch builder and open contextual panel)
    if (intent.capability === 'BUILDER_APP' && workspaceMode === 'agent') {
      setIsAgentPanelOpen(true);
      setActiveAgentPrompt(intent.cleanPrompt || rawText);
    }

    // 4. AUTOMATION ENGINE CAPABILITY DISPATCH (Requires explicit schedule resolution and user confirmation)
    if (intent.capability === 'AUTOMATION') {
      setIsLoading(false);
      activeAbortControllerRef.current = null;
      activeAssistantMsgIdRef.current = null;

      const schedule = intent.parameters?.schedule;
      if (schedule && schedule.isAmbiguous) {
        updateConversation(id, c => ({
          ...c,
          updatedAt: Date.now(),
          messages: c.messages.map(m => m.id === assistantId ? {
            ...m,
            content: `I recognized your request to automate a workflow: **"${intent.cleanPrompt}"**.\n\n${schedule.clarificationPrompt || 'Please specify the exact time and frequency for this automation (for example: "every Monday at 9:00 AM" or "tomorrow at 3:00 PM").'}`,
            isStreaming: false,
          } : m),
        }));
        return;
      }

      const proposalName = intent.cleanPrompt.slice(0, 48) || 'AIRA Automation';
      updateConversation(id, c => ({
        ...c,
        updatedAt: Date.now(),
        messages: c.messages.map(m => m.id === assistantId ? {
          ...m,
          content: `I prepared an automation workflow draft for your request: **"${intent.cleanPrompt}"**.\n\n**Proposed Schedule:** ${schedule?.humanSchedule || 'Scheduled automation'}\n\n*Note: Autonomous background scheduling is temporarily unavailable in this environment. Review the proposal below and click **Save Automation (Inactive Draft)** (Confirm and Schedule Automation action) to safely register an inactive draft.*`,
          isStreaming: false,
          automationProposal: {
            id: `prop_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            name: proposalName,
            objective: intent.cleanPrompt,
            trigger: schedule?.scheduleType === 'ONE_TIME' ? 'ONE_TIME' : 'CRON',
            cronExpression: schedule?.scheduleType === 'ONE_TIME' ? undefined : (schedule?.cronExpression || '0 9 * * *'),
            targetRunAt: schedule?.targetTimestamp,
            humanSchedule: schedule?.humanSchedule,
            timezone: schedule?.timezone,
            scheduleType: schedule?.scheduleType,
          },
        } : m),
      }));
      return;
    }

    let projectContext = '';
    if (currentProject?.instructions) projectContext += `Project instructions:\n${currentProject.instructions}\n\n`;
    if (currentProject?.knowledgeGraph) {
      const retrieved = retrieveRelevantSubgraph(rawText, currentProject.knowledgeGraph);
      if (retrieved) projectContext += retrieved.formattedContext;
    }
    let modeContext = MODE_CONTEXT[workspaceMode];
    if (intent.capability === 'RESEARCH') {
      modeContext += '\nPerform deep research synthesis. Decompose the inquiry into core sub-questions, extract evidence, cite primary sources, and clearly distinguish verified facts from inferences.';
    }
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
          onProvenance: provenance => updateConversation(id, c => ({
            ...c,
            messages: c.messages.map(m => m.id === assistantId ? {
              ...m,
              provenance,
              modelUsed: (provenance.executedModel || m.modelUsed) as any
            } : m),
          })),
          onArtifactFound: artifact => {
            setActiveArtifact(artifact);
            updateConversation(id, c => ({
              ...c,
              messages: c.messages.map(m => {
                if (m.id !== assistantId) return m;
                const existing = m.artifacts || [];
                const idx = existing.findIndex(a => a.id === artifact.id);
                if (idx >= 0) {
                  const updated = [...existing];
                  updated[idx] = artifact;
                  return { ...m, artifacts: updated };
                }
                return { ...m, artifacts: [...existing, artifact] };
              }),
            }));
          },
          onApprovalRequired: approval => {
            setPendingApproval({
              id: approval.id,
              runId: approval.runId,
              toolName: approval.toolCall?.name,
              reason: approval.reason
            });
          },
          onStatusUpdate: status => {
            setExecutionStatus(status);
          },
          onLatencyMetrics: metrics => {
            console.info('[AIRA Telemetry] Client observed latency metrics:', metrics);
          },
          onRunStarted: runId => {
            activeRunIdRef.current = runId;
          },
          onSourceAdded: source => {
            updateConversation(id, c => ({
              ...c,
              messages: c.messages.map(m => m.id === assistantId ? {
                ...m,
                citations: [...(m.citations || []), {
                  sourceTitle: source.title,
                  uri: source.url,
                  snippet: source.snippet,
                }],
              } : m),
            }));
          },
          onCancelled: () => {
            updateConversation(id, c => ({
              ...c,
              messages: c.messages.map(m => m.id === assistantId ? {
                ...m,
                content: m.content ? `${m.content}\n\n*[Execution cancelled by user]*` : '*[Execution cancelled by user]*',
                isStreaming: false,
              } : m),
            }));
          },
          onComplete: () => {
            activeAbortControllerRef.current = null;
            activeAssistantMsgIdRef.current = null;
            activeRunIdRef.current = null;
            setExecutionStatus(null);
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
            activeAbortControllerRef.current = null;
            activeAssistantMsgIdRef.current = null;
            activeRunIdRef.current = null;
            setExecutionStatus(null);
            updateConversation(id, c => ({
              ...c,
              messages: c.messages.map(m => m.id === assistantId ? { ...m, content: `Aira encountered an execution error: ${error}`, isStreaming: false } : m),
            }));
            setIsLoading(false);
          },
        },
        projectContext || undefined,
        id,
        intent.capability === 'RESEARCH' ? 'RESEARCH' : undefined,
        controller.signal
      );
    } catch (err: any) {
      activeAbortControllerRef.current = null;
      activeAssistantMsgIdRef.current = null;
      activeRunIdRef.current = null;
      setExecutionStatus(null);
      setIsLoading(false);
      if (err?.name === 'AbortError') {
        return;
      }
      updateConversation(id, c => ({
        ...c,
        messages: c.messages.map(m => m.id === assistantId ? { ...m, content: 'Aira could not complete this request.', isStreaming: false } : m),
      }));
    }
  };

  const handleApprovalDecision = async (decision: 'APPROVE' | 'REJECT') => {
    if (!pendingApproval) return;
    setIsSubmittingApproval(true);
    try {
      const res = await authenticatedApiFetch(`/api/runs/${pendingApproval.runId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId: pendingApproval.id,
          decision
        })
      });
      if (!res.ok) {
        showToast('Approval submission failed.');
      } else {
        showToast(decision === 'APPROVE' ? 'Action approved. Resuming execution...' : 'Action rejected.');
        setPendingApproval(null);
      }
    } catch (e: any) {
      showToast(`Error: ${e.message}`);
    } finally {
      setIsSubmittingApproval(false);
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
    <div className="h-[100dvh] w-full min-w-0 flex overflow-hidden bg-claude-bg-light dark:bg-claude-bg-dark text-claude-text-light dark:text-claude-text-dark">
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
        onOpenSettings={() => {
          setSettingsInitialTab('general');
          setIsSettingsOpen(true);
        }}
        onOpenSettingsTab={handleOpenSettingsTab}
        onOpenAuth={() => setIsAuthOpen(true)}
        onOpenSearch={handleOpenConversationSearch}
        isOpen={sidebarOpen}
        onToggleOpen={() => setSidebarOpen(v => !v)}
        settings={settings}
        onUpdateSettings={updateSettings}
        workspaceMode={workspaceMode}
        onSelectWorkspace={setWorkspaceMode}
        onOpenVisionStudio={() => setIsVisionOpen(true)}
        onOpenPricing={() => setIsPricingOpen(true)}
        onOpenBilling={() => {
          setBillingInitialTab('overview');
          setIsAccountBillingOpen(true);
        }}
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

      <ConversationSearchOverlay
        isOpen={isConversationSearchOpen}
        initialQuery={conversationSearchSeed}
        conversations={conversations}
        projects={projects}
        onClose={() => setIsConversationSearchOpen(false)}
        onSelectChat={handleSelectSearchResult}
      />

      <InlineToast message={toastMessage} />

      <main className="flex-1 min-w-0 min-h-0 h-[100dvh] flex flex-col overflow-hidden w-full max-w-full bg-mesh-canvas">
        <header className="h-[54px] shrink-0 px-3 md:px-5 flex items-center justify-between border-b border-claude-border-light/80 dark:border-white/10 gradient-fade-header relative z-30 bg-claude-bg-light/95 dark:bg-aira-navy/95 backdrop-blur-md">
          <div className="flex flex-1 items-center gap-1 min-w-0">
            {!sidebarOpen && (
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
            {currentProject && <button onClick={() => setIsProjectsOpen(true)} className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-aira-blue/10 text-aira-blue text-xs max-w-[180px]"><FolderGit2 className="w-3 h-3" /><span className="truncate">{currentProject.name}</span></button>}
          </div>
          <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
            {workspaceMode === 'agent' && (
              <button
                onClick={() => setIsAgentPanelOpen(prev => !prev)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                  isAgentPanelOpen
                    ? 'bg-aira-blue text-white'
                    : 'bg-aira-blue/10 text-aira-blue dark:text-aira-silver hover:bg-aira-blue/20'
                }`}
                title="Toggle Agent Workspace Panel"
              >
                <Bot className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Agent Panel</span>
              </button>
            )}
            {(isLoading || isBuilderBusy) && (
              <button
                onClick={handleCancelExecution}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium text-rose-500 hover:bg-rose-500/10 active:scale-95 transition-all"
                title="Cancel active execution"
              >
                Cancel
              </button>
            )}
            {activeConversation?.messages.some(m => (m.artifacts?.length || 0) > 0) && <button onClick={() => {
              if (activeArtifact) setActiveArtifact(null);
              else {
                const artifact = activeConversation.messages.flatMap(m => m.artifacts || [])[0];
                if (artifact) setActiveArtifact(artifact);
              }
            }} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs ${activeArtifact ? 'bg-aira-blue text-white' : 'hover:bg-claude-surface2-light dark:hover:bg-white/5'}`}><Layers className="w-3.5 h-3.5" /><span className="hidden sm:inline">Output Studio</span></button>}
            {activeConversation && <button onClick={() => handleToggleStar(activeConversation.id)} className="p-1.5 rounded-lg hover:bg-claude-surface2-light dark:hover:bg-white/5 active:scale-95 transition-all" title={activeConversation.isPinned ? 'Remove bookmark' : 'Bookmark conversation'}><Bookmark className={`w-4 h-4 ${activeConversation.isPinned ? 'fill-aira-blue text-aira-blue' : 'text-claude-muted-light dark:text-claude-muted-dark'}`} /></button>}
            <button onClick={handleShare} className="p-1.5 rounded-lg hover:bg-claude-surface2-light dark:hover:bg-white/5">{sharedCopied ? <Check className="w-4 h-4 text-emerald-400" /> : <Share2 className="w-4 h-4 text-claude-muted-light dark:text-claude-muted-dark" />}</button>
          </div>
        </header>

        <div ref={chatScrollRef} data-testid="chat-scroll-region" className="flex-1 min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain flex flex-col">
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
              {activeConversation.messages.map(message => (
                <div
                  id={`message-${message.id}`}
                  key={message.id}
                  className={highlightedMessageId === message.id
                    ? 'rounded-xl ring-2 ring-aira-blue/35 bg-aira-blue/[0.035] transition-all duration-500'
                    : 'transition-all duration-500'}
                >
                  <ChatMessage
                    message={message}
                    userName={settings.userName}
                    onOpenArtifact={setActiveArtifact}
                    onSwitchToAgentAndReview={handleSwitchToAgentAndReview}
                    onConfirmAutomation={handleConfirmAutomation}
                    onAuthorizeVision={handleAuthorizeVision}
                    onCancelVisionProposal={handleCancelVisionProposal}
                    isConfirmingAutomation={Boolean(confirmingAutoId)}
                    isAuthorizingVision={Boolean(authorizingVisionId)}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Persistent Composer (Visible in both Chat Mode and Agent Mode) */}
        <div className="shrink-0 min-w-0 relative z-10 pt-2 sm:pt-4 gradient-mask-bottom">
          {executionStatus && (
            <div className="max-w-2xl mx-auto px-4 mb-2">
              <div className="flex items-center gap-2 text-xs text-aira-blue dark:text-aira-silver bg-aira-blue/10 border border-aira-blue/20 rounded-lg px-3 py-1.5 shadow-sm backdrop-blur">
                <div className="w-2 h-2 rounded-full bg-aira-blue animate-pulse" />
                <span className="font-medium">{executionStatus}</span>
              </div>
            </div>
          )}

          {pendingApproval && (
            <div className="max-w-2xl mx-auto px-4 mb-3">
              <div className="p-4 bg-amber-500/10 dark:bg-amber-950/40 border border-amber-500/30 rounded-xl backdrop-blur-md text-sm text-claude-text-light dark:text-claude-text-dark shadow-lg">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex items-center gap-2 font-medium text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="w-4 h-4 text-amber-500" />
                    <span>Tool Execution Approval Required</span>
                  </div>
                  <span className="text-xs px-2 py-0.5 rounded bg-amber-500/20 text-amber-700 dark:text-amber-300 font-mono">
                    {pendingApproval.toolName || 'system_action'}
                  </span>
                </div>
                <p className="text-xs text-claude-muted-light dark:text-claude-muted-dark mb-3">
                  {pendingApproval.reason || 'This tool execution produces state changes or destructive side effects that require explicit user authorization.'}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleApprovalDecision('APPROVE')}
                    disabled={isSubmittingApproval}
                    className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-medium text-xs shadow-sm transition disabled:opacity-50"
                  >
                    {isSubmittingApproval ? 'Submitting...' : 'Approve Execution'}
                  </button>
                  <button
                    onClick={() => handleApprovalDecision('REJECT')}
                    disabled={isSubmittingApproval}
                    className="px-3 py-1.5 rounded-lg bg-rose-600/10 hover:bg-rose-600/20 text-rose-600 dark:text-rose-400 font-medium text-xs transition disabled:opacity-50"
                  >
                    Deny
                  </button>
                </div>
              </div>
            </div>
          )}

          <ChatInput
            onSendMessage={handleSendMessage}
            isLoading={isLoading}
            currentModel={settings.activeModel}
            extendedThinking={settings.extendedThinking}
            workspaceMode={workspaceMode}
            onWorkspaceModeChange={setWorkspaceMode}
          />
        </div>
      </main>

      <React.Suspense fallback={null}>
        {activeArtifact && <ArtifactStudio artifact={activeArtifact} onClose={() => setActiveArtifact(null)} />}
        {isAgentPanelOpen && (
          <AgentContextualPanel
            isOpen={isAgentPanelOpen}
            onClose={() => setIsAgentPanelOpen(false)}
            model={settings.activeModel}
            activePrompt={activeAgentPrompt}
            onActivePromptConsumed={() => setActiveAgentPrompt(undefined)}
            cancelSignal={cancelBuilderSignal}
            onExecutionCancelled={handleCancelExecution}
            onBusyChange={setIsBuilderBusy}
          />
        )}

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
            initialTab={settingsInitialTab}
            onOpenBilling={(tab) => {
              setIsSettingsOpen(false);
              setBillingInitialTab(tab || 'overview');
              setIsAccountBillingOpen(true);
            }}
          />
        )}

        {isMemoryVaultOpen && (
          <MemoryVaultModal
            isOpen={isMemoryVaultOpen}
            onClose={() => setIsMemoryVaultOpen(false)}
          />
        )}

        <AuthModal
          isOpen={isAuthOpen}
          onClose={() => setIsAuthOpen(false)}
          onAuthSuccess={(user) => {
            setSettings(s => ({
              ...s,
              userName: user.name || s.userName,
              email: user.email || s.email,
            }));
            setToastMessage(`Welcome, ${user.name}! Sync active.`);
          }}
        />

        <PricingModal
          isOpen={isPricingOpen}
          onClose={() => setIsPricingOpen(false)}
        />

        <VisionStudioModal
          isOpen={isVisionOpen}
          onClose={() => setIsVisionOpen(false)}
        />

        <AccountBillingModal
          isOpen={isAccountBillingOpen}
          onClose={() => setIsAccountBillingOpen(false)}
          onOpenPricing={() => {
            setIsAccountBillingOpen(false);
            setIsPricingOpen(true);
          }}
          initialTab={billingInitialTab}
        />
      </React.Suspense>
    </div>
  );
}

export default App;
